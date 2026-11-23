import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_TYPES, buildingInfo, cellAt, createState, generateTerrain, heightAt, serialize, syncCells, type SimState } from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { addPop } from "../packages/sim/src/pops/pops";
import { lotProblem } from "../packages/sim/src/buildings/where";
import { builtFixtureCity, finishConstruction, setBuildingUse } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { canvasShot, frames, openCity, settle } from "./helpers";

// Issue M3-17: a building tells the player whether it is lived in, empty or
// given up. Four houses side by side on one street, built in Node with the
// sim and imported as a city file: one with three people in its room for
// four, one vacant, one abandoned, and one built and empty. The street
// reaches no outside connection, so the vacant and the empty house say why
// nobody moves in. Hovering each with no tool on reads it; the bulldozer's
// tag over the abandoned one says so. Then the fixture city with every
// building type, its west third in use, its middle third vacant and its
// east third abandoned, in the street, district and city bands at Low and
// at Balanced, for the screenshots. Both cities are saved paused, so no
// building changes state while a test reads it.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    view: Promise<{ buildingUse(id: number): number | null; buildingTop(id: number): { x: number; y: number; z: number } | null }>;
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
const CELL = 8;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["BUILDING_USE_EVIDENCE_DIR"];

/** The centre of the cell `k` deep at place `p` along the street, on its north side. */
const cellCentre = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

/** The four houses, west to east, and what each is. */
const HOUSES = [
  { use: "inUse", people: 3 },
  { use: "vacant", people: 0 },
  { use: "abandoned", people: 0 },
  { use: "empty", people: 0 },
] as const;
/** The place along the street of each house's first column: two cells wide, two cells apart. */
const placeOf = (k: number) => 4 + k * 3;

function fourHouses(): { state: SimState; ids: number[] } {
  const state = createState(SEED);
  buildRoads(state, [[[4200, 4600], [4392, 4600], "street"]]);
  syncCells(state);
  for (let p = 0; p < 24; p++) {
    for (let k = 0; k < 6; k++) {
      const [x, z] = cellCentre(p, k);
      const cell = cellAt(state, x, z);
      if (!cell) throw new Error(`no cell at ${x}, ${z}`);
      state.cells.zone[cell.index] = 1;
      state.cells.density[cell.index] = 1;
    }
  }
  const type = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  const ids = HOUSES.map((house, k) => {
    const [x, z] = cellCentre(placeOf(k), 0);
    const cell = cellAt(state, x, z);
    if (!cell) throw new Error(`no cell at ${x}, ${z}`);
    const shape = { first: { seg: cell.segment, side: cell.side, place: cell.place, dir: 0 }, width: 2, depth: 4, back: null };
    const problem = lotProblem(state, shape, 1, 1);
    if (problem !== null) throw new Error(problem);
    const lot = { firstSeg: cell.segment, firstSide: cell.side, firstPlace: cell.place, dir: 0, width: 2, depth: 4, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 };
    const id = addBuilding(state, { ...lot, type, residents: 4, variant: k * 5 });
    if (house.people > 0) addPop(state, { home: id, size: house.people, education: 1, wealth: 1, children: 0, satisfaction: 100 });
    return id;
  });
  finishConstruction(state);
  HOUSES.forEach((house, k) => {
    if (house.use === "vacant" || house.use === "abandoned") setBuildingUse(state, ids[k] ?? -1, house.use);
  });
  state.speed = 0;
  return { state, ids };
}

/**
 * The fixture city with every building type, its buildings in thirds by
 * where they stand, west to east: in use, vacant and abandoned. Nobody
 * lives or works in it, so any may be vacant or abandoned.
 */
