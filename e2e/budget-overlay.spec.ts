import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { areaBudget, blockBudgets, budgetAreasOfSlots, cellAt, generateTerrain, heightAt, serialize, type AreaBudget } from "../packages/sim/src/index";
import { SPOTS, at, budgetTown } from "../packages/sim/test/budget-town";
import { finishConstruction } from "./building-fixtures";
import { SEED, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M4-18: the budget overlay. The budget town (packages/sim/test/
// budget-town.ts) is built and grown in Node with the sim and opened as a
// city file, saved paused so its figures hold still while the test reads
// them. The overlay turns on from its key, colours each block on its
// diverging scale with a legend, and pointing at a block gives its tax, its
// road upkeep and the net: a compact block of density 2 above zero, the
// large block round a long cul-de-sac below it, each the very figures the
// sim gives for that block. Screenshots of the overlay on the mixed town go
// to the pull request.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    view: Promise<{ cellStats(): { pending: number; visible: boolean; colouring: string } | null }>;
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

interface Spot {
  x: number;
  z: number;
}

function town(): { bytes: Buffer; spots: Record<keyof typeof SPOTS, Spot>; figures: Map<number, AreaBudget>; compactArea: number } {
  const { state, f } = budgetTown();
  finishConstruction(state);
  state.speed = 0;
  const spots = Object.fromEntries(Object.entries(SPOTS).map(([k, [u, v]]) => [k, at(f, u, v)])) as Record<keyof typeof SPOTS, Spot>;
  // The sim's figures for every block, and for open ground in every chunk.
  const budgets = blockBudgets(state);
  const figures = new Map<number, AreaBudget>();
  for (const id of budgets.blocks) {
    const b = areaBudget(budgets, id);
    if (b) figures.set(id, b);
  }
  for (let c = 0; c < budgets.chunkTax.length; c++) {
    const b = areaBudget(budgets, -1 - c);
    if (b) figures.set(-1 - c, b);
  }
  // The compact block's spot is on one of its cells, so the readout names the block that cell faces.
  const cell = cellAt(state, spots.compact.x, spots.compact.z);
  if (!cell) throw new Error("no cell at the compact block's spot");
  const chunk = Math.floor(spots.compact.z / 500) * 24 + Math.floor(spots.compact.x / 500);
  const compactArea = budgetAreasOfSlots(state, [cell.index], chunk)[0] ?? -1;
  return { bytes: Buffer.from(serialize(state)), spots, figures, compactArea };
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

async function readout(page: Page): Promise<{ area: number; kind: string; tax: number; upkeep: number; net: number; text: string }> {
  const r = page.locator("#budget-readout");
  await expect(r).toBeVisible();
  const num = async (name: string) => Number(await r.getAttribute(`data-${name}`));
  return {
    area: await num("area"),
    kind: (await r.getAttribute("data-kind")) ?? "",
    tax: await num("tax"),
    upkeep: await num("upkeep"),
    net: await num("net"),
    text: (await r.innerText()).replace(/\s+/g, " "),
  };
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the budget overlay shows a compact block paying its way and a long cul-de-sac's block losing money, as the sim figures them", async ({ page }, testInfo) => {
  const { bytes, spots, figures, compactArea } = town();
  await openCity(page, bytes, { name: "Budget town", timeout: 120_000 });
  const middle = { x: (spots.compact.x + spots.large.x) / 2, z: (spots.compact.z + spots.large.z) / 2 };
  await look(page, middle.x, middle.z, 260);
  await attach(page, testInfo, "the budget town, no overlay");

  // On from its key, with its legend and its button pressed.
  await expect(page.locator("#budget-legend")).toHaveCount(0);
  await page.keyboard.press("KeyN");
  await expect(page.locator("#overlay-budget")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#budget-legend")).toBeVisible();
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0" && document.body.dataset["budgetMs"] !== undefined, null, { timeout: 60_000 });
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  expect(stats).toMatchObject({ visible: true, colouring: "budget" });
  await page.mouse.move(5, 400);
  await frames(page, 4);
  await attach(page, testInfo, "budget overlay on the mixed town, street band");

  // The compact block of density 2: above zero, the sim's own figures.
  await moveTo(page, spots.compact.x, spots.compact.z);
  const compact = await readout(page);
  expect(compact.kind).toBe("block");
  expect(compact.area).toBe(compactArea);
  expect({ tax: compact.tax, upkeep: compact.upkeep, net: compact.net }).toEqual(figures.get(compactArea));
  expect(compact.net).toBeGreaterThan(0);
  expect(compact.text).toContain("This block, a year");
  // The building readout gives way to the block's.
  await expect(page.locator("#building-readout")).toHaveCount(0);
  await attach(page, testInfo, "budget overlay, pointing at the compact R2 block");

  // The shops' block beside it.
  await moveTo(page, spots.shops.x, spots.shops.z);
  const shops = await readout(page);
  expect(shops.kind).toBe("block");
  expect(shops.area).not.toBe(compact.area);
  expect({ tax: shops.tax, upkeep: shops.upkeep, net: shops.net }).toEqual(figures.get(shops.area));

  // The large block round the long cul-de-sac, pointed at well away from any road: below zero.
  await moveTo(page, spots.large.x, spots.large.z);
  const large = await readout(page);
  expect(large.kind).toBe("block");
  expect({ tax: large.tax, upkeep: large.upkeep, net: large.net }).toEqual(figures.get(large.area));
  expect(large.net).toBeLessThan(0);
  await attach(page, testInfo, "budget overlay, pointing at the block round the long cul-de-sac");
  await page.mouse.move(5, 400);
  await look(page, spots.large.x, spots.large.z, 420);
  await attach(page, testInfo, "budget overlay, the long cul-de-sac in its block");

  // The spur on open ground counts in its chunk.
  await page.mouse.move(5, 400);
  await look(page, spots.spur.x, spots.spur.z, 260);
  await moveTo(page, spots.spur.x, spots.spur.z);
  const spur = await readout(page);
  expect(spur.kind).toBe("chunk");
  expect({ tax: spur.tax, upkeep: spur.upkeep, net: spur.net }).toEqual(figures.get(spur.area));
  console.log(`M4-18 budget overlay: compact ${JSON.stringify(compact)}, shops ${JSON.stringify(shops)}, cul-de-sac block ${JSON.stringify(large)}, spur ${JSON.stringify(spur)}`);
  const ms = await page.evaluate(() => document.body.dataset["budgetMs"]);
  console.log(`M4-18 budget overlay figures worked out in ${ms} ms on the budget town`);

  // The district band, then off again from its key.
  await page.mouse.move(5, 400);
  await look(page, middle.x, middle.z, 900);
  await attach(page, testInfo, "budget overlay on the mixed town, district band");
  await attach(page, testInfo, "budget overlay, pointing at the spur on open ground");
  await page.keyboard.press("KeyN");
  await expect(page.locator("#budget-legend")).toHaveCount(0);
  await expect(page.locator("#overlay-budget")).toHaveAttribute("aria-pressed", "false");
});
