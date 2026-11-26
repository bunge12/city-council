import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CELL_OPEN, ZONING_BALANCE, cellAt, createState, generateTerrain, heightAt, serialize, syncCells, type SimState } from "../packages/sim/src/index";
import { buildEverySide, finishConstruction } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M3-18: the land value overlay. A city with two strips of R1: one by
// the water, and one across a street from a row of factories. The overlay
// turns on from the dock and from its key, colours the cells, and the
// readout over a cell gives its value and the parts it is made of: the
// waterfront reads higher, with water in its parts, and the strip by the
// factories lower, with industry taken off. One overlay shows at a time:
// the zone tool brings zoning back over land value. Screenshots of the
// overlay in each zoom band go to the pull request.
//
// The city is built in Node with the sim and imported as a city file,
// saved paused so nothing grows on the strips during the test.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    view: Promise<{ cellStats(): { pending: number; visible: boolean; colouring: string; zoned: number; unzoned: number } | null }>;
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
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = 3;

/** A street with water a few tens of metres north of it on seed 2026, found by a search over the map. */
const WATERFRONT = { x: 3740, z: 7220, places: 20 };
/** A street on the flat square, with factories along its south side and R1 along its north. */
const FACTORIES = { x: 4200, z: 4600, places: 24 };

/** The centre of the cell `k` deep at place `p` along an east-running street from (x0, z0), north of it or south. */
const cellCentre = (x0: number, z0: number, p: number, k: number, north: boolean): [number, number] => [
  x0 + CELL * p + CELL / 2,
  north ? z0 - 5 - CELL * k - CELL / 2 : z0 + 5 + CELL * k + CELL / 2,
];

/** Zones the open cells `DEPTH` deep along one side of a street, straight into state. Returns how many. */
function zoneSide(state: SimState, street: { x: number; z: number; places: number }, north: boolean, zoneId: string): number {
  syncCells(state);
  const zone = ZONING_BALANCE.zones.findIndex((z) => z.id === zoneId) + 1;
  let n = 0;
  for (let p = 0; p < street.places; p++) {
    for (let k = 0; k < DEPTH; k++) {
      const [x, z] = cellCentre(street.x, street.z, p, k, north);
      const cell = cellAt(state, x, z);
      if (!cell || cell.status !== CELL_OPEN) continue;
      state.cells.zone[cell.index] = zone;
      state.cells.density[cell.index] = 1;
      n++;
    }
  }
  return n;
}

/** The middle open front cell along one side of a street, as a point to hover. */
function frontCell(state: SimState, street: { x: number; z: number; places: number }, north: boolean): [number, number] | null {
  for (let d = 0; d < street.places / 2; d++) {
    for (const p of [street.places / 2 + d, street.places / 2 - d - 1]) {
      const [x, z] = cellCentre(street.x, street.z, p, 0, north);
      const cell = cellAt(state, x, z);
      if (cell?.status === CELL_OPEN) return [x, z];
    }
  }
  return null;
}

function landCity(): { bytes: Buffer; water: [number, number]; factory: [number, number] } {
  const state = createState(SEED);
  buildRoads(state, [
    [[WATERFRONT.x, WATERFRONT.z], [WATERFRONT.x + CELL * WATERFRONT.places, WATERFRONT.z], "street"],
    [[FACTORIES.x, FACTORIES.z], [FACTORIES.x + CELL * FACTORIES.places, FACTORIES.z], "street"],
  ]);
  // Factories first, on the only zoned side, so the homes' strips stay open ground.
  expect(zoneSide(state, FACTORIES, false, "industrial")).toBeGreaterThan(0);
  buildEverySide(state);
  expect(zoneSide(state, FACTORIES, true, "residential")).toBeGreaterThan(0);
  const waterSide = zoneSide(state, WATERFRONT, true, "residential") + zoneSide(state, WATERFRONT, false, "residential");
  expect(waterSide).toBeGreaterThan(0);
  finishConstruction(state);
  state.speed = 0;
  const water = frontCell(state, WATERFRONT, true) ?? frontCell(state, WATERFRONT, false);
  const factory = frontCell(state, FACTORIES, true);
  if (!water || !factory) throw new Error("no open front cell to hover");
  return { bytes: Buffer.from(serialize(state)), water, factory };
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && (!document.body.dataset["overlay"] || document.body.dataset["cellsPending"] === "0"), null, { timeout: 60_000 });
  await frames(page, 4);
}

