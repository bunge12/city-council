import { writeFileSync } from "node:fs";
import { FULL_DEMAND, holdDemand } from "../packages/sim/test/demand-helper";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { TIME_BALANCE, buildingCount, createState, readBuilding, step, submit, type SimState } from "../packages/sim/src/index";
import { finishConstruction } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { buildingsDrawn, frames, openCity } from "./helpers";

// Issue 194: the grower builds at an end of the free frontage it draws a
// cell on, so a building stands against a road end, a neighbour or other
// zoning, and the ground it leaves stays in one piece, at least as wide as
// the narrowest type of its zone. Before, a 3-wide building could stand in
// the middle of a 7-wide lot and leave 2 cells either side that nothing
// could grow on.
//
// One street on seed 2026's flat square. Its north side is zoned O3 in three
// lots 7 cells wide and 6 deep, with an unzoned cell between them; its south
// side C3 24 cells wide and 6 deep. The sim grows it for 60 game days in
// Node, and the city is imported as a city file. The zone tool's overlay
// hatches free zoned ground no building type fits.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    view: Promise<{ cellStats(): { marked: number; pending: number; visible: boolean } | null }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

const CELL = 8;
const WEST = 4200;
/** The north side's three O3 lots, as [first place, end place). */
const LOTS: [number, number][] = [
  [0, 7],
  [8, 15],
  [16, 23],
];

function grownCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[WEST, 4600], [WEST + 24 * CELL, 4600], "street"]]);
  const rect = ([p0, p1]: [number, number], z: number) => ({ from: { x: WEST + CELL * p0 + 2, z }, to: { x: WEST + CELL * p1 - 2, z }, width: 6 * CELL - 4 });
  let seq = 0;
  for (const [zone, rects] of [
    ["office", LOTS.map((lot) => rect(lot, 4595 - 3 * CELL))],
    ["commercial", [rect([0, 24], 4605 + 3 * CELL)]],
  ] as const) {
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "ZoneCells", payload: { zone, density: 3, rects } });
    if (!result.ok) throw new Error(`zoning refused: ${result.reason}`);
    step(state);
  }
  // An empty city wants no offices or shops (M3-07): hold their bars up for the 60 days.
  holdDemand(FULL_DEMAND, () => {
    while (state.tick < 60 * TIME_BALANCE.ticksPerDay) step(state);
  });
  finishConstruction(state);
  // Saved paused, so nothing grows while the test looks.
  state.speed = 0;
  return state;
}

const city = grownCity();

/** The places along the street each north-side building covers. The street is one segment, so they run on from the first. */
function northPlaces(state: SimState): number[][] {
  const out: number[][] = [];
  state.buildings.flags.forEach((f, id) => {
    if (!f) return;
    const b = readBuilding(state.buildings, id);
    if (b.zone !== 3) return;
    const step = b.dir === 0 ? 1 : -1;
    out.push(Array.from({ length: b.width }, (_, i) => b.firstPlace + i * step));
  });
  return out;
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("each 7-wide O3 lot is built from end to end, with no cell left over", () => {
  const built = northPlaces(city);
  for (const [p0, p1] of LOTS) {
    const on = built.filter((places) => places.every((p) => p >= p0 && p < p1));
    // O3 types on one strip are 3, 4, 5 or 6 wide: only 3 and 4 make 7.
    expect(on.map((places) => places.length).sort(), `lot ${p0} to ${p1 - 1}`).toEqual([3, 4]);
    expect(on.flat().sort((a, b) => a - b), `lot ${p0} to ${p1 - 1}`).toEqual(Array.from({ length: p1 - p0 }, (_, i) => p0 + i));
  }
});

test("the grown street from above, with the zone tool's hatching on ground nothing fits", async ({ page }, testInfo) => {
  await openCity(page, city, { name: "Frontage" });
  const x = WEST + 12 * CELL;
  const z = 4600;
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [
    [x, g + 230, z + 120],
    [x, g, z],
  ] as const);
  await buildingsDrawn(page, buildingCount(city.buildings));
  await frames(page, 4);
  await attach(page, testInfo, "the grown street");

  await page.keyboard.press("KeyK");
  await page.waitForFunction(async () => {
    const s = (await window.cityCouncil.view).cellStats();
    return s !== null && s.visible && s.pending === 0;
  });
  // With the pointer off the map, so the zone tool's own preview covers nothing.
  await page.mouse.move(640, 20);
  await frames(page, 4);
  const marked = await page.evaluate(async () => (await window.cityCouncil.view).cellStats()?.marked ?? 0);
  await attach(page, testInfo, "the zone tool hatches ground nothing fits");
  // Every zoned cell is built on, so nothing is hatched.
  expect(marked).toBe(0);
  await testInfo.attach("counts", {
    body: JSON.stringify({ buildings: buildingCount(city.buildings), northPlaces: northPlaces(city), marked }),
    contentType: "application/json",
  });
});
