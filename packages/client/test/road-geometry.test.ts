// Road geometry checks that stand in for "no gaps, no overlaps": every point
// of road is covered by exactly one surface triangle, chunk by chunk, and a
// chunk rebuilt after a delta comes out the same as one built from scratch.
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHUNKS_PER_SIDE,
  ROAD_TYPES,
  applyRoadDelta,
  createState,
  drainRoadChanges,
  encodeRoadDelta,
  generateTerrain,
  nextFloat,
  nextInt,
  recordRoadChanges,
  seedRng,
  step,
  submit,
  type RoadNetwork,
  type SimState,
  type Terrain,
} from "@city-council/sim";
import { ROADS } from "../src/render/config";
import { withoutDropped } from "../src/render/decor";
import {
  MASK_GRASS,
  MASK_TREES,
  RoadChunks,
  buildRoadChunk,
  chunkAt,
  junctionAt,
  masked,
  paintFor,
  roadMask,
  roadSegmentsAt,
  segFrame,
  stations,
  type MeshArrays,
  type RoadNet,
} from "../src/render/road-geometry";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000),
// across the chunk lines x = 4500 and z = 4500. The sim's tests use it too.
const SEED = 2026;
let terrain: Terrain;
beforeAll(() => {
  terrain = generateTerrain(SEED);
});

let seq = 0;
function build(state: SimState, from: [number, number], to: [number, number], type = "street"): void {
  const result = submit(state, {
    seq: ++seq,
    playerId: "p1",
    type: "BuildRoad",
    payload: { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type },
  });
  if (!result.ok) throw new Error(`road refused: ${result.reason}`);
  step(state);
}

function city(roads: [from: [number, number], to: [number, number], type?: string][]): RoadNetwork {
  const state = createState(SEED);
  for (const [from, to, type] of roads) build(state, from, to, type);
  return state.roads;
}

/** Every chunk's geometry, built from scratch. */
function allChunks(net: RoadNet): Map<number, ReturnType<typeof buildRoadChunk>> {
  const index = new RoadChunks();
  index.reset(net);
  const out = new Map<number, ReturnType<typeof buildRoadChunk>>();
  for (let c = 0; c < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; c++) {
    const segs = index.chunkSegs[c] ?? new Set();
    const nodes = index.chunkNodes[c] ?? new Set();
    if (segs.size === 0 && nodes.size === 0) continue;
    out.set(c, buildRoadChunk(net, terrain, c, segs, nodes));
  }
  return out;
}

/** Surface triangles of every chunk, as x, z corner triples. */
function triangles(net: RoadNet): number[][] {
  const out: number[][] = [];
  for (const g of allChunks(net).values()) {
    const { positions: p, indices } = g.surface;
    for (let k = 0; k < indices.length; k += 3) {
      const tri: number[] = [];
      for (let v = 0; v < 3; v++) {
        const i = indices[k + v] ?? 0;
        tri.push(p[i * 3] ?? 0, p[i * 3 + 2] ?? 0);
      }
      out.push(tri);
    }
  }
  return out;
}

