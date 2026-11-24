import { describe, expect, it } from "vitest";
import { CELL_OPEN, ZONING_BALANCE, cellAt, cellStatuses, createState, step, type Command, type SimState } from "../src/index";
import { cloneState } from "../src/state";
import { NO_TIER, isSegment, segmentIdLimit } from "../src/roads/network";
import { settleCells } from "../src/zoning/cell-index";
import { submit } from "./seen-ends";

// #341: which side of its block a strip fronts decides who gets the ground
// between roads of one age.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts). A street is 10 m wide.
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const ROAD = 10;
const OX = 4104;
const OZ = 4408;
const WIDTH_M = (cells: number) => cells * CELL;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
  settleCells(state);
}
const road = (from: [number, number], to: [number, number]) =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" });

/** A grid of three by three blocks `depth` by `width` cells between road edges. Returns the middle block's ground. */
function grid(state: SimState, depth: number, width: number): Ground {
  const d = depth * CELL;
  const w = width * CELL;
  ok(
    state,
    command("BuildRoadGrid", {
      origin: { x: OX, z: OZ },
      along: { x: OX + 3 * (w + ROAD), z: OZ },
      across: { x: OX, z: OZ + 3 * (d + ROAD) },
      depth: d,
      width: w,
      type: "street",
    }),
  );
  return { x: OX + w + ROAD + ROAD / 2, z: OZ + d + ROAD + ROAD / 2, w, d };
}

/** A block's ground between its road edges, metres. */
interface Ground {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** Whether segment `seg` runs more east-west than north-south. */
function eastWest(state: SimState, seg: number): boolean {
  const net = state.roads;
  const a = net.segA[seg] ?? 0;
  const b = net.segB[seg] ?? 0;
  return Math.abs((net.nodeX[b] ?? 0) - (net.nodeX[a] ?? 0)) > Math.abs((net.nodeZ[b] ?? 0) - (net.nodeZ[a] ?? 0));
}

/** The segment holding the open cell at (x, z), or -1. */
function owner(state: SimState, x: number, z: number): number {
  const c = cellAt(state, x, z);
  return c && c.status === CELL_OPEN ? c.segment : -1;
}

/**
 * Down a line across the block at `x`, a metre at a time: how many metres
 * the strip along its north edge holds, and the one along its south edge.
 */
function split(state: SimState, g: Ground, x = g.x + g.w / 2): { north: number; south: number } {
  const top = owner(state, x, g.z + 0.5);
  const bottom = owner(state, x, g.z + g.d - 0.5);
  let north = 0;
  let south = 0;
  for (let m = 0; m < g.d; m++) {
    const o = owner(state, x, g.z + m + 0.5);
    if (o === top && top >= 0) north++;
    else if (o === bottom && bottom >= 0) south++;
  }
  return { north, south };
}

/** The open cells inside the block, more than a cell from its ends, as which way their roads run: [east-west, north-south, no cell]. */
function owners(state: SimState, g: Ground): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let x = g.x + CELL; x <= g.x + g.w - CELL; x += 2) {
    for (let z = g.z + 0.5; z < g.z + g.d; z += 2) {
      const o = owner(state, x, z);
      out[o < 0 ? 2 : eastWest(state, o) ? 0 : 1]++;
    }
  }
  return out;
}

function live(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(state.roads); id++) if (isSegment(state.roads, id)) out.push(id);
  return out;
}

/** Every cell's status kept current agrees with a walk from scratch. */
function expectFresh(state: SimState): void {
  expect(Array.from(cellStatuses(state))).toEqual(Array.from(cellStatuses(cloneState(state))));
}

describe("a grid block's frontage", () => {
  it("gives a block twelve cells deep to its two long streets, six rows each, and nothing to its ends", () => {
    const state = createState(SEED);
    const g = grid(state, 12, 24);
    expect(owners(state, g)).toEqual([expect.any(Number), 0, 0]);
    expect(split(state, g)).toEqual({ north: 6 * CELL, south: 6 * CELL });
    // The corners too, right up to the end streets.
    expect(split(state, g, g.x + CELL / 2 + 2)).toEqual({ north: 6 * CELL, south: 6 * CELL });
    expect(split(state, g, g.x + g.w - CELL / 2 - 2)).toEqual({ north: 6 * CELL, south: 6 * CELL });
  });

  it("splits a block ten cells deep five and five", () => {
    const state = createState(SEED);
    const g = grid(state, 10, 15);
    expect(owners(state, g)).toEqual([expect.any(Number), 0, 0]);
    expect(split(state, g)).toEqual({ north: 5 * CELL, south: 5 * CELL });
  });

  it("splits a block seven cells deep four and three, leaving no strip too shallow to build on", () => {
    const state = createState(SEED);
    const g = grid(state, 7, 15);
    const { north, south } = split(state, g);
    expect([north, south].sort((p, q) => p - q)).toEqual([3 * CELL, 4 * CELL]);
  });

  it("gives a square block's corners to one pair of facing streets", () => {
    const state = createState(SEED);
    const g = grid(state, 12, 12);
    const [ew, ns, none] = owners(state, g);
    expect(none).toBe(0);
    expect(ew === 0 || ns === 0).toBe(true);
  });

  it("treats a long side a street joins from outside as one side", () => {
    const state = createState(SEED);
    const g = grid(state, 10, 24);
    // A dead end south from the middle of the block's south street, outside the block.
    const zSouth = g.z + g.d + ROAD / 2;
    ok(state, road([g.x + g.w / 2 - 4, zSouth], [g.x + g.w / 2 - 4, zSouth + 40]));
    expect(owners(state, g)).toEqual([expect.any(Number), 0, 0]);
    expect(split(state, g, g.x + 3 * CELL)).toEqual({ north: 5 * CELL, south: 5 * CELL });
    expect(split(state, g, g.x + g.w - 3 * CELL)).toEqual({ north: 5 * CELL, south: 5 * CELL });
    expectFresh(state);
  });
});

