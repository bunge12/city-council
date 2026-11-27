import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { PLAYER_STATE } from "./browser-state";
import {
  BUILDING_TYPES,
  CHARGE_LINES,
  ECONOMY,
  LINE,
  MILESTONES,
  TAX_LINES,
  TIME_BALANCE,
  ZONING_BALANCE,
  areaBudget,
  blockBudgets,
  budgetAreasOfSlots,
  cellAt,
  deserialize,
  floorSpaceOf,
  formatMoneyShort,
  gameDate,
  generateTerrain,
  hashState,
  heightAt,
  replayFrom,
  serialize,
  unlockMilestone,
  type AreaBudget,
} from "../packages/sim/src/index";
import { SPOTS, at, budgetTown } from "../packages/sim/test/budget-town";
import { finishConstruction } from "./building-fixtures";
import { CITY_HALL, HALL_POINT, villageEveCity } from "./city-hall-fixtures";
import { MENU_SHIFT } from "./dock";
import { cityReady, frames, hideNotes, openCity, settingsButton, settle } from "./helpers";
import {
  FACTORY_STRIPS,
  GROWTH_STRIPS,
  HOMES,
  HOUSE_STRIPS,
  MAIN,
  NEW_SHOP_STRIPS,
  OFFICE_STRIP,
  REFUSED_STREET,
  SEED,
  SHOP_STRIP,
  SHORE,
  SPEND_MAX_LENGTH,
  SPEND_ROWS,
  SPEND_X0,
  STREETS,
  X0,
  X1,
  fillPoint,
  newCity,
  newCityStart,
  stripCell,
  type Strip,
} from "./m4-walkthrough-city";

// The M4 exit test from docs/milestones/M4.md (issue M4-20), as one
// walkthrough a player could do by hand, run once on WebGPU (when the
// browser has an adapter) and once on the `?webgl` fallback. It runs in the
// `walkthrough` project, against the production build or, with BASE_URL,
// the public address.
//
// Step 1 opens a new city on seed 2026 with nothing on it and the starting
// grant in its treasury (e2e/m4-walkthrough-city.ts). Steps 2 to 8 build a
// town on it from that grant with the page's own tools: the road tool, the
// zone tool, the budget panel's sliders and its loan form. The mirror's
// read-only copy is read to check what a step did. Waits on the sim hold
// the worker's clock and step it at 4x a chunk at a time (`growUntil`), so
// how far the town has gone before a read does not depend on how fast the
// runner draws, and every figure is read with the clock held still.
//
// Step 6 shows that a high development charge slows building against the
// same town at the default charge: the city is downloaded with the menu's
// button and opened in a browser context of its own, both zone the same
// fresh shop ground, and they run the same game days.
//
// Steps 9 to 12 run on the money specs' town a game day short of its first
// milestone, funded so it can pay City Hall's price, in a context of its
// own, as the issue's notes ask for a step that waits on the sim: at honest
// prices City Hall costs more than the starting grant and the Village grant
// together (M4.md), so the new city cannot reach it. Step 13 runs on the
// budget overlay's town, which isolates a compact block and a long
// cul-de-sac (issue M4-18). Step 14 reloads the new city's page and the
// milestone town's. Steps 2, 7 and 9 read sounds from the sound engine's
// test hook (M3-02): a headless browser plays nothing. Screenshots of each
// step land in walkthrough-screenshots/m4-<backend>/ and are attached to
// the report.

type Vec3 = readonly [number, number, number];
type Arrays = Record<string, ArrayLike<number>>;
interface LogEntry {
  tick: number;
  seq: number;
  playerId: string;
  type: string;
  payload: unknown;
}
interface CellInfo {
  segment: number;
  side: number;
  index: number;
}
interface MirrorBudget {
  treasury: number;
  opening: number;
  month: ArrayLike<number>;
  lastMonth: ArrayLike<number>;
  taxRates: ArrayLike<number>;
  chargeRates: ArrayLike<number>;
  loans: ArrayLike<number>;
}
interface MirrorState {
  tick: number;
  speed: number;
  log: LogEntry[];
  /** Whole dollars each log entry's command took from the treasury (M4-03). */
  logSpent: number[];
  budget: MirrorBudget;
  milestones: ArrayLike<number>;
  buildings: Arrays;
  cells: Arrays;
  pops: Arrays;
  demand: Record<string, { value: number; parts: Record<string, number> }>;
  stats: { totals: Record<string, number>; money: Record<string, ArrayLike<number>> };
}
interface Cue {
  cue: string;
  outcome: string;
}
interface BuildingRow {
  id: number;
  zone: number;
  type: number;
  residents: number;
  jobs: number;
  builtAt: number;
  strip: string;
  people: number;
  filled: number;
}
declare const window: {
  cityCouncil: {
    saves: { status: { city: { id: string }; loadedFrom: string; loadedTick: number } | null };
    downloadCity(): Promise<{ hash: string; tick: number }>;
    holdClock(): Promise<number>;
    advance(steps: number): Promise<number>;
    releaseClock(): Promise<number>;
    sendCommand(type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }>;
    sound: { cues(): Cue[]; clear(): void };
    mirror: {
      state: MirrorState | null;
      cellAt(x: number, z: number): CellInfo | null;
      buildingPeople(id: number): number;
      jobsFilled(id: number): number;
      building(id: number): { type: number; residents: number; jobs: number; corners: number[] | null } | null;
    };
    renderStatus(): { backend: string } | null;
    view: Promise<{ buildingTop(id: number): { x: number; y: number; z: number } | null }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const navigator: { gpu?: { requestAdapter(): Promise<unknown> } };
declare function getComputedStyle(element: unknown): { color: string };

const VIEWPORT = { width: 1280, height: 800 };
test.use({ viewport: VIEWPORT });
// Four page loads of the new city and its copy, one each of the milestone
// town and the budget town, two reloads, and game months at 4x on a machine
// that may have no GPU. 26 minutes is a third of the walkthrough-m4 job's
// 80, so a test that times out twice still leaves its job time to report
// (issue #228, scripts/check-e2e-timeouts.mjs).
test.setTimeout(1_560_000);

const SCREENSHOTS = "walkthrough-screenshots";
const terrain = generateTerrain(SEED);
const DAY = TIME_BALANCE.ticksPerDay;
/** The longest game month, in ticks, and a little over: a wait for a month's close gives up past it. */
const MONTH_MAX = 32 * DAY;
const zoneNumber = (id: string): number => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;
const RESIDENTIAL = zoneNumber("residential");
const COMMERCIAL = zoneNumber("commercial");
const OFFICE = zoneNumber("office");
const INDUSTRIAL = zoneNumber("industrial");
/** The warning colour, `--bad-ink`, as the treasury below zero shows it (M4-14). */
const WARNING = "rgb(122, 23, 18)";
const CHARGE_INDEX = Object.fromEntries(CHARGE_LINES.map((line, i) => [line, i])) as Record<string, number>;
const COMMERCIAL_CHARGE = CHARGE_INDEX["chargeCommercial"] ?? -1;
const firstMilestone = MILESTONES[0];
if (!firstMilestone) throw new Error("no milestones in progression.json");

async function shot(page: Page, info: TestInfo, dir: string, name: string, what?: Locator): Promise<void> {
  mkdirSync(join(SCREENSHOTS, dir), { recursive: true });
  const path = join(SCREENSHOTS, dir, `${name}.png`);
  const body = what ? await what.screenshot({ path }) : await page.screenshot({ path });
  await info.attach(name, { body, contentType: "image/png" });
}

const groundAt = (x: number, z: number): number => Math.max(heightAt(terrain, x, z), terrain.waterLevel);

/** Looks at (x, z) from `height` metres up and to the south, set back so the work area sits above the tool menus. */
async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  const shift = height * MENU_SHIFT;
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * 0.75 + shift],
      [x, g, z + shift],
    ] as const,
  );
  await frames(page);
}

/** The whole town, from the south. */
const lookAtTown = (page: Page) => look(page, (X0 + X1) / 2, (MAIN + SHORE) / 2, 620);

/** Waits until every chunk of buildings is read and the view settles, for a screenshot. */
async function settleBuilt(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0", null, { timeout: 180_000 });
  await settle(page, { timeout: 180_000 });
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y ?? groundAt(x, z), z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  await hover(page, x, z);
  await page.mouse.down();
  await page.mouse.up();
  await frames(page);
}

/** Moves the pointer onto building `id` as drawn, a little under its roof. */
async function hoverBuilding(page: Page, id: number): Promise<void> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  const p = await screenAt(page, top.x, top.z, top.y - 1);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