function inside(t: number[], x: number, z: number): boolean {
  const [ax = 0, az = 0, bx = 0, bz = 0, cx = 0, cz = 0] = t;
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** True when (x, z) lies on some road's full, untrimmed strip. */
function onRoad(net: RoadNet, x: number, z: number): boolean {
  for (let seg = 0; seg < net.segFlags.length; seg++) {
    if (!net.segFlags[seg]) continue;
    const f = segFrame(net, seg);
    const px = x - f.ax;
    const pz = z - f.az;
    const t = px * f.dx + pz * f.dz;
    const o = px * f.nx + pz * f.nz;
    if (t >= 0 && t <= f.length && Math.abs(o) <= f.half) return true;
  }
  return false;
}

/**
 * Samples a jittered grid over the box and counts the surface triangles
 * over each point. On a road: exactly one. Off every road: at most one,
 * since a mitred corner may fill a little past the kerbs.
 */
function expectTiled(net: RoadNet, x0: number, z0: number, x1: number, z1: number, step = 0.73): void {
  const tris = triangles(net);
  let onCount = 0;
  for (let z = z0 + 0.011; z < z1; z += step) {
    for (let x = x0 + 0.017; x < x1; x += step) {
      let n = 0;
      for (const t of tris) if (inside(t, x, z)) n++;
      if (onRoad(net, x, z)) {
        onCount++;
        expect(n, `road point ${x.toFixed(2)}, ${z.toFixed(2)} covered ${n} times`).toBe(1);
      } else {
        expect(n, `off-road point ${x.toFixed(2)}, ${z.toFixed(2)} covered ${n} times`).toBeLessThanOrEqual(1);
      }
    }
  }
  expect(onCount).toBeGreaterThan(100);
}

describe("stations", () => {
  it("splits a line at every chunk line and sample step, in order", () => {
    const st = stations(4480, 4490, 1, 0, 0, 40, 8);
    expect(st).toEqual([0, 8, 16, 20, 24, 32, 40]);
  });
});

describe("junctions", () => {
  it("fill a T, a cross and a five-way with no gaps or overlaps", () => {
    const net = city([
      [[4150, 4450], [4350, 4450]],
      [[4250, 4450], [4250, 4550]],
      [[4150, 4650], [4350, 4650], "avenue"],
      [[4250, 4580], [4250, 4720], "oneWay"],
      [[4600, 4630], [4660, 4630], "avenue"],
      [[4600, 4630], [4619, 4687]],
      [[4600, 4630], [4551, 4665], "oneWay"],
      [[4600, 4630], [4551, 4595]],
      [[4600, 4630], [4619, 4573]],
    ]);
    expectTiled(net, 4230, 4430, 4270, 4470);
    expectTiled(net, 4225, 4625, 4275, 4675);
    expectTiled(net, 4570, 4600, 4630, 4660);
  });

  it("fill bends and sharp angles, mitred or bevelled", () => {
    const net = city([
      // A right-angle bend.
      [[4150, 4450], [4200, 4450]],
      [[4200, 4450], [4200, 4500]],
      // A slight bend, street into avenue.
      [[4300, 4450], [4350, 4450]],
      [[4350, 4450], [4400, 4458], "avenue"],
      // A sharp 30 degree fork.
      [[4150, 4600], [4250, 4600], "avenue"],
      [[4150, 4600], [4237, 4650]],
    ]);
    expectTiled(net, 4180, 4430, 4220, 4470);
    expectTiled(net, 4330, 4430, 4370, 4470);
    expectTiled(net, 4140, 4585, 4230, 4650);
  });

  it("fill random junctions of two to six roads of mixed types", () => {
    const rng = seedRng(32);
    const types = ["street", "avenue", "oneWay"];
    let tried = 0;
    for (let n = 0; n < 24; n++) {
      const state = createState(SEED);
      const cx = 4200 + (n % 4) * 130;
      const cz = 4470 + Math.floor(n / 4) * 85;
      const arms = 2 + nextInt(rng, 5);
      // Angles at least 30 degrees apart, so BuildRoad accepts them.
      const angles: number[] = [];
      for (let tries = 0; angles.length < arms && tries < 200; tries++) {
        const a = nextFloat(rng) * 2 * Math.PI;
        if (angles.every((b) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) > (30 * Math.PI) / 180)) angles.push(a);
      }
      for (const a of angles) {
        // Long enough for the junction of two avenues at 30 degrees, which cuts each back 34 m.
        const length = 36 + nextFloat(rng) * 30;
        const to: [number, number] = [Math.round((cx + Math.cos(a) * length) * 8) / 8, Math.round((cz + Math.sin(a) * length) * 8) / 8];
        try {
          build(state, [cx, cz], to, types[nextInt(rng, types.length)]);
        } catch {
          // A refused arm, too steep or too close to another: the rest still make a junction.
        }
      }
      if (state.roads.segFlags.length < 2) continue;
      tried++;
      expectTiled(state.roads, cx - 40, cz - 40, cx + 40, cz + 40, 0.9);
    }
    expect(tried).toBeGreaterThan(15);
  });

  it("cut a road back from both kerbs' corners, and not at a dead end", () => {
    const net = city([
      [[4150, 4450], [4350, 4450]],
      [[4250, 4450], [4250, 4550]],
    ]);
    // Node 2 is the T, node 3 the dead end at (4250, 4550).
    const tee = [0, 1, 2, 3].find((n) => roadSegmentsAt(net, n).length === 3) ?? -1;
    const j = junctionAt(net, tee);
    expect(j?.segs.length).toBe(3);
    // A street is 10 m wide, so every road is cut back half that.
    for (const t of j?.trims ?? []) expect(t).toBeCloseTo(5, 9);
    const end = [0, 1, 2, 3].find((n) => net.nodeX[n] === 4250 && net.nodeZ[n] === 4550) ?? -1;
    expect(junctionAt(net, end)).toBeNull();
  });

  it("end square at a dead end, flush with the node", () => {
    const net = city([[[4150, 4450], [4250, 4450]]]);
    const g = allChunks(net).get(chunkAt(4200, 4450));
    const p = g?.surface.positions ?? new Float32Array();
    const xs = new Set<number>();
    for (let v = 0; v < p.length / 3; v++) xs.add(Math.round(p[v * 3] ?? 0));
    expect(Math.min(...xs)).toBe(4150);
    expect(Math.max(...xs)).toBe(4250);
    const atEnd: number[] = [];
    for (let v = 0; v < p.length / 3; v++) if (Math.round(p[v * 3] ?? 0) === 4150) atEnd.push(p[v * 3 + 2] ?? 0);
    expect(atEnd.sort()).toEqual([4445, 4455]);
  });
});

