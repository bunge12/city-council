import { describe, expect, it } from "vitest";
import {
  LEVELS_ELEVATED_1,
  LEVELS_GROUND,
  LEVELS_SURFACE,
  ROAD_LEVELS,
  createBareState,
  createState,
  deserialize,
  hashState,
  heightAlong,
  nearestNode,
  nearestPointOnSegment,
  planRoad,
  replay,
  segmentShape,
  segmentsInBox,
  serialize,
  step,
  submit,
  type Command,
  type CommandResult,
  type SimState,
} from "../src/index";
import { blockIndexOf, listBlocks } from "../src/roads/blocks";
import { roadTypeIndex } from "../src/roads/balance";
import {
  LEVEL_BRIDGE,
  LEVEL_ELEVATED_1,
  LEVEL_ELEVATED_2,
  LEVEL_GROUND,
  LEVEL_TUNNEL,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  checkRoadNetwork,
  isSegment,
  nodeIdLimit,
  restyleSegment,
  segmentCount,
  segmentIdLimit,
  type RoadNetwork,
} from "../src/roads/network";
import { NETWORKS_ROAD, roadIndexOf } from "../src/roads/spatial";
import { findRoute, routingGraphOf } from "../src/roads/routing";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/levels.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import { unjoinedCrossings } from "./unjoined";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
// build-road.test.ts checks it is still there.
const SEED = 2026;
const fixture = fixtureJson as ReplayFixture;

let seq = 0;
function road(from: [number, number], to: [number, number], level?: string, type = "street", playerId = "p1"): Command {
  const payload: Record<string, unknown> = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  if (level !== undefined) payload["level"] = level;
  return { seq: ++seq, playerId, type: "BuildRoad", payload };
}

function build(state: SimState, command: Command): CommandResult {
  const result = submit(state, command);
  step(state);
  return result;
}

function rejection(state: SimState, command: Command): string {
  const result = submit(state, command);
  if (result.ok) throw new Error("expected the road to be refused");
  return result.reason;
}

/** The live node at (x, z), or NONE. */
function nodeAt(net: RoadNetwork, x: number, z: number): number {
  for (let n = 0; n < nodeIdLimit(net); n++) if (net.nodeX[n] === x && net.nodeZ[n] === z && (net.nodeFlags[n] ?? 0) & 1) return n;
  return NONE;
}

/** Live segment ids. */
function live(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let s = 0; s < segmentIdLimit(net); s++) if (isSegment(net, s)) out.push(s);
  return out;
}

/** The live segments the last BuildRoad added: those not in `before`. */
function added(net: RoadNetwork, before: number[]): number[] {
  return live(net).filter((s) => !before.includes(s));
}

describe("BuildRoad's level", () => {
  it("is the ground when left out, and builds at the level it names", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    expect(build(state, road([4200, 4700], [4600, 4700], "elevated2"))).toEqual({ ok: true });
    const [ground, raised] = live(net);
    expect([net.segLevelA[ground ?? 0], net.segLevelB[ground ?? 0]]).toEqual([LEVEL_GROUND, LEVEL_GROUND]);
    expect([net.segLevelA[raised ?? 0], net.segLevelB[raised ?? 0]]).toEqual([LEVEL_ELEVATED_2, LEVEL_ELEVATED_2]);
  });

  it("refuses a level it does not know, and a bridge, which only water makes", () => {
    const state = createBareState(SEED);
    for (const level of ["bridge", "sky", 3, null]) {
      const command = road([4200, 4500], [4600, 4500]);
      (command.payload as Record<string, unknown>)["level"] = level;
      expect(rejection(state, command)).toBe("A road's level must be one of ground, tunnel, elevated1, elevated2");
    }
  });

  it("makes no bridge off the ground: a raised road over water is refused", () => {
    const state = createBareState(SEED);
    const terrain = terrainOf(SEED);
    // The bridge fixture's inlet crossing on this seed, which a ground road bridges.
    const ground = planRoad(state.roads, terrain, road([3400, 6600], [3700, 6600]).payload);
    expect(ground.ok && ground.plan.levels.includes(LEVEL_BRIDGE)).toBe(true);
    const raised = road([3400, 6600], [3700, 6600], "elevated1");
    expect(planRoad(state.roads, terrain, raised.payload)).toEqual({ ok: false, reason: "The road runs too close along the water's edge" });
  });
});