/** Moves the pointer off the map so no preview shows in a screenshot. */
async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page, 3);
}

async function mirror(page: Page): Promise<MirrorState> {
  const s = await page.evaluate(() => window.cityCouncil.mirror.state);
  if (!s) throw new Error("no state in the mirror");
  return s;
}

/** The mirror's budget, as plain arrays. */
async function budget(page: Page): Promise<{ treasury: number; opening: number; month: number[]; lastMonth: number[]; taxRates: number[]; chargeRates: number[]; loans: number[] }> {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.budget;
    if (!b) throw new Error("no city");
    return { treasury: b.treasury, opening: b.opening, month: Array.from(b.month), lastMonth: Array.from(b.lastMonth), taxRates: Array.from(b.taxRates), chargeRates: Array.from(b.chargeRates), loans: Array.from(b.loans) };
  });
}

const treasury = async (page: Page): Promise<number> => (await budget(page)).treasury;
const tickOf = async (page: Page): Promise<number> => (await page.evaluate(() => window.cityCouncil.mirror.state?.tick)) ?? 0;

async function log(page: Page): Promise<LogEntry[]> {
  return (await page.evaluate(() => window.cityCouncil.mirror.state?.log)) ?? [];
}

const logSpent = async (page: Page): Promise<number> => (await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))) ?? NaN;
const cues = (page: Page) => page.evaluate(() => window.cityCouncil.sound.cues().map((c) => c.cue));

const speedButton = (page: Page, name: string) => page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

/** Turns every tool off: Escape drops what a tool holds, a second leaves it. */
async function noTool(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const on = await page
      .locator("#road-tool, #upgrade-tool, #bulldoze-tool, #grid-tool, #zone-tool, #landmark-tool")
      .evaluateAll((els) => els.some((e) => e.getAttribute("aria-pressed") === "true"));
    if (!on) return;
    await page.keyboard.press("Escape");
    await frames(page);
  }
  throw new Error("a tool stayed on");
}

/** Zones each of `strips` with the zone tool's fill, `depth` cells deep, one ZoneCells each. */
async function zoneStrips(page: Page, strips: readonly Strip[], zone: string, density: number, depth: number): Promise<void> {
  if ((await page.locator("#zone-tool").getAttribute("aria-pressed")) !== "true") {
    await noTool(page);
    await page.keyboard.press("KeyK");
  }
  await expect(page.locator("#zone-menu")).toBeVisible();
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  await page.locator(`#zone-${zone}`).click();
  await expect(page.locator(`#zone-${zone}`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`#zone-density-${density}`).click();
  await page.locator("#zone-mode-fill").click();
  await page.locator(`#zone-depth-${depth}`).click();
  for (const strip of strips) {
    const before = (await log(page)).filter((e) => e.type === "ZoneCells").length;
    const [x, z] = fillPoint(strip);
    // Centred on the strip, clear of the top bar and the tool menus.
    await look(page, x, z, 320);
    await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
    await hover(page, x, z);
    await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
    await click(page, x, z);
    await expect.poll(async () => (await log(page)).filter((e) => e.type === "ZoneCells").length).toBe(before + 1);
  }
  await noTool(page);
}

/** The key of `strip`'s run of cells, as `BuildingRow.strip` holds it. */
async function stripKey(page: Page, strip: Strip): Promise<string> {
  const [x, z] = stripCell(strip);
  const cell = await page.evaluate(([x, z]) => window.cityCouncil.mirror.cellAt(x, z), [x, z] as const);
  if (!cell) throw new Error(`no cell at (${x}, ${z})`);
  return `${cell.segment}/${cell.side}`;
}

/** Every building standing in the copy, with its type, room, jobs and the people in it. */
async function buildings(page: Page): Promise<BuildingRow[]> {
  return page.evaluate(() => {
    const m = window.cityCouncil.mirror;
    const s = m.state;
    if (!s) return [];
    const b = s.buildings;
    const flags = b["flags"] ?? [];
    const out: BuildingRow[] = [];
    for (let id = 0; id < flags.length; id++) {
      if (((flags[id] ?? 0) & 1) === 0) continue;
      const info = m.building(id);
      out.push({
        id,
        zone: b["zone"]?.[id] ?? 0,
        type: info?.type ?? 0,
        residents: info?.residents ?? 0,
        jobs: info?.jobs ?? 0,
        builtAt: b["builtAt"]?.[id] ?? 0,
        strip: `${b["firstSeg"]?.[id] ?? 0}/${b["firstSide"]?.[id] ?? 0}`,
        people: m.buildingPeople(id),
        filled: m.jobsFilled(id),
      });
    }
    return out;
  });
}

const ofZone = (bs: readonly BuildingRow[], zone: number): BuildingRow[] => bs.filter((b) => b.zone === zone);
const keyOf = (b: BuildingRow): string => `${b.id}@${b.builtAt}`;

/** The development charge a new building pays at `rates` (economy/charges.ts): its zone's rate times its floor space, floored. */
function chargeOf(b: BuildingRow, rates: readonly number[]): number {
  const type = BUILDING_TYPES[b.type];
  if (!type) throw new Error(`no building type ${b.type}`);
  const space = floorSpaceOf(type, b.residents, b.jobs).total;
  const rate = rates[b.zone - 1] ?? 0;
  return space > 0 && rate > 0 ? Math.floor(rate * space) : 0;
}

/** The development charges in a ledger, every zone's line together. */
const chargesIn = (ledger: readonly number[]): number => CHARGE_LINES.reduce((n, line) => n + (ledger[LINE[line]] ?? 0), 0);

/** The game month a tick is in, as a number that rises month on month. */
const monthOf = (tick: number): number => {
  const d = gameDate(tick);
  return d.year * 12 + d.month;
};

/** The residential bar's tax part as its tooltip shows it, a signed whole number. */
async function taxInTip(page: Page): Promise<number> {
  await page.locator("#demand-residential").hover();
  const tip = page.locator("#demand-residential [role=tooltip]");
  await expect(tip).toContainText("Residential tax rate");
  const m = /Residential tax rate ([+-]\d+)/.exec((await tip.textContent()) ?? "");
  if (!m) throw new Error("no tax part in the residential bar's tooltip");
  return Number(m[1]);
}

/** A demand bar as the top bar shows it. */
async function bar(page: Page, name: string): Promise<number> {
  return Number(await page.locator(`#demand-${name}`).getAttribute("data-value"));
}

/**
 * Runs the game at 4x until `done` holds, at most `maxTicks` ticks, then
 * pauses. The worker's clock is held meanwhile and stepped `chunk` ticks at
 * a time, so how far the city goes before `done` is read does not depend
 * on how fast the runner draws (issue #224). `each` sees every read.
 */
async function growUntil<T>(page: Page, what: string, read: () => Promise<T>, done: (value: T) => boolean, maxTicks: number, chunk = 50, each?: (value: T) => void): Promise<T> {
  await page.evaluate(() => window.cityCouncil.holdClock());
  await heldSpeed(page, "4x");
  let ran = 0;
  for (let last = await read(); ; last = await read()) {
    each?.(last);
    if (done(last)) break;
    if (ran >= maxTicks) throw new Error(`${what}: not there after ${ran} ticks at 4x, last read ${JSON.stringify(last)}`);
    await page.evaluate((n) => window.cityCouncil.advance(n), chunk);
    ran += chunk;
  }
  await heldSpeed(page, "Pause");
  await page.evaluate(() => window.cityCouncil.releaseClock());
  return read();
}

/** Runs exactly `ticks` ticks at 4x and pauses. */
async function runTicks(page: Page, ticks: number, chunk = 50): Promise<void> {
  const until = (await tickOf(page)) + ticks;
  await growUntil(page, `${ticks} ticks`, () => tickOf(page), (t) => t >= until, ticks + chunk, Math.min(chunk, ticks));
}

/** Runs at 4x until the budget has closed a month, and returns the treasury the month that closed opened with. */
async function runToClose(page: Page): Promise<{ openedWith: number; closedAt: number }> {
  const start = await budget(page);
  const month = monthOf(await tickOf(page));
  await growUntil(page, "the month's close", () => tickOf(page), (t) => monthOf(t) !== month, MONTH_MAX, 25);
  return { openedWith: start.opening, closedAt: await tickOf(page) };
}

/** Presses a speed button with the clock held and runs the one step that applies it. */
async function heldSpeed(page: Page, name: "Pause" | "4x"): Promise<void> {
  await speedButton(page, name).click();
  await page.evaluate(() => window.cityCouncil.advance(1));
  await expect(speedButton(page, name)).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.speed)).toBe(name === "Pause" ? 0 : 4);
}

