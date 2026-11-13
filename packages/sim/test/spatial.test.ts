import { describe, expect, it } from "vitest";
import { nextFloat, seedRng } from "../src/rng";
import {
  NETWORK_RAIL,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  createRoadNetwork,
  isNode,
  isSegment,
  nodeIdLimit,
  removeNode,
  removeSegment,
  segmentIdLimit,
  type RoadNetwork,
} from "../src/roads/network";
import {
  NETWORKS_ALL,
  NETWORKS_PATH,
  NETWORKS_RAIL,
  NETWORKS_ROAD,
  buildRoadIndex,
  nearestNode,
  nearestPointOnSegment,
  nodeOnNetworks,
  roadIndexOf,
  segmentTouchesBox,
  segmentsInBox,
  type NearestNode,
  type NearestPoint,
  type RoadIndex,
} from "../src/roads/spatial";
import * as entry from "../src/index";
import { createBareState } from "../src/state";
import { deserialize, serialize } from "../src/snapshot";
import { hashState } from "../src/hash";
import { churnNetwork, growNetwork } from "./road-network-helper";

// ---- Brute-force answers, by scanning every node and segment ----

function bruteNearestNode(net: RoadNetwork, x: number, z: number, r: number, networks: number): NearestNode | null {
  let best: NearestNode | null = null;
  let bestD2 = Infinity;
  for (let id = 0; id < nodeIdLimit(net); id++) {
    if (!isNode(net, id) || !nodeOnNetworks(net, id, networks)) continue;
    const dx = (net.nodeX[id] ?? 0) - x;
    const dz = (net.nodeZ[id] ?? 0) - z;
    const d2 = dx * dx + dz * dz;
    // Ascending ids, so a strict < keeps the lowest id on a tie.
    if (d2 <= r * r && d2 < bestD2) {
      bestD2 = d2;
      best = { node: id, distance: Math.sqrt(d2) };
    }
  }
  return best;
}

function bruteNearestPoint(net: RoadNetwork, x: number, z: number, r: number, networks: number): NearestPoint | null {
  let best: NearestPoint | null = null;
  let bestD2 = Infinity;
  for (let id = 0; id < segmentIdLimit(net); id++) {
    if (!isSegment(net, id) || ((1 << (net.segNetwork[id] ?? 0)) & networks) === 0) continue;
    const a = net.segA[id] ?? NONE;
    const b = net.segB[id] ?? NONE;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const sx = (net.nodeX[b] ?? 0) - ax;
    const sz = (net.nodeZ[b] ?? 0) - az;
    const len2 = sx * sx + sz * sz;
    const t = Math.min(1, Math.max(0, len2 > 0 ? ((x - ax) * sx + (z - az) * sz) / len2 : 0));
    const px = ax + t * sx;
    const pz = az + t * sz;
    const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d2 <= r * r && d2 < bestD2) {
      bestD2 = d2;
      best = { segment: id, x: px, z: pz, t, distance: Math.sqrt(d2) };
    }
  }
  return best;
}

function bruteSegmentsInBox(
  net: RoadNetwork,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  networks: number,
): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) {
    if (!isSegment(net, id) || ((1 << (net.segNetwork[id] ?? 0)) & networks) === 0) continue;
    const a = net.segA[id] ?? NONE;
    const b = net.segB[id] ?? NONE;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const bx = net.nodeX[b] ?? 0;
    const bz = net.nodeZ[b] ?? 0;
    if (segmentTouchesBox(ax, az, bx, bz, minX, minZ, maxX, maxZ)) out.push(id);
  }
  return out;
}

const FILTERS = [NETWORKS_ALL, NETWORKS_ROAD, NETWORKS_RAIL, NETWORKS_PATH, NETWORKS_ROAD | NETWORKS_PATH];

interface Query {
  x: number;
  z: number;
  r: number;
  w: number;
  h: number;
  networks: number;
}

