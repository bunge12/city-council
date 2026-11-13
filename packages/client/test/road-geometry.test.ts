// Road geometry checks that stand in for "no gaps, no overlaps": every point
// of road is covered by exactly one surface triangle, chunk by chunk, and a
// chunk rebuilt after a delta comes out the same as one built from scratch.
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHUNKS_PER_SIDE,
  LEVEL_BRIDGE,
  LEVEL_ELEVATED_1,
  ROAD_LEVELS,
  ROAD_TYPES,
  bridgeDeckLevel,
  heightAt,
  applyRoadDelta,
  createBareState,
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
  isRaised,
  junctionAt,
  nodeLift,
  raisedPierStations,
  masked,
  paintFor,
  pierStations,
  roadMask,
  roadSegmentsAt,
  segPath,
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
function build(state: SimState, from: [number, number], to: [number, number], type = "street", control?: [number, number]): void {
  const result = submit(state, {
    seq: ++seq,
    playerId: "p1",
    type: "BuildRoad",
    payload: {
      from: { x: from[0], z: from[1] },
      to: { x: to[0], z: to[1] },
      type,
      ...(control ? { control: { x: control[0], z: control[1] } } : {}),
    },
  });
  if (!result.ok) throw new Error(`road refused: ${result.reason}`);
  step(state);
}

