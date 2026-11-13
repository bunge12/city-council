import { describe, expect, it } from "vitest";
import * as entry from "../src/index";
import { submit, type Command } from "../src/commands";
import { step } from "../src/step";
import { roadTypeIndex } from "../src/roads/balance";
import {
  BLOCK_MIN_AREA,
  blockById,
  blockIndexOf,
  buildBlockIndex,
  existingBlockIndex,
  listBlocks,
  sameBlocks,
  type Block,
} from "../src/roads/blocks";
import { applyRoadDelta, drainRoadChanges, encodeRoadDelta, recordRoadChanges } from "../src/roads/delta";
import { hashState } from "../src/hash";
import { nextFloat, nextInt, seedRng } from "../src/rng";
import {
  LEVEL_BRIDGE,
  LEVEL_TUNNEL,
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  createRoadNetwork,
  isSegment,
  removeSegment,
  restyleSegment,
  segmentIdLimit,
  type RoadNetwork,
  type SegmentSpec,
} from "../src/roads/network";
import { deserialize, serialize } from "../src/snapshot";
import { cloneState, createState, type SimState } from "../src/state";
import { churnNetwork, growNetwork } from "./road-network-helper";

// Issue M1-18: blocks enclosed by roads.

const STREET = roadTypeIndex("street");
const AVENUE = roadTypeIndex("avenue");
const ONE_WAY = roadTypeIndex("oneWay");

type Edge = [string, string, Partial<SegmentSpec>?];

/** Builds a network from named points and segments between them. */
function network(points: Record<string, [number, number]>, edges: Edge[]): { net: RoadNetwork; node: Record<string, number>; seg: number[] } {
  const net = createRoadNetwork();
  const node: Record<string, number> = {};
  for (const [name, [x, z]] of Object.entries(points)) node[name] = addNode(net, x, z, 0);
  const seg = edges.map(([a, b, spec]) => addSegment(net, node[a] ?? NONE, node[b] ?? NONE, { type: STREET, ...spec }));
  return { net, node, seg };
}

/** A 100 m square from (0, 0) to (100, 100): a b on top, d c below. */
const SQUARE = { a: [0, 0], b: [100, 0], c: [100, 100], d: [0, 100] } satisfies Record<string, [number, number]>;
const SQUARE_EDGES: Edge[] = [
  ["a", "b"],
  ["b", "c"],
  ["c", "d"],
  ["d", "a"],
];

function blocks(net: RoadNetwork): Block[] {
  return listBlocks(blockIndexOf(net));
}

function only(net: RoadNetwork): Block {
  const all = blocks(net);
  expect(all).toHaveLength(1);
  return all[0] as Block;
}

/** Each side of a block once, as a set of segment ids. */
function sides(block: Block): number[] {
  return [...new Set(block.segments)].sort((p, q) => p - q);
}

