import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_TYPES, CONNECTION_BALANCE, NONE, ROAD_TYPES, SCALE_TREASURY, TIME_BALANCE, WAITING_PART, ZONING_BALANCE, cityPopulation, connectionEnd, createState, demandPull, fundCity, generateTerrain, heightAt, reachableRoom, step, syncCells, unfilledHomesAllowed, waitingShares, yearDays, type SimState } from "../packages/sim/src/index";
import { formatDemandTitle } from "../packages/client/src/ui/top-figures";
import { CITIES, Player, SEED as BALANCE_SEED } from "../packages/sim/test/balance/cities";
import { buildEverySide, finishConstruction, zoneSides } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity, ready, settingsButton } from "./helpers";

// Issue M3-15: population and demand, in the bottom left corner since #332. A player paints R1
// along a street that runs from an outside connection, lets houses grow and
// people move in, and watches the population rise with its arrow up. The
// residential bar's value and tooltip are read and checked against the
// page's copy of the sim's state, and every figure survives a reload. A
// second city has the same street a gap short of the connection: houses
// grow, nobody can reach them, and the population stays at 0, level.
//
// Each city is one street built in Node with the sim and opened as a city
// file, with nothing zoned. No demand is held: the outside pull lifts the
// residential bar on its own (demand.json, `outsidePull`).
//
// Issue #330: a third city has six empty towers facing office towers, the
// residential bar well above zero. While the towers fill the grower adds no
// home, and the bar's tooltip says so; once fewer than `unfilledHomesAllowed`
// are still filling, the line goes. Since #420 the bar's last part takes
// away what the filling homes hold back, so the steps read the bar without
// it, its pull, which is what the line needs above zero.

type Vec3 = readonly [number, number, number];
interface Bar {
  value: number;
  parts: Record<string, number>;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: {
      room: number | null;
      homesWaiting(): { capacity: number; empty: number; unfilled: number } | null;
      waitingFor(bar: string): number | null;
      state: {
        tick: number;
        log: { type: string }[];
        stats: { totals: Record<string, number> };
        demand: Record<string, Bar>;
        buildings: { flags: Uint8Array; residents: Int32Array };
      } | null;
    };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const terrain = generateTerrain(SEED);
const HALF = (ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0) / 2;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["POPULATION_EVIDENCE_DIR"];
/** The street's length: twelve cells of 16 m. */
const LENGTH = 192;

interface Street {
  /** Where it starts, at the connection's inner end or a gap short of it. */
  x: number;
  z: number;
  /** The way it runs, a unit vector. */
  dx: number;
  dz: number;
}

/** A city with one street running on from the first outside connection, or, `joined` false, starting 48 m short of it, `length` metres long. */
function streetCity(joined: boolean, length = LENGTH): { state: SimState; street: Street } {
  const state = createState(SEED);
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const gap = joined ? 0 : 48;
  const x = (r.nodeX[inner] ?? 0) + dx * gap;
  const z = (r.nodeZ[inner] ?? 0) + dz * gap;
  buildRoads(state, [[[x, z], [x + dx * length, z + dz * length], "street"]]);
  return { state, street: { x, z, dx, dz } };
}

/** A point `along` metres down the street and `off` metres to its left. */
function on(s: Street, along: number, off: number): [number, number] {
  return [s.x + s.dx * along - s.dz * off, s.z + s.dz * along + s.dx * off];
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

/** The population the city status card shows, as a number, or the text when it is not one. */
async function shown(page: Page): Promise<number | string> {
  const text = (await page.locator("#population-count").textContent()) ?? "";
  const n = Number(text.replace(/,/g, ""));
  return text !== "" && Number.isFinite(n) ? n : text;
}

/** What the page's copy of the sim's state holds: population, room counted in full, and the residential bar. */
async function copy(page: Page): Promise<{ population: number; room: number; mirrorRoom: number | null; residential: Bar }> {
  return page.evaluate(([alive, abandoned]) => {
    const s = window.cityCouncil.mirror.state;
    if (!s) throw new Error("no state");
    let room = 0;
    // Alive and not abandoned, as the sim's homeRoom has it.
    s.buildings.flags.forEach((f, id) => {
      if ((f & alive) !== 0 && (f & abandoned) === 0) room += s.buildings.residents[id] ?? 0;
    });
    const bar = s.demand["residential"];
    if (!bar) throw new Error("no residential bar");
    return { population: s.stats.totals["population"] ?? 0, room, mirrorRoom: window.cityCouncil.mirror.room, residential: { value: bar.value, parts: { ...bar.parts } } };
  }, [BUILDING_ALIVE, BUILDING_ABANDONED] as const);
}

/** The residential bar without its part for homes still filling (#420): what newcomers and the grower read. */
function pullOf(bar: Bar): number {
  return bar.value - (bar.parts[WAITING_PART.residential] ?? 0);
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  expect(await page.evaluate((speed) => window.cityCouncil.sendCommand("SetSpeed", { speed }), speed)).toEqual({ ok: true });
}

/** Checks the city status card against the copy while the city is paused: population, room and the residential bar, value and tooltip. */
async function agrees(page: Page): Promise<Awaited<ReturnType<typeof copy>>> {
  const c = await copy(page);
  expect(c.mirrorRoom).toBe(c.room);
  await expect.poll(() => shown(page)).toBe(c.population);
  await expect(page.locator("#population-count")).toHaveAttribute("data-room", String(c.room));
  const bar = page.locator("#demand-residential");
  await expect(bar).toHaveAttribute("data-value", String(c.residential.value));
  await expect(bar).toHaveAttribute("aria-valuenow", String(Math.round(c.residential.value)));
  await expect(bar).toHaveAttribute("data-tip", formatDemandTitle("residential", c.residential.value, c.residential.parts));
  return c;
}

let shotNo = 0;
async function attach(page: Page, testInfo: TestInfo, name: string, whole = false): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const png = whole ? await page.screenshot() : await page.locator("#city-status").screenshot();
  writeFileSync(path, png);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, png);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Paints R1 along the left side of `s` with the zone tool, in one click. */
async function zoneR1(page: Page, s: Street): Promise<void> {
  const [mx, mz] = on(s, LENGTH / 2, 0);
  await look(page, mx, mz, 260);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  await expect(page.locator("#zone-residential")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zone-density-1")).toHaveAttribute("aria-pressed", "true");
  const [px, pz] = on(s, LENGTH / 2, HALF / 2);
  const p = await screenAt(page, px, pz);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.log.filter((e) => e.type === "ZoneCells").length ?? 0)).toBe(1);
  await page.keyboard.press("KeyK");
  await page.mouse.move(640, 20);
}

