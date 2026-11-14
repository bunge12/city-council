import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ROAD_TYPES, ZONING_BALANCE, createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M2-07: the zone tool. A player opens it, paints R1 along one side of
// a street with a fill two cells deep, sees the cells change and one entry
// in the activity log, clicks again where nothing would change and sends
// nothing, erases, and brushes across two streets.
//
// The city is built in Node with the sim and imported as a city file.

type Vec3 = readonly [number, number, number];
interface CellInfo {
  segment: number;
  side: number;
  depth: number;
  index: number;
}
declare const window: {
  cityCouncil: {
    mirror: {
      state: { log: { type: string; playerId: string; tick: number }[]; cells: { zone: ArrayLike<number>; density: ArrayLike<number> } } | null;
      cellAt(x: number, z: number): CellInfo | null;
    };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);
const CELL = ZONING_BALANCE.cellSize;
const HALF = (ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0) / 2;
const RESIDENTIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;
const COMMERCIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1;

/** Two streets running east, 120 m apart: room for a full strip on each side between them. */
const SOUTH_Z = 4600;
const NORTH_Z = 4480;
const X0 = 4200;
const X1 = 4392;
const MID_X = 4300;

function twoStreets(): SimState {
  const state = createState(SEED);
  buildRoads(state, [
    [[X0, SOUTH_Z], [X1, SOUTH_Z], "street"],
    [[X0, NORTH_Z], [X1, NORTH_Z], "street"],
  ]);
  return state;
}

/** The z of the centre of the cell `row` back from the north edge of the street along `z`. */
const northRow = (z: number, row: number) => z - HALF - CELL / 2 - row * CELL;

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Zone.city", mimeType: "application/octet-stream", buffer: Buffer.from(serialize(state)) });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.6], [x, g, z]] as const);
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

async function zoneLog(page: Page): Promise<{ type: string; playerId: string; tick: number }[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.filter((e) => e.type === "ZoneCells").map((e) => ({ type: e.type, playerId: e.playerId, tick: e.tick })) ?? []);
}

/** The cell at (x, z) and its zone and density in the mirror, or null. */
async function cellAt(page: Page, x: number, z: number): Promise<(CellInfo & { zone: number; density: number }) | null> {
  return page.evaluate(([x, z]) => {
    const { mirror } = window.cityCouncil;
    const cell = mirror.cellAt(x, z);
    const cells = mirror.state?.cells;
    if (!cell || !cells) return null;
    return { ...cell, zone: cells.zone[cell.index] ?? 0, density: cells.density[cell.index] ?? 0 };
  }, [x, z] as const);
}