async function moveTo(page: Page, x: number, z: number): Promise<void> {
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  const p = await page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

async function readout(page: Page): Promise<{ value: number; water: number; pollution: number; text: string }> {
  const r = page.locator("#land-value-readout");
  await expect(r).toBeVisible();
  const num = async (name: string) => Number(await r.getAttribute(`data-${name}`));
  return { value: await num("value"), water: await num("water"), pollution: await num("pollution"), text: (await r.innerText()).replace(/\s+/g, " ") };
}

async function overlay(page: Page): Promise<string> {
  await frames(page, 2);
  return page.evaluate(() => document.body.dataset["overlay"] ?? "");
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the land value overlay shows the waterfront strip worth more than the strip by the factories, and why", async ({ page }, testInfo) => {
  const { bytes, water, factory } = landCity();
  await openCity(page, bytes, { name: "Land value", timeout: 120_000 });
  await look(page, factory[0], factory[1], 160);

  // Off to start with, and on from the dock.
  expect(await overlay(page)).toBe("");
  await expect(page.locator("#land-value-legend")).toHaveCount(0);
  await page.locator("#overlay-landValue").click();
  await expect(page.locator("#overlay-landValue")).toHaveAttribute("aria-pressed", "true");
  expect(await overlay(page)).toBe("landValue");
  await expect(page.locator("#land-value-legend")).toBeVisible();
  await expect(page.locator("#zone-legend")).toHaveCount(0);
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  expect(stats).toMatchObject({ visible: true, colouring: "landValue" });

  // By the factories: industry takes points off.
  await moveTo(page, factory[0], factory[1]);
  const byFactories = await readout(page);
  expect(byFactories.pollution).toBeGreaterThan(0);
  expect(byFactories.text).toMatch(/Land value \d+ of 100/);
  expect(byFactories.text).toContain("Industry −");
  // The building readout gives way to the land's.
  await expect(page.locator("#building-readout")).toHaveCount(0);
  await attach(page, testInfo, "land value overlay, street band, by the factories");

  // By the water: water adds points, and the land is worth more.
  await look(page, water[0], water[1], 160);
  await moveTo(page, water[0], water[1]);
  const byWater = await readout(page);
  expect(byWater.water).toBeGreaterThan(0);
  expect(byWater.text).toContain("Water +");
  expect(byWater.value).toBeGreaterThan(byFactories.value);
  console.log(`M3-18 land value: waterfront ${byWater.value} (${byWater.text}), by the factories ${byFactories.value} (${byFactories.text})`);
  await attach(page, testInfo, "land value overlay, street band, by the water");

  // The district band and the city band, over the factory strip.
  await page.mouse.move(5, 400);
  await look(page, factory[0], factory[1], 1200);
  await attach(page, testInfo, "land value overlay, district band");
  await look(page, factory[0], factory[1], 3600);
  await attach(page, testInfo, "land value overlay, city band");

  // One at a time: the zone tool brings zoning back, and land value comes back over it from its key.
  await look(page, factory[0], factory[1], 160);
  await page.keyboard.press("KeyK");
  expect(await overlay(page)).toBe("zoning");
  await expect(page.locator("#zone-legend")).toBeVisible();
  await expect(page.locator("#land-value-legend")).toHaveCount(0);
  await expect(page.locator("#overlay-landValue")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("KeyO");
  expect(await overlay(page)).toBe("landValue");
  await expect(page.locator("#zone-legend")).toHaveCount(0);
  // Off again with the zone tool still on: zoning.
  await page.keyboard.press("KeyO");
  expect(await overlay(page)).toBe("zoning");
  // Leaving the zone tool puts zoning away.
  await page.keyboard.press("KeyK");
  expect(await overlay(page)).toBe("");
  await page.keyboard.press("KeyO");
  expect(await overlay(page)).toBe("landValue");
  await page.keyboard.press("KeyO");
  expect(await overlay(page)).toBe("");
  // Escape puts it away like a window, and the legend with it.
  await page.keyboard.press("KeyO");
  await expect(page.locator("#land-value-legend")).toBeVisible();
  await attach(page, testInfo, "land value overlay, before Escape");
  await page.keyboard.press("Escape");
  expect(await overlay(page)).toBe("");
  await expect(page.locator("#land-value-legend")).toHaveCount(0);
  await attach(page, testInfo, "land value overlay, after Escape");
});
