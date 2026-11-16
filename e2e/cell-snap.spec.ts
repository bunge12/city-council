import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ROAD_TYPES, ZONING_BALANCE, createState, generateTerrain, heightAt, serialize, step, submit, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M2-08: the road tool snaps to zoned cells. A player draws a street
// along the back of a zoned strip, both clicks a few pixels off its
// corners. The ends land clear of the cells, and no cell of the strip is
// blocked afterwards. With the Cells toggle off the same pointer snaps to
// nothing.
//
// The city is built and zoned in Node with the sim and imported as a city file.

type Vec3 = readonly [number, number, number];
interface SnapInfo {
  kind: string;
  x: number;
  z: number;
}
interface CellInfo {
  status: number;
  index: number;
}
declare const window: {
  cityCouncil: {
    mirror: {
      state: { log: unknown[]; cells: { zone: ArrayLike<number> } } | null;
      cellAt(x: number, z: number): CellInfo | null;
    };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      snap(): SnapInfo | null;
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const STREET = ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0;
/** The setback the tool keeps between a road on the outline and the cells (`CELL_SNAP.clearance`). */
const CLEARANCE = 0.25;

// A street west to east along z = 4600. Its north side is zoned R1 from
// x = 4232 to 4296, eight places, every row, so the back of the strip is a
// straight line at z = 4547 with nothing behind it.
const Z = 4600;
const EDGE = Z - STREET / 2;
const BACK = EDGE - DEPTH * CELL;
const X0 = 4232;
const X1 = 4296;
/** The centre line of a street drawn along the back, clear of the cells. */
const BEHIND = BACK - STREET / 2 - CLEARANCE;

function zonedStrip(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4200, Z], [4392, Z], "street"]]);
  const mid = (EDGE + BACK) / 2;
  const result = submit(state, {
    seq: 1000,
    playerId: "fixture",
    type: "ZoneCells",
    payload: { zone: "residential", density: 1, rects: [{ from: { x: X0 + 1, z: mid }, to: { x: X1 - 1, z: mid }, width: DEPTH * CELL - 2 }] },
  });
  if (!result.ok) throw new Error(result.reason);
  for (let i = 0; i < 5; i++) step(state);
  return state;
}

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Cells.city", mimeType: "application/octet-stream", buffer: Buffer.from(serialize(state)) });
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
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, heightAt(terrain, x, z), z] as const);
}

async function hover(page: Page, x: number, z: number, off: [number, number]): Promise<SnapInfo | null> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x + off[0], p.y + off[1], { steps: 4 });
  await frames(page);
  return page.evaluate(async () => (await window.cityCouncil.camera).snap());
}

async function click(page: Page, x: number, z: number, off: [number, number]): Promise<SnapInfo | null> {
  const snap = await hover(page, x, z, off);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x + off[0], p.y + off[1]);
  await frames(page);
  return snap;
}

/** Whether each cell of the zoned run is open and zoned, by its centre. */
async function strip(page: Page): Promise<{ open: boolean; zoned: boolean }[]> {
  const centres: [number, number][] = [];
  for (let x = X0 + CELL / 2; x < X1; x += CELL) for (let row = 0; row < DEPTH; row++) centres.push([x, EDGE - row * CELL - CELL / 2]);
  return page.evaluate((points) => {
    const { mirror } = window.cityCouncil;
    return points.map(([x, z]) => {
      const cell = mirror.cellAt(x, z);
      return { open: cell?.status === 0, zoned: cell ? (mirror.state?.cells.zone[cell.index] ?? 0) !== 0 : false };
    });
  }, centres);
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("a street drawn along the back of a zoned strip snaps to its corners and leaves every cell whole", async ({ page }, testInfo) => {
  await openCity(page, zonedStrip());
  await look(page, (X0 + X1) / 2, BACK + 10, 150);
  // The zone tool shows the strip, for the first screenshot.
  await page.locator("#view").focus();
  await page.keyboard.press("KeyK");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  await attach(page, testInfo, "the zoned strip, before");
  expect((await strip(page)).every((c) => c.open && c.zoned)).toBe(true);
  expect(await strip(page)).toHaveLength(8 * DEPTH);

  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyZ");
  await expect(page.locator("#guide-cells")).toHaveAttribute("aria-pressed", "true");
  const log0 = await page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);

  // The first click, a few pixels off the strip's back corner.
  const startX = X0 - STREET / 2 - CLEARANCE;
  const start = await hover(page, startX, BEHIND, [5, -4]);
  expect(start?.kind).toBe("corner");
  await attach(page, testInfo, "the start snaps to the back corner of the strip");
  await click(page, startX, BEHIND, [5, -4]);

  // Along the back, the end slides on the line behind the strip.
  const along = await hover(page, (X0 + X1) / 2 + 3, BEHIND, [0, 5]);
  expect(["edge", "corner"]).toContain(along?.kind);
  expect(along?.z).toBeCloseTo(BEHIND, 3);
  await attach(page, testInfo, "the end slides along the back of the strip");

  // The second click, a few pixels off the far corner.
  const endX = X1 + STREET / 2 + CLEARANCE;
  const end = await click(page, endX, BEHIND, [-4, 5]);
  expect(end?.kind).toBe("corner");
  expect(end?.x).toBeCloseTo(endX, 3);
  expect(end?.z).toBeCloseTo(BEHIND, 3);
  await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0)).toBe(log0 + 1);
  await page.keyboard.press("Escape");

  // Every cell of the strip is still open and zoned.
  await expect.poll(async () => (await strip(page)).every((c) => c.open && c.zoned)).toBe(true);
  await page.keyboard.press("KeyK");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  await attach(page, testInfo, "the street along the back, every cell still zoned");
});

test("the Cells toggle turns the source off", async ({ page }, testInfo) => {
  await openCity(page, zonedStrip());
  await look(page, (X0 + X1) / 2, BACK + 10, 150);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyZ");
  const at = { x: X0 + 3 * CELL, z: BEHIND };
  expect((await hover(page, at.x, at.z, [4, 4]))?.kind).toBe("corner");
  await page.locator("#guide-cells").click();
  await expect(page.locator("#guide-cells")).toHaveAttribute("aria-pressed", "false");
  const off = await hover(page, at.x, at.z, [4, 3]);
  expect(["corner", "edge"]).not.toContain(off?.kind);
  await attach(page, testInfo, "cells toggle off: no cell snap");
  await page.locator("#guide-cells").click();
  expect((await hover(page, at.x, at.z, [4, 4]))?.kind).toBe("corner");
});