function thirdsCity(): { bytes: Buffer; state: SimState; ids: Record<"inUse" | "vacant" | "abandoned", number[]> } {
  const { state } = builtFixtureCity();
  const live: { id: number; x: number }[] = [];
  state.buildings.flags.forEach((f, id) => {
    const corners = (f & 1) !== 0 ? buildingInfo(state, id)?.corners : null;
    if (corners) live.push({ id, x: ((corners[0] ?? 0) + (corners[4] ?? 0)) / 2 });
  });
  const xs = live.map((b) => b.x).sort((a, b) => a - b);
  const cut = [xs[Math.floor(xs.length / 3)] ?? 0, xs[Math.floor((2 * xs.length) / 3)] ?? 0];
  const ids = { inUse: [] as number[], vacant: [] as number[], abandoned: [] as number[] };
  for (const b of live) {
    const use = b.x < (cut[0] ?? 0) ? "inUse" : b.x < (cut[1] ?? 0) ? "vacant" : "abandoned";
    if (use !== "inUse") setBuildingUse(state, b.id, use);
    ids[use].push(b.id);
  }
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), state, ids };
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function moveTo(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

/** Moves the pointer to the top of building `id` as drawn, where the bulldozer picks it. */
async function moveToTop(page: Page, id: number): Promise<void> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  const p = await screenAt(page, top.x, top.z, top.y - 1);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

let shotNo = 0;
async function attach(page: Page, testInfo: TestInfo, name: string, png?: Buffer): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const shot = png ?? (await page.screenshot());
  writeFileSync(path, shot);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, shot);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("hovering an occupied, a vacant, an abandoned and an empty house reads who is in each", async ({ page }, testInfo) => {
  const { state, ids } = fourHouses();
  await openCity(page, state, { name: "Four houses" });
  const [x] = cellCentre(placeOf(1) + 2, 0);
  await look(page, x, 4570, 120);
  // Each drawn as it is: in use, vacant, abandoned, and the empty one in use until it has stood empty a month.
  expect(await page.evaluate(async (ids) => Promise.all(ids.map(async (id) => (await window.cityCouncil.view).buildingUse(id))), ids)).toEqual([0, 1, 2, 0]);
  const readout = page.locator("#building-readout");
  const expected = [
    { use: "inUse", people: "3", detail: "Residential R1 · lot 2 × 4 cells · 3 residents, room for 4", state: null },
    { use: "vacant", people: "0", detail: "Residential R1 · lot 2 × 4 cells · nobody living here, room for 4", state: "Vacant · no road to an outside connection" },
    { use: "abandoned", people: "0", detail: "Residential R1 · lot 2 × 4 cells · nobody living here, room for 4", state: "Abandoned" },
    { use: "inUse", people: "0", detail: "Residential R1 · lot 2 × 4 cells · nobody living here, room for 4", state: "Empty · no road to an outside connection" },
  ];
  for (const [k, want] of expected.entries()) {
    const [hx, hz] = cellCentre(placeOf(k) + 1, 2);
    await moveTo(page, hx, hz);
    await expect(readout).toBeVisible();
    await expect(readout).toHaveAttribute("data-building", String(ids[k]));
    await expect(readout).toHaveAttribute("data-use", want.use);
    await expect(readout).toHaveAttribute("data-people", want.people);
    await expect(readout).toHaveAttribute("data-residents", "4");
    await expect(readout.locator(".what")).toHaveText("Single family home");
    await expect(readout.locator(".detail")).toHaveText(want.detail);
    if (want.state) await expect(readout.locator(".state")).toHaveText(want.state);
    else await expect(readout.locator(".state")).toHaveCount(0);
    await attach(page, testInfo, `the readout over the ${["occupied", "vacant", "abandoned", "empty"][k]} house`);
  }

  // The bulldozer's tag over the abandoned house says so; over the occupied one it says nothing of the kind.
  await page.keyboard.press("KeyB");
  const tag = page.locator("#bulldoze-tag");
  await moveToTop(page, ids[2] ?? -1);
  await expect(tag).toHaveAttribute("data-ids", String(ids[2]));
  await expect(tag).toHaveAttribute("data-use", "abandoned");
  await expect(tag.locator(".state")).toHaveText("Abandoned");
  await attach(page, testInfo, "the bulldozer's tag over the abandoned house");
  await moveToTop(page, ids[0] ?? -1);
  await expect(tag).toHaveAttribute("data-ids", String(ids[0]));
  await expect(tag).toHaveAttribute("data-use", "inUse");
  await expect(tag.locator(".state")).toHaveCount(0);
  await expect(tag.locator(".detail")).toHaveText("Residential R1 · lot 2 × 4 cells · 3 residents, room for 4");
});

const thirds = thirdsCity();
const GRID = { x: 4250, z: 4600 };
/** Where the thirds city's district is looked at from, per band: its middle, from above and to the south. */
const BANDS: { band: string; height: number; back: number; clip: number }[] = [
  { band: "street", height: 210, back: 230, clip: 1 },
  { band: "district", height: 900, back: 1100, clip: 2 },
  { band: "city", height: 3150, back: 1200, clip: 3 },
];

/** The canvas, or its middle `1 / zoom` of each side for a far band, so the town fills the shot. */
async function shotOf(page: Page, zoom: number): Promise<Buffer> {
  if (zoom <= 1) return canvasShot(page);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas");
  const width = box.width / zoom;
  const height = box.height / zoom;
  return page.screenshot({ clip: { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height } });
}

for (const preset of ["low", "balanced"] as const) {
  test(`the four houses close up, and a city's in use, vacant and abandoned thirds in every band, at ${preset}`, async ({ page }, testInfo) => {
    const { state, ids } = fourHouses();
    await openCity(page, state, { query: `webgl&preset=${preset}`, name: "Four houses", presetSettled: true });
    // Low over the street from the south, so the fronts and their windows show.
    const [x] = cellCentre(placeOf(1) + 3, 0);
    const g = groundAt(x, 4580);
    await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + 22, 4648], [x, g + 3, 4580]] as const);
    await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
    await page.mouse.move(640, 790);
    await frames(page, 4);
    expect(await page.evaluate(async (ids) => Promise.all(ids.map(async (id) => (await window.cityCouncil.view).buildingUse(id))), ids)).toEqual([0, 1, 2, 0]);
    await attach(page, testInfo, `occupied, vacant, abandoned and empty, west to east, ${preset}`, await canvasShot(page));

    await openCity(page, thirds.bytes, { query: `webgl&preset=${preset}`, name: "Thirds", presetSettled: true, timeout: 120_000 });
    // One building of each third, as drawn.
    const one = [thirds.ids.inUse[0], thirds.ids.vacant[0], thirds.ids.abandoned[0]];
    for (const { band, height, back, clip } of BANDS) {
      const g = groundAt(GRID.x, GRID.z + back);
      const position: Vec3 = [GRID.x, g + height, GRID.z + back];
      const target: Vec3 = [GRID.x, groundAt(GRID.x, GRID.z), GRID.z];
      await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
      await settle(page);
      expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      expect(await page.evaluate(async (ids) => Promise.all(ids.map(async (id) => (await window.cityCouncil.view).buildingUse(id ?? -1))), one)).toEqual([0, 1, 2]);
      await attach(page, testInfo, `in use, vacant and abandoned thirds, west to east, ${band} band, ${preset}`, await shotOf(page, clip));
    }
  });
}