/** Random query points over the map and a little past its edges. */
function queries(seed: number, count: number): Query[] {
  const rng = seedRng(seed);
  const out: Query[] = [];
  for (let i = 0; i < count; i++) {
    const big = nextFloat(rng) < 0.1;
    out.push({
      x: -600 + nextFloat(rng) * 13_200,
      z: -600 + nextFloat(rng) * 13_200,
      r: big ? nextFloat(rng) * 1500 : nextFloat(rng) * 80,
      w: nextFloat(rng) * (big ? 2000 : 150),
      h: nextFloat(rng) * (big ? 2000 : 150),
      networks: FILTERS[i % FILTERS.length] ?? NETWORKS_ALL,
    });
  }
  return out;
}

/** Every answer the index gives for `qs`, for comparing two indexes. */
function answers(index: RoadIndex, qs: Query[]): unknown[] {
  return qs.map((q) => [
    nearestNode(index, q.x, q.z, q.r, q.networks),
    nearestPointOnSegment(index, q.x, q.z, q.r, q.networks),
    segmentsInBox(index, q.x, q.z, q.x + q.w, q.z + q.h, q.networks),
  ]);
}

/** The cell lists, which are the whole of an index's contents. */
function contents(index: RoadIndex): { nodeCells: number[][]; segCells: number[][] } {
  return { nodeCells: index.nodeCells, segCells: index.segCells };
}

describe("spatial index on a random network of 5,000 segments", () => {
  const net = createRoadNetwork();
  growNetwork(net, 2028, 5000);
  const index = buildRoadIndex(net);
  const qs = queries(7, 2000);

  it("puts every live node in one cell and every segment in at least one", () => {
    expect(index.cellsPerSide).toBe(24);
    const nodeHits = new Map<number, number>();
    for (const cell of index.nodeCells) for (const id of cell) nodeHits.set(id, (nodeHits.get(id) ?? 0) + 1);
    const segs = new Set(index.segCells.flat());
    let nodes = 0;
    for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id)) nodes++;
    expect(nodeHits.size).toBe(nodes);
    expect([...nodeHits.values()].every((n) => n === 1)).toBe(true);
    expect(segs.size).toBe(5000);
  });

  it("finds the same nearest node as a brute-force scan", () => {
    let found = 0;
    for (const q of qs) {
      const got = nearestNode(index, q.x, q.z, q.r, q.networks);
      expect(got).toEqual(bruteNearestNode(net, q.x, q.z, q.r, q.networks));
      if (got) found++;
    }
    // The test means something only if many queries find a node and some do not.
    expect(found).toBeGreaterThan(qs.length / 10);
    expect(found).toBeLessThan(qs.length);
  });

  it("finds the same nearest point on a segment as a brute-force scan", () => {
    let found = 0;
    for (const q of qs) {
      const got = nearestPointOnSegment(index, q.x, q.z, q.r, q.networks);
      expect(got).toEqual(bruteNearestPoint(net, q.x, q.z, q.r, q.networks));
      if (got) found++;
    }
    expect(found).toBeGreaterThan(qs.length / 4);
    expect(found).toBeLessThan(qs.length);
  });

  it("finds the same segments in a box as a brute-force scan, in id order", () => {
    let hits = 0;
    for (const q of qs) {
      const got = segmentsInBox(index, q.x, q.z, q.x + q.w, q.z + q.h, q.networks);
      expect(got).toEqual(bruteSegmentsInBox(net, q.x, q.z, q.x + q.w, q.z + q.h, q.networks));
      hits += got.length;
    }
    expect(hits).toBeGreaterThan(qs.length);
  });

  it("finds roads that are partly off the map", () => {
    const off = createRoadNetwork();
    const a = addNode(off, -300, 100, 0);
    const b = addNode(off, -100, 400, 0);
    const c = addNode(off, 12_200, 12_300, 0);
    const d = addNode(off, 11_900, 11_950, 0);
    const ab = addSegment(off, a, b, { type: 0 });
    const cd = addSegment(off, c, d, { type: 0 });
    const idx = buildRoadIndex(off);
    expect(nearestNode(idx, -310, 100, 20)?.node).toBe(a);
    expect(nearestPointOnSegment(idx, -200, 250, 5)?.segment).toBe(ab);
    expect(segmentsInBox(idx, 12_000, 12_000, 12_100, 12_200)).toEqual([cd]);
    expect(segmentsInBox(idx, -1000, -1000, -500, -500)).toEqual([]);
  });
});

