import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CONNECTION_BALANCE, DEMAND_BALANCE, NONE, TIME_BALANCE, ZONING_BALANCE, cellAt, connectionEnd, createState, generateTerrain, heightAt, landValueAt, step, submit, type Command, type SimState } from "../packages/sim/src/index";
import { HELD_DEMAND_STATE } from "./browser-state";
import { frames, openCity, settle } from "./helpers";
import { holdDemand } from "../packages/sim/test/demand-helper";
import { isSegment, segmentIdLimit } from "../packages/sim/src/roads/network";

// M3-25: the best ground fills first. Seed 2026's first outside connection
// runs east into dry ground with the coast about 700 m south. A street runs
// east from the connection past a row of I3 factories, and a second runs
// south from it to the shore. R1 is zoned six deep along the south street's
// last 16 places, by the water, and on the first street's south side facing
// the factories, where pollution takes most of the ground's value.
//
// The city is built in Node with the factories grown, and opened with every
// bar held at 25 (HELD_DEMAND_STATE). Houses fill the strip by the water
// first; the strip beside the factories gets none until that one is full.

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const SCREENSHOTS = join("test-results", "land-value-order");
const terrain = generateTerrain(SEED);

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: { state: { buildings: { flags: Uint8Array; residents: Int32Array; firstSeg: Int32Array } } | null };
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};

declare const document: { body: { dataset: Record<string, string | undefined> } };

interface City {
  bytes: SimState;
  /** Segment ids of the south street's strip by the water, and of the first street's stretch facing the factories. */
  water: number[];
  factories: number[];
  /** Where to look: the middle of the two strips. */
  x: number;
  z: number;
  /** The land value of a front cell on each strip, for the report. */
  values: { water: number; factories: number };
}

let seq = 0;
function apply(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "fixture", type, payload };
  const result = submit(state, c);
  if (!result.ok) throw new Error(`${type}: ${result.reason}`);
  // A stroke waits for a change of roads to settle before it applies.
  for (let i = 0; i < 2000 && state.log.at(-1)?.seq !== c.seq; i++) step(state);
  if (state.log.at(-1)?.seq !== c.seq) throw new Error(`${type} did not apply`);
}

function zone(state: SimState, zoneId: string, density: number, from: { x: number; z: number }, to: { x: number; z: number }): void {
  apply(state, "ZoneCells", { zone: zoneId, density, rects: [{ from, to, width: 44 }] });
}

/** Segments with both ends within `d` metres of the line from (x0, z0) to (x1, z1), an axis-aligned one. */
function segmentsAlong(state: SimState, x0: number, z0: number, x1: number, z1: number, d = 1): number[] {
  const r = state.roads;
  const out: number[] = [];
  const inBox = (n: number) => {
    const x = r.nodeX[n] ?? 0;
    const z = r.nodeZ[n] ?? 0;
    return x >= Math.min(x0, x1) - d && x <= Math.max(x0, x1) + d && z >= Math.min(z0, z1) - d && z <= Math.max(z0, z1) + d;
  };
  for (let seg = 0; seg < segmentIdLimit(r); seg++) if (isSegment(r, seg) && inBox(r.segA[seg] ?? -1) && inBox(r.segB[seg] ?? -1)) out.push(seg);
  return out;
}

