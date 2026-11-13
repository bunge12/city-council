import { describe, expect, it } from "vitest";
import { createState, planRoad, step, submit, type Command, type CommandResult, type SimState } from "../src/index";
import {
  curveBox,
  isStraight,
  minRadius,
  nearestOnQuad,
  quadMeetings,
  quadPoint,
  segmentQuad,
  straightQuad,
  subQuad,
  type Quad,
} from "../src/roads/curve";
import {
  NONE,
  checkRoadNetwork,
  curveLength,
  isNode,
  isSegment,
  nodeIdLimit,
  segmentCount,
  segmentIdLimit,
  segmentsAt,
  type RoadNetwork,
} from "../src/roads/network";
import { ROAD_TYPES } from "../src/roads/balance";
import { buildRoadIndex, forSegmentChunks, nearestPointOnSegment, roadIndexOf, segmentsInBox } from "../src/roads/spatial";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/curves.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import { unjoinedCrossings } from "./unjoined";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
// build-road.test.ts checks it is still there.
const SEED = 2026;
/** A north-south street at x = 3300 from z = 6680 to 6780 is dry; 100 m east is water. */
const SHORE = { x: 3300, z0: 6680, z1: 6780 };
/** A north-south street at x = 2000 from z = 1380 to 1460 is gentle; 40 m west it is steep. */
const SLOPE = { x: 2000, z0: 1380, z1: 1460 };

const fixture = fixtureJson as ReplayFixture;

let seq = 0;
function road(from: [number, number], to: [number, number], control?: [number, number], type = "street"): Command {
  const payload: Record<string, unknown> = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  if (control) payload["control"] = { x: control[0], z: control[1] };
  return { seq: ++seq, playerId: "p1", type: "BuildRoad", payload };
}

function build(state: SimState, command: Command): CommandResult {
  const result = submit(state, command);
  step(state);
  return result;
}

function rejection(state: SimState, command: Command): string {
  const result = submit(state, command);
  expect(result.ok, "the command should be refused").toBe(false);
  return result.ok ? "" : result.reason;
}

function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let s = 0; s < segmentIdLimit(net); s++) if (isSegment(net, s)) out.push(s);
  return out;
}

/** The live node at (x, z), or NONE. */
function nodeAt(net: RoadNetwork, x: number, z: number): number {
  for (let id = 0; id < nodeIdLimit(net); id++) {
    if (isNode(net, id) && net.nodeX[id] === x && net.nodeZ[id] === z) return id;
  }
  return NONE;
}

/** Nodes where four segments meet. */
function fourWays(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id) && segmentsAt(net, id).length === 4) out.push(id);
  return out;
}

/** How far curve `piece` strays from curve `whole`, sampled at 200 points: the furthest any is from `whole`. */
function strayFrom(piece: Quad, whole: Quad): number {
  let worst = 0;
  for (let i = 0; i <= 200; i++) {
    const p = quadPoint(piece, i / 200);
    const d = Math.sqrt(nearestOnQuad(whole, p.x, p.z).d2);
    if (d > worst) worst = d;
  }
  return worst;
}

/** The arch used in most tests: from (4200, 4500) to (4400, 4500), bulging 50 m south to (4300, 4550). Radius 100 m at its apex. */
const ARCH: [[number, number], [number, number], [number, number]] = [
  [4200, 4500],
  [4400, 4500],
  [4300, 4600],
];

function withArch(): SimState {
  const state = createState(SEED);
  expect(build(state, road(...ARCH))).toEqual({ ok: true });
  return state;
}

