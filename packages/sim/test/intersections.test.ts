import { describe, expect, it } from "vitest";
import {
  ROAD_BUILD,
  createBareState,
  createState,
  hashState,
  heightAt,
  nextFloat,
  nextInt,
  planRoad,
  replay,
  seedRng,
  step,
  submit,
  type Command,
  type CommandResult,
  type SimState,
} from "../src/index";
import { crossingPoint, segmentsMeet } from "../src/roads/build";
import { isStraight, segmentQuad } from "../src/roads/curve";
import { roadTypeIndex } from "../src/roads/balance";
import {
  LEVEL_BRIDGE,
  NETWORK_RAIL,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  checkRoadNetwork,
  isNode,
  isSegment,
  nodeIdLimit,
  segmentIdLimit,
  segmentsAt,
  segmentCount,
  type RoadNetwork,
} from "../src/roads/network";
import { buildRoadIndex, roadIndexOf } from "../src/roads/spatial";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/intersections.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import { unjoinedCrossings } from "./unjoined";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
// build-road.test.ts checks it is still there.
const SEED = 2026;
const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };

const fixture = fixtureJson as ReplayFixture;

let seq = 0;
function road(from: [number, number], to: [number, number], type = "street", playerId = "p1"): Command {
  return { seq: ++seq, playerId, type: "BuildRoad", payload: { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type } };
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

/** A state with one street from (4200, 4500) to (4500, 4500): nodes 0 and 1, segment 0. */
function withStreet(type = "street"): SimState {
  const state = createBareState(SEED);
  expect(build(state, road([4200, 4500], [4500, 4500], type))).toEqual({ ok: true });
  return state;
}

/** The live node at (x, z), or NONE. */
function nodeAt(net: RoadNetwork, x: number, z: number): number {
  for (let id = 0; id < nodeIdLimit(net); id++) {
    if (isNode(net, id) && net.nodeX[id] === x && net.nodeZ[id] === z) return id;
  }
  return NONE;
}

/** Each live segment as [node A, node B]. */
function segments(net: RoadNetwork): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 0; s < segmentIdLimit(net); s++) if (isSegment(net, s)) out.push([net.segA[s] ?? NONE, net.segB[s] ?? NONE]);
  return out;
}

describe("a road across another", () => {
  it("splits it and makes a four-way intersection", () => {
    const state = withStreet();
    expect(build(state, road([4350, 4400], [4350, 4600]))).toEqual({ ok: true });
    const net = state.roads;
    const cross = nodeAt(net, 4350, 4500);
    expect(cross).not.toBe(NONE);
    expect(segmentsAt(net, cross)).toHaveLength(4);
    expect(segmentCount(net)).toBe(4);
    expect(unjoinedCrossings(net)).toEqual([]);
    expect(state.log).toHaveLength(2);
  });

  it("hands out ids in a fixed order", () => {
    const state = withStreet();
    build(state, road([4350, 4400], [4350, 4600]));
    const net = state.roads;
    // New nodes from start to end: the start, the crossing, the end.
    expect([...net.nodeX]).toEqual([4200, 4500, 4350, 4350, 4350]);
    expect([...net.nodeZ]).toEqual([4500, 4500, 4400, 4500, 4600]);
    // The split first: its piece at node A takes back the freed id 0. Then
    // the new road from start to end.
    expect(segments(net)).toEqual([
      [0, 3],
      [3, 1],
      [2, 3],
      [3, 4],
    ]);
  });

  it("keeps the type, network and level of the segment it splits", () => {
    const state = withStreet("avenue");
    build(state, road([4350, 4400], [4350, 4600], "oneWay"));
    const net = state.roads;
    expect([...net.segType]).toEqual([roadTypeIndex("avenue"), roadTypeIndex("avenue"), roadTypeIndex("oneWay"), roadTypeIndex("oneWay")]);
    expect([...net.segNetwork]).toEqual([NETWORK_ROAD, NETWORK_ROAD, NETWORK_ROAD, NETWORK_ROAD]);
    expect([...net.segLevel]).toEqual([0, 0, 0, 0]);
  });

  it("sets the new node's height from the ground", () => {
    const state = withStreet();
    build(state, road([4350, 4400], [4350, 4600]));
    const t = terrainOf(SEED);
    const cross = nodeAt(state.roads, 4350, 4500);
    expect(state.roads.nodeHeight[cross]).toBe(heightAt(t, 4350, 4500));
  });

  it("prices only the new road, every piece of it", () => {
    const state = withStreet();
    const result = planRoad(state.roads, terrainOf(SEED), road([4350, 4400], [4350, 4600]).payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.stops.map((s) => [s.x, s.z, s.node, s.splits])).toEqual([
      [4350, 4400, NONE, []],
      [4350, 4500, NONE, [0]],
      [4350, 4600, NONE, []],
    ]);
    expect(result.plan.length).toBe(200);
    expect(result.plan.cost).toBe(200 * result.plan.type.buildCostPerMetre);
  });

  it("goes through three parallel roads as a chain in order along the line", () => {
    const state = createBareState(SEED);
    for (const z of [4500, 4600, 4700]) expect(build(state, road([4200, z], [4600, z]))).toEqual({ ok: true });
    const before = segmentCount(state.roads);
    const result = submit(state, road([4300.3, 4420.7], [4520.1, 4781.9]));
    expect(result).toEqual({ ok: true });
    step(state);
    const net = state.roads;
    expect(segmentCount(net)).toBe(before + 3 + 4);
    expect(unjoinedCrossings(net)).toEqual([]);
    // The four pieces of the new road are the last four ids, start to end,
    // and each starts where the one before it ends.
    const pieces = segments(net).slice(-4);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]?.[0]).toBe(pieces[i - 1]?.[1]);
    const crossZ = pieces.slice(1).map(([a]) => net.nodeZ[a]);
    expect(crossZ).toEqual([4500, 4600, 4700]);
    for (const [a] of pieces.slice(1)) expect(segmentsAt(net, a)).toHaveLength(4);
  });

  it("passes through an existing node it crosses exactly", () => {
    const state = withStreet();
    build(state, road([4350, 4500], [4350, 4650]));
    // A road through the T's node, along neither of its segments.
    expect(build(state, road([4250, 4400], [4450, 4600]))).toEqual({ ok: true });
    const t = nodeAt(state.roads, 4350, 4500);
    expect(segmentsAt(state.roads, t)).toHaveLength(5);
    expect(unjoinedCrossings(state.roads)).toEqual([]);
  });
});