describe("blocks of small networks", () => {
  it("finds one block in a single square, with its area", () => {
    const { net, seg } = network(SQUARE, SQUARE_EDGES);
    const block = only(net);
    expect(block.area).toBe(10_000);
    expect(sides(block)).toEqual([...seg].sort((p, q) => p - q));
    // The id is the lowest half-edge on the loop, and the loop starts there.
    expect(block.id).toBe(2 * (block.segments[0] ?? 0) + (block.forward[0] ? 0 : 1));
    expect(block.id).toBe(Math.min(...block.segments.map((s, i) => 2 * s + (block.forward[i] ? 0 : 1))));
    // Each segment is used once, in one direction, and the loop closes.
    expect(block.segments).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const s = block.segments[i] ?? 0;
      const t = block.segments[(i + 1) % 4] ?? 0;
      const end = block.forward[i] ? net.segB[s] : net.segA[s];
      const start = block.forward[(i + 1) % 4] ? net.segA[t] : net.segB[t];
      expect(end).toBe(start);
    }
  });

  it("finds the same block whichever way the sides were drawn", () => {
    const flipped = network(SQUARE, [
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
      ["a", "d"],
    ]);
    expect(only(flipped.net).area).toBe(10_000);
  });

  it("finds four blocks in a grid of four, adding up to the whole", () => {
    const points: Record<string, [number, number]> = {};
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) points[`${i}${j}`] = [i * 100, j * 100];
    const edges: Edge[] = [];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        if (i < 2) edges.push([`${i}${j}`, `${i + 1}${j}`]);
        if (j < 2) edges.push([`${i}${j}`, `${i}${j + 1}`]);
      }
    }
    const { net } = network(points, edges);
    const all = blocks(net);
    expect(all.map((b) => b.area)).toEqual([10_000, 10_000, 10_000, 10_000]);
    for (const b of all) expect(b.segments).toHaveLength(4);
    // Ids are unique and the list is in id order.
    expect(all.map((b) => b.id)).toEqual([...new Set(all.map((b) => b.id))].sort((p, q) => p - q));
  });

  it("keeps a block with a dead end inside as one block, the dead end walked out and back", () => {
    const { net, seg } = network({ ...SQUARE, e: [50, 50], f: [70, 60] }, [...SQUARE_EDGES, ["a", "e"], ["e", "f"]]);
    const block = only(net);
    expect(block.area).toBeCloseTo(10_000, 6);
    const spur = [seg[4] ?? 0, seg[5] ?? 0];
    for (const s of spur) {
      const passes = block.segments.flatMap((x, i) => (x === s ? [block.forward[i]] : []));
      expect(passes.sort()).toEqual([false, true]);
    }
    expect(block.segments).toHaveLength(8);
  });

  it("keeps a dead end off a corner outside the block out of it", () => {
    const { net } = network({ ...SQUARE, e: [-50, -50] }, [...SQUARE_EDGES, ["a", "e"]]);
    expect(sides(only(net))).toHaveLength(4);
    expect(only(net).area).toBe(10_000);
  });

  it("adds the area between a curve and its chord: two thirds of the triangle", () => {
    // The top side bows out north to a control point 60 m above its middle.
    const { net } = network(SQUARE, [["a", "b", { cx: 50, cz: -60 }], ...SQUARE_EDGES.slice(1)]);
    // Triangle (0, 0), (50, -60), (100, 0) has area 3000.
    expect(only(net).area).toBeCloseTo(10_000 + (2 / 3) * 3000, 6);
    // Bowed in, it takes the same away.
    const inward = network(SQUARE, [["a", "b", { cx: 50, cz: 60 }], ...SQUARE_EDGES.slice(1)]);
    expect(only(inward.net).area).toBeCloseTo(10_000 - (2 / 3) * 3000, 6);
  });

  it("bounds a block with curves alone: two arcs between the same nodes", () => {
    const { net } = network({ a: [0, 0], b: [100, 0] }, [
      ["a", "b", { cx: 50, cz: -40 }],
      ["a", "b", { cx: 50, cz: 40 }],
    ]);
    // Two segments of 2/3 of a 2000 m² triangle each.
    expect(only(net).area).toBeCloseTo((4 / 3) * 2000, 6);
  });

  it("orders curves that leave a node on the same tangent by how they bend", () => {
    // Three roads leave a heading due east: a straight one to b and two
    // curves, one bending each way. Only the second-order bend tells them
    // apart, and the straight one must sit between the curves for the two
    // blocks either side of it to come out right.
    const { net } = network({ a: [0, 0], b: [100, 0], c: [100, 50], d: [100, -50] }, [
      ["a", "c", { cx: 50, cz: 0 }],
      ["a", "b"],
      ["a", "d", { cx: 50, cz: 0 }],
      ["b", "c"],
      ["b", "d"],
    ]);
    const all = blocks(net);
    expect(all).toHaveLength(2);
    // Each block is the region between the straight road, one curve and one short side.
    const want = 2500 - (2 / 3) * 1250;
    for (const b of all) expect(b.area).toBeCloseTo(want, 6);
  });

  it("finds no block in a loop closed by a bridge, a tunnel, rail or a path", () => {
    const closers: Partial<SegmentSpec>[] = [{ level: LEVEL_BRIDGE }, { level: LEVEL_TUNNEL }, { network: NETWORK_RAIL, type: 0 }, { network: NETWORK_PATH, type: 0 }];
    for (const spec of closers) {
      const { net } = network(SQUARE, [...SQUARE_EDGES.slice(0, 3), ["d", "a", spec]]);
      expect(blocks(net), JSON.stringify(spec)).toEqual([]);
    }
  });

  it("is not split by a bridge or a path across it", () => {
    const { net } = network({ ...SQUARE, e: [50, 0], f: [50, 100] }, [
      ["a", "e"],
      ["e", "b"],
      ["b", "c"],
      ["c", "f"],
      ["f", "d"],
      ["d", "a"],
      ["e", "f", { level: LEVEL_BRIDGE }],
    ]);
    expect(only(net).area).toBe(10_000);
    addSegment(net, net.segA[6] ?? 0, net.segB[6] ?? 0, { type: 0, network: NETWORK_PATH });
    expect(only(net).area).toBe(10_000);
  });

  it("finds no block in a tree or a single road", () => {
    expect(blocks(network({ a: [0, 0], b: [100, 0] }, [["a", "b"]]).net)).toEqual([]);
    expect(blocks(network({ a: [0, 0], b: [100, 0], c: [50, 80], d: [50, -80] }, [["a", "b"], ["a", "c"], ["a", "d"]]).net)).toEqual([]);
    expect(blocks(createRoadNetwork())).toEqual([]);
  });

  it("loses the block when one side is bulldozed, and gets it back when it is rebuilt", () => {
    const { net, node, seg } = network(SQUARE, SQUARE_EDGES);
    const index = blockIndexOf(net);
    const before = only(net);
    expect(blockById(index, before.id)).toEqual(before);
    removeSegment(net, seg[2] ?? 0);
    expect(listBlocks(index)).toEqual([]);
    expect(blockById(index, before.id)).toBeNull();
    addSegment(net, node["c"] ?? NONE, node["d"] ?? NONE, { type: STREET });
    expect(listBlocks(index).map((b) => b.area)).toEqual([10_000]);
    expect(sameBlocks(index, buildBlockIndex(net))).toBe(true);
  });

  it("keeps the block through an upgrade and a one-way reversal, ids following the new direction", () => {
    const { net, seg } = network(SQUARE, SQUARE_EDGES);
    const index = blockIndexOf(net);
    restyleSegment(net, seg[1] ?? 0, AVENUE, false);
    expect(only(net).area).toBe(10_000);
    restyleSegment(net, seg[0] ?? 0, ONE_WAY, true);
    expect(only(net).area).toBe(10_000);
    expect(sameBlocks(index, buildBlockIndex(net))).toBe(true);
  });

  it("does not count a separate loop inside a block as a hole", () => {
    const { net } = network(
      { ...SQUARE, e: [40, 40], f: [60, 40], g: [60, 60], h: [40, 60] },
      [...SQUARE_EDGES, ["e", "f"], ["f", "g"], ["g", "h"], ["h", "e"]],
    );
    expect(blocks(net).map((b) => b.area).sort((p, q) => p - q)).toEqual([400, 10_000]);
  });
});

