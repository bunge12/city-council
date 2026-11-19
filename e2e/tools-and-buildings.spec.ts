import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_TYPES, cellAt, createState, generateTerrain, heightAt, syncCells, type SimState } from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { finishConstruction } from "./building-fixtures";
import { lotProblem } from "../packages/sim/src/buildings/where";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M2-15: the tools and buildings. The road tool marks the houses a
// road would clear and counts them before the click, and after it they are
// gone. The grid tool counts the buildings its rectangle would clear.
// Hovering a building with no tool on reads it out. The zoning overlay
// hatches an R3 strip of 3 x 6, where no tower fits, and says why on hover.
//
// The city is built in Node with the sim and imported as a city file: a
// street running east from (4200, 4600), its north side zoned R1 six deep
// with a house on every two cells, and three places of its south side
// zoned R3 six deep.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: { state: { tick: number; buildings: { flags: Uint8Array; builtAt: Float64Array }; log: { type: string }[] } | null };
    view: Promise<{ cellStats(): { marked: number; pending: number; visible: boolean } | null }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

const terrain = generateTerrain(SEED);
const CELL = 8;

/** The centre of the cell `k` deep at place `p` along the street, north (side 1) or south of it. */
const cellCentre = (p: number, k: number, northSide: boolean): [number, number] => [4200 + CELL * p + CELL / 2, northSide ? 4595 - CELL * k - CELL / 2 : 4605 + CELL * k + CELL / 2];

/** Zones the cells `places` by `depth` on one side of the street, straight into state. */
function zone(state: SimState, places: [number, number], depth: number, northSide: boolean, zoneNumber: number, density: number): void {
  syncCells(state);
  for (let p = places[0]; p < places[1]; p++) {
    for (let k = 0; k < depth; k++) {
      const [x, z] = cellCentre(p, k, northSide);
      const cell = cellAt(state, x, z);
      if (!cell) throw new Error(`no cell at ${x}, ${z}`);
      state.cells.zone[cell.index] = zoneNumber;
      state.cells.density[cell.index] = density;
    }
  }
}

/** The street with houses two cells wide and four deep all along its north side, and R3 three places wide on its south side. */
function houseCity(): { state: SimState; houses: number } {
  const state = createState(SEED);
  buildRoads(state, [[[4200, 4600], [4392, 4600], "street"]]);
  zone(state, [0, 24], 6, true, 1, 1);
  zone(state, [10, 13], 6, false, 1, 3);
  const type = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  let houses = 0;
  for (let p = 0; p + 1 < 24; p += 2) {
    const [x, z] = cellCentre(p, 0, true);
    const cell = cellAt(state, x, z);
    if (!cell) continue;
    const shape = { first: { seg: cell.segment, side: cell.side, place: cell.place, dir: 0 }, width: 2, depth: 4, back: null };
    if (lotProblem(state, shape, 1, 1) !== null) continue;
    const lot = { firstSeg: cell.segment, firstSide: cell.side, firstPlace: cell.place, dir: 0, width: 2, depth: 4, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 };
    addBuilding(state, { ...lot, type, residents: 3, variant: p * 7 });
    houses++;
  }
  finishConstruction(state);
  return { state, houses };
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  // Let the buildings near the camera fill in.
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function moveTo(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

async function clickAt(page: Page, x: number, z: number): Promise<void> {
  await moveTo(page, x, z);
  await page.mouse.down();
  await page.mouse.up();
  await frames(page);
}

async function live(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const flags = window.cityCouncil.mirror.state?.buildings.flags ?? new Uint8Array();
    return Array.from(flags.keys()).filter((id) => ((flags[id] ?? 0) & 1) !== 0);
  });
}

/** The tick of the client's copy of the city. */
async function tickNow(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? 0);
}

/**
 * The live buildings built on or before `tick`. The cells a road or grid
 * clears stay zoned, so the grower can put a house back on them a few game
 * seconds later, often under a freed id. Counted with the rest, that house
 * can land in the same update as the clearing on a slow runner, and the
 * count never shows the houses gone (issue #245).
 */