describe("crossings between levels", () => {
  it("let an elevated road pass over a ground road with no node", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    expect(build(state, road([4400, 4420], [4400, 4800], "elevated1"))).toEqual({ ok: true });
    expect(segmentCount(net)).toBe(2);
    expect(nodeAt(net, 4400, 4500)).toBe(NONE);
    expect(checkRoadNetwork(net)).toBeNull();
    expect(unjoinedCrossings(net)).toEqual([]);
  });

  it("let a ground road pass under an elevated road, and a tunnel under both", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4400, 4420], [4400, 4800], "elevated1"))).toEqual({ ok: true });
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    expect(build(state, road([4300, 4600], [4500, 4400], "tunnel"))).toEqual({ ok: true });
    expect(segmentCount(net)).toBe(3);
    expect(nodeAt(net, 4400, 4500)).toBe(NONE);
  });

  it("split and join two roads at the same level as before, ground or raised", () => {
    for (const level of [undefined, "elevated1", "elevated2", "tunnel"]) {
      const state = createBareState(SEED);
      const net = state.roads;
      expect(build(state, road([4200, 4500], [4600, 4500], level))).toEqual({ ok: true });
      expect(build(state, road([4400, 4420], [4400, 4800], level))).toEqual({ ok: true });
      expect(segmentCount(net)).toBe(4);
      const node = nodeAt(net, 4400, 4500);
      expect(node).not.toBe(NONE);
      const want = level === undefined ? LEVEL_GROUND : { elevated1: LEVEL_ELEVATED_1, elevated2: LEVEL_ELEVATED_2, tunnel: LEVEL_TUNNEL }[level];
      for (const s of live(net)) expect([net.segLevelA[s], net.segLevelB[s]]).toEqual([want, want]);
      expect(unjoinedCrossings(net)).toEqual([]);
    }
  });

  it("join a raised road only to nodes on its own level", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    const before = live(net);
    // Starts right on the ground road's end, but up on the first elevated level.
    expect(build(state, road([4200, 4500], [4200, 4800], "elevated1"))).toEqual({ ok: true });
    const [raised] = added(net, before);
    expect(net.segA[raised ?? 0]).not.toBe(net.segA[before[0] ?? 0]);
    // Two nodes now share that point: one for each level.
    let here = 0;
    for (let n = 0; n < nodeIdLimit(net); n++) if (net.nodeX[n] === 4200 && net.nodeZ[n] === 4500 && (net.nodeFlags[n] ?? 0) & 1) here++;
    expect(here).toBe(2);
    // A second elevated road ending there joins the elevated node, not the ground one.
    const elevatedNode = net.segA[raised ?? 0] ?? NONE;
    expect(build(state, road([4200, 4500], [4500, 4800], "elevated1"))).toEqual({ ok: true });
    expect(live(net).filter((s) => net.segA[s] === elevatedNode || net.segB[s] === elevatedNode)).toHaveLength(2);
  });

  it("refuse a crossing with too little clearance, with the gap and the clearance in the reason", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    const terrain = terrainOf(SEED);
    // A ramp from the ground up to the first elevated level, as M5 will build.
    const a = addNode(net, 4200, 4500, 0);
    const b = addNode(net, 4600, 4500, 0);
    const ramp = addSegment(net, a, b, { type: roadTypeIndex("street"), level: LEVEL_GROUND, levelB: LEVEL_ELEVATED_1 });
    // Near its foot the ramp is barely off the ground.
    const reason = rejection(state, road([4250, 4400], [4250, 4600]));
    expect(reason).toMatch(/^The road would pass only [\d.]+ m under a ramp, and roads need 6\.5 m between them to cross without a junction$/);
    const gap = heightAlong(terrain, segmentShape(net, ramp), 50 / 400) - heightAlong(terrain, { ...segmentShape(net, ramp), levelA: 0, levelB: 0 }, 50 / 400);
    expect(gap).toBeCloseTo(ROAD_LEVELS.elevated1 / 8, 9);
    expect(reason).toContain(`only ${Math.round(gap * 10) / 10} m under`);
    // Near its top there is room underneath.
    expect(build(state, road([4580, 4400], [4580, 4600]))).toEqual({ ok: true });
    expect(nodeAt(net, 4580, 4500)).toBe(NONE);
    // Nothing on the ramp's own level at the crossing point either.
    expect(rejection(state, road([4300, 4400], [4300, 4600], "elevated1"))).toMatch(/^The road would pass only [\d.]+ m over a ramp/);
  });

  it("refuse a raised road crossing a road at the same height it cannot join", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    // A ramp between the two elevated levels.
    const a = addNode(net, 4200, 4500, 0);
    const b = addNode(net, 4600, 4500, 0);
    addSegment(net, a, b, { type: roadTypeIndex("street"), level: LEVEL_ELEVATED_1, levelB: LEVEL_ELEVATED_2 });
    // Right by the ramp's low end the first elevated level is all but level with it.
    const reason = rejection(state, road([4200.25, 4400], [4200.25, 4600], "elevated1"));
    expect(reason).toMatch(/^The road would (meet a ramp at the same height|pass only 0 m (over|under) a ramp)/);
  });

  it("refuse a ground road under a bridge approach, and let a tunnel pass under the bridge", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    const terrain = terrainOf(SEED);
    // The bridge fixture's first street, which the sim bridges over the inlet.
    expect(build(state, road([3400, 6600], [3700, 6600]))).toEqual({ ok: true });
    const bridge = live(net).find((s) => net.segLevelA[s] === LEVEL_BRIDGE && net.segNetwork[s] === NETWORK_ROAD);
    if (bridge === undefined) throw new Error("expected a bridge");
    const ax = net.nodeX[net.segA[bridge] ?? 0] ?? 0;
    const bx = net.nodeX[net.segB[bridge] ?? 0] ?? 0;
    // Just inside the east bank node, on the approach, where the shore runs dry north to south.
    const x = (ax > bx ? ax : bx) - 2;
    const across = (level?: string): Command => road([x, 6540], [x, 6630], level);
    const deckGap = (): number => {
      const shape = segmentShape(net, bridge);
      const u = (x - (net.nodeX[net.segA[bridge] ?? 0] ?? 0)) / ((net.nodeX[net.segB[bridge] ?? 0] ?? 0) - (net.nodeX[net.segA[bridge] ?? 0] ?? 0));
      return heightAlong(terrain, shape, u) - heightAlong(terrain, { ...shape, levelA: LEVEL_GROUND, levelB: LEVEL_GROUND }, u);
    };
    // The deck stands only 5 m over the water, and the bank is above the
    // water, so no ground road clears it.
    expect(deckGap()).toBeLessThan(ROAD_LEVELS.clearance);
    expect(rejection(state, across())).toMatch(/^The road would pass only [\d.]+ m under a bridge, and roads need 6\.5 m/);
    expect(build(state, across("tunnel"))).toEqual({ ok: true });
    expect(live(net).filter((s) => net.segLevelA[s] === LEVEL_TUNNEL)).toHaveLength(1);
    expect(segmentCount(net)).toBe(4);
  });
});

