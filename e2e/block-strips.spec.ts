import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CELL_OPEN, ZONING_BALANCE, cellCorners, cellsInBox, cellsSettled, createState, serialize, step, submit, type SimState } from "../packages/sim/src/index";
import { SEED, groundAt } from "./road-fixtures";
import { canvasShot, openCity, settle } from "./helpers";

// #341: a grid block's cells come from its two long streets only, and two
// strips facing across a block too shallow for both split it row by row.
// Two grids on seed 2026's flat square, three blocks by three, fifteen cells
// wide: one ten cells deep, one seven. The middle block of each has its
// north strip zoned R1 and its south strip C1, written straight into the
// cell arrays, and any cell of an end street I1, so a strip from an end
// street would show in its own colour. Built in Node with the sim and
// imported as a city file. In the evidence project: the pictures are for
// the pull request, and the rules are the sim's unit tests
// (packages/sim/test/frontage.test.ts).
//
// #348: a third city has one grid turned about 13 degrees, blocks twelve
// cells deep. Its road ends snap to the build grid, so each block comes a
// few centimetres short of twelve whole cells along part of its length, and
// the two sixth rows used to overlap there and one gave way. Every strip on
// the north side of its street is zoned R1 and every one on the south side
// C1, so a lost row shows as a bare band between the colours.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

const CELL = ZONING_BALANCE.cellSize;
const ROAD = 10;
const WIDTH = 15;

/** A block's ground between its road edges, metres. */
interface Ground {
  x: number;
  z: number;
  w: number;
  d: number;
  /** The open cells inside it, by which road they belong to. */
  north: number;
  south: number;
  ends: number;
}

const zoneId = (id: string) => 1 + ZONING_BALANCE.zones.findIndex((z) => z.id === id);

/** A three by three grid of blocks `depth` cells deep from (ox, oz), with its middle block zoned as the header says. */
function grid(state: SimState, ox: number, oz: number, depth: number, seq: number): Ground {
  const d = depth * CELL;
  const w = WIDTH * CELL;
  const payload = {
    origin: { x: ox, z: oz },
    along: { x: ox + 3 * (w + ROAD), z: oz },
    across: { x: ox, z: oz + 3 * (d + ROAD) },
    depth: d,
    width: w,
    type: "street",
  };
  const result = submit(state, { seq, playerId: "fixture", type: "BuildRoadGrid", payload });
  if (!result.ok) throw new Error(`grid refused: ${result.reason}`);
  step(state);
  while (!cellsSettled(state)) step(state);
  const g = { x: ox + w + ROAD + ROAD / 2, z: oz + d + ROAD + ROAD / 2, w, d, north: 0, south: 0, ends: 0 };
  const net = state.roads;
  for (const c of cellsInBox(state, g.x, g.z, g.x + g.w, g.z + g.d)) {
    if (c.status !== CELL_OPEN) continue;
    const a = net.segA[c.segment] ?? 0;
    const b = net.segB[c.segment] ?? 0;
    const eastWest = Math.abs((net.nodeX[b] ?? 0) - (net.nodeX[a] ?? 0)) > Math.abs((net.nodeZ[b] ?? 0) - (net.nodeZ[a] ?? 0));
    const north = eastWest && (net.nodeZ[a] ?? 0) < g.z;
    const zone = !eastWest ? "industrial" : north ? "residential" : "commercial";
    if (!eastWest) g.ends++;
    else if (north) g.north++;
    else g.south++;
    state.cells.zone[c.index] = zoneId(zone);
    state.cells.density[c.index] = 1;
  }
  return g;
}

function blockCity(): { bytes: Buffer; deep10: Ground; deep7: Ground } {
  const state = createState(SEED);
  const deep10 = grid(state, 4104, 4408, 10, 1);
  const deep7 = grid(state, 4104, 4700, 7, 2);
  // Saved paused, so nothing grows while the test looks.
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), deep10, deep7 };
}

const fixture = blockCity();

/** Seed 2026's flat square fits a turned grid of blocks fifteen cells wide and twelve deep. */
const TURN_SIN = 5 / 23;
const TURN_COS = Math.sqrt(1 - TURN_SIN * TURN_SIN);
const snap = (v: number) => Math.round(v * 8) / 8;