/** How many cells in the mirror are zoned. */
async function zonedCount(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(window.cityCouncil.mirror.state?.cells.zone ?? []).filter((z) => z !== 0).length);
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("fill paints a strip two cells deep, a repeat sends nothing, and erase clears it", async ({ page }, testInfo) => {
  await openCity(page, twoStreets());
  await look(page, MID_X, SOUTH_Z - 30, 280);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyL");

  // K opens the tool, and with it the overlay and its menu.
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zone-menu")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  // Residential, density 1, fill: the defaults. Depth two.
  await expect(page.locator("#zone-residential")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zone-density-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zone-mode-fill")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#zone-depth-2").click();
  await expect(page.locator("#zone-depth-2")).toHaveAttribute("aria-pressed", "true");

  // Hover the south street, just north of its middle: its north strip lights up.
  await hover(page, MID_X, SOUTH_Z - HALF / 2);
  const readout = page.locator("#zone-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  const count = Number(await readout.getAttribute("data-cells"));
  const places = (X1 - X0) / CELL;
  // Two rows along the street, fewer the few cells the junction ends block.
  expect(count).toBeGreaterThan(2 * places - 6);
  expect(count).toBeLessThanOrEqual(2 * places);
  expect(count % 2).toBe(0);
  await expect(readout).toContainText(`Zone ${count} cells R1`);
  expect(Number(await page.evaluate(() => document.body.dataset["zonePreview"]))).toBe(count);
  await attach(page, testInfo, "fill preview, R1 two cells deep");

  // The click paints it: one ZoneCells in the log, with a player id and a tick.
  await page.mouse.click(...Object.values(await screenAt(page, MID_X, SOUTH_Z - HALF / 2)) as [number, number]);
  await expect.poll(() => zoneLog(page).then((l) => l.length)).toBe(1);
  const [entry] = await zoneLog(page);
  expect(entry?.playerId).toBeTruthy();
  expect(entry?.tick).toBeGreaterThan(0);
  await expect(page.locator("#activity-log tbody tr").first()).toContainText("ZoneCells");
  await expect.poll(() => zonedCount(page)).toBe(count);
  // Two rows and no more, on the north side only.
  for (const row of [0, 1]) {
    const cell = await cellAt(page, MID_X + 2, northRow(SOUTH_Z, row));
    expect(cell?.depth).toBe(row);
    expect(cell?.zone).toBe(RESIDENTIAL);
    expect(cell?.density).toBe(1);
  }
  expect((await cellAt(page, MID_X + 2, northRow(SOUTH_Z, 2)))?.zone).toBe(0);
  expect((await cellAt(page, MID_X + 2, SOUTH_Z + HALF + CELL / 2))?.zone).toBe(0);
  await page.mouse.move(10, 10);
  await expect.poll(() => page.evaluate(() => document.body.dataset["cellsPending"])).toBe("0");
  await frames(page);
  await attach(page, testInfo, "painted R1 strip and one log entry");

  // The same click again would change nothing: the readout says so and nothing is sent.
  await hover(page, MID_X, SOUTH_Z - HALF / 2);
  await expect(readout).toHaveAttribute("data-ok", "false");
  await click(page, MID_X, SOUTH_Z - HALF / 2);
  await frames(page);
  expect(await zoneLog(page)).toHaveLength(1);
  await expect(page.locator("#road-note")).toContainText("no cell would change");

  // Erase clears them.
  await page.locator("#zone-erase").click();
  await hover(page, MID_X, SOUTH_Z - HALF / 2);
  await expect(readout).toHaveAttribute("data-zone", "none");
  await expect(readout).toContainText(`Clear ${count} cells`);
  await click(page, MID_X, SOUTH_Z - HALF / 2);
  await expect.poll(() => zoneLog(page).then((l) => l.length)).toBe(2);
  await expect.poll(() => zonedCount(page)).toBe(0);

  // Leaving the tool puts the overlay back off.
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-menu")).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("false");
});

test("a brush drag across two streets paints cells on both, and Escape drops a stroke", async ({ page }, testInfo) => {
  await openCity(page, twoStreets());
  await look(page, MID_X, SOUTH_Z - 30, 280);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyK");
  await page.locator("#zone-commercial").click();
  await page.locator("#zone-density-2").click();
  await page.locator("#zone-mode-brush").click();
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });

  // From beside the south street, north across the strips of both, to the far side of the north one.
  const from = await screenAt(page, MID_X, northRow(SOUTH_Z, 0));
  const to = await screenAt(page, MID_X + 40, NORTH_Z - HALF - CELL);

  // A stroke dropped with Escape sends nothing.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await frames(page);
  expect(Number(await page.evaluate(() => document.body.dataset["zonePreview"]))).toBeGreaterThan(4);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await frames(page);
  expect(await zoneLog(page)).toHaveLength(0);
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await frames(page);
  await attach(page, testInfo, "brush stroke preview across two streets");
  await page.mouse.up();
  await expect.poll(() => zoneLog(page).then((l) => l.length)).toBe(1);
  await expect.poll(() => zonedCount(page)).toBeGreaterThan(4);

  // Cells beside both streets are C2.
  const south = await cellAt(page, MID_X, northRow(SOUTH_Z, 0));
  const north = await cellAt(page, MID_X + 40, NORTH_Z - HALF - CELL);
  expect(south?.zone).toBe(COMMERCIAL);
  expect(north?.zone).toBe(COMMERCIAL);
  expect(south?.density).toBe(2);
  expect(south?.segment).not.toBe(north?.segment);
  await page.mouse.move(10, 10);
  await expect.poll(() => page.evaluate(() => document.body.dataset["cellsPending"])).toBe("0");
  await frames(page);
  await attach(page, testInfo, "brushed C2 cells on two streets");
});

test("the zone tool's keys are in the shortcut list", async ({ page }) => {
  await page.goto("/?debug&webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const panel = page.locator("#debug-panel");
  await expect(panel).toContainText("zone tool on or off");
  await expect(panel).toContainText("fill one cell deeper");
});