test("the city status card shows the population rising with its arrow up, and the residential bar as the sim has it, the same after a reload", async ({ page }, testInfo) => {
  const { state, street } = streetCity(true);
  await openCity(page, state, { name: "Gateway Street" });

  await test.step("a city with nobody in it shows 0, and four demand bars beside it", async () => {
    await setSpeed(page, 0);
    await expect(page.locator("#population-count")).toHaveText("0");
    // In the bottom left corner, the population over the bars (issue #332).
    expect(await page.locator("#city-status > #population + #demand").count()).toBe(1);
    const card = await page.locator("#city-status").boundingBox();
    const viewport = page.viewportSize();
    if (!card || !viewport) throw new Error("the card is not laid out");
    expect(card.x).toBeLessThan(viewport.width / 4);
    expect(card.y + card.height).toBeGreaterThan(viewport.height - 80);
    await expect(page.locator("#demand .demand-bar")).toHaveCount(4);
    // Each bar lies on its side, wide enough to read, with its name and value beside it.
    for (const bar of ["residential", "commercial", "office", "industrial"]) {
      const box = await page.locator(`#demand-${bar} .track`).boundingBox();
      expect(box?.width, bar).toBeGreaterThanOrEqual(80);
      expect(box?.height, bar).toBeLessThanOrEqual(box?.width ?? 0);
      await expect(page.locator(`#demand-${bar} .value`)).not.toHaveText("");
    }
    await agrees(page);
    await attach(page, testInfo, "nobody yet");
  });

  await test.step("paint R1 along the street from the outside connection", async () => {
    await zoneR1(page, street);
  });

  let grown = 0;
  await test.step("houses grow, people move in, and the population rises with its arrow up", async () => {
    await setSpeed(page, 4);
    await expect.poll(async () => Number(await shown(page)), { timeout: 120_000 }).toBeGreaterThanOrEqual(24);
    // At least a day past the first sample, so the arrow has one to compare with.
    await expect(page.locator("#population-trend")).toHaveAttribute("data-trend", "up", { timeout: 60_000 });
    await setSpeed(page, 0);
    const c = await agrees(page);
    grown = c.population;
    expect(c.residential.value).toBeGreaterThan(0);
    await expect(page.locator("#population")).toHaveAttribute("data-tip", new RegExp(`^${c.population.toLocaleString("en-US")} residents in homes with room for ${c.room.toLocaleString("en-US")}\\. Up over the last game month\\.$`));
    // The bar's tooltip says what lifts it, in plain words.
    await expect(page.locator("#demand-residential")).toHaveAttribute("data-tip", /^Residential demand \+\d+\. .*(Newcomers from outside|Open jobs) \+\d+/);
    // Pointing at a bar shows its tooltip at once, beside the card.
    await page.locator("#demand-residential").hover();
    const tip = page.locator("#demand-residential [role=tooltip]");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(/^Residential demand \+\d+\./);
    await attach(page, testInfo, "the residential bar's tooltip", true);
    await page.mouse.move(640, 300);
    await expect(tip).toHaveCount(0);
    await attach(page, testInfo, `a growing city of ${grown}`);
    const [mx, mz] = on(street, LENGTH / 2, 30);
    await look(page, mx, mz, 220);
    await attach(page, testInfo, "the houses and the city status card", true);
  });

  await test.step("a reload shows the same figures", async () => {
    const before = await copy(page);
    await settingsButton(page, "City");
    await page.getByRole("region", { name: "City menu" }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#save-status")).toContainText("(manual)");
    await page.reload();
    await ready(page);
    await expect.poll(() => shown(page), { timeout: 30_000 }).toBe(before.population);
    const after = await agrees(page);
    expect(after).toEqual(before);
    await expect(page.locator("#population-trend")).toHaveAttribute("data-trend", "up");
    await attach(page, testInfo, "the same figures after a reload");
  });
});

test("a street cut off from the outside builds houses but stays empty: population 0, level", async ({ page }, testInfo) => {
  const { state, street } = streetCity(false);
  await openCity(page, state, { name: "Cut-off Street" });
  await setSpeed(page, 0);
  await zoneR1(page, street);
  await setSpeed(page, 4);
  // Houses grow on the outside pull, but no newcomer can reach them.
  await expect.poll(async () => (await copy(page)).room, { timeout: 120_000 }).toBeGreaterThan(0);
  await expect(page.locator("#population-trend")).toHaveAttribute("data-trend", "level", { timeout: 60_000 });
  await setSpeed(page, 0);
  const c = await agrees(page);
  expect(c.population).toBe(0);
  await expect(page.locator("#population")).toHaveAttribute("data-tip", `0 residents in homes with room for ${c.room.toLocaleString("en-US")}. Level over the last game month.`);
  await attach(page, testInfo, "a stalled city");
  const [mx, mz] = on(street, LENGTH / 2, 30);
  await look(page, mx, mz, 220);
  await attach(page, testInfo, "the empty houses and the city status card", true);
});

const DENSITIES = ZONING_BALANCE.densities.length;
const zonePair = (id: string) => ZONING_BALANCE.zones.findIndex((z) => z.id === id) * DENSITIES + DENSITIES - 1;
const RESIDENTIAL = 1 + ZONING_BALANCE.zones.findIndex((z) => z.id === "residential");
/** A street that takes six towers on its left side. */
const TOWER_STREET = 240;

/**
 * Six empty towers on a street from an outside connection, office towers
 * facing them. The offices stand alone for 25 game days first, so their
 * open jobs lift the residential bar well above zero before any home is
 * there, then the towers go in on every lot, so the grower has nowhere to
 * add more and the count of towers still filling only falls.
 */
function towersCity(): { state: SimState; street: Street } {
  const { state, street } = streetCity(true, TOWER_STREET);
  zoneSides(state, 0, [zonePair("residential"), zonePair("office")]);
  syncCells(state);
  const homes: number[] = [];
  state.cells.zone.forEach((z, i) => {
    if (z === RESIDENTIAL) homes.push(i);
  });
  for (const i of homes) state.cells.zone[i] = 0;
  buildEverySide(state);
  for (let t = 0; t < 25 * 100; t++) step(state);
  for (const i of homes) state.cells.zone[i] = RESIDENTIAL;
  const counts = buildEverySide(state);
  const towers = BUILDING_TYPES.filter((t) => t.zone === "residential").reduce((n, t) => n + (counts[t.index] ?? 0), 0);
  if (towers !== 6) throw new Error(`the street took ${towers} towers, not 6`);
  if (reachableRoom(state).unfilled < unfilledHomesAllowed(cityPopulation(state))) throw new Error("the towers do not hold new homes back");
  finishConstruction(state);
  state.speed = 0;
  return { state, street };
}

test("while six towers fill, the residential bar's tooltip says new homes are waiting, and the line goes once they fill (#330)", async ({ page }, testInfo) => {
  const { state, street } = towersCity();
  await openCity(page, state, { name: "Tower Street" });
  const bar = page.locator("#demand-residential");
  const tip = page.locator("#demand-residential [role=tooltip]");
  const waitingLine = /\nNew homes waiting: [\d,]+ empty places to fill first\.$/;

  await test.step("six empty towers and the bar above zero: pointing at the bar shows the line", async () => {
    await setSpeed(page, 0);
    const [mx, mz] = on(street, TOWER_STREET / 2, 0);
    await look(page, mx, mz, 320);
    await page.mouse.move(640, 300);
    // Not counted while the tooltip is closed.
    await expect(bar).not.toHaveAttribute("data-tip", waitingLine);
    await bar.hover();
    const c = await copy(page);
    expect(pullOf(c.residential)).toBeGreaterThan(0);
    const waiting = await page.evaluate(() => window.cityCouncil.mirror.homesWaiting());
    expect(waiting?.unfilled).toBe(6);
    expect(waiting?.empty).toBe(c.room);
    await expect(bar).toHaveAttribute("data-tip", formatDemandTitle("residential", c.residential.value, c.residential.parts, waiting?.empty ?? null));
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(new RegExp(`New homes waiting: ${c.room.toLocaleString("en-US")} empty places to fill first\\.$`));
    // On a line of its own: the rendered text keeps the break only where the tip draws it.
    expect(await tip.evaluate((e) => (e as unknown as { innerText: string }).innerText)).toMatch(/\nNew homes waiting: /);
    await attach(page, testInfo, "six towers filling, new homes waiting", true);
  });

  await test.step("people move in, and once fewer than six towers are still filling the line goes", async () => {
    await page.mouse.move(640, 300);
    await setSpeed(page, 4);
    // Waits on the copy's count, not the tooltip, which drops the line whenever it is closed.
    await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.homesWaiting()), { timeout: 120_000 }).toBeNull();
    await setSpeed(page, 0);
    const c = await copy(page);
    expect(pullOf(c.residential)).toBeGreaterThan(0);
    expect(c.population).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.cityCouncil.mirror.homesWaiting())).toBeNull();
    await bar.hover();
    await expect(tip).toBeVisible();
    await expect(bar).toHaveAttribute("data-tip", formatDemandTitle("residential", c.residential.value, c.residential.parts));
    await expect(tip).not.toHaveText(/New homes waiting/);
    await attach(page, testInfo, `${c.population} people in, nothing waiting`, true);
  });
});