/** The city menu, opened if it is closed. */
async function cityMenu(page: Page) {
  const menu = page.getByRole("region", { name: "City menu" });
  if (!(await menu.isVisible())) await settingsButton(page, "City");
  await expect(menu).toBeVisible();
  return menu;
}

async function closeCityMenu(page: Page): Promise<void> {
  const menu = page.getByRole("region", { name: "City menu" });
  if (await menu.isVisible()) await settingsButton(page, "City");
  await expect(menu).toBeHidden();
  if (await page.locator("#settings-menu").isVisible()) await page.locator("#settings-toggle").click();
}

/** Downloads the city with the menu's button and returns the file's bytes. */
async function download(page: Page, info: TestInfo, name: string): Promise<Uint8Array> {
  const menu = await cityMenu(page);
  const [file] = await Promise.all([page.waitForEvent("download"), menu.locator("#download-city").click()]);
  const path = info.outputPath(name, file.suggestedFilename());
  await file.saveAs(path);
  await closeCityMenu(page);
  return new Uint8Array(readFileSync(path));
}

/** Saves with the city menu's button and reloads the page, which opens the latest save. */
async function saveAndReload(page: Page): Promise<void> {
  const menu = await cityMenu(page);
  const tick = Number(await page.locator("#sim-tick").textContent());
  await menu.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#save-status")).toContainText(`tick ${tick} at`);
  await closeCityMenu(page);
  const id = (await page.evaluate(() => window.cityCouncil.saves.status))?.city.id;
  await page.reload();
  await cityReady(page);
  await hideNotes(page);
  const status = await page.evaluate(() => window.cityCouncil.saves.status);
  expect(status?.loadedFrom).toBe("latest save");
  expect(status?.city.id).toBe(id);
  expect(status?.loadedTick).toBe(tick);
}

/** Opens a city in `page` and checks it drew on the backend the variant asks for. */
async function openOn(page: Page, info: TestInfo, city: Uint8Array, variant: { name: string; query: string }, name: string): Promise<void> {
  await openCity(page, city, { query: variant.query, name });
  const hasWebGpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  // CI starts Chromium with a software WebGPU adapter (playwright.config.ts).
  if (variant.name === "webgpu" && process.env["CI"]) expect(hasWebGpu, "CI must have a WebGPU adapter").toBe(true);
  const want = variant.name === "webgpu" && hasWebGpu ? "webgpu" : "webgl2";
  if (variant.name === "webgpu" && !hasWebGpu) info.annotations.push({ type: "backend", description: "no WebGPU adapter in this browser; ran on the WebGL 2 fallback" });
  expect((await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend).toBe(want);
  await expect(speedButton(page, "Pause")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#view").focus();
}

/** A page in a browser context of its own, as a player's second browser, so the first page's saves are untouched. */
async function otherPage(browser: Browser, info: TestInfo): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...devices["Desktop Chrome"], viewport: VIEWPORT, storageState: PLAYER_STATE, ...(info.project.use.baseURL ? { baseURL: info.project.use.baseURL } : {}) });
  return { context, page: await context.newPage() };
}

/** Opens the budget panel from the treasury in the time card if it is shut, on `tab`. */
async function budgetTab(page: Page, tab: "budget" | "charts" | "loans" | "taxes" | "charges"): Promise<Locator> {
  const panel = page.locator("#budget-panel");
  if (!(await panel.isVisible())) await page.locator("#treasury").click();
  await expect(panel).toBeVisible();
  await page.locator(`#budget-tab-${tab}`).click();
  await expect(page.locator(`#budget-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#budget-tabpanel-${tab}`)).toBeVisible();
  return panel;
}

async function closeBudget(page: Page): Promise<void> {
  if (await page.locator("#budget-panel").isVisible()) await page.locator("#treasury").click();
  await expect(page.locator("#budget-panel")).toBeHidden();
}

/** A ledger row's figure as the budget panel shows it: last month's or this month's. */
async function ledgerRow(page: Page, line: string, which: "last" | "now"): Promise<number> {
  return Number(await page.locator(`#budget-ledger tr[data-line="${line}"]`).getAttribute(`data-${which}`));
}

/** The time card's treasury, checked against the copy, which it shows in short form. */
async function shownTreasury(page: Page): Promise<number> {
  const t = await treasury(page);
  await expect(page.locator("#treasury")).toHaveAttribute("data-treasury", String(t));
  await expect(page.locator("#treasury")).toHaveText(formatMoneyShort(t));
  return t;
}

/**
 * Draws a straight road of `type` from `from` to `to` with the road tool, a
 * click at each end, and checks the price the tool showed before the second
 * click is what the treasury lost. Paused, so nothing else moved it.
 * Returns the price.
 */
async function drawRoad(page: Page, from: readonly [number, number], to: readonly [number, number], type: "street" | "avenue", height: number, beforeClick?: () => Promise<void>): Promise<number> {
  await noTool(page);
  await look(page, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, height);
  await onScreen(page, [from, to]);
  await page.keyboard.press("KeyR");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.locator(`#road-type-${type}`).click();
  await page.locator("#draw-mode-straight").click();
  await expect(page.locator("#draw-mode-straight")).toHaveAttribute("aria-pressed", "true");
  await click(page, from[0], from[1]);
  await hover(page, to[0], to[1]);
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toHaveAttribute("data-type", type);
  await expect(readout).toHaveAttribute("data-refusal", "");
  const price = Number(await readout.getAttribute("data-price"));
  expect(price).toBeGreaterThan(0);
  await expect(page.locator("#road-cost")).toHaveText(formatMoneyShort(price));
  await beforeClick?.();
  const before = await treasury(page);
  const entries = (await log(page)).length;
  await click(page, to[0], to[1]);
  await expect.poll(async () => (await log(page)).length).toBe(entries + 1);
  expect((await log(page)).at(-1)?.type).toBe("BuildRoad");
  expect(await logSpent(page)).toBe(price);
  expect(await treasury(page)).toBe(before - price);
  await noTool(page);
  return price;
}

/** Throws unless each ground point is on the map between the top bar and the tool menus, where a click reaches it. */
async function onScreen(page: Page, points: readonly (readonly [number, number])[]): Promise<void> {
  for (const [x, z] of points) {
    const p = await screenAt(page, x, z);
    if (p.x < 20 || p.x > VIEWPORT.width - 20 || p.y < 60 || p.y > 570) throw new Error(`(${x}, ${z}) is at (${Math.round(p.x)}, ${Math.round(p.y)}) on screen, under the page's bars or off it`);
  }
}

/** Points the road tool at a road of `type` from `from` to `to` and returns what its readout says, without the second click. */
async function previewRoad(page: Page, from: readonly [number, number], to: readonly [number, number], type: "street" | "avenue"): Promise<{ ok: boolean; price: number; refusal: string }> {
  await hover(page, to[0], to[1]);
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-type", type);
  await expect.poll(async () => Number(await readout.getAttribute("data-length"))).toBeGreaterThan(Math.hypot(to[0] - from[0], to[1] - from[1]) - 20);
  return { ok: (await readout.getAttribute("data-ok")) === "true", price: Number(await readout.getAttribute("data-price")), refusal: (await readout.getAttribute("data-refusal")) ?? "" };
}

/** The tag's lines as it shows them: each line's id and amount. */
async function tagLines(tag: Locator): Promise<{ line: string; amount: number }[]> {
  return tag.locator("#bulldoze-lines tr").evaluateAll((rows) =>
    rows.map((r) => ({ line: (r as unknown as { dataset: Record<string, string> }).dataset["line"] ?? "", amount: Number((r as unknown as { dataset: Record<string, string> }).dataset["amount"]) })),
  );
}

/** Looks straight down at building `id`, so no taller building stands between the camera and it, and settles. */
async function lookDownAt(page: Page, id: number, height = 160): Promise<void> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  const g = groundAt(top.x, top.z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [top.x, g + height, top.z + height / 5],
      [top.x, g, top.z],
    ] as const,
  );
  await frames(page);
  await settleBuilt(page);
}

/** Points the bulldozer at the first of `ids` it reaches and returns that id, or -1. */
async function bulldozerOn(page: Page, ids: readonly number[]): Promise<number> {
  for (const id of ids.slice(0, 10)) {
    await noTool(page);
    await lookDownAt(page, id);
    await page.keyboard.press("KeyB");
    await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
    await hoverBuilding(page, id);
    if ((await page.locator("#bulldoze-tag").getAttribute("data-ids")) === String(id)) return id;
  }
  return -1;
}