describe("roads of different ages", () => {
  it("lets the older road keep all six rows, so a new road never takes the back of a strip", () => {
    const state = createState(SEED);
    const west = 4200;
    const east = 4400;
    const north = 4600;
    const south = north + ROAD + 10 * CELL;
    ok(state, road([west, north], [east, north]));
    ok(state, road([west, south], [east, south]));
    ok(state, road([west, north], [west, south]));
    ok(state, road([east, north], [east, south]));
    const g = { x: west + ROAD / 2, z: north + ROAD / 2, w: east - west - ROAD, d: 10 * CELL };
    expect(split(state, g)).toEqual({ north: 6 * CELL, south: 4 * CELL });
  });
});

describe("tiers stay as the road was built (#341)", () => {
  /** The live segments of `state` with both ends at x = `x`, running across `z`. */
  function northSouthAt(state: SimState, x: number, z: number): number[] {
    const net = state.roads;
    return live(state).filter((s) => {
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      return net.nodeX[a] === x && net.nodeX[b] === x && Math.min(net.nodeZ[a] ?? 0, net.nodeZ[b] ?? 0) < z && Math.max(net.nodeZ[a] ?? 0, net.nodeZ[b] ?? 0) > z;
    });
  }

  it("keeps a grid's tiers on its segments, and a split's pieces keep them too", () => {
    const state = createState(SEED);
    const g = grid(state, 10, 15);
    const net = state.roads;
    const tiered = live(state).filter((s) => (net.segTierL[s] ?? NO_TIER) !== NO_TIER || (net.segTierR[s] ?? NO_TIER) !== NO_TIER);
    expect(tiered.length).toBeGreaterThan(0);
    // A street across the middle block's south street from outside splits it, and both pieces keep its tiers.
    const zSouth = g.z + g.d + ROAD / 2;
    const south = live(state).find((s) => net.nodeZ[net.segA[s] ?? 0] === zSouth && net.nodeZ[net.segB[s] ?? 0] === zSouth && Math.min(net.nodeX[net.segA[s] ?? 0] ?? 0, net.nodeX[net.segB[s] ?? 0] ?? 0) < g.x + g.w / 2 && Math.max(net.nodeX[net.segA[s] ?? 0] ?? 0, net.nodeX[net.segB[s] ?? 0] ?? 0) > g.x + g.w / 2);
    if (south === undefined) throw new Error("no south street");
    const tiers = [net.segTierL[south], net.segTierR[south]];
    ok(state, road([g.x + g.w / 2 - 4, zSouth], [g.x + g.w / 2 - 4, zSouth + 40]));
    const pieces = live(state).filter((s) => net.nodeZ[net.segA[s] ?? 0] === zSouth && net.nodeZ[net.segB[s] ?? 0] === zSouth && (net.segOrder[s] ?? 0) === (net.segOrder[tiered[0] ?? 0] ?? 0));
    for (const p of pieces.filter((s) => Math.abs((net.nodeX[net.segA[s] ?? 0] ?? 0) - (g.x + g.w / 2 - 4)) < 1 || Math.abs((net.nodeX[net.segB[s] ?? 0] ?? 0) - (g.x + g.w / 2 - 4)) < 1)) {
      expect([net.segTierL[p], net.segTierR[p]]).toEqual(tiers);
    }
  });

  it("moves no ground between a grid's strips when a later road opens the block and another closes it again", () => {
    // The review case: open a corner block by bulldozing its outer street,
    // then build a new street in its place.
    const state = createState(SEED);
    grid(state, 10, 15);
    const w = WIDTH_M(15);
    const d = 10 * CELL;
    const ne = { x: OX + 2 * (w + ROAD) + ROAD / 2, z: OZ + ROAD / 2, w, d };
    expect(split(state, ne)).toEqual({ north: 5 * CELL, south: 5 * CELL });
    const xEast = OX + 3 * (w + ROAD);
    const east = northSouthAt(state, xEast, ne.z + d / 2);
    expect(east).toHaveLength(1);
    ok(state, command("BulldozeRoad", { segments: east }));
    expect(split(state, ne, ne.x + w / 2)).toEqual({ north: 5 * CELL, south: 5 * CELL });
    expectFresh(state);
    ok(state, road([xEast, ne.z - ROAD / 2], [xEast, ne.z + d + ROAD / 2]));
    expect(split(state, ne)).toEqual({ north: 5 * CELL, south: 5 * CELL });
    expectFresh(state);
  });

  it("gives a square block's corners to the same pair of streets whatever joins it from outside later", () => {
    const state = createState(SEED);
    const g = grid(state, 12, 12);
    const [ew, ns] = owners(state, g);
    const zSouth = g.z + g.d + ROAD / 2;
    ok(state, road([g.x + g.w / 2 - 4, zSouth], [g.x + g.w / 2 - 4, zSouth + 40]));
    const [ew2, ns2] = owners(state, g);
    expect(ew2 === 0).toBe(ew === 0);
    expect(ns2 === 0).toBe(ns === 0);
    expectFresh(state);
  });
});