// ---- Through the commands, on seed 2026's flat square ----

/** Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000). */
const SEED = 2026;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

function road(from: [number, number], to: [number, number], type = "street", control?: [number, number]): Command {
  const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  return command("BuildRoad", control ? { ...payload, control: { x: control[0], z: control[1] } } : payload);
}

function ok(state: SimState, c: Command): void {
  expect(submit(state, c)).toEqual({ ok: true });
  step(state);
}

/** Streets round the square from (4200, 4500) to (4400, 4700). */
function squareCity(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4500], [4400, 4500]));
  ok(state, road([4400, 4500], [4400, 4700]));
  ok(state, road([4400, 4700], [4200, 4700]));
  ok(state, road([4200, 4700], [4200, 4500]));
  return state;
}

function segmentBetween(net: RoadNetwork, x: number, z: number): number {
  for (let seg = 0; seg < segmentIdLimit(net); seg++) {
    if (!isSegment(net, seg)) continue;
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const mx = ((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0)) / 2;
    const mz = ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0)) / 2;
    if (mx === x && mz === z) return seg;
  }
  throw new Error(`no segment centred on (${x}, ${z})`);
}

describe("blocks through the commands", () => {
  it("closes a loop of streets into one block", () => {
    const state = squareCity();
    expect(only(state.roads).area).toBe(40_000);
  });

  it("splits a block in two with a new road through it, the areas adding up to the old one", () => {
    const state = squareCity();
    const whole = only(state.roads).area;
    ok(state, road([4280, 4500], [4280, 4700]));
    const halves = blocks(state.roads);
    expect(halves.map((b) => b.area).sort((p, q) => p - q)).toEqual([16_000, 24_000]);
    expect((halves[0]?.area ?? 0) + (halves[1]?.area ?? 0)).toBe(whole);
    // A curved one through the bigger half: the parts still add up.
    ok(state, road([4280, 4600], [4400, 4600], "street", [4340, 4560]));
    const thirds = blocks(state.roads);
    expect(thirds).toHaveLength(3);
    expect(thirds.reduce((sum, b) => sum + b.area, 0)).toBeCloseTo(whole, 6);
  });

  it("loses the block when one side is bulldozed, and undo brings it back with the same id", () => {
    const state = squareCity();
    const before = only(state.roads);
    ok(state, command("BulldozeRoad", { segments: [segmentBetween(state.roads, 4300, 4700)] }));
    expect(blocks(state.roads)).toEqual([]);
    ok(state, command("Undo", {}));
    expect(blocks(state.roads)).toEqual([before]);
  });

  it("has no block where the loop is closed by a bridge", () => {
    // Seed 2026 has an inlet whose water runs from x = 3488 to 3600 along
    // z = 6600 (bridges.test.ts). A loop with a side along there crosses it
    // on a bridge.
    const state = createState(SEED);
    ok(state, road([3400, 6600], [3700, 6600]));
    ok(state, road([3700, 6600], [3700, 6520]));
    ok(state, road([3700, 6520], [3400, 6520]));
    ok(state, road([3400, 6520], [3400, 6600]));
    let bridges = 0;
    for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) if (isSegment(state.roads, seg) && state.roads.segLevelA[seg] === LEVEL_BRIDGE) bridges++;
    expect(bridges).toBeGreaterThan(0);
    expect(blocks(state.roads)).toEqual([]);
  });
});