describe("spatial index kept current", () => {
  it("equals one rebuilt from scratch after 1,000 random adds and removes", () => {
    const net = createRoadNetwork();
    growNetwork(net, 11, 2000);
    const live = roadIndexOf(net);
    churnNetwork(net, 12, 1000);
    const rebuilt = buildRoadIndex(net);
    expect(contents(live)).toEqual(contents(rebuilt));
    const qs = queries(13, 500);
    expect(answers(live, qs)).toEqual(answers(rebuilt, qs));
  });

  it("is the same object each time it is asked for", () => {
    const net = createRoadNetwork();
    expect(roadIndexOf(net)).toBe(roadIndexOf(net));
    expect(roadIndexOf(createRoadNetwork())).not.toBe(roadIndexOf(net));
  });

  it("follows each kind of change", () => {
    const net = createRoadNetwork();
    const index = roadIndexOf(net);
    const a = addNode(net, 100, 100, 0);
    const b = addNode(net, 900, 100, 0);
    expect(nearestNode(index, 905, 100, 10)?.node).toBe(b);
    const ab = addSegment(net, a, b, { type: 0 });
    expect(segmentsInBox(index, 400, 50, 600, 150)).toEqual([ab]);
    expect(index.segCells.filter((cell) => cell.includes(ab))).toHaveLength(2);
    removeSegment(net, ab);
    expect(segmentsInBox(index, 400, 50, 600, 150)).toEqual([]);
    expect(index.segCells.flat()).toEqual([]);
    removeNode(net, b);
    expect(nearestNode(index, 905, 100, 10)).toBeNull();
  });

  it("is not part of state: saving, hashing and cloning ignore it", () => {
    const state = createBareState(5);
    growNetwork(state.roads, 3, 300);
    const before = hashState(state);
    const bytes = serialize(state);
    roadIndexOf(state.roads);
    expect(hashState(state)).toBe(before);
    expect(serialize(state)).toEqual(bytes);
  });

  it("gives a city saved and loaded mid-run the same answers as one that never stopped", () => {
    const state = createBareState(9);
    growNetwork(state.roads, 21, 1500);
    entry.prepareDerived(state);
    churnNetwork(state.roads, 22, 300);

    const loaded = deserialize(serialize(state)).state;
    // Both go on with the same changes.
    churnNetwork(state.roads, 23, 500);
    churnNetwork(loaded.roads, 23, 500);

    expect(hashState(loaded)).toBe(hashState(state));
    expect(contents(roadIndexOf(loaded.roads))).toEqual(contents(roadIndexOf(state.roads)));
    const qs = queries(24, 500);
    expect(answers(roadIndexOf(loaded.roads), qs)).toEqual(answers(roadIndexOf(state.roads), qs));
  });
});

describe("spatial query order", () => {
  it("breaks a tie by the lower id, whichever was added first", () => {
    const net = createRoadNetwork();
    const index = roadIndexOf(net);
    const first = addNode(net, 0, 0, 0);
    addNode(net, 200, 0, 0);
    removeNode(net, first);
    // Id 0 comes back off the free list after id 1 was added.
    const late = addNode(net, 200, 200, 0);
    expect(late).toBe(0);
    // Both are 100 m from (200, 100).
    expect(nearestNode(index, 200, 100, 150)).toEqual({ node: 0, distance: 100 });
  });

  it("breaks a segment tie by the lower id", () => {
    const net = createRoadNetwork();
    const index = roadIndexOf(net);
    const n = [addNode(net, 0, 0, 0), addNode(net, 100, 0, 0), addNode(net, 0, 100, 0), addNode(net, 100, 100, 0)];
    const s0 = addSegment(net, n[0] ?? 0, n[1] ?? 0, { type: 0 });
    const s1 = addSegment(net, n[2] ?? 0, n[3] ?? 0, { type: 0 });
    removeSegment(net, s0);
    const s0again = addSegment(net, n[0] ?? 0, n[1] ?? 0, { type: 0 });
    expect([s0again, s1]).toEqual([0, 1]);
    expect(nearestPointOnSegment(index, 50, 50, 60)).toEqual({ segment: 0, x: 50, z: 0, t: 0.5, distance: 50 });
  });

  it("returns box results in ascending id order", () => {
    const net = createRoadNetwork();
    growNetwork(net, 31, 1000);
    churnNetwork(net, 32, 400);
    const index = roadIndexOf(net);
    for (const q of queries(33, 200)) {
      const got = segmentsInBox(index, q.x, q.z, q.x + 2000, q.z + 2000);
      expect(got).toEqual([...new Set(got)].sort((p, q2) => p - q2));
    }
  });
});

