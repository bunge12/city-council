import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test, type Page, type TestInfo } from "@playwright/test";
import { PLAYER_STATE } from "./browser-state";
import { TIME_BALANCE, YEAR_COUNTS, ZONING_BALANCE, deserialize, hashState, heightAt, generateTerrain, replay } from "../packages/sim/src/index";
import { MENU_SHIFT } from "./dock";
import { cityReady, frames, hideNotes, openCity, openSettings, settingsButton, settle } from "./helpers";
import { HALF, HOMES, MAIN, REZONED, SEED, SHOPS, SHORE, UPPER, X0, X1, XM, abandonmentCity, fillPoint, redevelopmentCity, stripCell, townCity, type Strip } from "./m3-walkthrough-city";

// The M3 exit test from docs/milestones/M3.md (issue M3-22), as one
// walkthrough a player could do by hand, run once on WebGPU (when the
// browser has an adapter) and once on the `?webgl` fallback. It runs in the
// `walkthrough` project, against the production build or, with BASE_URL,
// the public address.
//
// Nothing holds the demand bars: the page is a player's, and the town runs
// on its own economy. The town is a few streets on seed 2026 between the
// west outside connection and the sea (e2e/m3-walkthrough-city.ts), built
// in Node with nothing zoned and imported as a city file.
//
// Every step goes through the page's own controls: the zone tool, the
// bulldozer, the overlay buttons, the statistics panel, the settings and
// the city menu. The mirror's read-only copy is read to check what a step
// did. Waits on the sim hold the worker's clock and step it at 4x a chunk
// at a time (`growUntil`), so how far the town grows before a read does not
// depend on how fast the runner draws.
//
// Two steps run out of the exit test's order. Step 9 bulldozes every
// workplace, which leaves nothing for steps 10 and 11 to work with, so it
// runs after them, and step 12's years run on the town step 9 left.
// Redevelopment in step 11 is a daily draw that took this town game months
// in Node, so step 11 opens a city built in Node a game day short of the
// first tower, as the issue's notes ask, in a browser context of its own so
// the town's saves are untouched. Step 9 does the same for abandonment,
// after the bulldoze, the departures and the vacant homes in the town: the
// pull from outside refills a town of under 500 residents faster than a
// home can stand vacant for 90 game days. The page still runs the day, and every
// check goes through its tools. Screenshots of each step land in
// walkthrough-screenshots/m3-<backend>/ and are attached to the report.

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
type Bar = "residential" | "commercial" | "office" | "industrial";
interface MirrorState {
  tick: number;
  speed: number;
  log: LogEntry[];
  buildings: Arrays;
  cells: Arrays;
  demand: Record<Bar, { value: number }>;
  stats: { totals: Record<string, number>; year: Record<string, number>; lastYear: Record<string, number> };
}
interface Cue {
  cue: string;
  outcome: string;
}
declare const window: {
  cityCouncil: {
    saves: { status: { city: { id: string }; loadedFrom: string; loadedTick: number } | null };
    downloadCity(): Promise<{ hash: string; tick: number }>;
    holdClock(): Promise<number>;
    advance(steps: number): Promise<number>;
    releaseClock(): Promise<number>;
    sendCommand(type: string, payload: unknown): { ok: boolean };
    sound: { cues(): Cue[]; clear(): void };
    mirror: {
      state: MirrorState | null;
      cellAt(x: number, z: number): CellInfo | null;
      buildingPeople(id: number): number;
      jobsFilled(id: number): number;
    };
    renderStatus(): { backend: string } | null;
    view: Promise<{
      buildingTop(id: number): { x: number; y: number; z: number } | null;
      buildingUse(id: number): number | null;
    }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
  localStorage: { getItem(key: string): string | null };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const navigator: { gpu?: { requestAdapter(): Promise<unknown> } };

const VIEWPORT = { width: 1280, height: 800 };
test.use({ viewport: VIEWPORT });
// Two page loads of the town, one each of step 9's and step 11's cities,
// and game years at 4x on a machine that may have no GPU: 11 minutes on
// software WebGPU in a 4-core container. 26 minutes is a third of the
// walkthrough-m3 job's 80, so a test that times out twice still leaves its
// job time to report (issue #228, scripts/check-e2e-timeouts.mjs).
test.setTimeout(1_560_000);

const SCREENSHOTS = "walkthrough-screenshots";
const terrain = generateTerrain(SEED);
const DAY = TIME_BALANCE.ticksPerDay;
const YEAR = TIME_BALANCE.ticksPerDay * TIME_BALANCE.monthDays.reduce((a, b) => a + b, 0);
const zoneNumber = (id: string): number => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;
const RESIDENTIAL = zoneNumber("residential");
const COMMERCIAL = zoneNumber("commercial");
const OFFICE = zoneNumber("office");
const INDUSTRIAL = zoneNumber("industrial");
const MIXED = zoneNumber("mixed");
/** What `view.buildingUse` and `usesOf` read: in use, vacant, abandoned. */
const VACANT = 1;
const ABANDONED = 2;

/** The strips each step zones. */
const HOUSES: Strip[] = [
  { z: HOMES, piece: "west", side: "north" },
  { z: HOMES, piece: "east", side: "north" },
  { z: HOMES, piece: "west", side: "south" },
  { z: HOMES, piece: "east", side: "south" },
  { z: UPPER, piece: "west", side: "north" },
  { z: UPPER, piece: "east", side: "north" },
];
const SHOP_STRIPS: Strip[] = [
  { z: SHOPS, piece: "west", side: "south" },
  { z: SHOPS, piece: "east", side: "south" },
];
const FACTORY_STRIPS: Strip[] = [
  { z: MAIN, piece: "west", side: "south" },
  { z: MAIN, piece: "east", side: "south" },
];
const OFFICE_STRIP: Strip = { z: SHOPS, piece: "west", side: "north" };
const MIXED_STRIP: Strip = { z: SHOPS, piece: "east", side: "north" };
/** Five cells deep: every lot on it is 4 x 4 or more. */
const TOWER_STRIP: Strip = { z: UPPER, piece: "west", side: "south" };
const SHORE_STRIP: Strip = { z: SHORE, piece: "east", side: "north" };
/** Across the main street from the factories. */
const FACTORY_SIDE_STRIP: Strip = { z: MAIN, piece: "east", side: "north" };

interface Building {
  id: number;
  zone: number;
  density: number;
  strip: string;
  builtAt: number;
  people: number;
  residents: number;
  filled: number;
}

async function shot(page: Page, info: TestInfo, dir: string, name: string): Promise<void> {
  mkdirSync(join(SCREENSHOTS, dir), { recursive: true });
  const body = await page.screenshot({ path: join(SCREENSHOTS, dir, `${name}.png`) });
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

async function log(page: Page): Promise<LogEntry[]> {
  return (await page.evaluate(() => window.cityCouncil.mirror.state?.log)) ?? [];
}

const speedButton = (page: Page, name: string) => page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

/** Turns every tool off: Escape drops what a tool holds, a second leaves it. */
async function noTool(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const on = await page
      .locator("#road-tool, #upgrade-tool, #bulldoze-tool, #grid-tool, #zone-tool")
      .evaluateAll((els) => els.some((e) => e.getAttribute("aria-pressed") === "true"));
    if (!on) return;
    await page.keyboard.press("Escape");
    await frames(page);
  }
  throw new Error("a tool stayed on");
}

/** Zones each of `strips` with the zone tool's fill, `depth` cells deep, one ZoneCells each, or erases them with `zone` "erase". */
async function zoneStrips(page: Page, strips: readonly Strip[], zone: string, density: number, depth: number): Promise<void> {
  if ((await page.locator("#zone-tool").getAttribute("aria-pressed")) !== "true") {
    await noTool(page);
    await page.keyboard.press("KeyK");
  }
  await expect(page.locator("#zone-menu")).toBeVisible();
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  if (zone === "erase") {
    await page.locator("#zone-erase").click();
    await expect(page.locator("#zone-erase")).toHaveAttribute("aria-pressed", "true");
  } else {
    await page.locator(`#zone-${zone}`).click();
    await expect(page.locator(`#zone-${zone}`)).toHaveAttribute("aria-pressed", "true");
    await page.locator(`#zone-density-${density}`).click();
  }
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

/** The zone and density of the first cell of `strip` in the copy. */
async function stripZone(page: Page, strip: Strip): Promise<{ zone: number; density: number }> {
  const [x, z] = stripCell(strip);
  const cell = await page.evaluate(([x, z]) => {
    const m = window.cityCouncil.mirror;
    const c = m.cellAt(x, z);
    return c ? { zone: m.state?.cells["zone"]?.[c.index] ?? 0, density: m.state?.cells["density"]?.[c.index] ?? 0 } : null;
  }, [x, z] as const);
  if (!cell) throw new Error(`no cell at (${x}, ${z})`);
  return cell;
}

/** The key of `strip`'s run of cells, as `Building.strip` holds it. */
async function stripKey(page: Page, strip: Strip): Promise<string> {
  const [x, z] = stripCell(strip);
  const cell = await page.evaluate(([x, z]) => window.cityCouncil.mirror.cellAt(x, z), [x, z] as const);
  if (!cell) throw new Error(`no cell at (${x}, ${z})`);
  return `${cell.segment}/${cell.side}`;
}

/** Every building standing in the copy, with its people, room, jobs and jobs filled. */
async function buildings(page: Page): Promise<Building[]> {
  return page.evaluate(() => {
    const s = window.cityCouncil.mirror.state;
    if (!s) return [];
    const b = s.buildings;
    const flags = b["flags"] ?? [];
    const out: Building[] = [];
    for (let id = 0; id < flags.length; id++) {
      if (((flags[id] ?? 0) & 1) === 0) continue;
      out.push({
        id,
        zone: b["zone"]?.[id] ?? 0,
        density: b["density"]?.[id] ?? 0,
        strip: `${b["firstSeg"]?.[id] ?? 0}/${b["firstSide"]?.[id] ?? 0}`,
        builtAt: b["builtAt"]?.[id] ?? 0,
        people: window.cityCouncil.mirror.buildingPeople(id),
        residents: b["residents"]?.[id] ?? 0,
        filled: window.cityCouncil.mirror.jobsFilled(id),
      });
    }
    return out;
  });
}

const ofZone = (bs: readonly Building[], zone: number, density?: number): Building[] => bs.filter((b) => b.zone === zone && (density === undefined || b.density === density));

/** A demand bar as the top bar shows it. */
async function bar(page: Page, name: Bar): Promise<number> {
  return Number(await page.locator(`#demand-${name}`).getAttribute("data-value"));
}

/** The four bars and the population as the top bar shows them, checked against the copy. */
async function topBar(page: Page): Promise<{ population: number; trend: string } & Record<Bar, number>> {
  const s = await page.evaluate(() => {
    const st = window.cityCouncil.mirror.state;
    return st ? { population: st.stats.totals["population"] ?? 0, demand: st.demand } : null;
  });
  if (!s) throw new Error("no state");
  await expect(page.locator("#population-count")).toHaveText(s.population.toLocaleString("en-US"));
  for (const name of ["residential", "commercial", "office", "industrial"] as const) {
    await expect(page.locator(`#demand-${name}`)).toHaveAttribute("data-value", String(s.demand[name].value));
  }
  return {
    population: s.population,
    trend: (await page.locator("#population-trend").getAttribute("data-trend")) ?? "",
    residential: s.demand.residential.value,
    commercial: s.demand.commercial.value,
    office: s.demand.office.value,
    industrial: s.demand.industrial.value,
  };
}

/** The population the top bar shows. */
async function population(page: Page): Promise<number> {
  return Number(((await page.locator("#population-count").textContent()) ?? "").replace(/,/g, ""));
}

async function stats(page: Page): Promise<MirrorState["stats"]> {
  const s = await page.evaluate(() => window.cityCouncil.mirror.state?.stats);
  if (!s) throw new Error("no state");
  return s;
}

/**
 * Runs the game at 4x until `done` holds, at most `maxTicks` ticks, then
 * pauses. The worker's clock is held meanwhile and stepped `chunk` ticks at
 * a time, so how far the city grows before `done` is read does not depend
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

/** Points at building `id` with no tool on and returns the readout's figures and text. */
async function readout(page: Page, id: number): Promise<Record<string, string>> {
  await noTool(page);
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  await look(page, top.x, top.z, 160);
  await settleBuilt(page);
  await hoverBuilding(page, id);
  const r = page.locator("#building-readout");
  await expect(r).toBeVisible();
  await expect(r).toHaveAttribute("data-building", String(id));
  const out: Record<string, string> = { text: (await r.innerText()).replace(/\s+/g, " ") };
  for (const name of ["use", "people", "residents", "jobs", "filled"]) out[name] = (await r.getAttribute(`data-${name}`)) ?? "";
  return out;
}

/** Each building's use as the copy's flags have it, as `view.buildingUse` reads it once drawn: 0 in use, 1 vacant, 2 abandoned. */
async function usesOf(page: Page, ids: readonly number[]): Promise<number[]> {
  return page.evaluate((ids) => {
    const flags = window.cityCouncil.mirror.state?.buildings["flags"] ?? [];
    // BUILDING_VACANT is 2 and BUILDING_ABANDONED 4 in the sim's flags.
    return ids.map((id) => ((flags[id] ?? 0) & 4 ? 2 : (flags[id] ?? 0) & 2 ? 1 : 0));
  }, ids);
}

/** Waits until the view draws building `id` in the use the copy has for it, for a screenshot. */
async function drawnAs(page: Page, id: number, use: number): Promise<void> {
  await expect.poll(() => page.evaluate(async (id) => (await window.cityCouncil.view).buildingUse(id), id), { timeout: 60_000 }).toBe(use);
}

/** Drags the bulldozer over every building on `strip`, roof to roof from west to east, in one stroke: one BulldozeBuilding. Returns how many it covered. */
async function bulldozeAlong(page: Page, strip: Strip): Promise<number> {
  await noTool(page);
  const key = await stripKey(page, strip);
  const ids = (await buildings(page)).filter((b) => b.strip === key).map((b) => b.id);
  if (ids.length === 0) return 0;
  const [x, z] = stripCell(strip, 1);
  await look(page, x, z, 360);
  await settleBuilt(page);
  const tops = await page.evaluate(async (ids) => {
    const view = await window.cityCouncil.view;
    return ids.map((id) => view.buildingTop(id));
  }, ids);
  const points: { x: number; y: number }[] = [];
  for (const top of tops.filter((t) => t !== null).sort((p, q) => p.x - q.x)) points.push(await screenAt(page, top.x, top.z, top.y - 1));
  await page.keyboard.press("KeyB");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  const before = (await log(page)).length;
  const [first, ...rest] = points;
  if (!first) throw new Error("no building on the strip is drawn");
  await page.mouse.move(first.x, first.y, { steps: 4 });
  await frames(page, 3);
  await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-kind", "building");
  await page.mouse.down();
  for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 6 });
  await frames(page, 3);
  await page.mouse.up();
  await expect.poll(async () => (await log(page)).length).toBe(before + 1);
  expect((await log(page)).at(-1)?.type).toBe("BulldozeBuilding");
  await noTool(page);
  return ids.length;
}

/** Opens a city in `page` and checks it drew on the backend the variant asks for. */
async function openOn(page: Page, info: TestInfo, city: Parameters<typeof openCity>[1], variant: { name: string; query: string }, name: string): Promise<void> {
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

let redevelopmentBuilt: ReturnType<typeof redevelopmentCity> | null = null;
/** Step 11's city, built once per worker. */
const redevelopment = (): ReturnType<typeof redevelopmentCity> => (redevelopmentBuilt ??= redevelopmentCity());
let abandonmentBuilt: ReturnType<typeof abandonmentCity> | null = null;
/** Step 9's abandonment city, built once per worker. */
const abandonment = (): ReturnType<typeof abandonmentCity> => (abandonmentBuilt ??= abandonmentCity());

for (const variant of [
  { name: "webgpu", query: "" },
  { name: "webgl", query: "?webgl" },
] as const) {
  test(`M3 walkthrough (${variant.name})`, async ({ page, browser }, info) => {
    const dir = `m3-${variant.name}`;
    await openOn(page, info, townCity(), variant, "M3 walkthrough");
    expect(await buildings(page)).toEqual([]);
    await lookAtTown(page);

    await test.step("1. zone R1 along streets joined to an outside connection: the residential bar is above zero, houses grow, and the population counts up from zero with its arrow up", async () => {
      const start = await topBar(page);
      expect(start.population).toBe(0);
      // The pull from outside holds the bar above zero in an empty city.
      expect(start.residential).toBeGreaterThan(0);
      await zoneStrips(page, HOUSES, "residential", 1, 6);
      await away(page);
      await shot(page, info, dir, "1-zoned-r1");
      const counts: number[] = [];
      await growUntil(
        page,
        "houses and people, the arrow up",
        async () => ({ houses: ofZone(await buildings(page), RESIDENTIAL).length, population: await population(page), trend: (await page.locator("#population-trend").getAttribute("data-trend")) ?? "" }),
        (v) => v.houses >= 20 && v.population >= 100 && v.trend === "up",
        6_000,
        50,
        (v) => counts.push(v.population),
      );
      // Counted up from zero and never down on the way.
      expect(counts[0]).toBe(0);
      for (let i = 1; i < counts.length; i++) expect(counts[i] ?? 0, `population read ${i}`).toBeGreaterThanOrEqual(counts[i - 1] ?? 0);
      const now = await topBar(page);
      expect(now.trend).toBe("up");
      expect(now.residential).toBeGreaterThan(0);
      await settleBuilt(page);
      await shot(page, info, dir, "1-houses-and-population");
      info.annotations.push({ type: "step 1", description: `population ${now.population}, residential bar ${now.residential.toFixed(1)}` });
    });

    await test.step("2. all residential: unemployment rises, the residential bar falls below zero, building stops and some pops leave; the bar's tooltip says why", async () => {
      const left = (await stats(page)).year["departures"] ?? 0;
      await growUntil(
        page,
        "the stall",
        async () => ({ bar: await bar(page, "residential"), departures: (await stats(page)).year["departures"] ?? 0, unemployed: (await stats(page)).totals["workersUnemployed"] ?? 0 }),
        // At -1 or below, so the tooltip's rounded figure is negative too.
        (v) => v.bar <= -1 && v.departures > left,
        12_000,
        100,
      );
      const s = await stats(page);
      expect(s.totals["workersUnemployed"] ?? 0).toBeGreaterThan(0);
      expect(s.totals["workersEmployed"] ?? 0).toBe(0);
      // The tooltip names unemployment as what holds the bar down.
      await page.locator("#demand-residential").hover();
      const tip = page.locator("#demand-residential [role=tooltip]");
      await expect(tip).toHaveText(/^Residential demand -\d+\./);
      await expect(tip).toContainText("Unemployment -");
      await shot(page, info, dir, "2-stalled-tooltip");
      await away(page);
      // Building stops: a game week on, with the bar still below zero, no new house.
      const houses = ofZone(await buildings(page), RESIDENTIAL).length;
      await page.evaluate(() => window.cityCouncil.holdClock());
      await heldSpeed(page, "4x");
      let stalledDays = 0;
      for (let d = 0; d < 7; d++) {
        await page.evaluate((n) => window.cityCouncil.advance(n), DAY);
        if ((await bar(page, "residential")) >= 0) break;
        expect(ofZone(await buildings(page), RESIDENTIAL).length, `houses on stalled day ${d + 1}`).toBe(houses);
        stalledDays++;
      }
      expect(stalledDays, "game days the bar stayed below zero").toBeGreaterThan(0);
      await heldSpeed(page, "Pause");
      await page.evaluate(() => window.cityCouncil.releaseClock());
      info.annotations.push({ type: "step 2", description: `${s.totals["workersUnemployed"]} unemployed, ${s.year["departures"]} departures this year` });
    });

    await test.step("3. zone commercial and industrial ground: shops and factories grow, pops take the jobs, and the residential bar comes back above zero", async () => {
      await zoneStrips(page, SHOP_STRIPS, "commercial", 1, 6);
      await zoneStrips(page, FACTORY_STRIPS, "industrial", 1, 6);
      await growUntil(
        page,
        "shops, factories and workers",
        async () => {
          const bs = await buildings(page);
          return { shops: ofZone(bs, COMMERCIAL).length, factories: ofZone(bs, INDUSTRIAL).length, employed: (await stats(page)).totals["workersEmployed"] ?? 0, bar: await bar(page, "residential") };
        },
        (v) => v.shops > 0 && v.factories > 0 && v.employed > 50 && v.bar > 0,
        6_000,
      );
      await settleBuilt(page);
      await away(page);
      await shot(page, info, dir, "3-shops-factories-jobs");
    });

    await test.step("4. zone office ground: small offices grow from the start", async () => {
      expect(await bar(page, "office")).toBeGreaterThan(0);
      await zoneStrips(page, [OFFICE_STRIP], "office", 1, 5);
      const key = await stripKey(page, OFFICE_STRIP);
      await growUntil(page, "an office", async () => (await buildings(page)).filter((b) => b.strip === key && b.zone === OFFICE), (v) => v.length > 0, 3_000);
      const offices = (await buildings(page)).filter((b) => b.strip === key);
      expect(offices.every((b) => b.zone === OFFICE && b.density === 1)).toBe(true);
      await settleBuilt(page);
      await shot(page, info, dir, "4-offices");
    });

    await test.step("5. zone mixed ground: it builds only while the residential and commercial bars are both above zero", async () => {
      await zoneStrips(page, [MIXED_STRIP], "mixed", 1, 5);
      const key = await stripKey(page, MIXED_STRIP);
      // Each read: the bars and the mixed buildings. A new one may only come in a chunk that started with both bars above zero.
      let last: { r: number; c: number; ids: number[] } | null = null;
      const checked: string[] = [];
      await growUntil(
        page,
        "a mixed building",
        async () => ({ r: await bar(page, "residential"), c: await bar(page, "commercial"), ids: (await buildings(page)).filter((b) => b.strip === key && b.zone === MIXED).map((b) => b.id) }),
        (v) => v.ids.length >= 1,
        6_000,
        25,
        (v) => {
          if (last && v.ids.length > last.ids.length) {
            checked.push(`R ${last.r.toFixed(1)} to ${v.r.toFixed(1)}, C ${last.c.toFixed(1)} to ${v.c.toFixed(1)}`);
            expect(Math.min(last.r, last.c), "a mixed building grew with a bar at or below zero").toBeGreaterThan(0);
          }
          last = v;
        },
      );
      expect(checked.length).toBeGreaterThan(0);
      await settleBuilt(page);
      await shot(page, info, dir, "5-mixed");
      info.annotations.push({ type: "step 5", description: checked.join("; ") });
    });

    await test.step("6. zone an empty R3 lot of 4 x 4 or more: a tower grows there as soon as residential demand is above zero, with no density 1 or 2 building first", async () => {
      expect(await bar(page, "residential")).toBeGreaterThan(0);
      await zoneStrips(page, [TOWER_STRIP], "residential", 3, 5);
      const key = await stripKey(page, TOWER_STRIP);
      const seen = new Set<number>();
      await growUntil(
        page,
        "a tower",
        async () => (await buildings(page)).filter((b) => b.strip === key),
        (v) => v.some((b) => b.density === 3),
        3_000,
        25,
        (v) => {
          for (const b of v) {
            seen.add(b.id);
            expect(b.density, `building ${b.id} on the R3 lot`).toBe(3);
          }
        },
      );
      await settleBuilt(page);
      await shot(page, info, dir, "6-tower");
    });

    await test.step("7. two strips, one by the water and one beside factories: the land value overlay shows the first worth more, and it fills first", async () => {
      await zoneStrips(page, [SHORE_STRIP, FACTORY_SIDE_STRIP], "residential", 1, 4);
      await look(page, (XM + X1) / 2, (MAIN + SHORE) / 2, 620);
      await page.locator("#overlay-landValue").click();
      await expect.poll(() => page.evaluate(() => document.body.dataset["overlay"] ?? "")).toBe("landValue");
      const valueAt = async (strip: Strip) => {
        const [x, z] = stripCell(strip, 1);
        await look(page, x, z, 320);
        await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
        await hover(page, x, z);
        const r = page.locator("#land-value-readout");
        await expect(r).toBeVisible();
        return Number(await r.getAttribute("data-value"));
      };
      const shore = await valueAt(SHORE_STRIP);
      await shot(page, info, dir, "7-land-value-by-the-water");
      const factories = await valueAt(FACTORY_SIDE_STRIP);
      expect(shore).toBeGreaterThan(factories);
      await shot(page, info, dir, "7-land-value-beside-factories");
      await away(page);
      await page.locator("#overlay-landValue").click();
      await lookAtTown(page);
      const shoreKey = await stripKey(page, SHORE_STRIP);
      const factoryKey = await stripKey(page, FACTORY_SIDE_STRIP);
      const v = await growUntil(
        page,
        "houses by the water",
        async () => {
          const bs = await buildings(page);
          return { shore: bs.filter((b) => b.strip === shoreKey).length, factories: bs.filter((b) => b.strip === factoryKey).length };
        },
        (v) => v.shore >= 3,
        6_000,
      );
      expect(v.shore).toBeGreaterThan(v.factories);
      await settleBuilt(page);
      await shot(page, info, dir, "7-shore-fills-first");
      info.annotations.push({ type: "step 7", description: `land value ${shore} by the water, ${factories} beside factories; houses ${v.shore} and ${v.factories}` });
    });

    await test.step("8. point at a house: the readout gives the people living there against its room; at a shop: jobs filled against jobs offered", async () => {
      await lookAtTown(page);
      await settleBuilt(page);
      const bs = await buildings(page);
      const house = ofZone(bs, RESIDENTIAL, 1).find((b) => b.people > 0);
      const shop = ofZone(bs, COMMERCIAL).find((b) => b.filled > 0);
      if (!house || !shop) throw new Error("no lived-in house or staffed shop");
      const h = await readout(page, house.id);
      expect(h["people"]).toBe(String(house.people));
      expect(h["residents"]).toBe(String(house.residents));
      expect(h["text"]).toContain(`${house.people}/${house.residents} residents`);
      await shot(page, info, dir, "8-house-readout");
      const s = await readout(page, shop.id);
      expect(s["filled"]).toBe(String(shop.filled));
      const jobs = Number(s["jobs"]);
      expect(jobs).toBeGreaterThanOrEqual(shop.filled);
      expect(s["text"]).toContain(`${shop.filled}/${jobs} jobs`);
      await shot(page, info, dir, "8-shop-readout");
      await away(page);
    });

    await test.step("10. bulldoze an occupied house while other homes have room: its pops move into them and the population does not drop", async () => {
      const bs = await buildings(page);
      const room = bs.filter((b) => b.zone === RESIDENTIAL || b.zone === MIXED).reduce((n, b) => n + b.residents - b.people, 0);
      // An occupied house that fits the room left elsewhere, and that the pointer reaches: a tower can stand in front of one.
      const candidates = ofZone(bs, RESIDENTIAL, 1).filter((b) => b.people > 0 && b.people <= room - b.residents);
      const before = await population(page);
      let house: Building | null = null;
      for (const c of candidates.slice(0, 8)) {
        const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), c.id);
        if (!top) continue;
        await noTool(page);
        await look(page, top.x, top.z, 160);
        await settleBuilt(page);
        await page.keyboard.press("KeyB");
        await hoverBuilding(page, c.id);
        if ((await page.locator("#bulldoze-tag").getAttribute("data-ids")) === String(c.id)) {
          house = c;
          break;
        }
      }
      if (!house) throw new Error(`no occupied house the pointer reaches that fits the room left (${room})`);
      await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-kind", "building");
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(async () => (await log(page)).at(-1)?.type).toBe("BulldozeBuilding");
      await noTool(page);
      // Run at 4x: paused, the step applies the command but runs no system, so the displaced pass needs the clock.
      // A few ticks, so turnover and arrivals have little room to hide anyone leaving.
      const left = (await stats(page)).year["departures"] ?? 0;
      await page.evaluate(() => window.cityCouncil.holdClock());
      await heldSpeed(page, "4x");
      await page.evaluate(() => window.cityCouncil.advance(10));
      await heldSpeed(page, "Pause");
      await page.evaluate(() => window.cityCouncil.releaseClock());
      expect((await buildings(page)).some((b) => b.id === house.id && b.builtAt === house.builtAt)).toBe(false);
      const gone = ((await stats(page)).year["departures"] ?? 0) - left;
      expect(gone, `departures while ${house.people} people were rehoused`).toBeLessThan(house.people);
      expect(await population(page)).toBeGreaterThanOrEqual(before - gone);
      expect(await population(page)).toBeGreaterThanOrEqual(before - 1);
      await shot(page, info, dir, "10-house-cleared-people-stay");
      info.annotations.push({ type: "step 10", description: `house ${house.id} of ${house.people} people cleared; population ${before} then ${await population(page)}` });
    });

    await test.step("11. rezone built R1 ground to R3 while residential demand is high: a house there is replaced by a tower, and its pops find other homes", async () => {
      // A context of its own, so the town's saves and reload are untouched (see the top of the file).
      const context = await browser.newContext({ ...devices["Desktop Chrome"], viewport: VIEWPORT, storageState: PLAYER_STATE, ...(info.project.use.baseURL ? { baseURL: info.project.use.baseURL } : {}) });
      const other = await context.newPage();
      const city = redevelopment();
      await openOn(other, info, city.bytes, variant, "M3 walkthrough, redevelopment");
      const r = await bar(other, "residential");
      expect(r).toBeGreaterThan(15);
      // The ground is zoned R3 under standing houses.
      expect(await stripZone(other, REZONED)).toEqual({ zone: RESIDENTIAL, density: 3 });
      const key = await stripKey(other, REZONED);
      const houses = (await buildings(other)).filter((b) => b.strip === key && b.density === 1);
      expect(houses.length).toBeGreaterThan(3);
      await look(other, ...stripCell(REZONED), 260);
      await settleBuilt(other);
      await shot(other, info, dir, "11-before-redevelopment");
      const before = await population(other);
      const leftBefore = (await stats(other)).year["departures"] ?? 0;
      const tower = await growUntil(other, "a tower in place of a house", async () => (await buildings(other)).filter((b) => b.strip === key && b.density === 3), (v) => v.length > 0, 2 * DAY, 10);
      const after = (await buildings(other)).filter((b) => b.strip === key);
      const gone = houses.filter((h) => !after.some((b) => b.id === h.id && b.builtAt === h.builtAt));
      expect(gone.length).toBeGreaterThan(0);
      // Its pops found other homes: everyone who lived in the houses it replaced is still in the city, give or take the day's turnover.
      const housed = gone.reduce((n, h) => n + h.people, 0);
      const now = await population(other);
      const departed = ((await stats(other)).year["departures"] ?? 0) - leftBefore;
      expect(housed).toBeGreaterThan(0);
      // Nobody left the city for want of a home: fewer departures in the day than the people moved, and the population held.
      expect(departed, `departures while ${housed} people were moved`).toBeLessThan(housed);
      expect(now, `${housed} people were in the houses replaced`).toBeGreaterThanOrEqual(before - departed);
      await look(other, ...stripCell(REZONED), 260);
      await settleBuilt(other);
      await shot(other, info, dir, "11-tower");
      info.annotations.push({ type: "step 11", description: `rezoned on day ${city.rezonedOnDay}; tower ${tower[0]?.id} in place of ${gone.length} houses of ${housed} people; population ${before} then ${now}` });
      await context.close();
    });

    await test.step("9. bulldoze the workplaces: pops lose their jobs, then leave; homes stand vacant, then abandoned, and look it; the population falls and the arrow points down", async () => {
      await lookAtTown(page);
      await settleBuilt(page);
      const leftBefore = (await stats(page)).year["departures"] ?? 0;
      const yearBefore = (await page.evaluate(() => window.cityCouncil.mirror.state?.tick)) ?? 0;
      const workplaces = [...SHOP_STRIPS, ...FACTORY_STRIPS, OFFICE_STRIP, MIXED_STRIP];
      // A stroke can miss a building hidden behind a taller one, so each strip is swept until nothing stands on it.
      for (const strip of workplaces) for (let k = 0; k < 4 && (await bulldozeAlong(page, strip)) > 0; k++);
      // Their ground unzoned, so they do not grow back.
      await zoneStrips(page, workplaces, "erase", 1, 6);
      await page.evaluate(() => window.cityCouncil.holdClock());
      await page.evaluate(() => window.cityCouncil.advance(2));
      await page.evaluate(() => window.cityCouncil.releaseClock());
      const bs = await buildings(page);
      expect(bs.filter((b) => b.zone !== RESIDENTIAL).length, "workplaces left").toBe(0);
      expect((await stats(page)).totals["workersEmployed"]).toBe(0);
      const peak = await population(page);
      await shot(page, info, dir, "9-workplaces-gone");
      let sawDown = false;
      let low = peak;
      let vacantIds: number[] = [];
      const read = async () => {
        const ids = (await buildings(page)).map((b) => b.id);
        const uses = await usesOf(page, ids);
        return { vacant: ids.filter((_, k) => uses[k] === VACANT), population: await population(page), trend: (await page.locator("#population-trend").getAttribute("data-trend")) ?? "" };
      };
      await growUntil(
        page,
        "people leaving and homes vacant",
        read,
        (v) => v.vacant.length >= 1 && sawDown && v.population < peak,
        12_000,
        100,
        (v) => {
          if (v.trend === "down") sawDown = true;
          low = Math.min(low, v.population);
          vacantIds = v.vacant;
        },
      );
      expect(low).toBeLessThan(peak);
      expect(sawDown).toBe(true);
      // Departures since the bulldoze, across a year's end if the wait crossed one.
      const after = await stats(page);
      const crossed = Math.floor(((await page.evaluate(() => window.cityCouncil.mirror.state?.tick)) ?? 0) / YEAR) > Math.floor(yearBefore / YEAR);
      const departed = crossed ? (after.lastYear["departures"] ?? 0) - leftBefore + (after.year["departures"] ?? 0) : (after.year["departures"] ?? 0) - leftBefore;
      expect(departed, "people who left after the workplaces went").toBeGreaterThan(0);
      const vacantId = vacantIds[0];
      if (vacantId === undefined) throw new Error("no vacant home");
      const v = await readout(page, vacantId);
      expect(v["use"]).toBe("vacant");
      await drawnAs(page, vacantId, VACANT);
      expect(v["text"]).toContain("Vacant");
      // How it looks: the view draws it in its disuse shade (buildingUse), which the screenshot shows.
      await shot(page, info, dir, "9-vacant");
      await away(page);

      // Abandonment comes 90 game days of vacancy later, with the residential bar at or below zero. In this town the
      // pull from outside refills homes while it has under 500 residents, so the wait runs on a city built in Node
      // the same way, a game day short of its first abandoned home, in a context of its own.
      const context = await browser.newContext({ ...devices["Desktop Chrome"], viewport: VIEWPORT, storageState: PLAYER_STATE, ...(info.project.use.baseURL ? { baseURL: info.project.use.baseURL } : {}) });
      const other = await context.newPage();
      await openOn(other, info, abandonment().bytes, variant, "M3 walkthrough, abandonment");
      // Next to no work: a shop may have grown on a cell at a strip's end that the erase left zoned.
      const t = (await stats(other)).totals;
      expect(t["workersEmployed"] ?? 0, "workers in jobs").toBeLessThan((t["workersUnemployed"] ?? 0) / 4);
      expect(await bar(other, "residential")).toBeLessThanOrEqual(0);
      const uses = async () => {
        const ids = (await buildings(other)).map((b) => b.id);
        const u = await usesOf(other, ids);
        return { vacant: ids.filter((_, k) => u[k] === VACANT), abandoned: ids.filter((_, k) => u[k] === ABANDONED) };
      };
      const before = await uses();
      expect(before.abandoned).toEqual([]);
      expect(before.vacant.length).toBeGreaterThan(0);
      const later = await growUntil(other, "a home abandoned", uses, (v) => v.abandoned.length > 0, 2 * DAY, 10);
      // Each one abandoned stood vacant the day before.
      for (const id of later.abandoned) expect(before.vacant, `home ${id} was vacant first`).toContain(id);
      const abandonedId = later.abandoned[0] ?? -1;
      const a = await readout(other, abandonedId);
      expect(a["use"]).toBe("abandoned");
      await drawnAs(other, abandonedId, ABANDONED);
      expect(a["text"]).toContain("Abandoned");
      await shot(other, info, dir, "9-abandoned");
      await context.close();
      info.annotations.push({ type: "step 9", description: `population ${peak} at its peak, ${low} at its lowest, ${departed} departures; in the abandonment city ${later.abandoned.length} abandoned of ${before.vacant.length} vacant` });
    });

    await test.step("12. run some game years at 4x: the statistics panel graphs population over time and lists births, deaths, arrivals and departures per year", async () => {
      const start = (await page.evaluate(() => window.cityCouncil.mirror.state?.tick)) ?? 0;
      await growUntil(page, "two game years", async () => (await page.evaluate(() => window.cityCouncil.mirror.state?.tick)) ?? 0, (t) => t >= start + 2 * YEAR, 2 * YEAR + 1000, 1000);
      await page.locator("#stats-toggle").click();
      await expect(page.locator("#stats-panel")).toBeVisible();
      await expect(page.locator("#stats-graph")).toHaveAttribute("data-series", "population");
      // A sample a game month: well over the twelve of a year.
      expect(Number(await page.locator("#stats-graph").getAttribute("data-samples"))).toBeGreaterThan(24);
      const s = await stats(page);
      for (const what of YEAR_COUNTS) {
        await expect(page.locator(`#stats-${what}-last`)).toHaveText((s.lastYear[what] ?? 0).toLocaleString("en-US"));
        await expect(page.locator(`#stats-${what}-now`)).toHaveText((s.year[what] ?? 0).toLocaleString("en-US"));
      }
      expect(Object.values(s.lastYear).some((n) => n > 0)).toBe(true);
      await shot(page, info, dir, "12-statistics");
      await page.locator("#stats-toggle").click();
      info.annotations.push({ type: "step 12", description: `last year: ${YEAR_COUNTS.map((w) => `${w} ${s.lastYear[w]}`).join(", ")}` });
    });

    await test.step("13. place a road, paint a zone, bulldoze and try something the sim rejects: each makes its sound; with the interface volume at zero they stop", async () => {
      const cues = () => page.evaluate(() => window.cityCouncil.sound.cues().map((c) => ({ cue: c.cue, outcome: c.outcome })));
      await page.evaluate(() => window.cityCouncil.sound.clear());
      await look(page, (XM + X1) / 2, (UPPER + SHORE) / 2, 300);
      const start = (await log(page)).length;
      // A road between the upper and shore streets, east of the spine.
      await noTool(page);
      await page.keyboard.press("KeyR");
      await click(page, 600, UPPER + HALF + 1);
      await click(page, 600, SHORE - HALF - 1);
      await expect.poll(async () => (await log(page)).length).toBe(start + 1);
      await noTool(page);
      // A zone along it.
      await zoneStrips(page, [{ z: UPPER, piece: "east", side: "south" }], "commercial", 1, 2);
      // A bulldoze of the new road.
      await page.keyboard.press("KeyB");
      await click(page, 600, (UPPER + SHORE) / 2);
      await expect.poll(async () => (await log(page)).length).toBe(start + 3);
      await noTool(page);
      // A command the sim refuses: a road with no points.
      expect((await page.evaluate(() => window.cityCouncil.sendCommand("BuildRoad", {}))).ok).toBe(false);
      await expect.poll(async () => (await cues()).map((c) => c.cue)).toEqual(["road", "zone", "bulldoze", "reject"]);
      expect((await cues()).every((c) => c.outcome === "played")).toBe(true);
      await openSettings(page);
      await page.locator("#sound-interface").fill("0");
      await expect(page.locator("#sound-interface")).toHaveValue("0");
      expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem("city-council:sound"))) ?? "null")).toMatchObject({ interface: 0 });
      await shot(page, info, dir, "13-interface-volume-zero");
      await page.locator("#settings-toggle").click();
      await page.evaluate(() => window.cityCouncil.sound.clear());
      expect((await page.evaluate(() => window.cityCouncil.sendCommand("BuildRoad", {}))).ok).toBe(false);
      await expect.poll(cues).toEqual([{ cue: "reject", outcome: "silent" }]);
    });

    let saved = { hash: "", tick: 0, log: [] as LogEntry[] };
    await test.step("14. reload the page: the same pops, jobs, demand bars, population and history come back, and the interface volume is still zero", async () => {
      const menu = await cityMenu(page);
      const tick = Number(await page.locator("#sim-tick").textContent());
      await menu.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("#save-status")).toContainText(`tick ${tick} at`);
      await closeCityMenu(page);
      const before = { top: await topBar(page), stats: await stats(page), buildings: await buildings(page), city: await page.evaluate(() => window.cityCouncil.downloadCity()) };
      saved = { hash: before.city.hash, tick: before.city.tick, log: await log(page) };
      const id = (await page.evaluate(() => window.cityCouncil.saves.status))?.city.id;
      await page.reload();
      await cityReady(page);
      await hideNotes(page);
      const status = await page.evaluate(() => window.cityCouncil.saves.status);
      expect(status?.loadedFrom).toBe("latest save");
      expect(status?.city.id).toBe(id);
      expect(status?.loadedTick).toBe(tick);
      // The whole city, pops included, hashes the same.
      expect((await page.evaluate(() => window.cityCouncil.downloadCity())).hash).toBe(before.city.hash);
      expect(await topBar(page)).toEqual(before.top);
      expect(await stats(page)).toEqual(before.stats);
      expect(await buildings(page)).toEqual(before.buildings);
      await openSettings(page);
      await expect(page.locator("#sound-interface")).toHaveValue("0");
      await page.locator("#settings-toggle").click();
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
      const rebuilt = replay(header.seed, fullLog, header.tick);
      const hash = hashState(rebuilt);
      expect(hash).toBe(hashState(state));
      expect(rebuilt.stats.totals).toEqual(state.stats.totals);
      info.annotations.push({ type: "replay", description: `seed ${header.seed}, ${fullLog.length} commands, tick ${header.tick}, population ${state.stats.totals["population"]}, hash ${hash}` });
    });
  });
}