// ---- Kept current, and equal to a rebuild ----

/** Random roads on the flat square through BuildRoad, BulldozeRoad, UpgradeRoad and Undo. */
function commandChurn(state: SimState, seed: number, count: number): number {
  const rng = seedRng(seed);
  const grid = (lo: number, hi: number) => lo + 20 * nextInt(rng, (hi - lo) / 20 + 1);
  let applied = 0;
  for (let i = 0; i < count; i++) {
    const roll = nextFloat(rng);
    let c: Command;
    const live: number[] = [];
    for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) if (isSegment(state.roads, seg)) live.push(seg);
    if (roll < 0.6 || live.length === 0) {
      // Mostly straight streets on a 20 m grid, so they meet and split often.
      const x0 = grid(4120, 4680);
      const z0 = grid(4420, 4980);
      const along = nextFloat(rng) < 0.5;
      const x1 = along ? grid(4120, 4680) : x0;
      const z1 = along ? z0 : grid(4420, 4980);
      if (nextFloat(rng) < 0.15) c = road([x0, z0], [x1 + 40, z1 + 40], "street", [x0 + 40, z1]);
      else c = road([x0, z0], [x1, z1], nextFloat(rng) < 0.2 ? "avenue" : "street");
    } else if (roll < 0.8) {
      c = command("BulldozeRoad", { segments: [live[nextInt(rng, live.length)] ?? 0] });
    } else if (roll < 0.9) {
      c = command("UpgradeRoad", { segments: [live[nextInt(rng, live.length)] ?? 0], type: ["street", "avenue", "oneWay"][nextInt(rng, 3)] });
    } else {
      c = command("Undo", {});
    }
    if (submit(state, c).ok) applied++;
    step(state);
  }
  return applied;
}