/**
 * Issue #420: the balance check's balanced town after its first game year,
 * built in Node. Its educated workers pull the office bar above zero, while
 * its offices stand with more open jobs than the grower allows, so no office
 * is built. The bar reads near 0, its tooltip names the open office jobs as
 * what holds it, and says new offices are waiting.
 */
function officesHeldCity(): SimState {
  const state = createState(BALANCE_SEED);
  fundCity(state, SCALE_TREASURY);
  const balanced = CITIES.find((c) => c.name === "balanced");
  if (!balanced) throw new Error("no balanced town");
  balanced.setup(new Player(state));
  const year = yearDays() * TIME_BALANCE.ticksPerDay;
  while (state.tick < year) step(state);
  if (waitingShares(state).office !== 1) throw new Error("the grower does not hold offices back");
  if (demandPull(state.demand, "office") < 5) throw new Error(`nothing pulls offices: ${demandPull(state.demand, "office")}`);
  state.speed = 0;
  return state;
}

test("a town whose offices stand with open jobs reads 0 office demand, and its tooltip says new offices are waiting (#420)", async ({ page }, testInfo) => {
  const state = officesHeldCity();
  await openCity(page, state, { name: "Balanced Town" });
  await setSpeed(page, 0);
  await look(page, 5976, 2112, 900);

  await test.step("the office bar reads well under what pulls it, and the tooltip names the open jobs", async () => {
    const office = page.locator("#demand-office");
    await office.hover();
    const bar = await page.evaluate(() => window.cityCouncil.mirror.state?.demand["office"]);
    if (!bar) throw new Error("no office bar");
    const pull = bar.value - (bar.parts[WAITING_PART.office] ?? 0);
    expect(pull).toBeGreaterThan(5);
    expect(bar.value).toBeLessThan(pull / 2);
    const waiting = await page.evaluate(() => window.cityCouncil.mirror.waitingFor("office"));
    expect(waiting).toBeGreaterThan(0);
    await expect(office).toHaveAttribute("data-tip", formatDemandTitle("office", bar.value, bar.parts, waiting));
    const tip = page.locator("#demand-office [role=tooltip]");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Office jobs still open");
    await expect(tip).toHaveText(new RegExp(`New offices waiting: ${(waiting ?? 0).toLocaleString("en-US")} open jobs to fill first\\.$`));
    await attach(page, testInfo, "offices held, office bar and tooltip", true);
  });

  await test.step("the residential bar's tooltip shows its parts the same way", async () => {
    const residential = page.locator("#demand-residential");
    await residential.hover();
    const bar = await page.evaluate(() => window.cityCouncil.mirror.state?.demand["residential"]);
    if (!bar) throw new Error("no residential bar");
    const waiting = await page.evaluate(() => window.cityCouncil.mirror.waitingFor("residential"));
    await expect(residential).toHaveAttribute("data-tip", formatDemandTitle("residential", bar.value, bar.parts, waiting));
    await expect(page.locator("#demand-residential [role=tooltip]")).toBeVisible();
    await attach(page, testInfo, "residential bar and tooltip", true);
  });
});
