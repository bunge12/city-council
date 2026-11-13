import { describe, expect, it } from "vitest";
import {
  LEVEL_GROUND,
  ROAD_BUILD,
  blockIndexOf,
  createBareState,
  deserialize,
  gridLines,
  hashState,
  heightAt,
  listBlocks,
  planRoadGrid,
  serialize,
  step,
  submit,
  type Command,
  type CommandResult,
  type GridPlan,
  type SimState,
} from "../src/index";
import { isSegment, nodeCount, segmentCount, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/grid.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

// Issue M1-20: BuildRoadGrid.

const fixture = fixtureJson as ReplayFixture;

// Places on the map of seed 2026 (build-road.test.ts and bridges.test.ts).
// The first test checks each is still what these tests think it is.
const SEED = 2026;
/** A dry, nearly flat square from (4100, 4400) to (4700, 5000). */
const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };
/** Dry land north of an inlet that widens to the south-west, around (3300 to 3800, 6600 to 6900). */
const INLET = { x0: 3300, z0: 6400, x1: 3800, z1: 6800 };
/** Dry ground, steep in patches, from (1800, 1150) to (2088, 1438). */
const HILL = { x0: 1800, z0: 1150, x1: 2088, z1: 1438 };

/** Street blocks 86 m between edges put street centre lines 96 m apart. */
const BLOCK = 86;
const SPACING = 96;

const seqs = new Map<string, number>();
function command(type: string, payload: unknown, playerId = "p1"): Command {
  const seq = (seqs.get(playerId) ?? 0) + 1;
  seqs.set(playerId, seq);
  return { seq, playerId, type, payload };
}

function road(from: [number, number], to: [number, number], type = "street"): Command {
  return command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });
}

function gridPayload(origin: [number, number], along: [number, number], across: [number, number], depth = BLOCK, width = BLOCK, type = "street") {
  return {
    origin: { x: origin[0], z: origin[1] },
    along: { x: along[0], z: along[1] },
    across: { x: across[0], z: across[1] },
    depth,
    width,
    type,
  };
}

/** A grid of `cols` by `rows` street blocks from `origin`, lined up with the map. */
function squareGrid(origin: [number, number], cols: number, rows: number) {
  const [x, z] = origin;
  return gridPayload(origin, [x + cols * SPACING, z], [x, z + rows * SPACING]);
}

const grid = (payload: unknown, playerId = "p1") => command("BuildRoadGrid", payload, playerId);
const undo = (playerId = "p1") => command("Undo", {}, playerId);

function run(state: SimState, c: Command): CommandResult {
  const result = submit(state, c);
  step(state);
  return result;
}

function ok(state: SimState, c: Command): void {
  expect(run(state, c)).toEqual({ ok: true });
}

function refusal(state: SimState, c: Command): string {
  const result = submit(state, c);
  expect(result.ok, "the command should be refused").toBe(false);
  return result.ok ? "" : result.reason;
}

/** The state hash leaving out the log, the undo history and the tick. */
function cityHash(state: SimState): string {
  return hashState({ ...state, tick: 0, log: [], logOffset: 0, undo: [] });
}