describe("curve maths", () => {
  const arch: Quad = { ax: 0, az: 0, cx: 100, cz: 100, bx: 200, bz: 0 };

  it("starts and ends exactly at the nodes", () => {
    expect(quadPoint(arch, 0)).toEqual({ x: 0, z: 0 });
    expect(quadPoint(arch, 1)).toEqual({ x: 200, z: 0 });
    expect(quadPoint(arch, 0.5)).toEqual({ x: 100, z: 50 });
  });

  it("measures length on a fixed subdivision, close to the true length", () => {
    // The parabola z = x - x^2 / 200 from 0 to 200 has length 229.558 m.
    const length = curveLength(0, 0, 100, 100, 200, 0);
    expect(length).toBeCloseTo(229.558, 0);
    expect(length).toBeLessThan(229.558);
    // The same number every time: only exact operations.
    expect(curveLength(0, 0, 100, 100, 200, 0)).toBe(length);
    // A straight segment is measured exactly.
    expect(curveLength(0, 0, 50, 0, 100, 0)).toBe(100);
  });

  it("finds the tightest radius", () => {
    // A parabola from (0, 0) through (w, h) to (2w, 0) has radius w^2 / h at its apex.
    expect(minRadius(arch)).toBe(100);
    expect(minRadius({ ax: 0, az: 0, cx: 30, cz: 30, bx: 60, bz: 0 })).toBe(30);
    expect(minRadius(straightQuad(0, 0, 100, 0))).toBe(Infinity);
    // A control point beyond an end on the same line folds the curve back on itself.
    expect(minRadius({ ax: 0, az: 0, cx: 150, cz: 0, bx: 100, bz: 0 })).toBe(0);
    // Off-centre: the tightest point is not the middle, and is tighter than the apex of the symmetric arch.
    expect(minRadius({ ax: 0, az: 0, cx: 40, cz: 100, bx: 200, bz: 0 })).toBeLessThan(100);
  });

  it("bounds a curve by its bulge, not its chord", () => {
    expect(curveBox(arch)).toEqual({ minX: 0, minZ: 0, maxX: 200, maxZ: 50 });
    expect(curveBox(straightQuad(10, 20, 0, 5))).toEqual({ minX: 0, minZ: 5, maxX: 10, maxZ: 20 });
  });

  it("finds the nearest point on a curve", () => {
    const near = nearestOnQuad(arch, 100, 80);
    expect(near.t).toBeCloseTo(0.5, 9);
    expect(near.x).toBeCloseTo(100, 6);
    expect(near.z).toBeCloseTo(50, 6);
    expect(Math.sqrt(near.d2)).toBeCloseTo(30, 6);
    // Past an end, the end.
    expect(nearestOnQuad(arch, -10, 0).t).toBe(0);
  });

  it("finds where a curve crosses a line, twice", () => {
    const line = straightQuad(-10, 30, 210, 30);
    const met = quadMeetings(arch, line);
    expect(met.along).toBe(false);
    expect(met.at).toHaveLength(2);
    for (const m of met.at) {
      const p = quadPoint(arch, m.t);
      expect(p.z).toBeCloseTo(30, 3);
      const q = quadPoint(line, m.u);
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(1e-3);
    }
  });

  it("finds where a curve crosses a curve twice", () => {
    const other: Quad = { ax: 0, az: 60, cx: 100, cz: -40, bx: 200, bz: 60 };
    const met = quadMeetings(arch, other);
    expect(met.along).toBe(false);
    expect(met.at).toHaveLength(2);
    for (const m of met.at) {
      const p = quadPoint(arch, m.t);
      const q = quadPoint(other, m.u);
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(1e-3);
    }
    // Symmetric about x = 100.
    expect((met.at[0]?.t ?? 0) + (met.at[1]?.t ?? 0)).toBeCloseTo(1, 6);
  });

  it("knows a curve laid over itself runs along it", () => {
    expect(quadMeetings(arch, subQuad(arch, 0.2, 0.8)).along).toBe(true);
  });

  it("splits a curve into two that trace it", () => {
    const left = subQuad(arch, 0, 0.3);
    const right = subQuad(arch, 0.3, 1);
    expect(strayFrom(left, arch)).toBeLessThan(1e-9);
    expect(strayFrom(right, arch)).toBeLessThan(1e-9);
  });
});

describe("BuildRoad with a control point", () => {
  it("builds one curved segment", () => {
    const state = withArch();
    const net = state.roads;
    expect(segmentCount(net)).toBe(1);
    expect(net.segCX[0]).toBe(4300);
    expect(net.segCZ[0]).toBe(4600);
    expect(isStraight(segmentQuad(net, 0))).toBe(false);
    expect(net.segLength[0]).toBe(curveLength(4200, 4500, 4300, 4600, 4400, 4500));
  });

  it("prices the curve by its length along the curve", () => {
    const plan = planRoad(createState(SEED).roads, terrainOf(SEED), road(...ARCH).payload);
    if (!plan.ok) throw new Error(plan.reason);
    const street = ROAD_TYPES.find((t) => t.id === "street");
    expect(plan.plan.length).toBe(curveLength(4200, 4500, 4300, 4600, 4400, 4500));
    expect(plan.plan.cost).toBe(Math.round(plan.plan.length * (street?.buildCostPerMetre ?? 0)));
    expect(plan.plan.control).toEqual({ x: 4300, z: 4600 });
  });

  it("builds a straight road when the control point is on the line between the ends", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4400, 4500], [4250, 4500]))).toEqual({ ok: true });
    expect(isStraight(segmentQuad(state.roads, 0))).toBe(true);
    expect(state.roads.segLength[0]).toBe(200);
  });

  it("refuses a control point that is not a point", () => {
    const command = road([4200, 4500], [4400, 4500]);
    (command.payload as Record<string, unknown>)["control"] = { x: 4300 };
    expect(rejection(createState(SEED), command)).toBe("A curved road's control point needs a finite x and z");
  });
});