describe("chunks", () => {
  it("split a road at a chunk line, with each piece in one chunk and the line covered once", () => {
    const net = city([[[4450, 4300], [4550, 4300], "avenue"]]);
    const chunks = allChunks(net);
    expect([...chunks.keys()].sort((a, b) => a - b)).toEqual([chunkAt(4450, 4300), chunkAt(4550, 4300)]);
    for (const [c, g] of chunks) {
      const p = g.surface.positions;
      for (let v = 0; v < p.length / 3; v++) {
        const x = p[v * 3] ?? 0;
        expect(c === chunkAt(4450, 4300) ? x <= 4500 : x >= 4500).toBe(true);
      }
    }
    expectTiled(net, 4490, 4285, 4510, 4315, 0.37);
  });

  it("rebuild after a delta to exactly what a fresh build draws", () => {
    // A host and a client copy fed the same deltas, as the worker and the mirror are.
    const state = createState(SEED);
    recordRoadChanges(state.roads);
    const copy = structuredClone(state.roads);
    const index = new RoadChunks();
    index.reset(copy);
    const drawn = new Map<number, string>();
    const key = (g: ReturnType<typeof buildRoadChunk>) =>
      JSON.stringify(["surface", "markings", "lines"].map((k) => Array.from((g as unknown as Record<string, MeshArrays>)[k]?.positions ?? [])));
    const plan: [from: [number, number], to: [number, number], type: string][] = [
      [[4150, 4450], [4650, 4450], "street"],
      [[4300, 4420], [4300, 4700], "avenue"],
      [[4520, 4400], [4520, 4600], "oneWay"],
      [[4150, 4550], [4600, 4550], "street"],
      [[4400, 4480], [4440, 4520], "street"],
      [[4300, 4700], [4450, 4800], "avenue"],
      [[4480, 4560], [4560, 4480], "street"],
    ];
    for (const [from, to, type] of plan) {
      build(state, from, to, type);
      const changes = drainRoadChanges(state.roads);
      if (!changes) continue;
      const delta = encodeRoadDelta(state.roads, changes);
      expect(applyRoadDelta(copy, delta)).not.toBeTypeOf("string");
      const dirty = index.apply(copy, delta.nodeIds, delta.segIds);
      for (const c of dirty) {
        const g = buildRoadChunk(copy, terrain, c, index.chunkSegs[c] ?? [], index.chunkNodes[c] ?? []);
        drawn.set(c, key(g));
      }
      // Every chunk that has roads now matches a build from scratch.
      const fresh = allChunks(copy);
      for (const [c, g] of fresh) expect(drawn.get(c), `chunk ${c}`).toBe(key(g));
      for (const [c, k] of drawn) if (!fresh.has(c)) expect(JSON.parse(k).flat()).toEqual([]);
    }
  });

  it("name only the chunks a short road and its junctions reach", () => {
    const state = createState(SEED);
    build(state, [4150, 4450], [4350, 4450]);
    recordRoadChanges(state.roads);
    const index = new RoadChunks();
    index.reset(state.roads);
    build(state, [4250, 4450], [4250, 4350]);
    const changes = drainRoadChanges(state.roads);
    if (!changes) throw new Error("no changes");
    const dirty = index.apply(state.roads, changes.nodes, changes.segs);
    expect([...dirty]).toEqual([chunkAt(4250, 4400)]);
  });
});