function plan(state: SimState, payload: unknown): GridPlan {
  const result = planRoadGrid(state.roads, terrainOf(SEED), payload);
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

const key = (ax: number, az: number, bx: number, bz: number): string =>
  ax < bx || (ax === bx && az < bz) ? `${ax},${az}-${bx},${bz}` : `${bx},${bz}-${ax},${az}`;

/** Every link the plan builds, ends in a fixed order. */
function plannedLinks(p: GridPlan): string[] {
  return p.streets.flatMap((s) => s.points.slice(1).map((b, k) => key(s.points[k]?.x ?? 0, s.points[k]?.z ?? 0, b.x, b.z))).sort();
}

/** Every live segment by its ends. */
function builtLinks(net: RoadNetwork): string[] {
  const out: string[] = [];
  for (let s = 0; s < segmentIdLimit(net); s++) {
    if (!isSegment(net, s)) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    out.push(key(net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0, net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0));
  }
  return out.sort();
}

function blocks(state: SimState): number {
  return listBlocks(blockIndexOf(state.roads)).length;
}

describe("the test map", () => {
  it("has the places these tests use", () => {
    const t = terrainOf(SEED);
    for (let x = FLAT.x0; x <= FLAT.x1; x += 50) {
      for (let z = FLAT.z0; z <= FLAT.z1; z += 50) expect(heightAt(t, x, z)).toBeGreaterThan(t.waterLevel + 1);
    }
    expect(heightAt(t, INLET.x0, INLET.z0)).toBeGreaterThan(t.waterLevel);
    expect(heightAt(t, 3500, 6750)).toBeLessThan(t.waterLevel);
    // The hill is dry all over, so any cut there is the slope's.
    for (let x = HILL.x0; x <= HILL.x1; x += 8) {
      for (let z = HILL.z0; z <= HILL.z1; z += 8) expect(heightAt(t, x, z)).toBeGreaterThan(t.waterLevel);
    }
  });
});

describe("gridLines", () => {
  it("puts a line every block and one on the far side", () => {
    expect(gridLines(384, 96, 86, 10)).toEqual([0, 96, 192, 288, 384]);
  });

  it("gives the last block what is left when that is a block's worth", () => {
    // 66 m left is 56 m between road edges, over half of 86.
    expect(gridLines(450, 96, 86, 10)).toEqual([0, 96, 192, 288, 384, 450]);
  });

  it("joins a leftover too small for a block to its neighbour", () => {
    // 16 m left is 6 m between road edges.
    expect(gridLines(400, 96, 86, 10)).toEqual([0, 96, 192, 288, 400]);
  });
});

describe("BuildRoadGrid", () => {
  it("lays a 4 by 4 block grid on open ground as one log entry", () => {
    const state = createBareState(SEED);
    const payload = squareGrid([4200, 4500], 4, 4);
    const p = plan(state, payload);
    expect(p.lines).toBe(10);
    expect(p.streets).toHaveLength(10);
    expect(p.streets.every((s) => s.points.length === 5 && !s.cutStart && !s.cutEnd)).toBe(true);
    expect(p.length).toBe(10 * 4 * SPACING);
    expect(p.cost).toBe(Math.round(p.length * p.type.buildCostPerMetre));

    ok(state, grid(payload));
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoadGrid"]);
    expect(state.undo).toHaveLength(1);
    expect(nodeCount(state.roads)).toBe(25);
    expect(segmentCount(state.roads)).toBe(40);
    expect(blocks(state)).toBe(16);
    expect(builtLinks(state.roads)).toEqual(plannedLinks(p));
  });

  it("lays a grid at an angle, the client having turned the rectangle", () => {
    const state = createBareState(SEED);
    // Sides of 300 m along (0.8, 0.6) and (-0.6, 0.8). The fourth line along
    // each would leave 2 m between road edges, so the last block is 108 m.
    const payload = gridPayload([4400, 4420], [4640, 4600], [4220, 4660]);
    const p = plan(state, payload);
    expect(p.lines).toBe(8);
    ok(state, grid(payload));
    expect(segmentCount(state.roads)).toBe(24);
    expect(blocks(state)).toBe(9);
    expect(builtLinks(state.roads)).toEqual(plannedLinks(p));
    // Every segment runs along one of the two sides.
    const net = state.roads;
    for (let s = 0; s < segmentIdLimit(net); s++) {
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      const dx = (net.nodeX[b] ?? 0) - (net.nodeX[a] ?? 0);
      const dz = (net.nodeZ[b] ?? 0) - (net.nodeZ[a] ?? 0);
      const len = Math.sqrt(dx * dx + dz * dz);
      const along = Math.abs(dx * 0.8 + dz * 0.6) / len;
      const across = Math.abs(-dx * 0.6 + dz * 0.8) / len;
      expect(Math.max(along, across)).toBeGreaterThan(0.9999);
    }
  });

  it("stops streets at water and never builds a bridge", () => {
    const state = createBareState(SEED);
    const payload = gridPayload([INLET.x0, INLET.z0], [INLET.x1, INLET.z0], [INLET.x0, INLET.z1]);
    const p = plan(state, payload);
    expect(p.streets.some((s) => s.cutStart || s.cutEnd)).toBe(true);
    ok(state, grid(payload));
    expect(builtLinks(state.roads)).toEqual(plannedLinks(p));
    const t = terrainOf(SEED);
    const net = state.roads;
    for (let s = 0; s < segmentIdLimit(net); s++) {
      expect(net.segLevelA[s]).toBe(LEVEL_GROUND);
      // Dry all along.
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      for (let k = 0; k <= 16; k++) {
        const x = (net.nodeX[a] ?? 0) + (((net.nodeX[b] ?? 0) - (net.nodeX[a] ?? 0)) * k) / 16;
        const z = (net.nodeZ[a] ?? 0) + (((net.nodeZ[b] ?? 0) - (net.nodeZ[a] ?? 0)) * k) / 16;
        expect(heightAt(t, x, z)).toBeGreaterThan(t.waterLevel);
      }
    }
  });

  it("stops streets where the ground gets too steep", () => {
    const state = createBareState(SEED);
    const payload = squareGrid([HILL.x0, HILL.z0], 3, 3);
    const p = plan(state, payload);
    const cut = p.streets.filter((s) => s.cutStart || s.cutEnd);
    expect(cut.length).toBeGreaterThan(0);
    expect(plannedLinks(p).length).toBeLessThan(24);
    ok(state, grid(payload));
    expect(builtLinks(state.roads)).toEqual(plannedLinks(p));
  });

  it("splits an existing road it is laid across", () => {
    const state = createBareState(SEED);
    // A diagonal through the grid's lattice points.
    ok(state, road([4150, 4450], [4650, 4950]));
    ok(state, grid(squareGrid([4200, 4500], 4, 4)));
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoadGrid"]);
    // The diagonal cuts each block along it in two.
    expect(blocks(state)).toBe(20);
    // It runs on through the grid's corners, each with four roads meeting.
    expect(nodeCount(state.roads)).toBe(25 + 2);
  });

  it("refuses the whole grid when a street would cross a road at too shallow an angle", () => {
    const state = createBareState(SEED);
    // About 5 degrees off the line z = 4596.
    ok(state, road([4180, 4580], [4620, 4620]));
    const before = serialize(state);
    expect(refusal(state, grid(squareGrid([4200, 4500], 4, 4)))).toMatch(
      /^Street \d+ of \d+ in the grid: The road crosses another road at too shallow an angle/,
    );
    // The rehearsal left no trace.
    expect(serialize(state)).toEqual(before);
    step(state);
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad"]);
  });

  it("joins a road it is started on, and builds nothing along it", () => {
    const state = createBareState(SEED);
    ok(state, road([4200, 4500], [4584, 4500]));
    ok(state, grid(squareGrid([4200, 4500], 4, 4)));
    expect(segmentCount(state.roads)).toBe(40);
    expect(nodeCount(state.roads)).toBe(25);
    expect(blocks(state)).toBe(16);
  });

  it("carries on past the end of a shorter road it is started on", () => {
    const state = createBareState(SEED);
    ok(state, road([4200, 4500], [4392, 4500]));
    const p = plan(state, squareGrid([4200, 4500], 4, 4));
    // The first two links of the first street lie along the road.
    expect(plannedLinks(p)).toHaveLength(38);
    ok(state, grid(squareGrid([4200, 4500], 4, 4)));
    expect(segmentCount(state.roads)).toBe(40);
    expect(blocks(state)).toBe(16);
  });

  it("is taken back whole by one undo, rejoining the road it split", () => {
    const state = createBareState(SEED);
    ok(state, road([4150, 4450], [4650, 4950]));
    const before = cityHash(state);
    const bytes = serialize({ ...state, tick: 0, log: [], logOffset: 0, undo: [] });
    ok(state, grid(squareGrid([4200, 4500], 4, 4)));
    expect(segmentCount(state.roads)).toBeGreaterThan(40);
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
    expect(serialize({ ...state, tick: 0, log: [], logOffset: 0, undo: [] })).toEqual(bytes);
    expect(segmentCount(state.roads)).toBe(1);
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoadGrid", "Undo"]);
  });

  it("plans the same streets on the mirror's copy as the sim builds", () => {
    const state = createBareState(SEED);
    // It ends part way along the grid's third block, where the grid's
    // first street takes over from it.
    ok(state, road([4200, 4500], [4430, 4500]));
    const payload = squareGrid([4200, 4500], 4, 4);
    const mirror = deserialize(serialize(state)).state.roads;
    const onMirror = planRoadGrid(mirror, terrainOf(SEED), payload);
    expect(onMirror).toEqual(planRoadGrid(state.roads, terrainOf(SEED), payload));
    const planned = plannedLinks(plan({ ...state, roads: mirror }, payload));
    ok(state, grid(payload));
    // The first street starts where the road ends.
    expect(planned).toContain(key(4430, 4500, 4488, 4500));
    // Each planned link is built, beside the three pieces of the road the
    // grid started on, which the streets across split twice.
    const built = builtLinks(state.roads);
    for (const link of planned) expect(built).toContain(link);
    expect(built).toHaveLength(planned.length + 3);
  });

  it("leaves the network as it was after checking a grid", () => {
    const state = createBareState(SEED);
    ok(state, road([4150, 4450], [4650, 4950]));
    const before = serialize(state);
    expect(submit(state, grid(squareGrid([4200, 4500], 4, 4)))).toEqual({ ok: true });
    expect(serialize({ ...state, pending: [] })).toEqual(before);
  });

  it("drops a grid that an earlier command in the same tick made invalid", () => {
    const state = createBareState(SEED);
    expect(submit(state, road([4180, 4580], [4620, 4620]))).toEqual({ ok: true });
    expect(submit(state, grid(squareGrid([4200, 4500], 4, 4)))).toEqual({ ok: true });
    step(state);
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad"]);
    expect(state.undo).toHaveLength(1);
    expect(segmentCount(state.roads)).toBe(1);
  });

  it(`refuses a grid of more than ${ROAD_BUILD.gridMaxStreets} streets`, () => {
    const state = createBareState(SEED);
    expect(refusal(state, grid(squareGrid([4100, 4400], 7, 6)))).toBe(
      `Too many streets: the grid has 15, and the most one grid can lay is ${ROAD_BUILD.gridMaxStreets}`,
    );
  });

  it("refuses a bad grid with a reason", () => {
    const state = createBareState(SEED);
    expect(refusal(state, grid(null))).toBe("BuildRoadGrid needs three corners, a block depth and width, and a road type");
    expect(refusal(state, grid({ ...squareGrid([4200, 4500], 2, 2), origin: { x: "a", z: 0 } }))).toBe(
      "BuildRoadGrid needs three corners, each with a finite x and z",
    );
    expect(refusal(state, grid({ ...squareGrid([4200, 4500], 2, 2), type: "boulevard" }))).toBe('There is no road type "boulevard"');
    expect(refusal(state, grid({ ...squareGrid([4200, 4500], 2, 2), type: "highway" }))).toBe("Highways cannot be built yet");
    expect(refusal(state, grid({ ...squareGrid([4200, 4500], 2, 2), depth: 5 }))).toBe("Blocks must be at least 10 m deep and wide");
    expect(refusal(state, grid(gridPayload([4200, 4500], [4250, 4500], [4200, 4700])))).toBe(
      "The grid must be at least one block deep and one block wide",
    );
    expect(refusal(state, grid(gridPayload([4200, 4500], [4400, 4500], [4250, 4700])))).toBe("The grid's corners must make a rectangle");
    expect(refusal(state, grid(squareGrid([-100, 4500], 2, 2)))).toBe("The grid runs off the map");
  });
});

describe("replay fixture grid", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoadGrid", "BuildRoadGrid", "Undo"]);
  });
});