describe("the radius limit", () => {
  it("refuses a curve tighter than the road type allows", () => {
    // Radius 10 m at its apex; a street needs 20 m.
    expect(rejection(createState(SEED), road([4200, 4500], [4240, 4500], [4220, 4540]))).toBe(
      "The curve is too tight: a 10 m radius, and the street limit is 20 m",
    );
  });

  it("comes from the road type", () => {
    // Radius 30 m: wide enough for a street, too tight for an avenue.
    const curve = (type: string) => road([4200, 4500], [4260, 4500], [4230, 4530], type);
    expect(build(createState(SEED), curve("street"))).toEqual({ ok: true });
    expect(rejection(createState(SEED), curve("avenue"))).toBe(
      "The curve is too tight: a 30 m radius, and the avenue limit is 40 m",
    );
  });

  it("refuses a curve that folds back on itself", () => {
    expect(rejection(createState(SEED), road([4200, 4500], [4300, 4500], [4350, 4500]))).toMatch(/^The curve is too tight: a 0 m radius/);
  });
});

describe("the ground under a curve", () => {
  it("is checked along the curve, not the chord, for water", () => {
    const straight = road([SHORE.x, SHORE.z0], [SHORE.x, SHORE.z1]);
    expect(planRoad(createState(SEED).roads, terrainOf(SEED), straight.payload).ok).toBe(true);
    const bulging = road([SHORE.x, SHORE.z0], [SHORE.x, SHORE.z1], [SHORE.x + 100, (SHORE.z0 + SHORE.z1) / 2]);
    // Over the water it would be a bridge, but the curve leaves no room on the banks for its ramps.
    expect(rejection(createState(SEED), bulging)).toMatch(/^Not enough room on the bank for the ramp up to the bridge/);
  });

  it("is checked along the curve, not the chord, for slope", () => {
    const straight = road([SLOPE.x, SLOPE.z0], [SLOPE.x, SLOPE.z1]);
    expect(planRoad(createState(SEED).roads, terrainOf(SEED), straight.payload).ok).toBe(true);
    const bulging = road([SLOPE.x, SLOPE.z0], [SLOPE.x, SLOPE.z1], [SLOPE.x - 80, (SLOPE.z0 + SLOPE.z1) / 2]);
    expect(rejection(createState(SEED), bulging)).toMatch(/^Too steep: a \d+% grade, and the street limit is 12%$/);
  });
});