/** Clicks where the pointer is with the clock held and runs the one paused step that applies what the click sent. */
async function clickAndApply(page: Page): Promise<void> {
  await page.evaluate(() => window.cityCouncil.holdClock());
  await page.mouse.down();
  await page.mouse.up();
  await frames(page, 2);
  await page.evaluate(() => window.cityCouncil.advance(1));
  await page.evaluate(() => window.cityCouncil.releaseClock());
}

/** The budget town of step 13 (packages/sim/test/budget-town.ts), paused, with the sim's figures for every block and the block under each spot. */
function overlayTown(): { bytes: Uint8Array; spots: Record<keyof typeof SPOTS, { x: number; z: number }>; figures: Map<number, AreaBudget>; compactArea: number } {
  const { state, f } = budgetTown();
  finishConstruction(state);
  state.speed = 0;
  const spots = Object.fromEntries(Object.entries(SPOTS).map(([k, [u, v]]) => [k, at(f, u, v)])) as Record<keyof typeof SPOTS, { x: number; z: number }>;
  const budgets = blockBudgets(state);
  const figures = new Map<number, AreaBudget>();
  for (const id of budgets.blocks) {
    const b = areaBudget(budgets, id);
    if (b) figures.set(id, b);
  }
  const cell = cellAt(state, spots.compact.x, spots.compact.z);
  if (!cell) throw new Error("no cell at the compact block's spot");
  const chunk = Math.floor(spots.compact.z / 500) * 24 + Math.floor(spots.compact.x / 500);
  const compactArea = budgetAreasOfSlots(state, [cell.index], chunk)[0] ?? -1;
  return { bytes: serialize(state), spots, figures, compactArea };
}

/** The budget overlay's readout where the pointer is. */
async function budgetReadout(page: Page): Promise<{ area: number; kind: string; tax: number; upkeep: number; net: number }> {
  const r = page.locator("#budget-readout");
  await expect(r).toBeVisible();
  const num = async (name: string) => Number(await r.getAttribute(`data-${name}`));
  return { area: await num("area"), kind: (await r.getAttribute("data-kind")) ?? "", tax: await num("tax"), upkeep: await num("upkeep"), net: await num("net") };
}

let milestoneTownBuilt: ReturnType<typeof villageEveCity> | null = null;
/** Steps 9 to 12's town, built once per worker. */
const milestoneTown = (): ReturnType<typeof villageEveCity> => (milestoneTownBuilt ??= villageEveCity());
let overlayTownBuilt: ReturnType<typeof overlayTown> | null = null;
/** Step 13's town, built once per worker. */
const budgetOverlayTown = (): ReturnType<typeof overlayTown> => (overlayTownBuilt ??= overlayTown());