async function standingSince(page: Page, tick: number): Promise<number[]> {
  return page.evaluate((tick) => {
    const b = window.cityCouncil.mirror.state?.buildings;
    if (!b) return [];
    return Array.from(b.flags.keys()).filter((id) => ((b.flags[id] ?? 0) & 1) !== 0 && (b.builtAt[id] ?? 0) <= tick);
  }, tick);
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("a road through a row of houses marks and counts them before the click, and they are gone after", async ({ page }, testInfo) => {
  const { state, houses } = houseCity();
  expect(houses).toBeGreaterThan(8);
  await openCity(page, state, { name: "Houses" });
  await look(page, 4300, 4560, 260);
  const before = await live(page);
  const beforeTick = await tickNow(page);
  expect(before).toHaveLength(houses);

  await page.keyboard.press("KeyR");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  // A street from the street, through the houses, to open ground north of them.
  await clickAt(page, 4300, 4600);
  await moveTo(page, 4300, 4504);
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  const count = Number(await readout.getAttribute("data-clears"));
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(houses);
  await expect(page.locator("#road-clears")).toHaveText(count === 1 ? "Clears 1 building, 3 residents" : `Clears ${count} buildings, ${count * 3} residents`);
  expect(await page.evaluate(() => document.body.dataset["buildingsToClear"])).toBe(String(count));
  await attach(page, testInfo, "the road's preview marks the houses in its way");

  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await standingSince(page, beforeTick)).length, { timeout: 30_000 }).toBe(houses - count);
  await page.keyboard.press("Escape");
  await page.mouse.move(640, 20);
  await frames(page, 6);
  await attach(page, testInfo, "after the click the houses are gone");
});

test("the grid tool counts the buildings its rectangle would clear", async ({ page }, testInfo) => {
  const { state } = houseCity();
  await openCity(page, state, { name: "Houses" });
  await look(page, 4300, 4590, 300);
  const before = await live(page);
  const beforeTick = await tickNow(page);

  await page.keyboard.press("KeyG");
  // The first side west to east along the near edge, then the grid reaches
  // north and a click places it (issue 88). The reach is set with no button
  // held, so the pointer stays clear of the build menu at the bottom.
  const a = await screenAt(page, 4180, 4700);
  const b = await screenAt(page, 4420, 4700);
  const c = await screenAt(page, 4300, 4480);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await frames(page);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 30 });
  await frames(page);
  await page.mouse.up();
  await page.mouse.move(c.x, c.y, { steps: 20 });
  await frames(page);
  // While the reach follows the pointer the count waits.
  await expect(page.locator("#grid-summary")).toHaveAttribute("data-clears", "");
  await page.mouse.click(c.x, c.y);
  await frames(page);
  const summary = page.locator("#grid-summary");
  await expect(summary).toHaveAttribute("data-ok", "true");
  const count = Number(await summary.getAttribute("data-clears"));
  expect(count).toBeGreaterThan(0);
  await expect(page.locator("#grid-clears")).toContainText(`Clears ${count} building`);
  await page.mouse.move(640, 20);
  await frames(page, 4);
  await attach(page, testInfo, "the grid preview counts the buildings it would clear");

  await page.locator("#grid-confirm").click();
  await expect.poll(async () => (await standingSince(page, beforeTick)).length, { timeout: 30_000 }).toBe(before.length - count);
});

test("hovering a building with no tool on reads it out", async ({ page }, testInfo) => {
  const { state } = houseCity();
  await openCity(page, state, { name: "Houses" });
  await look(page, 4300, 4590, 160);
  const [x, z] = cellCentre(12, 1, true);
  await moveTo(page, x, z);
  const readout = page.locator("#building-readout");
  await expect(readout).toBeVisible();
  await expect(readout).toHaveAttribute("data-type", "single-family-home");
  await expect(readout).toHaveAttribute("data-zone", "1");
  await expect(readout).toHaveAttribute("data-density", "1");
  await expect(readout).toHaveAttribute("data-residents", "3");
  await expect(readout.locator(".what")).toHaveText("Single family home");
  const width = await readout.getAttribute("data-width");
  const depth = await readout.getAttribute("data-depth");
  await expect(readout.locator(".detail")).toHaveText(`Residential R1 · lot ${width} × ${depth} cells · 3 residents`);
  await attach(page, testInfo, "the readout over a house");
  // Off the houses, no readout.
  await moveTo(page, 4300, 4700);
  await expect(readout).toHaveCount(0);
});

test("an R3 strip of 3 x 6 is hatched, and the zone tool says why", async ({ page }, testInfo) => {
  const { state } = houseCity();
  await openCity(page, state, { name: "Houses" });
  await look(page, 4300, 4640, 160);
  await page.keyboard.press("KeyK");
  await page.waitForFunction(async () => {
    const s = (await window.cityCouncil.view).cellStats();
    return s !== null && s.visible && s.pending === 0;
  });
  const marked = await page.evaluate(async () => (await window.cityCouncil.view).cellStats()?.marked ?? 0);
  expect(marked).toBe(18);
  // With the pointer off the map, so the zone tool's own preview does not cover the strip.
  await page.mouse.move(640, 20);
  await frames(page, 4);
  await attach(page, testInfo, "the R3 strip of 3 x 6 is hatched");
  const [x, z] = cellCentre(11, 3, false);
  await moveTo(page, x, z);
  const note = page.locator("#zone-lot-note");
  await expect(note).toHaveText("Nothing can grow here: R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 wide");
  await attach(page, testInfo, "the hatched R3 strip and the reason");
  // Over ground where a lot fits, nothing is said.
  await moveTo(page, 4300, 4640 + 200);
  await expect(note).toHaveCount(0);
});