describe("blocks kept current", () => {
  it("equal a fresh rebuild, ids included, after a long run of builds, bulldozes, upgrades and undos", () => {
    const state = createState(SEED);
    const index = blockIndexOf(state.roads);
    let applied = 0;
    let most = 0;
    for (let round = 0; round < 6; round++) {
      applied += commandChurn(state, 100 + round, 50);
      const fresh = buildBlockIndex(state.roads);
      expect(sameBlocks(index, fresh)).toBe(true);
      expect(listBlocks(index)).toEqual(listBlocks(fresh));
      most = Math.max(most, listBlocks(index).length);
      // The commands keep the network planar, so blocks never overlap: the
      // block areas add up to no more than the square they are drawn in.
      expect(listBlocks(index).reduce((sum, b) => sum + b.area, 0)).toBeLessThanOrEqual(640 * 640);
    }
    expect(blockIndexOf(state.roads)).toBe(index);
    expect(applied).toBeGreaterThan(150);
    expect(most).toBeGreaterThan(5);
  });

  it("equal a fresh rebuild on a random network after adds, removals and restyles", () => {
    // The random network is not planar, so its faces mean little, but the
    // walk must still give the same answer kept current as rebuilt.
    const net = createRoadNetwork();
    growNetwork(net, 30, 1500);
    const index = blockIndexOf(net);
    const rng = seedRng(31);
    for (let round = 0; round < 10; round++) {
      churnNetwork(net, 32 + round, 200);
      for (let i = 0; i < 20; i++) {
        const seg = nextInt(rng, segmentIdLimit(net));
        if (!isSegment(net, seg) || net.segNetwork[seg] !== NETWORK_ROAD) continue;
        restyleSegment(net, seg, nextInt(rng, 3), nextFloat(rng) < 0.3);
      }
      // Read only every other round, so changes pile up between reads too.
      if (round % 2 === 1) expect(sameBlocks(index, buildBlockIndex(net))).toBe(true);
    }
    expect(index.faces.size).toBeGreaterThan(1);
  });

  it("are not part of state: saving, hashing and cloning ignore them", () => {
    const state = squareCity();
    const before = hashState(state);
    const bytes = serialize(state);
    listBlocks(blockIndexOf(state.roads));
    expect(hashState(state)).toBe(before);
    expect(serialize(state)).toEqual(bytes);
    expect(existingBlockIndex(cloneState(state).roads)).toBeNull();
  });

  it("give a city saved and loaded mid-run the same blocks and ids as one that never stopped", () => {
    const state = createState(SEED);
    entry.prepareDerived(state);
    expect(existingBlockIndex(state.roads)).not.toBeNull();
    commandChurn(state, 200, 80);
    const loaded = deserialize(serialize(state)).state;
    // The same commands, sequence numbers included, to both.
    const from = seq;
    commandChurn(state, 201, 80);
    seq = from;
    commandChurn(loaded, 201, 80);
    expect(hashState(loaded)).toBe(hashState(state));
    expect(listBlocks(blockIndexOf(loaded.roads))).toEqual(listBlocks(blockIndexOf(state.roads)));
  });

  it("follow road deltas on a client's copy", () => {
    const state = createState(SEED);
    const copy = cloneState(state).roads;
    const index = blockIndexOf(copy);
    recordRoadChanges(state.roads);
    for (let round = 0; round < 6; round++) {
      commandChurn(state, 300 + round, 25);
      const changes = drainRoadChanges(state.roads);
      if (!changes) continue;
      const applied = applyRoadDelta(copy, encodeRoadDelta(state.roads, changes));
      if (typeof applied === "string") throw new Error(applied);
      expect(listBlocks(index)).toEqual(listBlocks(buildBlockIndex(state.roads)));
    }
  });

  it("follow road deltas on a random network", () => {
    const net = createRoadNetwork();
    growNetwork(net, 50, 400);
    const copy = cloneState({ ...createState(0), roads: net }).roads;
    const index = blockIndexOf(copy);
    recordRoadChanges(net);
    for (let round = 0; round < 5; round++) {
      churnNetwork(net, 51 + round, 100);
      const changes = drainRoadChanges(net);
      if (!changes) continue;
      const applied = applyRoadDelta(copy, encodeRoadDelta(net, changes));
      if (typeof applied === "string") throw new Error(applied);
      expect(sameBlocks(index, buildBlockIndex(copy))).toBe(true);
    }
  });
});

describe("block exports", () => {
  it("are on the sim entry file", () => {
    expect(entry.blockIndexOf).toBe(blockIndexOf);
    expect(entry.listBlocks).toBe(listBlocks);
    expect(entry.buildBlockIndex).toBe(buildBlockIndex);
    expect(entry.sameBlocks).toBe(sameBlocks);
    expect(entry.BLOCK_MIN_AREA).toBe(BLOCK_MIN_AREA);
  });
});