describe("crossings with curves", () => {
  it("splits a street a curve crosses twice, and the curve at both crossings", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4500, 4500]))).toEqual({ ok: true });
    // An arch from z = 4420 bulging to z = 4520: it crosses z = 4500 twice.
    expect(build(state, road([4250, 4420], [4450, 4420], [4350, 4620]))).toEqual({ ok: true });
    const net = state.roads;
    expect(segmentCount(net)).toBe(6);
    const crossings = fourWays(net);
    expect(crossings).toHaveLength(2);
    // On a straight street, crossings are on the grid.
    for (const n of crossings) {
      expect(net.nodeZ[n]).toBe(4500);
      expect(((net.nodeX[n] ?? 0) * 8) % 1).toBe(0);
    }
    expect(unjoinedCrossings(net)).toEqual([]);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("splits a curve a straight road crosses into two curves that trace it within 1 cm", () => {
    const state = withArch();
    const before = segmentQuad(state.roads, 0);
    // Off-centre, so the split is not at the curve's middle.
    expect(build(state, road([4240, 4430], [4240, 4650]))).toEqual({ ok: true });
    const net = state.roads;
    expect(segmentCount(net)).toBe(4);
    const [cross] = fourWays(net);
    expect(cross).toBeDefined();
    // The new road is straight, so the curved segments are the arch's pieces.
    let traced = 0;
    for (const s of liveSegments(net)) {
      const q = segmentQuad(net, s);
      if (isStraight(q)) continue;
      expect(strayFrom(q, before)).toBeLessThan(0.01);
      traced++;
    }
    expect(traced).toBe(2);
    // The two pieces' lengths add up to the whole, within the subdivision's error.
    const total = liveSegments(net).filter((s) => !isStraight(segmentQuad(net, s))).reduce((sum, s) => sum + (net.segLength[s] ?? 0), 0);
    expect(total).toBeCloseTo(curveLength(4200, 4500, 4300, 4600, 4400, 4500), 0);
    expect(unjoinedCrossings(net)).toEqual([]);
  });

  it("splits a curve that a curve crosses twice, and the new curve too", () => {
    const state = withArch();
    const before = segmentQuad(state.roads, 0);
    // From z = 4560 bulging north to z = 4510: it crosses the arch twice.
    expect(build(state, road([4200, 4560], [4400, 4560], [4300, 4460]))).toEqual({ ok: true });
    const net = state.roads;
    expect(segmentCount(net)).toBe(6);
    expect(fourWays(net)).toHaveLength(2);
    for (const s of liveSegments(net)) expect(isStraight(segmentQuad(net, s))).toBe(false);
    // The arch's three pieces still trace it.
    const archPieces = liveSegments(net).filter((s) => strayFrom(segmentQuad(net, s), before) < 0.01);
    expect(archPieces).toHaveLength(3);
    expect(unjoinedCrossings(net)).toEqual([]);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("makes a T-junction where a road ends on a curve's body, exactly on the curve", () => {
    const state = withArch();
    // Ends 1 m short of the apex at (4300, 4550), within the merge distance.
    expect(build(state, road([4300, 4700], [4300, 4551]))).toEqual({ ok: true });
    const net = state.roads;
    expect(segmentCount(net)).toBe(3);
    const tee = nodeAt(net, 4300, 4550);
    expect(tee).not.toBe(NONE);
    expect(segmentsAt(net, tee)).toHaveLength(3);
    expect(unjoinedCrossings(net)).toEqual([]);
  });

  it("refuses a curve laid along another", () => {
    const state = withArch();
    // The same arch, a little shorter at each end: it runs along the first.
    const along = road(
      [quadPoint(segmentQuad(state.roads, 0), 0.2).x, quadPoint(segmentQuad(state.roads, 0), 0.2).z],
      [4400, 4500],
      [4300, 4600],
    );
    const reason = rejection(state, along);
    expect(reason.length).toBeGreaterThan(0);
  });

  it("refuses a curve that leaves a node too close to the road already there", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4400, 4500]))).toEqual({ ok: true });
    // Starts at the street's end and leaves it at 0 degrees, then curves away.
    expect(rejection(state, road([4400, 4500], [4300, 4600], [4300, 4500]))).toMatch(/too sharp/);
  });
});

describe("the spatial index and curves", () => {
  // From (4200, 4450) to (4400, 4450), bulging south over the chunk line z = 4500 to z = 4525.
  function bulge(): SimState {
    const state = createState(SEED);
    expect(build(state, road([4200, 4450], [4400, 4450], [4300, 4600]))).toEqual({ ok: true });
    return state;
  }

  it("files a curve under every chunk its bulge reaches", () => {
    const chunks: number[] = [];
    forSegmentChunks(bulge().roads, 0, (c) => chunks.push(c));
    // Chunk (8, 8) holds the chord, chunk (8, 9) the bulge.
    expect(chunks.sort((a, b) => a - b)).toEqual([8 * 24 + 8, 9 * 24 + 8]);
  });

  it("finds a curve in a box by its shape", () => {
    const index = roadIndexOf(bulge().roads);
    expect(segmentsInBox(index, 4295, 4520, 4305, 4530)).toEqual([0]);
    // On the chord, where the curve is not.
    expect(segmentsInBox(index, 4295, 4445, 4305, 4455)).toEqual([]);
  });

  it("finds the nearest point on a curve", () => {
    const near = nearestPointOnSegment(roadIndexOf(bulge().roads), 4300, 4540, 30);
    expect(near?.segment).toBe(0);
    expect(near?.t).toBeCloseTo(0.5, 9);
    expect(near?.z).toBeCloseTo(4525, 6);
    expect(near?.distance).toBeCloseTo(15, 6);
  });

  it("built live matches built from scratch", () => {
    const state = bulge();
    expect(build(state, road([4300, 4400], [4300, 4700]))).toEqual({ ok: true });
    expect(roadIndexOf(state.roads).segCells).toEqual(buildRoadIndex(state.roads).segCells);
  });
});

describe("replay fixture curves", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log).toHaveLength(fixture.log.length);
    expect(unjoinedCrossings(state.roads)).toEqual([]);
    expect(liveSegments(state.roads).some((s) => !isStraight(segmentQuad(state.roads, s)))).toBe(true);
  });
});