for (const variant of [
  { name: "webgpu", query: "" },
  { name: "webgl", query: "?webgl" },
] as const) {
  test(`M4 walkthrough (${variant.name})`, async ({ page, browser }, info) => {
    const dir = `m4-${variant.name}`;

    await test.step("1. start a new city: the time card in the bottom right shows the treasury at the starting grant", async () => {
      await openOn(page, info, newCity(), variant, "M4 walkthrough");
      expect(await buildings(page)).toEqual([]);
      expect(await shownTreasury(page)).toBe(ECONOMY.startingGrant);
      await page.locator("#treasury").hover();
      await expect(page.getByRole("tooltip")).toContainText("This month so far:");
      await lookAtTown(page);
      await shot(page, info, dir, "1-new-city-treasury");
      await shot(page, info, dir, "1-time-card", page.locator("#game-clock"));
    });

    await test.step("2. draw a street: the road tool shows its price before the click, the treasury drops by exactly that, the activity log names the player and the amount, and the money spent sound plays", async () => {
      const prices: number[] = [];
      for (const [i, street] of STREETS.entries()) {
        await page.evaluate(() => window.cityCouncil.sound.clear());
        const before = await treasury(page);
        const price = await drawRoad(page, street.from, street.to, "street", street.from[1] === street.to[1] ? 420 : 1150, i === 0 ? () => shot(page, info, dir, "2-price-before-the-click") : undefined);
        prices.push(price);
        expect(await shownTreasury(page), street.name).toBe(before - price);
        // A command that took money: its own cue, then the money cue.
        await expect.poll(() => cues(page), { message: street.name }).toEqual(["road", "money"]);
      }
      // The log names the player and the amount of each.
      await settingsButton(page, "Log");
      await page.locator("#settings-toggle").click();
      const rows = page.locator("#activity-log tbody tr").filter({ hasText: "local" }).filter({ hasText: "BuildRoad" });
      await expect(rows).toHaveCount(STREETS.length);
      // Newest first.
      for (const [i, price] of [...prices].reverse().entries()) {
        await expect(rows.nth(i)).toHaveAttribute("data-spent", String(price));
        await expect(rows.nth(i).locator("td.money")).toHaveText(formatMoneyShort(price));
      }
      await shot(page, info, dir, "2-log-names-player-and-amount", page.locator("#activity-log"));
      await settingsButton(page, "Log");
      await page.locator("#settings-toggle").click();
      expect(await shownTreasury(page)).toBe(ECONOMY.startingGrant - prices.reduce((a, b) => a + b, 0));
      await lookAtTown(page);
      await shot(page, info, dir, "2-streets");
      info.annotations.push({ type: "step 2", description: `streets ${prices.map(formatMoneyShort).join(", ")}; treasury ${formatMoneyShort(await treasury(page))}` });
    });

    await test.step("3. zone R1, C1, O1 and I1 along streets joined to an outside connection: buildings grow, and each new one adds its development charge to the treasury", async () => {
      await zoneStrips(page, HOUSE_STRIPS, "residential", 1, 6);
      await zoneStrips(page, [SHOP_STRIP], "commercial", 1, 6);
      await zoneStrips(page, [OFFICE_STRIP], "office", 1, 5);
      await zoneStrips(page, FACTORY_STRIPS, "industrial", 1, 6);
      await away(page);
      await shot(page, info, dir, "3-zoned");
      // Each read: the buildings standing and the charges in the ledger. The charges a chunk took in are the new buildings' own.
      const read = async () => ({ tick: await tickOf(page), buildings: await buildings(page), budget: await budget(page) });
      let last: Awaited<ReturnType<typeof read>> | null = null;
      let charged = 0;
      let checkedBuildings = 0;
      const done = await growUntil(
        page,
        "buildings of every zone",
        read,
        (v) => [RESIDENTIAL, COMMERCIAL, OFFICE, INDUSTRIAL].every((z) => ofZone(v.buildings, z).length > 0) && ofZone(v.buildings, RESIDENTIAL).length >= 30,
        3_000,
        50,
        (v) => {
          if (last) {
            const before = new Set(last.buildings.map(keyOf));
            const added = v.buildings.filter((b) => !before.has(keyOf(b)));
            const want = added.reduce((n, b) => n + chargeOf(b, last?.budget.chargeRates ?? []), 0);
            // Across a month's close the month before is the last month now.
            const closed = monthOf(v.tick) !== monthOf(last.tick);
            const got = closed ? chargesIn(v.budget.lastMonth) - chargesIn(last.budget.month) + chargesIn(v.budget.month) : chargesIn(v.budget.month) - chargesIn(last.budget.month);
            expect(got, `development charges from tick ${last.tick} to ${v.tick}, ${added.length} new buildings`).toBe(want);
            charged += got;
            checkedBuildings += added.length;
          }
          last = v;
        },
      );
      expect(charged).toBeGreaterThan(0);
      expect(checkedBuildings).toBe(done.buildings.length);
      await lookAtTown(page);
      await settleBuilt(page);
      await shot(page, info, dir, "3-buildings-grow");
      const counts = [RESIDENTIAL, COMMERCIAL, OFFICE, INDUSTRIAL].map((z) => ofZone(done.buildings, z).length);
      info.annotations.push({ type: "step 3", description: `buildings R ${counts[0]}, C ${counts[1]}, O ${counts[2]}, I ${counts[3]}; development charges ${formatMoneyShort(charged)}` });
    });

    let firstMonthResidentialTax = 0;
    await test.step("4. run a game month at 4x: the budget closes, and the budget panel shows last month's income by tax and by development charges, each on its own line, and expenses by road upkeep; income less expenses is the month's change in the treasury", async () => {
      const { openedWith } = await runToClose(page);
      const b = await budget(page);
      await budgetTab(page, "budget");
      for (const line of TAX_LINES) expect(await page.locator(`#budget-ledger tr[data-line="${line}"]`).count(), line).toBe(1);
      for (const line of CHARGE_LINES) expect(await page.locator(`#budget-ledger tr[data-line="${line}"]`).count(), line).toBe(1);
      // Every line is the sim's.
      for (const line of [...TAX_LINES, ...CHARGE_LINES, "roadUpkeep"] as const) {
        expect(await ledgerRow(page, line, "last"), line).toBe(b.lastMonth[LINE[line]]);
      }
      for (const line of ["taxResidential", "taxCommercial", "taxOffice", "taxIndustrial", "chargeResidential", "chargeCommercial", "roadUpkeep"] as const) {
        expect(await ledgerRow(page, line, "last"), line).toBeGreaterThan(0);
      }
      const net = Number(await page.locator("#budget-net").getAttribute("data-last"));
      expect(net, "last month's net against the treasury it opened and closed with").toBe(b.opening - openedWith);
      expect(Number(await page.locator("#budget-income").getAttribute("data-last")) - Number(await page.locator("#budget-expenses").getAttribute("data-last"))).toBe(net);
      firstMonthResidentialTax = b.lastMonth[LINE.taxResidential] ?? 0;
      await shot(page, info, dir, "4-budget-after-the-close", page.locator("#budget-panel"));
      await closeBudget(page);
      info.annotations.push({ type: "step 4", description: `opened ${formatMoneyShort(openedWith)}, closed ${formatMoneyShort(b.opening)}, net ${formatMoneyShort(net)}` });
    });

    await test.step("5. raise the residential tax rate: the residential bar's tooltip shows tax pulling it down, and the next month's residential tax income is higher; at zero the bar rises", async () => {
      const top = ECONOMY.taxRates.residential.max;
      await budgetTab(page, "taxes");
      await page.locator("#tax-residential").fill(String(top));
      await expect.poll(async () => (await budget(page)).taxRates[0]).toBe(top);
      await expect(page.locator('label[for="tax-residential"] output')).toHaveText(`${Math.round(top * 100)}%`);
      await shot(page, info, dir, "5-residential-tax-at-the-top", page.locator("#budget-panel"));
      await closeBudget(page);
      // The bar's tax part eases in a day at a time (demand.json `dailyShare`).
      await runTicks(page, 2 * DAY);
      await page.locator("#demand-residential").hover();
      const tip = page.locator("#demand-residential [role=tooltip]");
      await expect(tip).toContainText(/Residential tax rate -\d+/);
      await shot(page, info, dir, "5-tax-pulls-the-bar-down");
      await away(page);
      // A whole month at the top rate.
      await runToClose(page);
      const higher = (await budget(page)).lastMonth[LINE.taxResidential] ?? 0;
      expect(higher, "residential tax in the month at the top rate").toBeGreaterThan(firstMonthResidentialTax);
      await budgetTab(page, "budget");
      expect(await ledgerRow(page, "taxResidential", "last")).toBe(higher);
      await closeBudget(page);
      // At zero the bar rises, and tax pulls it down less.
      const before = await bar(page, "residential");
      const pullBefore = await taxInTip(page);
      await budgetTab(page, "taxes");
      await page.locator("#tax-residential").fill("0");
      await expect.poll(async () => (await budget(page)).taxRates[0]).toBe(0);
      await closeBudget(page);
      await runTicks(page, 2 * DAY);
      const after = await bar(page, "residential");
      expect(after, "the residential bar two days after the rate went to zero").toBeGreaterThan(before);
      const pullAfter = await taxInTip(page);
      expect(pullAfter, "the tax part of the residential bar, eased a day at a time toward zero's").toBeGreaterThan(pullBefore);
      await shot(page, info, dir, "5-zero-tax-lifts-the-bar");
      await away(page);
      // A rate off its default, for step 14 to find again after the reload.
      await budgetTab(page, "taxes");
      await page.locator("#tax-residential").fill("0.02");
      await expect.poll(async () => (await budget(page)).taxRates[0]).toBe(0.02);
      await closeBudget(page);
      info.annotations.push({ type: "step 5", description: `residential tax ${formatMoneyShort(firstMonthResidentialTax)} in the first month, ${formatMoneyShort(higher)} at ${top * 100}%; bar ${before.toFixed(1)} then ${after.toFixed(1)} at zero, its tax part ${pullBefore} then ${pullAfter}` });
    });

    await test.step("6. raise the commercial development charge to its top: commercial building slows; at zero the commercial charge line shows nothing the next month", async () => {
      expect((await mirror(page)).demand["commercial"]?.value ?? 0, "the commercial bar").toBeGreaterThan(0);
      // The same town in a second browser, at the default charge, to compare with.
      const copy = await download(page, info, "step-6");
      const other = await otherPage(browser, info);
      await openOn(other.page, info, copy, variant, "M4 walkthrough, default charge");
      expect(await tickOf(other.page)).toBe(await tickOf(page));
      const top = ECONOMY.developmentCharges.commercial.max;
      await budgetTab(page, "charges");
      await page.locator("#charge-commercial").fill(String(top));
      await expect.poll(async () => (await budget(page)).chargeRates[COMMERCIAL_CHARGE]).toBe(top);
      await shot(page, info, dir, "6-commercial-charge-at-the-top", page.locator("#budget-panel"));
      await closeBudget(page);
      expect((await budget(other.page)).chargeRates[COMMERCIAL_CHARGE]).toBe(ECONOMY.developmentCharges.commercial.default);
      // The same fresh shop ground in both, then the same three game days.
      await zoneStrips(page, NEW_SHOP_STRIPS, "commercial", 1, 6);
      await zoneStrips(other.page, NEW_SHOP_STRIPS, "commercial", 1, 6);
      const keys = new Set(await Promise.all(NEW_SHOP_STRIPS.map((s) => stripKey(page, s))));
      const shops = async (p: Page) => (await buildings(p)).filter((b) => b.zone === COMMERCIAL && keys.has(b.strip));
      const chargedBefore = (await budget(page)).month[LINE.chargeCommercial] ?? 0;
      await runTicks(page, 3 * DAY);
      await runTicks(other.page, 3 * DAY);
      expect(await tickOf(other.page)).toBe(await tickOf(page));
      const slow = await shops(page);
      const usual = await shops(other.page);
      expect(usual.length, "shops at the default charge").toBeGreaterThan(0);
      expect(slow.length, "shops at the top charge, against the default").toBeLessThan(usual.length);
      // Each paid the top rate.
      const rates = (await budget(page)).chargeRates;
      expect(((await budget(page)).month[LINE.chargeCommercial] ?? 0) - chargedBefore).toBe(slow.reduce((n, b) => n + chargeOf(b, rates), 0));
      for (const p of [page, other.page]) {
        await look(p, fillPoint(NEW_SHOP_STRIPS[0] as Strip)[0], fillPoint(NEW_SHOP_STRIPS[0] as Strip)[1], 300);
        await settleBuilt(p);
        await away(p);
      }
      await shot(page, info, dir, "6-shops-at-the-top-charge");
      await shot(other.page, info, dir, "6-shops-at-the-default-charge");
      await other.context.close();
      // At zero: shops built from now pay nothing, this month and the next.
      await budgetTab(page, "charges");
      await page.locator("#charge-commercial").fill("0");
      await expect.poll(async () => (await budget(page)).chargeRates[COMMERCIAL_CHARGE]).toBe(0);
      await closeBudget(page);
      const atZero = { charged: (await budget(page)).month[LINE.chargeCommercial] ?? 0, shops: (await buildings(page)).filter((b) => b.zone === COMMERCIAL).map(keyOf) };
      await runToClose(page);
      expect((await budget(page)).lastMonth[LINE.chargeCommercial], "the commercial charge line at the close: nothing added after the charge went to zero").toBe(atZero.charged);
      const before = new Set(atZero.shops);
      const builtAtZero = (await buildings(page)).filter((b) => b.zone === COMMERCIAL && !before.has(keyOf(b))).length;
      await runToClose(page);
      await budgetTab(page, "budget");
      expect(await ledgerRow(page, "chargeCommercial", "last")).toBe(0);
      expect((await budget(page)).lastMonth[LINE.chargeCommercial]).toBe(0);
      await shot(page, info, dir, "6-no-commercial-charge-the-next-month", page.locator("#budget-panel"));
      await closeBudget(page);
      info.annotations.push({ type: "step 6", description: `three days: ${slow.length} shops at $${top}/m², ${usual.length} at the default; ${builtAtZero} more built at $0 before the close` });
    });

    await test.step("7. spend the treasury down to the overdraft: the road tool shows the price in red and the reason, a click is refused with the rejected sound, and upkeep keeps running", async () => {
      const overdraft = ECONOMY.overdraft;
      let built = 0;
      for (const z of SPEND_ROWS) {
        const t = await treasury(page);
        if (t < 0) break;
        const from = [SPEND_X0, z] as const;
        await noTool(page);
        await look(page, SPEND_X0 + SPEND_MAX_LENGTH / 2, z, 2000);
        await page.keyboard.press("KeyR");
        await page.locator("#road-type-avenue").click();
        await page.locator("#draw-mode-straight").click();
        await click(page, from[0], from[1]);
        const whole = await previewRoad(page, from, [SPEND_X0 + SPEND_MAX_LENGTH, z], "avenue");
        // As long as the city can still pay for it and stay above zero; the last one takes it below, into the overdraft.
        let length = SPEND_MAX_LENGTH;
        if (whole.price > t) length = Math.floor(((t + overdraft / 2) / whole.price) * SPEND_MAX_LENGTH);
        await noTool(page);
        const price = await drawRoad(page, from, [SPEND_X0 + length, z], "avenue", length > 1200 ? 2000 : 1200);
        built += price;
      }
      const left = await shownTreasury(page);
      expect(left, "the treasury, into its overdraft").toBeLessThan(0);
      expect(left).toBeGreaterThanOrEqual(-overdraft);
      await expect(page.locator("#treasury")).toHaveClass(/overdrawn/);
      // A street the city can no longer pay for: its price in the warning colour, and the sim's reason.
      await noTool(page);
      await look(page, (REFUSED_STREET.from[0] + REFUSED_STREET.to[0]) / 2, REFUSED_STREET.from[1], 500);
      await page.keyboard.press("KeyR");
      await page.locator("#road-type-street").click();
      await click(page, REFUSED_STREET.from[0], REFUSED_STREET.from[1]);
      const refused = await previewRoad(page, REFUSED_STREET.from, REFUSED_STREET.to, "street");
      const readout = page.locator("#road-readout");
      expect(refused.ok).toBe(true);
      expect(refused.price).toBeGreaterThan(left + overdraft);
      expect(refused.refusal).toMatch(/^Costs \$[\d.]+[KM], \$[\d.]+K available$/);
      await expect(readout).toHaveClass(/refused/);
      await expect(page.locator("#road-cost")).toHaveText(formatMoneyShort(refused.price));
      await expect(page.locator("#road-reason")).toHaveText(refused.refusal);
      expect(await page.locator("#road-cost").evaluate((el) => getComputedStyle(el).color)).toBe(WARNING);
      await shot(page, info, dir, "7-price-in-red-with-the-reason");
      await page.evaluate(() => window.cityCouncil.sound.clear());
      const entries = (await log(page)).length;
      await click(page, REFUSED_STREET.to[0], REFUSED_STREET.to[1]);
      await expect(page.locator("#road-note")).toHaveText(/^Costs /);
      await expect.poll(() => cues(page)).toEqual(["reject"]);
      expect((await log(page)).length).toBe(entries);
      await shot(page, info, dir, "7-refused");
      await noTool(page);
      // Upkeep keeps running past the overdraft.
      const upkeep = (await budget(page)).month[LINE.roadUpkeep] ?? 0;
      await runTicks(page, DAY);
      expect((await budget(page)).month[LINE.roadUpkeep] ?? 0, "road upkeep a game day on").toBeGreaterThan(upkeep);
      info.annotations.push({ type: "step 7", description: `avenues ${formatMoneyShort(built)}; treasury ${formatMoneyShort(left)}; the street refused at ${formatMoneyShort(refused.price)}: ${refused.refusal}` });
    });

    await test.step("8. take a loan: the treasury rises by the principal, the budget panel lists the loan with its monthly repayment, and the next month's close charges it; the credit limit is shown, and it is larger once the city has grown", async () => {
      const panel = await budgetTab(page, "loans");
      const credit = page.locator("#budget-credit");
      const limit = Number(await credit.getAttribute("data-limit"));
      const leftToBorrow = Number(await credit.getAttribute("data-left"));
      expect(limit).toBeGreaterThan(0);
      expect(leftToBorrow).toBe(limit);
      const population = (await mirror(page)).stats.totals["population"] ?? 0;
      const principal = Math.floor(leftToBorrow / 2 / 1000) * 1000;
      const offer = ECONOMY.loans.offers[0];
      if (!offer) throw new Error("no loan offers");
      await page.locator("#loan-amount").fill(String(principal));
      await page.locator("#loan-term").selectOption(String(offer.termMonths));
      const before = await treasury(page);
      await page.locator("#take-loan").click();
      const row = page.locator("#budget-loans tr[data-loan]");
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-balance", String(principal));
      expect(await treasury(page)).toBe(before + principal);
      await expect(credit).toHaveAttribute("data-owed", String(principal));
      const repayment = Number(await row.getAttribute("data-repayment"));
      expect(repayment).toBeGreaterThan(0);
      await expect(row).toContainText(formatMoneyShort(repayment));
      await shot(page, info, dir, "8-loan-listed", panel);
      await closeBudget(page);
      // More homes, so the city grows while the loan runs.
      await zoneStrips(page, GROWTH_STRIPS, "residential", 1, 4);
      // The month it was taken in closes without it; the next close charges its repayment, interest and principal together.
      await runToClose(page);
      expect((await budget(page)).lastMonth[LINE.loanRepayments] ?? 0).toBe(0);
      await runToClose(page);
      const charged = await budget(page);
      expect((charged.lastMonth[LINE.interest] ?? 0) + (charged.lastMonth[LINE.loanRepayments] ?? 0), "the repayment at the next month's close").toBe(repayment);
      await budgetTab(page, "budget");
      expect((await ledgerRow(page, "interest", "last")) + (await ledgerRow(page, "loanRepayments", "last"))).toBe(repayment);
      await shot(page, info, dir, "8-repayment-at-the-close", page.locator("#budget-panel"));
      await budgetTab(page, "loans");
      const grown = (await mirror(page)).stats.totals["population"] ?? 0;
      expect(grown, "the population").toBeGreaterThan(population);
      expect(grown, "the new city stays short of its first milestone").toBeLessThan(firstMilestone.population);
      const grownLimit = Number(await credit.getAttribute("data-limit"));
      expect(grownLimit, "the credit limit once the city has grown").toBeGreaterThan(limit);
      await shot(page, info, dir, "8-larger-credit-limit", page.locator("#budget-panel"));
      await closeBudget(page);
      info.annotations.push({ type: "step 8", description: `loan ${formatMoneyShort(principal)} repaying ${formatMoneyShort(repayment)} a month; credit limit ${formatMoneyShort(limit)} at ${population} residents, ${formatMoneyShort(grownLimit)} at ${grown}` });
    });

    // Steps 9 to 12 and half of 14: the milestone town, in a context of its own.
    const town = milestoneTown();
    const second = await otherPage(browser, info);
    const tp = second.page;

    await test.step("9. grow the city past the first milestone: a grant is paid, the milestone reached sound plays, and City Hall and density 2 unlock; before that the zone tool shows density 2 locked, with the population that unlocks it", async () => {
      await openOn(tp, info, town.bytes, variant, "M4 walkthrough, Village eve");
      expect((await mirror(tp)).milestones.length).toBe(0);
      // Locked, with the population that unlocks it.
      await tp.keyboard.press("KeyK");
      const medium = tp.locator("#zone-density-2");
      const opens = MILESTONES[unlockMilestone("density2")];
      if (!opens) throw new Error("no milestone unlocks density 2");
      await expect(medium).toHaveAttribute("data-locked", "true");
      await expect(medium.locator(".unlocks-at")).toHaveText(`Unlocks at ${opens.population.toLocaleString("en-US")} residents`);
      await expect(tp.locator("#landmark-tool")).toHaveAttribute("data-locked", "true");
      await lookAtTown(tp);
      await settleBuilt(tp);
      await shot(tp, info, dir, "9-density-2-locked", tp.locator("#zone-menu"));
      await noTool(tp);
      // A click starts audio, as the player's first one does.
      await tp.locator("#game-date").click();
      await tp.evaluate(() => window.cityCouncil.sound.clear());
      const grants = (await budget(tp)).month[LINE.grants] ?? 0;
      const reached = await growUntil(tp, "the first milestone", async () => ({ milestones: (await mirror(tp)).milestones.length, population: await population(tp) }), (v) => v.milestones > 0, 3 * DAY, 10);
      expect(reached.milestones).toBe(1);
      expect(reached.population).toBeGreaterThanOrEqual(firstMilestone.population);
      // The grant, on its line: paused before the next close, so the month holds it.
      expect(((await budget(tp)).month[LINE.grants] ?? 0) - grants).toBe(firstMilestone.grant);
      await expect.poll(async () => (await cues(tp)).filter((c) => c === "milestone")).toEqual(["milestone"]);
      const notice = tp.locator("#milestone-notice");
      await expect(notice).toContainText(`${firstMilestone.name} reached`);
      await expect(notice).toContainText(`Grant of ${formatMoneyShort(firstMilestone.grant)} paid`);
      await expect(notice).toContainText("Unlocked: Medium density and City Hall");
      await shot(tp, info, dir, "9-milestone-reached");
      await expect(tp.locator("#landmark-tool")).not.toHaveAttribute("data-locked", "true");
      await tp.keyboard.press("KeyK");
      await expect(medium).not.toHaveAttribute("data-locked", "true");
      await expect(medium.locator(".unlocks-at")).toHaveCount(0);
      await shot(tp, info, dir, "9-density-2-open", tp.locator("#zone-menu"));
      await noTool(tp);
      info.annotations.push({ type: "step 9", description: `${firstMilestone.name} at ${reached.population} residents, grant ${formatMoneyShort(firstMilestone.grant)}` });
    });

    let hall = -1;
    await test.step("10. place City Hall on a road: its price is charged, its cells cannot be zoned, and its upkeep joins the budget; clicking it opens the budget panel", async () => {
      await budgetTab(tp, "budget");
      expect(await ledgerRow(tp, "buildingUpkeep", "now")).toBe(0);
      await closeBudget(tp);
      await look(tp, HALL_POINT.x, HALL_POINT.z, 200);
      await tp.keyboard.press("KeyH");
      await expect(tp.locator("#landmark-tool")).toHaveAttribute("aria-pressed", "true");
      await hover(tp, HALL_POINT.x, HALL_POINT.z);
      const readout = tp.locator("#landmark-readout");
      await expect(readout).toHaveAttribute("data-ok", "true");
      await expect(readout).toHaveAttribute("data-price", String(CITY_HALL.price));
      await expect(readout).toContainText(`Place City Hall · ${formatMoneyShort(CITY_HALL.price)}`);
      await shot(tp, info, dir, "10-city-hall-preview");
      const before = await treasury(tp);
      await clickAndApply(tp);
      await expect.poll(() => treasury(tp)).toBe(before - CITY_HALL.price);
      expect(await logSpent(tp)).toBe(CITY_HALL.price);
      expect((await log(tp)).at(-1)?.type).toBe("PlaceLandmark");
      hall = await tp.evaluate(() => Array.from(window.cityCouncil.mirror.state?.buildings["flags"] ?? []).findIndex((f) => (f & 16) !== 0));
      expect(hall).toBeGreaterThanOrEqual(0);
      const corners = (await tp.evaluate((id) => window.cityCouncil.mirror.building(id)?.corners ?? null, hall)) ?? [];
      const mid = { x: ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4, z: ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4 };
      // Its cells cannot be zoned: the zone tool's fill over its lot paints the strip either side of it, and none of the lot.
      await tp.keyboard.press("KeyK");
      await tp.locator("#zone-residential").click();
      await tp.locator("#zone-density-1").click();
      await tp.locator("#zone-mode-fill").click();
      await hover(tp, mid.x, mid.z);
      await shot(tp, info, dir, "10-no-zoning-on-its-lot");
      const zoned = (await log(tp)).length;
      await clickAndApply(tp);
      expect((await log(tp)).length, "the fill around the lot").toBe(zoned + 1);
      expect((await log(tp)).at(-1)?.type).toBe("ZoneCells");
      expect((await buildings(tp)).some((b) => b.id === hall), "City Hall, after the fill").toBe(true);
      const cellZone = await tp.evaluate(([x, z]) => {
        const m = window.cityCouncil.mirror;
        const c = m.cellAt(x, z);
        return c ? (m.state?.cells["zone"]?.[c.index] ?? -1) : -1;
      }, [mid.x, mid.z] as const);
      expect(cellZone, "the zone of the cell under City Hall's middle, or -1 for no cell").toBeLessThanOrEqual(0);
      await noTool(tp);
      // A game day on, its upkeep is on the budget's building upkeep line.
      await runTicks(tp, DAY, 10);
      await budgetTab(tp, "budget");
      expect(await ledgerRow(tp, "buildingUpkeep", "now")).toBeGreaterThan(0);
      await closeBudget(tp);
      // A click on it opens the budget panel.
      await lookDownAt(tp, hall, 220);
      const top = await tp.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), hall);
      if (!top) throw new Error("City Hall is not drawn");
      const at = await screenAt(tp, top.x, top.z, top.y - 1);
      await tp.mouse.click(at.x, at.y);
      await expect(tp.locator("#budget-panel")).toBeVisible();
      await shot(tp, info, dir, "10-click-opens-the-budget");
      await closeBudget(tp);
    });

    await test.step("11. point the bulldozer at an occupied house: the tag gives its value, the relocation payment and the premium, the treasury drops by exactly that, and the displaced pops' satisfaction drops; at a vacant building the tag gives the demolition cost only", async () => {
      const bs = await buildings(tp);
      const houses = bs.filter((b) => b.zone === RESIDENTIAL && b.people > 0).map((b) => b.id);
      const house = await bulldozerOn(tp, houses);
      if (house < 0) throw new Error("the pointer reached no occupied house");
      const tag = tp.locator("#bulldoze-tag");
      const lines = await tagLines(tag);
      expect(lines.map((l) => l.line)).toEqual(["value", "relocation", "premium", "total"]);
      const total = lines.at(-1)?.amount ?? NaN;
      expect(total).toBe(lines.slice(0, -1).reduce((n, l) => n + l.amount, 0));
      expect(Number(await tag.getAttribute("data-cost"))).toBe(total);
      await shot(tp, info, dir, "11-occupied-house-tag");
      // Its pops and their satisfaction, from the city as the menu downloads it: pop rows do not travel in deltas, so the page's copy of them is its last snapshot's (pops/delta.ts).
      const popsOf = async (name: string) => deserialize(await download(tp, info, name)).state.pops;
      const was = await popsOf("step-11-before");
      const moved: { pop: number; satisfaction: number }[] = [];
      for (let i = 0; i < was.home.length; i++) if ((was.size[i] ?? 0) > 0 && was.home[i] === house) moved.push({ pop: i, satisfaction: was.satisfaction[i] ?? 0 });
      expect(await bulldozerOn(tp, [house]), "the bulldozer back on the house").toBe(house);
      expect(moved.length).toBeGreaterThan(0);
      const before = await treasury(tp);
      await clickAndApply(tp);
      expect((await buildings(tp)).some((b) => b.id === house)).toBe(false);
      expect(await logSpent(tp)).toBe(total);
      expect(await treasury(tp)).toBe(before - total);
      await noTool(tp);
      // A game day on, each displaced pop carries the city's mark and is less satisfied.
      await runTicks(tp, DAY, 10);
      const after = await popsOf("step-11-after");
      const now = moved.map((m) => ({ satisfaction: after.satisfaction[m.pop] ?? 0, by: after.displacedBy[m.pop] ?? 0 }));
      for (const [k, m] of moved.entries()) {
        // DISPLACED_BY_CITY in pops.ts.
        expect(now[k]?.by, `pop ${m.pop}'s mark`).toBe(1);
        expect(now[k]?.satisfaction ?? 100, `pop ${m.pop}'s satisfaction`).toBeLessThan(m.satisfaction);
      }
      // A building nobody lives or works in: demolition only.
      const empty = (await buildings(tp)).filter((b) => b.people === 0 && b.filled === 0 && b.id !== hall).map((b) => b.id);
      const vacant = await bulldozerOn(tp, empty);
      if (vacant < 0) throw new Error("the pointer reached no building nobody uses");
      const vacantLines = await tagLines(tag);
      expect(vacantLines.map((l) => l.line)).toEqual(["demolition"]);
      const demolition = vacantLines[0]?.amount ?? NaN;
      expect(demolition).toBeLessThan(total / 10);
      await shot(tp, info, dir, "11-vacant-building-tag");
      const left = await treasury(tp);
      await clickAndApply(tp);
      expect(await logSpent(tp)).toBe(demolition);
      expect(await treasury(tp)).toBe(left - demolition);
      await noTool(tp);
      info.annotations.push({ type: "step 11", description: `house ${house}: ${lines.map((l) => `${l.line} ${formatMoneyShort(l.amount)}`).join(", ")}; satisfaction ${moved.map((m, k) => `${m.satisfaction} to ${now[k]?.satisfaction}`).join(", ")}; building ${vacant} demolition ${formatMoneyShort(demolition)}` });
    });

    await test.step("12. bulldoze a stretch of street with buildings on it: the tag gives the road's demolition less its refund, plus the compensation for every building it takes, and the treasury drops by that total", async () => {
      // The houses' street, west of the spine, between two of its houses.
      const x = 320;
      const z = HOMES;
      await noTool(tp);
      await look(tp, x, z, 160);
      await settleBuilt(tp);
      await tp.keyboard.press("KeyB");
      await hover(tp, x, z);
      const tag = tp.locator("#bulldoze-tag");
      await expect(tag).toHaveAttribute("data-kind", "road");
      const taken = Number(await tag.getAttribute("data-buildings"));
      expect(taken, "buildings on the stretch").toBeGreaterThan(0);
      const lines = await tagLines(tag);
      expect(lines.slice(0, 2).map((l) => l.line)).toEqual(["road", "refund"]);
      expect(lines.map((l) => l.line)).toContain("value");
      expect(lines.at(-1)?.line).toBe("total");
      const total = lines.at(-1)?.amount ?? NaN;
      const road = Number(await tag.getAttribute("data-road-demolition"));
      const refund = Number(await tag.getAttribute("data-refund"));
      const compensation = ["value", "relocation", "premium", "demolition"].reduce((n, k) => n + Number(lines.find((l) => l.line === k)?.amount ?? 0), 0);
      expect(total).toBe(road - refund + compensation);
      expect(Number(await tag.getAttribute("data-cost"))).toBe(total);
      await shot(tp, info, dir, "12-street-stretch-tag");
      const before = await treasury(tp);
      const count = (await buildings(tp)).length;
      await clickAndApply(tp);
      expect((await log(tp)).at(-1)?.type).toBe("BulldozeRoad");
      expect(await logSpent(tp)).toBe(total);
      expect(await treasury(tp)).toBe(before - total);
      expect((await buildings(tp)).length).toBe(count - taken);
      await noTool(tp);
      await look(tp, x, z, 260);
      await settleBuilt(tp);
      await shot(tp, info, dir, "12-street-stretch-cleared");
      info.annotations.push({ type: "step 12", description: `${taken} buildings: ${lines.map((l) => `${l.line} ${formatMoneyShort(l.amount)}`).join(", ")}` });
    });

    await test.step("13. turn on the budget overlay: a compact block of density 2 shows a net income above zero, and a long cul-de-sac of houses shows one below it", async () => {
      const ot = budgetOverlayTown();
      const third = await otherPage(browser, info);
      const op = third.page;
      await openOn(op, info, ot.bytes, variant, "M4 walkthrough, budget town");
      const { spots } = ot;
      await look(op, (spots.compact.x + spots.large.x) / 2, (spots.compact.z + spots.large.z) / 2, 300);
      await settleBuilt(op);
      await op.keyboard.press("KeyN");
      await expect(op.locator("#overlay-budget")).toHaveAttribute("aria-pressed", "true");
      await expect(op.locator("#budget-legend")).toBeVisible();
      await op.waitForFunction(() => document.body.dataset["cellsPending"] === "0" && document.body.dataset["budgetMs"] !== undefined, null, { timeout: 60_000 });
      await away(op);
      await shot(op, info, dir, "13-budget-overlay");
      await hover(op, spots.compact.x, spots.compact.z);
      const compact = await budgetReadout(op);
      expect(compact.kind).toBe("block");
      expect(compact.area).toBe(ot.compactArea);
      expect({ tax: compact.tax, upkeep: compact.upkeep, net: compact.net }).toEqual(ot.figures.get(compact.area));
      expect(compact.net).toBeGreaterThan(0);
      await shot(op, info, dir, "13-compact-block-above-zero");
      await hover(op, spots.large.x, spots.large.z);
      const large = await budgetReadout(op);
      expect(large.kind).toBe("block");
      expect({ tax: large.tax, upkeep: large.upkeep, net: large.net }).toEqual(ot.figures.get(large.area));
      expect(large.net).toBeLessThan(0);
      await shot(op, info, dir, "13-cul-de-sac-below-zero");
      await third.context.close();
      info.annotations.push({ type: "step 13", description: `compact block net ${formatMoneyShort(compact.net)} a year, the cul-de-sac's block ${formatMoneyShort(large.net)}` });
    });

    let saved = { hash: "", tick: 0, log: [] as LogEntry[] };
    await test.step("14. reload the page: the treasury, the month's ledger, the history, the rates, the loans, the milestones reached and City Hall come back", async () => {
      const snapshot = async (p: Page) => {
        const s = await mirror(p);
        return { budget: await budget(p), money: Object.fromEntries(Object.entries(s.stats.money).map(([k, v]) => [k, Array.from(v)])), milestones: Array.from(s.milestones), city: await p.evaluate(() => window.cityCouncil.downloadCity()) };
      };
      const before = await snapshot(page);
      expect(before.budget.loans.length).toBeGreaterThan(0);
      saved = { hash: before.city.hash, tick: before.city.tick, log: await log(page) };
      await saveAndReload(page);
      const after = await snapshot(page);
      expect(after.city.hash).toBe(before.city.hash);
      expect(after.budget).toEqual(before.budget);
      expect(after.money).toEqual(before.money);
      expect(await shownTreasury(page)).toBe(before.budget.treasury);
      // The panel shows them again: the ledger, the rates and the loan.
      await budgetTab(page, "budget");
      expect(await ledgerRow(page, "taxResidential", "now")).toBe(before.budget.month[LINE.taxResidential]);
      await budgetTab(page, "taxes");
      await expect(page.locator("#tax-residential")).toHaveAttribute("data-value", "0.02");
      await budgetTab(page, "charges");
      await expect(page.locator("#charge-commercial")).toHaveAttribute("data-value", "0");
      await budgetTab(page, "loans");
      await expect(page.locator("#budget-loans tr[data-loan]")).toHaveCount(1);
      await budgetTab(page, "charts");
      await expect(page.locator("#budget-flow-graph")).toHaveAttribute("data-months", String(before.money["treasury"]?.length ?? 0));
      await shot(page, info, dir, "14-after-reload-budget", page.locator("#budget-panel"));
      await closeBudget(page);
      // The milestone town: its milestone and City Hall.
      const townBefore = await snapshot(tp);
      expect(townBefore.milestones.length).toBe(1);
      await saveAndReload(tp);
      const townAfter = await snapshot(tp);
      expect(townAfter.city.hash).toBe(townBefore.city.hash);
      expect(townAfter.milestones).toEqual(townBefore.milestones);
      expect(townAfter.budget).toEqual(townBefore.budget);
      await expect(tp.locator("#milestone-notice")).toBeHidden();
      await lookDownAt(tp, hall, 220);
      await hoverBuilding(tp, hall);
      const hallReadout = tp.locator("#building-readout");
      await expect(hallReadout).toHaveAttribute("data-landmark", "true");
      await expect(hallReadout).toContainText("City Hall");
      await shot(tp, info, dir, "14-city-hall-after-reload");
      await second.context.close();
      await lookAtTown(page);
      await settleBuilt(page);
      await shot(page, info, dir, "14-after-reload");
    });

    await test.step("15. a replay of the recorded command log from the same seed produces the same state hash", async () => {
      const { header, state, pagedLog } = deserialize(await download(page, info, "replay"));
      expect(header.tick).toBe(saved.tick);
      const fullLog = [...pagedLog, ...state.log];
      expect(fullLog.map((e) => e.type)).toEqual(saved.log.map((e) => e.type));
      for (const e of fullLog) expect(["fixture", "local"]).toContain(e.playerId);
      // A new city, unfunded and with no milestone credited: everything in it came from commands.
      expect(header.seed).toBe(SEED);
      const rebuilt = replayFrom(newCityStart(), fullLog, header.tick);
      const hash = hashState(rebuilt);
      expect(hash).toBe(hashState(state));
      expect(rebuilt.budget.treasury).toBe(state.budget.treasury);
      info.annotations.push({ type: "replay", description: `seed ${header.seed}, ${fullLog.length} commands, tick ${header.tick}, treasury ${formatMoneyShort(state.budget.treasury)}, hash ${hash}` });
    });
  });
}

/** The population the top bar shows. */
async function population(page: Page): Promise<number> {
  return Number(((await page.locator("#population-count").textContent()) ?? "").replace(/,/g, ""));
}