describe("the spatial index's level filter", () => {
  it("finds the ground road under an elevated deck, and ignores the deck", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    const [ground] = live(net);
    const before = live(net);
    expect(build(state, road([4200, 4502], [4600, 4502], "elevated1"))).toEqual({ ok: true });
    const [deck] = added(net, before);
    const index = roadIndexOf(net);
    expect(nearestPointOnSegment(index, 4400, 4503, 10, NETWORKS_ROAD)?.segment).toBe(deck);
    expect(nearestPointOnSegment(index, 4400, 4503, 10, NETWORKS_ROAD, LEVELS_SURFACE)?.segment).toBe(ground);
    expect(nearestPointOnSegment(index, 4400, 4499, 10, NETWORKS_ROAD, LEVELS_ELEVATED_1)?.segment).toBe(deck);
    expect(segmentsInBox(index, 4300, 4490, 4310, 4510, NETWORKS_ROAD, LEVELS_GROUND)).toEqual([ground]);
    expect(segmentsInBox(index, 4300, 4490, 4310, 4510, NETWORKS_ROAD, LEVELS_ELEVATED_1)).toEqual([deck]);
    expect(nearestNode(index, 4200, 4503, 10, NETWORKS_ROAD, LEVELS_GROUND)?.node).toBe(net.segA[ground ?? 0]);
    expect(nearestNode(index, 4200, 4501, 10, NETWORKS_ROAD, LEVELS_ELEVATED_1)?.node).toBe(net.segA[deck ?? 0]);
    expect(() => nearestNode(index, 0, 0, 1, NETWORKS_ROAD, 1 << 9)).toThrow(/level filter/);
  });
});