describe("a road that ends on another", () => {
  it("makes a T-junction at its end", () => {
    const state = withStreet();
    expect(build(state, road([4350, 4400], [4350, 4500]))).toEqual({ ok: true });
    const t = nodeAt(state.roads, 4350, 4500);
    expect(segmentsAt(state.roads, t)).toHaveLength(3);
    expect(segmentCount(state.roads)).toBe(3);
  });

  it("makes a T-junction at its start", () => {
    const state = withStreet();
    expect(build(state, road([4350, 4500], [4350, 4650]))).toEqual({ ok: true });
    const t = nodeAt(state.roads, 4350, 4500);
    expect(segmentsAt(state.roads, t)).toHaveLength(3);
  });

  it("joins a segment within the merge distance, at the nearest point on it", () => {
    const state = withStreet();
    const off = ROAD_BUILD.mergeDistance - 1;
    expect(build(state, road([4351, 4400], [4351, 4500 - off]))).toEqual({ ok: true });
    const t = nodeAt(state.roads, 4351, 4500);
    expect(segmentsAt(state.roads, t)).toHaveLength(3);
  });

  it("does not join a segment just past the merge distance", () => {
    const state = withStreet();
    const off = ROAD_BUILD.mergeDistance + 1;
    expect(build(state, road([4351, 4400], [4351, 4500 - off]))).toEqual({ ok: true });
    expect(segmentCount(state.roads)).toBe(2);
  });

  it("splits at both ends when it runs between two roads", () => {
    const state = createBareState(SEED);
    build(state, road([4200, 4500], [4500, 4500]));
    build(state, road([4200, 4700], [4500, 4700]));
    expect(build(state, road([4350, 4500], [4350, 4700]))).toEqual({ ok: true });
    expect(segmentCount(state.roads)).toBe(5);
    expect(segmentsAt(state.roads, nodeAt(state.roads, 4350, 4500))).toHaveLength(3);
    expect(segmentsAt(state.roads, nodeAt(state.roads, 4350, 4700))).toHaveLength(3);
  });
});