describe("spatial query filters and arguments", () => {
  it("filters nodes and segments by network type", () => {
    const net = createRoadNetwork();
    const index = roadIndexOf(net);
    const a = addNode(net, 0, 0, 0);
    const b = addNode(net, 100, 0, 0);
    const c = addNode(net, 0, 10, 0);
    const d = addNode(net, 100, 10, 0);
    const bare = addNode(net, 50, 5, 0);
    const road = addSegment(net, a, b, { type: 0, network: NETWORK_ROAD });
    const rail = addSegment(net, c, d, { type: 0, network: NETWORK_RAIL });
    expect(nearestPointOnSegment(index, 50, 9, 20, NETWORKS_ROAD)?.segment).toBe(road);
    expect(nearestPointOnSegment(index, 50, 1, 20, NETWORKS_RAIL)?.segment).toBe(rail);
    expect(nearestPointOnSegment(index, 50, 1, 20, NETWORKS_PATH)).toBeNull();
    expect(segmentsInBox(index, 0, 0, 100, 10, NETWORKS_RAIL)).toEqual([rail]);
    expect(nearestNode(index, 0, 9, 20, NETWORKS_ROAD)?.node).toBe(a);
    // A node with no segments belongs to no network, so only the full filter finds it.
    expect(nearestNode(index, 50, 5, 1)?.node).toBe(bare);
    expect(nearestNode(index, 50, 5, 1, NETWORKS_ROAD)).toBeNull();
  });

  it("counts a point exactly at the radius as within it", () => {
    const net = createRoadNetwork();
    const index = roadIndexOf(net);
    addSegment(net, addNode(net, 0, 0, 0), addNode(net, 0, 100, 0), { type: 0 });
    expect(nearestNode(index, 30, 40, 50)?.distance).toBe(50);
    expect(nearestPointOnSegment(index, 25, 50, 25)?.distance).toBe(25);
    expect(nearestPointOnSegment(index, 25, 50, 24.999)).toBeNull();
  });

  it("refuses bad arguments", () => {
    const index = roadIndexOf(createRoadNetwork());
    expect(() => nearestNode(index, NaN, 0, 10)).toThrow(RangeError);
    expect(() => nearestNode(index, 0, 0, -1)).toThrow(RangeError);
    expect(() => nearestPointOnSegment(index, 0, 0, NaN)).toThrow(RangeError);
    expect(() => nearestPointOnSegment(index, 0, 0, 10, 99)).toThrow(RangeError);
    expect(() => segmentsInBox(index, 10, 0, 0, 10)).toThrow(RangeError);
  });

  it("are exported from the sim entry file", () => {
    expect(entry.nearestNode).toBe(nearestNode);
    expect(entry.nearestPointOnSegment).toBe(nearestPointOnSegment);
    expect(entry.segmentsInBox).toBe(segmentsInBox);
    expect(entry.buildRoadIndex).toBe(buildRoadIndex);
    expect(entry.CHUNK_SIZE).toBe(500);
  });
});

describe("segmentTouchesBox", () => {
  it("handles crossing, grazing, inside and missing segments", () => {
    expect(segmentTouchesBox(-10, 5, 20, 5, 0, 0, 10, 10)).toBe(true);
    expect(segmentTouchesBox(2, 2, 3, 3, 0, 0, 10, 10)).toBe(true);
    expect(segmentTouchesBox(-5, 10, 0, 15, 0, 0, 10, 10)).toBe(false);
    expect(segmentTouchesBox(-5, 5, 5, 15, 0, 0, 10, 10)).toBe(true);
    expect(segmentTouchesBox(10, 10, 20, 20, 0, 0, 10, 10)).toBe(true);
    expect(segmentTouchesBox(-1, 12, 12, -1, 0, 0, 10, 10)).toBe(true);
    expect(segmentTouchesBox(-1, 22, 22, -1, 0, 0, 10, 10)).toBe(false);
  });
});