function city(roads: [from: [number, number], to: [number, number], type?: string, control?: [number, number]][]): RoadNetwork {
  const state = createBareState(SEED);
  for (const [from, to, type, control] of roads) build(state, from, to, type, control);
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

/**
 * A curve is drawn as straight pieces, so its kerbs cut a little inside the
 * true curve on the outside of a bend. Points this close to a curved road's
 * kerb may be covered or not.
 */
const KERB_SLACK = 0.05;

const walks = new Map<string, number[]>();
const paths = new WeakMap<RoadNet, Map<number, ReturnType<typeof segPath>>>();

function cachedPath(net: RoadNet, seg: number): ReturnType<typeof segPath> {
  let byNet = paths.get(net);
  if (!byNet) {
    byNet = new Map();
    paths.set(net, byNet);
  }
  let path = byNet.get(seg);
  if (!path) {
    path = segPath(net, seg);
    byNet.set(seg, path);
  }
  return path;
}

/** Points every 0.25 m along a curved path, as x, z and distance triples. */
function curveWalk(f: ReturnType<typeof segPath>): number[] {
  const key = `${f.seg}:${f.ax}:${f.az}:${f.length}`;
  let walk = walks.get(key);
  if (!walk) {
    walk = [];
    for (let s = 0; s <= f.length; s += 0.25) {
      const p = f.point(s);
      walk.push(p.x, p.z, s);
    }
    walks.set(key, walk);
  }
  return walk;
}

/**
 * Where (x, z) lies against the roads' full, untrimmed strips: on one, off
 * every one, or within KERB_SLACK of a curved road's kerb.
 */
function onRoad(net: RoadNet, x: number, z: number): "on" | "off" | "edge" {
  let edge = false;
  for (let seg = 0; seg < net.segFlags.length; seg++) {
    if (!net.segFlags[seg]) continue;
    const f = cachedPath(net, seg);
    if (!f.curved) {
      const px = x - f.ax;
      const pz = z - f.az;
      const t = px * f.dx + pz * f.dz;
      const o = -px * f.dz + pz * f.dx;
      if (t >= 0 && t <= f.length && Math.abs(o) <= f.half) return "on";
      continue;
    }
    // Distance to the curve, from a fine walk along it and a local refinement.
    const walk = curveWalk(f);
    let best = Infinity;
    let bestS = 0;
    for (let k = 0; k < walk.length; k += 3) {
      const d = Math.hypot((walk[k] ?? 0) - x, (walk[k + 1] ?? 0) - z);
      if (d < best) {
        best = d;
        bestS = walk[k + 2] ?? 0;
      }
    }
    if (best > f.half + 1) continue;
    for (let s = Math.max(0, bestS - 0.25); s <= Math.min(f.length, bestS + 0.25); s += 0.002) {
      const p = f.point(s);
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    }
    // Past an end the strip ends square, which the distance to the end point does not show.
    const atEnd = bestS <= 0.25 || bestS >= f.length - 0.25;
    if (atEnd) {
      const end = bestS <= 0.25 ? f.frame(0) : f.frame(f.length);
      const along = (x - end.x) * end.dx + (z - end.z) * end.dz;
      if (bestS <= 0.25 ? along < 0 : along > 0) continue;
    }
    if (best <= f.half - KERB_SLACK) return "on";
    if (best <= f.half + KERB_SLACK) edge = true;
  }
  return edge ? "edge" : "off";
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
      const where = onRoad(net, x, z);
      if (where === "on") {
        onCount++;
        expect(n, `road point ${x.toFixed(2)}, ${z.toFixed(2)} covered ${n} times`).toBe(1);
      } else {
        expect(n, `${where} point ${x.toFixed(2)}, ${z.toFixed(2)} covered ${n} times`).toBeLessThanOrEqual(1);
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
      const state = createBareState(SEED);
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

describe("curves", () => {
  it("draw a curved road with no gaps or overlaps, and on the curve", () => {
    const net = city([[[4200, 4450], [4400, 4450], "avenue", [4300, 4350]]]);
    expectTiled(net, 4190, 4380, 4410, 4460, 0.9);
    // Every surface vertex is a kerb point: half a width from the true curve.
    const f = segPath(net, 0);
    expect(f.curved).toBe(true);
    const g = allChunks(net).get(chunkAt(4300, 4450));
    const p = g?.surface.positions ?? new Float32Array();
    expect(p.length).toBeGreaterThan(0);
    for (let v = 0; v < p.length / 3; v += 7) {
      const x = p[v * 3] ?? 0;
      const z = p[v * 3 + 2] ?? 0;
      let best = Infinity;
      for (let s = 0; s <= f.length; s += 0.05) best = Math.min(best, Math.hypot(f.point(s).x - x, f.point(s).z - z));
      expect(Math.abs(best - f.half)).toBeLessThan(0.06);
    }
  });

  it("fill junctions with curved arms with no gaps or overlaps", () => {
    const net = city([
      // A curve with a straight street ending on its body, and one crossing it.
      [[4150, 4500], [4350, 4500], "street", [4250, 4600]],
      [[4250, 4640], [4250, 4551]],
      [[4190, 4420], [4190, 4620]],
      // Two curves crossing twice.
      [[4400, 4700], [4600, 4700], "street", [4500, 4800]],
      [[4400, 4765], [4600, 4765], "street", [4500, 4665]],
      // A curved avenue and a curved street off one node.
      [[4200, 4800], [4350, 4900], "avenue", [4300, 4800]],
      [[4200, 4800], [4250, 4950], "street", [4180, 4900]],
    ]);
    expectTiled(net, 4225, 4525, 4275, 4575, 0.6);
    expectTiled(net, 4165, 4480, 4215, 4540, 0.6);
    expectTiled(net, 4400, 4700, 4600, 4770, 0.9);
    expectTiled(net, 4180, 4780, 4240, 4840, 0.6);
  }, 60_000);

  it("are cut finer on the surface than in the city band's lines", () => {
    const f = segPath(city([[[4200, 4450], [4400, 4450], "avenue", [4300, 4350]]]), 0);
    const surface = f.stations(0, f.length, ROADS.sampleStep);
    const lines = f.stations(0, f.length, ROADS.cityLines.sampleStep, ROADS.curves.lineTurn);
    expect(surface.length).toBeGreaterThan(lines.length * 3);
    // No surface piece turns through more than the limit.
    for (let k = 0; k + 1 < surface.length; k++) {
      const a = f.frame(surface[k] ?? 0);
      const b = f.frame(surface[k + 1] ?? 0);
      expect(Math.acos(Math.min(1, a.dx * b.dx + a.dz * b.dz))).toBeLessThanOrEqual(ROADS.curves.surfaceTurn + 1e-3);
    }
    // Straight roads keep their old pieces.
    const straight = segPath(city([[[4480, 4490], [4520, 4490]]]), 0);
    expect(straight.stations(0, 40, 8)).toEqual(stations(4480, 4490, 1, 0, 0, 40, 8));
  });

  it("split a curve at a chunk line, with each piece in one chunk", () => {
    // Bulges south over z = 4500 and back.
    const net = city([[[4200, 4450], [4400, 4450], "avenue", [4300, 4600]]]);
    const chunks = allChunks(net);
    expect([...chunks.keys()].sort((a, b) => a - b)).toEqual([chunkAt(4300, 4450), chunkAt(4300, 4520)]);
    for (const [c, g] of chunks) {
      const p = g.surface.positions;
      for (let v = 0; v < p.length / 3; v++) {
        const z = p[v * 3 + 2] ?? 0;
        // Kerb vertices lie half a width either side of the centre, which is on the right side of the line.
        expect(c === chunkAt(4300, 4450) ? z <= 4500 + 9.01 : z >= 4500 - 9.01).toBe(true);
      }
    }
    expectTiled(net, 4220, 4490, 4380, 4530, 0.5);
  });

  it("mask decoration along the curve, not its chord", () => {
    const net = city([[[4200, 4450], [4400, 4450], "street", [4300, 4350]]]);
    const chunk = chunkAt(4300, 4420);
    const mask = roadMask(net, chunk, [0]);
    // The apex is at (4300, 4400); the chord's middle, 50 m away, is clear.
    expect(masked(mask, chunk, 4300, 4400, MASK_TREES)).toBe(true);
    expect(masked(mask, chunk, 4300, 4450, MASK_TREES)).toBe(false);
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
    const state = createBareState(SEED);
    recordRoadChanges(state.roads);
    const copy = structuredClone(state.roads);
    const index = new RoadChunks();
    index.reset(copy);
    const drawn = new Map<number, string>();
    const key = (g: ReturnType<typeof buildRoadChunk>) =>
      JSON.stringify(["surface", "markings", "lines"].map((k) => Array.from((g as unknown as Record<string, MeshArrays>)[k]?.positions ?? [])));
    const plan: [from: [number, number], to: [number, number], type: string, control?: [number, number]][] = [
      [[4150, 4450], [4650, 4450], "street"],
      [[4300, 4420], [4300, 4700], "avenue"],
      [[4520, 4400], [4520, 4600], "oneWay"],
      [[4150, 4550], [4600, 4550], "street"],
      [[4400, 4480], [4440, 4520], "street"],
      [[4300, 4700], [4450, 4800], "avenue"],
      [[4480, 4560], [4560, 4480], "street"],
      [[4160, 4760], [4280, 4760], "street", [4220, 4860]],
      [[4250, 4570], [4250, 4690], "street", [4390, 4630]],
    ];
    for (const [from, to, type, control] of plan) {
      build(state, from, to, type, control);
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
    const state = createBareState(SEED);
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

describe("a bridge", () => {
  // Seed 2026's inlet: water from x = 3488 to 3600 along z = 6600.
  function bridged(): { net: RoadNetwork; seg: number } {
    const net = city([[[3400, 6600], [3700, 6600]]]);
    const seg = Array.from(net.segLevelA).indexOf(LEVEL_BRIDGE);
    expect(seg).toBeGreaterThanOrEqual(0);
    return { net, seg };
  }

  it("draws its deck level at the clearance over the water, and joins the ground at its banks", () => {
    const { net, seg } = bridged();
    const deck = bridgeDeckLevel(terrain.waterLevel);
    const g = buildRoadChunk(net, terrain, chunkAt(3550, 6600), [0, 1, 2], [], () => null);
    const p = g.surface.positions;
    let overWater = 0;
    let atDeck = 0;
    let below = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] ?? 0;
      const y = p[i + 1] ?? 0;
      const z = p[i + 2] ?? 0;
      if (y < deck - ROADS.bridges.deckDepth - 0.5) below++;
      if (heightAt(terrain, x, z) > terrain.waterLevel || Math.abs(z - 6600) > 5.01) continue;
      overWater++;
      if (Math.abs(y - deck) < 1e-6) atDeck++;
    }
    // Every deck vertex over the water is at the deck; railings and the deck's underside are not.
    expect(overWater).toBeGreaterThan(20);
    expect(atDeck).toBeGreaterThan(20);
    // Piers reach below the deck, down to the lake bed.
    expect(below).toBeGreaterThan(0);
    // The ramp ends at the bank node's own height.
    const a = net.segA[seg] ?? 0;
    expect(net.nodeHeight[a]).toBe(heightAt(terrain, net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0));
  });

  it("stands piers along its level deck, no further apart than the spacing", () => {
    const { net, seg } = bridged();
    const f = segPath(net, seg);
    const deck = bridgeDeckLevel(terrain.waterLevel);
    const level = (t: number) => (t > 40 && t < f.length - 40 ? deck : deck - 1);
    const piers = pierStations(f.length, level, deck);
    expect(piers.length).toBeGreaterThanOrEqual(3);
    expect(piers[0]).toBeGreaterThan(40);
    for (let i = 1; i < piers.length; i++) expect((piers[i] ?? 0) - (piers[i - 1] ?? 0)).toBeLessThanOrEqual(ROADS.bridges.pierSpacing + 1e-9);
  });
});

describe("a road on another level", () => {
  /** An elevated avenue over a ground street, both across the flat square, and their segment ids. */
  function overpass(): { net: RoadNetwork; ground: number; raised: number } {
    const state = createBareState(SEED);
    build(state, [4200, 4600], [4400, 4600]);
    const result = submit(state, {
      seq: ++seq,
      playerId: "p1",
      type: "BuildRoad",
      payload: { from: { x: 4300, z: 4520 }, to: { x: 4300, z: 4680 }, type: "avenue", level: "elevated1" },
    });
    expect(result).toEqual({ ok: true });
    step(state);
    const net = state.roads;
    const raised = Array.from(net.segLevelA).indexOf(LEVEL_ELEVATED_1);
    return { net, ground: raised === 0 ? 1 : 0, raised };
  }

  it("is drawn at its level's height over the ground, on piers, and the road under it stays on the ground", () => {
    const { net, raised } = overpass();
    expect(isRaised(net, raised)).toBe(true);
    const g = buildRoadChunk(net, terrain, chunkAt(4300, 4600), [raised], [], () => null);
    const p = g.surface.positions;
    let atDeck = 0;
    let lower = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] ?? 0;
      const y = p[i + 1] ?? 0;
      const z = p[i + 2] ?? 0;
      // On the centre line's ground plus the level's height, across the whole width.
      if (Math.abs(y - (heightAt(terrain, 4300, z) + ROAD_LEVELS.elevated1)) < 1e-3 && Math.abs(x - 4300) <= 9.01) atDeck++;
      if (y < heightAt(terrain, x, z)) lower++;
    }
    expect(atDeck).toBeGreaterThan(10);
    // The piers reach into the ground.
    expect(lower).toBeGreaterThan(0);
    // The street beneath is drawn draped, as before.
    const under = buildRoadChunk(net, terrain, chunkAt(4300, 4600), [overpass().ground], [], () => null).surface.positions;
    for (let i = 0; i < under.length; i += 3) {
      expect(under[i + 1]).toBeCloseTo(heightAt(terrain, under[i] ?? 0, under[i + 2] ?? 0), 4);
    }
  });

  it("stands piers no further apart than the spacing, away from its ends", () => {
    for (const length of [10, 36, 37, 160, 1000]) {
      const st = raisedPierStations(length);
      expect(st.length).toBeGreaterThan(0);
      for (const t of st) expect(t > 0 && t < length).toBe(true);
      const all = [0, ...st, length];
      for (let i = 1; i < all.length; i++) expect((all[i] ?? 0) - (all[i - 1] ?? 0)).toBeLessThanOrEqual(ROADS.bridges.pierSpacing + 1e-9);
    }
  });

  it("lifts a junction whose roads are all on one level, and no other", () => {
    const { net, ground, raised } = overpass();
    expect(nodeLift(net, net.segA[raised] ?? 0)).toBe(ROAD_LEVELS.elevated1);
    expect(nodeLift(net, net.segA[ground] ?? 0)).toBe(0);
  });
});