describe("a crossing near an existing node", () => {
  // Two segments meeting in a straight line at node (4350, 4500).
  const withNode = (): SimState => {
    const state = createBareState(SEED);
    build(state, road([4200, 4500], [4350, 4500]));
    build(state, road([4350, 4500], [4500, 4500]));
    return state;
  };

  it("moves to the node when it is within the merge distance", () => {
    const state = withNode();
    const off = ROAD_BUILD.mergeDistance - 1;
    expect(build(state, road([4350 + off, 4400], [4350 + off, 4600]))).toEqual({ ok: true });
    const net = state.roads;
    const node = nodeAt(net, 4350, 4500);
    expect(segmentsAt(net, node)).toHaveLength(4);
    // No new node at the crossing: the two ends only.
    expect(nodeAt(net, 4350 + off, 4500)).toBe(NONE);
    expect(segmentCount(net)).toBe(4);
    expect(unjoinedCrossings(net)).toEqual([]);
  });

  it("is refused when it would leave a short piece and no node is near enough", () => {
    const state = withNode();
    const off = (ROAD_BUILD.mergeDistance + ROAD_BUILD.minLength) / 2;
    expect(rejection(state, road([4350 + off, 4400], [4350 + off, 4600]))).toMatch(/^Too close to a junction: every piece .* at least 10 m/);
  });

  it("is refused when it would leave a short piece of the new road", () => {
    const state = withStreet();
    const off = (ROAD_BUILD.mergeDistance + ROAD_BUILD.minLength) / 2;
    expect(rejection(state, road([4350, 4500 - off], [4350, 4600]))).toMatch(/^Too close to a junction/);
  });

  it("joins the new road's end when that is within the merge distance", () => {
    const state = createBareState(SEED);
    build(state, road([4200, 4500], [4500, 4500]));
    // Ends 3 m past the street's body, more than the merge distance from it
    // only along the slant.
    expect(build(state, road([4300, 4400], [4350, 4500 + 3]))).toEqual({ ok: true });
    expect(unjoinedCrossings(state.roads)).toEqual([]);
  });
});

describe("a crossing is refused", () => {
  it("at too shallow an angle", () => {
    const state = withStreet();
    // 20 degrees off the street: tan(20°) is about 0.364.
    expect(rejection(state, road([4250, 4500 - 0.364 * 100], [4450, 4500 + 0.364 * 100]))).toBe(
      "The road crosses another road at too shallow an angle: it must be at least 25 degrees",
    );
    // 30 degrees is fine: tan(30°) is about 0.577.
    expect(build(state, road([4250, 4500 - 0.577 * 100], [4450, 4500 + 0.577 * 100]))).toEqual({ ok: true });
  });

  it("at too shallow an angle at a T-junction", () => {
    const state = withStreet();
    expect(rejection(state, road([4250, 4500 - 0.364 * 100], [4350, 4500]))).toMatch(/too shallow an angle/);
  });

  it("when two roads it crosses are too close together", () => {
    const state = createBareState(SEED);
    build(state, road([4200, 4500], [4500, 4500]));
    build(state, road([4200, 4506], [4500, 4506]));
    expect(rejection(state, road([4350, 4400], [4350, 4600]))).toMatch(/^Too close to a junction/);
  });
});

describe("segments on other layers", () => {
  it("are not split by a ground road", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    const r0 = addNode(net, 4200, 4500, 0);
    const r1 = addNode(net, 4500, 4500, 0);
    addSegment(net, r0, r1, { type: 0, network: NETWORK_RAIL });
    expect(build(state, road([4350, 4400], [4350, 4700]))).toEqual({ ok: true });
    expect(segmentCount(net)).toBe(2);
    expect(nodeAt(net, 4350, 4500)).toBe(NONE);
  });

  it("refuse a ground road across a bridge instead of passing under it", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    const b0 = addNode(net, 4200, 4600, 0);
    const b1 = addNode(net, 4500, 4600, 0);
    addSegment(net, b0, b1, { type: roadTypeIndex("street"), level: LEVEL_BRIDGE });
    expect(submit(state, road([4350, 4400], [4350, 4700]))).toEqual({
      ok: false,
      reason: "The road would cross a bridge, and roads cannot pass over or under each other yet",
    });
  });
});