describe("paint and lines", () => {
  const type = (id: string) => ROAD_TYPES.find((t) => t.id === id) ?? (ROAD_TYPES[0] as (typeof ROAD_TYPES)[number]);

  it("gives each road type its own markings", () => {
    const street = paintFor(type("street"));
    const avenue = paintFor(type("avenue"));
    const oneWay = paintFor(type("oneWay"));
    expect(street).toHaveLength(1);
    expect(street[0]?.dashed).toBe(true);
    // Double centre line, a lane line each side and two edge lines.
    expect(avenue).toHaveLength(6);
    expect(avenue.filter((p) => !p.dashed)).toHaveLength(4);
    // A one-way's two lanes run the same way: one dashed line between them, and arrows (below).
    expect(oneWay).toHaveLength(1);
  });

  it("draws arrows on a one-way, and city lines only for avenues", () => {
    const net = city([
      [[4150, 4410], [4250, 4410], "street"],
      [[4150, 4440], [4250, 4440], "oneWay"],
      [[4150, 4475], [4250, 4475], "avenue"],
    ]);
    const g = allChunks(net).get(chunkAt(4200, 4450));
    if (!g) throw new Error("no chunk");
    // Lines: only the avenue's centre line, from x 4150 to 4250, plus caps at its two ends.
    const lp = g.lines.positions;
    const zs = new Set<number>();
    for (let v = 0; v < lp.length / 3; v++) zs.add(lp[v * 3 + 2] ?? 0);
    expect([...zs]).toEqual([4475]);
    // Arrows: white triangles beyond the dashed paint, on the one-way only.
    const mp = g.markings.positions;
    const oneWayVerts = [];
    for (let v = 0; v < mp.length / 3; v++) if (Math.abs((mp[v * 3 + 2] ?? 0) - 4440) < 5) oneWayVerts.push(v);
    // Each arrow is a shaft quad and a head triangle per lane; the dashes are quads.
    const dashes = Math.ceil(100 / (ROADS.markings.dash + ROADS.markings.gap));
    expect(oneWayVerts.length).toBeGreaterThan(dashes * 4);
  });
});

describe("decoration near roads", () => {
  it("masks the road and its margin, more widely for trees than for grass", () => {
    const net = city([[[4150, 4450], [4350, 4450]]]);
    const chunk = chunkAt(4200, 4450);
    const segs = [0, 1, 2].filter((s) => s < net.segFlags.length);
    const mask = roadMask(net, chunk, segs);
    expect(mask).not.toBeNull();
    expect(masked(mask, chunk, 4200, 4450, MASK_TREES)).toBe(true);
    expect(masked(mask, chunk, 4200, 4450, MASK_GRASS)).toBe(true);
    // 5 m half-width, then 3 m for trees and 0.5 m for grass.
    expect(masked(mask, chunk, 4200, 4450 + 7, MASK_TREES)).toBe(true);
    expect(masked(mask, chunk, 4200, 4450 + 7, MASK_GRASS)).toBe(false);
    expect(masked(mask, chunk, 4200, 4450 + 12, MASK_TREES)).toBe(false);
    expect(roadMask(net, chunkAt(1000, 1000), segs)).toBeNull();
  });

  it("drops only the instances a test says to", () => {
    const data = Float32Array.from([1, 0, 1, 5, 0, 0, 2, 0, 2, 5, 0, 0, 3, 0, 3, 5, 0, 0]);
    const kept = withoutDropped({ count: 3, data }, (x) => x === 2);
    expect(kept.count).toBe(2);
    expect(Array.from(kept.data)).toEqual([1, 0, 1, 5, 0, 0, 3, 0, 3, 5, 0, 0]);
  });
});