function buildCity(): City {
  seq = 0;
  const state = createState(SEED);
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  if (((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength !== 1) throw new Error("the first connection no longer runs east");
  const x0 = r.nodeX[inner] ?? 0;
  const z0 = r.nodeZ[inner] ?? 0;
  const xs = x0 + CELL * 32;
  const zs = z0 + CELL * 80;
  apply(state, "BuildRoad", { from: { x: x0, z: z0 }, to: { x: x0 + CELL * 96, z: z0 }, type: "street" });
  apply(state, "BuildRoad", { from: { x: xs, z: z0 }, to: { x: xs, z: zs }, type: "street" });
  zone(state, "industrial", 3, { x: x0 + CELL * 72 + 2, z: z0 - 29 }, { x: x0 + CELL * 96 - 2, z: z0 - 29 });
  // The factories first, with no workers to hold them back.
  const was = DEMAND_BALANCE.openJobsShareMax;
  DEMAND_BALANCE.openJobsShareMax = 1;
  try {
    holdDemand({ industrial: 100, residential: -1, commercial: -1, office: -1 }, () => {
      for (let i = 0; i < 20 * DAY; i++) step(state);
    });
  } finally {
    DEMAND_BALANCE.openJobsShareMax = was;
  }
  for (const side of [-1, 1]) zone(state, "residential", 1, { x: xs + side * 29, z: zs - CELL * 16 + 2 }, { x: xs + side * 29, z: zs - 2 });
  zone(state, "residential", 1, { x: x0 + CELL * 70 + 2, z: z0 + 29 }, { x: x0 + CELL * 94 - 2, z: z0 + 29 });
  apply(state, "SetSpeed", { speed: 0 });
  // Only the two strips are zoned R1, so a house on the south street is by the water and one on the first street east of it faces the factories.
  const water = segmentsAlong(state, xs, z0, xs, zs);
  const factories = segmentsAlong(state, xs, z0, x0 + CELL * 96, z0);
  if (water.length === 0 || factories.length === 0) throw new Error("no strip segments");
  // The best front cell of each strip, by the cells' own value.
  const best = (x: number, z: number, dx: number, dz: number, n: number) => {
    let v = -1;
    for (let k = 0; k < n; k++) {
      const cell = cellAt(state, x + dx * k * CELL, z + dz * k * CELL);
      if (cell) v = Math.max(v, landValueAt(state, cell)?.value ?? -1);
    }
    return v;
  };
  const values = { water: best(xs - 9, zs - CELL * 15.5, 0, 1, 15), factories: best(x0 + CELL * 70.5, z0 + 9, 1, 0, 24) };
  return { bytes: state, water, factories, x: (xs + x0 + CELL * 82) / 2, z: (z0 + zs) / 2, values };
}

/** Homes in the page's copy of the city on each strip. */
async function homes(page: Page, city: City): Promise<{ water: number; factories: number }> {
  return page.evaluate(
    ([water, factories]) => {
      const b = window.cityCouncil.mirror.state?.buildings;
      const out = { water: 0, factories: 0 };
      b?.flags.forEach((f, id) => {
        if (f === 0 || (b.residents[id] ?? 0) === 0) return;
        const seg = b.firstSeg[id] ?? -1;
        if (water.includes(seg)) out.water++;
        else if (factories.includes(seg)) out.factories++;
      });
      return out;
    },
    [city.water, city.factories] as const,
  );
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0", null, { timeout: 60_000 });
  await settle(page, { timeout: 60_000 });
  mkdirSync(SCREENSHOTS, { recursive: true });
  const body = await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
  await info.attach(name, { body, contentType: "image/png" });
}

test.use({ viewport: { width: 1280, height: 800 }, storageState: HELD_DEMAND_STATE });

test("houses fill the strip by the water before the strip beside the factories", async ({ page }, info) => {
  test.setTimeout(180_000);
  const city = buildCity();
  expect(city.values.water).toBeGreaterThan(city.values.factories + 30);
  await openCity(page, city.bytes, { query: "webgl", name: "shore and factories" });
  const g = heightAt(terrain, city.x, city.z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [
    [city.x, g + 1050, city.z + 330],
    [city.x, g, city.z + 70],
  ] as const);
  await frames(page);
  await shot(page, info, "1-zoned");

  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  // Houses come at a handful a game day with the bars at 25, and each goes by the water while it has free ground.
  await expect.poll(async () => (await homes(page, city)).water, { timeout: 60_000 }).toBeGreaterThanOrEqual(8);
  expect((await homes(page, city)).factories).toBe(0);
  await shot(page, info, "2-by-the-water-first");

  await expect.poll(async () => (await homes(page, city)).factories, { timeout: 90_000 }).toBeGreaterThan(0);
  const both = await homes(page, city);
  await shot(page, info, "3-then-beside-the-factories");
  await info.attach("homes", { body: JSON.stringify({ ...both, values: city.values }), contentType: "application/json" });
});