describe("the crossing point", () => {
  it("does not depend on the order or direction of the two segments", () => {
    const rng = seedRng(7);
    const r = (): number => 4000 + nextFloat(rng) * 1000;
    for (let i = 0; i < 2000; i++) {
      const p = [r(), r(), r(), r()] as const;
      const q = [r(), r(), r(), r()] as const;
      if (!segmentsMeet(...p, ...q)) continue;
      const want = crossingPoint(...p, ...q);
      expect(crossingPoint(...q, ...p)).toEqual(want);
      expect(crossingPoint(p[2], p[3], p[0], p[1], ...q)).toEqual(want);
      expect(crossingPoint(q[2], q[3], q[0], q[1], p[2], p[3], p[0], p[1])).toEqual(want);
    }
  });

  it("is the same whichever of two roads was drawn first", () => {
    const rng = seedRng(11);
    const at = (lo: number, hi: number): number => lo + nextFloat(rng) * (hi - lo);
    let compared = 0;
    for (let i = 0; i < 200; i++) {
      // A road across the square from west to east, and one from north to south.
      const first = road([at(4150, 4250), at(4450, 4950)], [at(4550, 4650), at(4450, 4950)]);
      const second = road([at(4350, 4450), at(4420, 4440)], [at(4350, 4450), at(4960, 4980)]);
      const ab = createBareState(SEED);
      const ba = createBareState(SEED);
      const okAB = build(ab, first).ok && build(ab, second).ok;
      const okBA = build(ba, second).ok && build(ba, first).ok;
      expect(okBA).toBe(okAB);
      if (!okAB) continue;
      const points = (net: RoadNetwork): string[] => {
        const out: string[] = [];
        for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n)) out.push(`${net.nodeX[n]},${net.nodeZ[n]}`);
        return out.sort();
      };
      expect(points(ba.roads)).toEqual(points(ab.roads));
      compared++;
    }
    expect(compared).toBeGreaterThan(150);
  });
});

describe("after any accepted road", () => {
  it("no two segments on the same level cross without a shared node, over 500 random roads, half of them curved", () => {
    const state = createBareState(SEED);
    const rng = seedRng(2026);
    const net = state.roads;
    let accepted = 0;
    let acceptedCurves = 0;
    for (let i = 0; i < 500; i++) {
      // Most roads start anywhere in the square. Some start on an existing
      // node, to exercise joins and crossings next to nodes.
      let x: number;
      let z: number;
      const nodes = nodeIdLimit(net);
      if (nodes > 0 && nextInt(rng, 4) === 0) {
        const n = nextInt(rng, nodes);
        x = (net.nodeX[n] ?? 0) + nextFloat(rng) * 8 - 4;
        z = (net.nodeZ[n] ?? 0) + nextFloat(rng) * 8 - 4;
      } else {
        x = FLAT.x0 + nextFloat(rng) * (FLAT.x1 - FLAT.x0);
        z = FLAT.z0 + nextFloat(rng) * (FLAT.z1 - FLAT.z0);
      }
      const length = 20 + nextFloat(rng) * 280;
      const dx = nextFloat(rng) * 2 - 1;
      const dz = nextFloat(rng) * 2 - 1;
      const norm = Math.sqrt(dx * dx + dz * dz) || 1;
      const to: [number, number] = [x + (dx / norm) * length, z + (dz / norm) * length];
      const types = ["street", "avenue", "oneWay"];
      const command = road([x, z], to, types[nextInt(rng, 3)]);
      // Half the roads are curves: the control point sits off the middle,
      // to either side, by up to half the road's length.
      const curvedRoad = i % 2 === 1;
      if (curvedRoad) {
        const bend = (nextFloat(rng) - 0.5) * length;
        (command.payload as Record<string, unknown>)["control"] = {
          x: (x + to[0]) / 2 - (dz / norm) * bend,
          z: (z + to[1]) / 2 + (dx / norm) * bend,
        };
      }
      const result = build(state, command);
      if (!result.ok) continue;
      accepted++;
      if (curvedRoad) acceptedCurves++;
      expect(unjoinedCrossings(net), `after road ${i}`).toEqual([]);
      expect(checkRoadNetwork(net), `after road ${i}`).toBeNull();
    }
    expect(accepted).toBeGreaterThan(100);
    expect(acceptedCurves).toBeGreaterThan(40);
    let curvedSegments = 0;
    for (let s = 0; s < segmentIdLimit(net); s++) {
      if (isSegment(net, s) && !isStraight(segmentQuad(net, s))) curvedSegments++;
    }
    expect(curvedSegments).toBeGreaterThan(60);
    // The live index kept up with every split.
    expect(roadIndexOf(net).segCells).toEqual(buildRoadIndex(net).segCells);
    expect(roadIndexOf(net).nodeCells).toEqual(buildRoadIndex(net).nodeCells);
  });
});

describe("replay fixture intersections", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(unjoinedCrossings(state.roads)).toEqual([]);
  });

  it("matches the same commands submitted live", () => {
    const live = createState(fixture.seed);
    let next = 0;
    while (live.tick < fixture.untilTick) {
      for (; next < fixture.log.length && fixture.log[next]?.tick === live.tick; next++) {
        const entry = fixture.log[next];
        if (entry) expect(submit(live, entry)).toEqual({ ok: true });
      }
      step(live);
    }
    expect(live.log).toEqual(fixture.log);
    expect(hashState(live)).toBe(fixture.hash);
    expect(hashState(replay(fixture.seed, live.log, live.tick))).toBe(fixture.hash);
  });
});