function turnedCity(): { bytes: Buffer; centre: { x: number; z: number }; north: number; south: number } {
  const state = createState(SEED);
  const ox = 4200;
  const oz = 4420;
  const w = WIDTH * CELL;
  const d = 12 * CELL;
  const along = 3 * (w + ROAD);
  const across = 3 * (d + ROAD);
  const payload = {
    origin: { x: ox, z: oz },
    along: { x: snap(ox + along * TURN_COS), z: snap(oz + along * TURN_SIN) },
    across: { x: snap(ox - across * TURN_SIN), z: snap(oz + across * TURN_COS) },
    depth: d,
    width: w,
    type: "street",
  };
  const result = submit(state, { seq: 1, playerId: "fixture", type: "BuildRoadGrid", payload });
  if (!result.ok) throw new Error(`grid refused: ${result.reason}`);
  step(state);
  while (!cellsSettled(state)) step(state);
  const net = state.roads;
  let north = 0;
  let south = 0;
  for (const c of cellsInBox(state, ox - across - 100, oz - 100, ox + along + 100, oz + along + across + 100)) {
    if (c.status !== CELL_OPEN) continue;
    const a = net.segA[c.segment] ?? 0;
    const b = net.segB[c.segment] ?? 0;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const bx = net.nodeX[b] ?? 0;
    const bz = net.nodeZ[b] ?? 0;
    // Only the long streets' strips: the end streets get no cells in a block this deep.
    if (Math.abs(bx - ax) < Math.abs(bz - az)) continue;
    // North of its street when the cell lies on the side away from the grid's across direction.
    const q = cellCorners(state, c) ?? [0, 0, 0, 0, 0, 0, 0, 0];
    const cx = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
    const cz = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
    const side = (cx - ax) * -TURN_SIN + (cz - az) * TURN_COS;
    const isNorth = side < 0;
    if (isNorth) north++;
    else south++;
    state.cells.zone[c.index] = zoneId(isNorth ? "residential" : "commercial");
    state.cells.density[c.index] = 1;
  }
  state.speed = 0;
  const mid = 1.5;
  const centre = {
    x: ox + mid * (w + ROAD) * TURN_COS - mid * (d + ROAD) * TURN_SIN,
    z: oz + mid * (w + ROAD) * TURN_SIN + mid * (d + ROAD) * TURN_COS,
  };
  return { bytes: Buffer.from(serialize(state)), centre, north, south };
}

const turned = turnedCity();

async function look(page: Page, g: Ground | { centre: { x: number; z: number } }): Promise<void> {
  const cx = "centre" in g ? g.centre.x : g.x + g.w / 2;
  const cz = "centre" in g ? g.centre.z : g.z + g.d / 2;
  const h = groundAt(cx, cz);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[cx, h + 210, cz + 120], [cx, h, cz]] as [Vec3, Vec3]);
  await settle(page);
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const shot = await canvasShot(page);
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the fixture's blocks have cells from their long streets only, split evenly", () => {
  // Fifteen columns, a few lost to the corners' kerbs.
  expect(fixture.deep10.ends).toBe(0);
  expect(fixture.deep10.north).toBe(fixture.deep10.south);
  expect(fixture.deep10.north).toBeGreaterThanOrEqual(5 * (WIDTH - 2));
  expect(fixture.deep7.ends).toBe(0);
  expect(fixture.deep7.north / 4).toBeCloseTo(fixture.deep7.south / 3, 0);
});

test("the zoning overlay shows two strips in each block", async ({ page }, testInfo) => {
  await openCity(page, fixture.bytes, { query: "webgl", name: "Block strips" });
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 120_000 });
  await look(page, fixture.deep10);
  await shoot(page, testInfo, "a block ten cells deep");
  await look(page, fixture.deep7);
  await shoot(page, testInfo, "a block seven cells deep");
});

test("a turned grid's blocks twelve cells deep keep all six rows of both strips", async ({ page }, testInfo) => {
  // Each block's north strip faces the next block's south strip across the street, and the two outer strips face no block.
  expect(turned.north).toBe(turned.south);
  await openCity(page, turned.bytes, { query: "webgl", name: "Turned grid" });
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 120_000 });
  await look(page, turned);
  await shoot(page, testInfo, "a turned grid, blocks twelve cells deep");
});