describe("routing over an overpass", () => {
  it("finds no route from one road to the road above it until they share a node", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    expect(build(state, road([4200, 4500], [4600, 4500]))).toEqual({ ok: true });
    const [ground] = live(net);
    const before = live(net);
    expect(build(state, road([4400, 4420], [4400, 4800], "elevated1"))).toEqual({ ok: true });
    const [over] = added(net, before);
    const from = net.segA[ground ?? 0] ?? NONE;
    const to = net.segB[over ?? 0] ?? NONE;
    expect(findRoute(routingGraphOf(net), from, to)).toEqual({ ok: false, reason: "no route" });
    // A ramp from the ground road's far end up to the elevated road's start,
    // built through the internal functions as M5's ramps will be.
    addSegment(net, net.segB[ground ?? 0] ?? NONE, net.segA[over ?? 0] ?? NONE, {
      type: roadTypeIndex("street"),
      level: LEVEL_GROUND,
      levelB: LEVEL_ELEVATED_1,
    });
    const route = findRoute(routingGraphOf(net), from, to);
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.route.segments).toHaveLength(3);
  });
});

describe("blocks under an elevated road", () => {
  it("keep their boundary and area", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    for (const [from, to] of [
      [[4200, 4500], [4500, 4500]],
      [[4500, 4500], [4500, 4800]],
      [[4500, 4800], [4200, 4800]],
      [[4200, 4800], [4200, 4500]],
    ] as [[number, number], [number, number]][]) {
      expect(build(state, road(from, to))).toEqual({ ok: true });
    }
    const blocks = listBlocks(blockIndexOf(net)).map((b) => ({ segments: b.segments, area: b.area }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.area).toBeCloseTo(90000, 6);
    // Diagonally over the whole block, past two of its corners' sides.
    expect(build(state, road([4150, 4450], [4550, 4850], "elevated1"))).toEqual({ ok: true });
    expect(segmentCount(net)).toBe(5);
    expect(listBlocks(blockIndexOf(net)).map((b) => ({ segments: b.segments, area: b.area }))).toEqual(blocks);
  });
});

describe("a ramp's levels", () => {
  it("stay with their nodes when a one-way is reversed", () => {
    const net = createBareState(SEED).roads;
    const a = addNode(net, 4200, 4500, 0);
    const b = addNode(net, 4600, 4500, 0);
    const seg = addSegment(net, a, b, { type: roadTypeIndex("oneWay"), level: LEVEL_GROUND, levelB: LEVEL_ELEVATED_1 });
    restyleSegment(net, seg, roadTypeIndex("oneWay"), true);
    expect([net.segA[seg], net.segLevelA[seg], net.segB[seg], net.segLevelB[seg]]).toEqual([b, LEVEL_ELEVATED_1, a, LEVEL_GROUND]);
  });

  it("may not be a bridge at one end only", () => {
    const net = createBareState(SEED).roads;
    const a = addNode(net, 4200, 4500, 0);
    const b = addNode(net, 4600, 4500, 0);
    expect(() => addSegment(net, a, b, { type: 0, level: LEVEL_BRIDGE, levelB: LEVEL_GROUND })).toThrow(/bridge/);
    expect(() => addSegment(net, a, b, { type: 0, level: LEVEL_GROUND, levelB: 5 })).toThrow(/level/);
  });
});

describe("an overpass in a save and a replay", () => {
  it("survives save and load with the same hash", () => {
    const state = expectReplay(fixture);
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(fixture.hash);
    expect(Array.from(loaded.roads.segLevelA)).toEqual(Array.from(state.roads.segLevelA));
    expect(Array.from(loaded.roads.segLevelB)).toEqual(Array.from(state.roads.segLevelB));
  });

  it("holds its levels in the replayed city: an overpass, a raised junction and a tunnel taken back", () => {
    const state = expectReplay(fixture);
    const net = state.roads;
    const levels = live(net).map((s) => net.segLevelA[s]);
    expect(levels.filter((l) => l === LEVEL_ELEVATED_1).length).toBeGreaterThanOrEqual(4);
    expect(levels).not.toContain(LEVEL_TUNNEL);
    expect(unjoinedCrossings(net)).toEqual([]);
    expect(nodeAt(net, 4400, 4500)).toBe(NONE);
    expect(nodeAt(net, 4400, 4600)).not.toBe(NONE);
  });

  it("matches the same commands submitted live", () => {
    const state = createState(fixture.seed);
    let next = 0;
    while (state.tick < fixture.untilTick) {
      for (; next < fixture.log.length && fixture.log[next]?.tick === state.tick; next++) {
        const entry = fixture.log[next];
        if (entry) expect(submit(state, entry)).toEqual({ ok: true });
      }
      step(state);
    }
    expect(state.log).toEqual(fixture.log);
    expect(hashState(state)).toBe(fixture.hash);
    expect(hashState(replay(fixture.seed, state.log, state.tick))).toBe(fixture.hash);
  });
});
