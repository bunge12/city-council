import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  LEVEL_GROUND,
  ROAD_BUILD,
  ROAD_TYPES,
  bridgeDeckHeight,
  bridgeDeckLevel,
  createState,
  deserialize,
  hashState,
  heightAt,
  planRoad,
  serialize,
  step,
  submit,
  type Command,
  type RoadPlan,
  type RoadType,
  type SimState,
  type Terrain,
} from "../src/index";
import { buildRoad } from "../src/roads/build";
import { checkRoadBalance, ROAD_BALANCE } from "../src/roads/balance";
import { createRoadNetwork, isSegment, segmentCount, type RoadNetwork } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/bridges.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

// Issue M1-11: a road drawn across water becomes a bridge.

const fixture = fixtureJson as ReplayFixture;
/** Element `i`, which must be there. */
function nth<T>(list: ArrayLike<T>, i: number): T {
  const value = list[i];
  if (value === undefined) throw new RangeError(`nothing at ${i}`);
  return value;
}

function typeOf(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(id);
  return type;
}

const street = typeOf("street");

// Seed 2026 has an inlet whose water runs from x = 3488 to 3600 along
// z = 6600, with low banks either side. The first test checks it.
const SEED = 2026;
const RIVER = { x0: 3400, x1: 3700, z: 6600 };

let seq = 0;
function road(from: [number, number], to: [number, number], type = "street", control?: [number, number]): Command {
  const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  return {
    seq: ++seq,
    playerId: "p1",
    type: "BuildRoad",
    payload: control ? { ...payload, control: { x: control[0], z: control[1] } } : payload,
  };
}

function build(state: SimState, command: Command): void {
  expect(submit(state, command)).toEqual({ ok: true });
  step(state);
}

/**
 * A 1024 m map whose height is `h(x, z)` at each 16 m sample, with the water
 * at 10 m. Only the fields the road planner reads mean anything.
 */
function synthetic(h: (x: number, z: number) => number): Terrain {
  const samples = 64;
  const spacing = 16;
  const heights = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) heights[j * samples + i] = h(i * spacing, j * spacing);
  const empty = new Uint8Array(samples * samples);
  return { seed: 0, samples, spacing, heights, waterLevel: 10, fertile: empty, forest: empty, ore: empty, buildableShare: 1, attempts: 1 };
}

/** Water from x = 400 to 520 between banks 1 m above it. */
const CANAL = synthetic((x) => (x >= 400 && x <= 520 ? 0 : 11));

function plan(net: RoadNetwork, terrain: Terrain, command: Command): RoadPlan {
  const result = planRoad(net, terrain, command.payload);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.plan;
}

function reason(net: RoadNetwork, terrain: Terrain, command: Command): string {
  const result = planRoad(net, terrain, command.payload);
  expect(result.ok, "the road should be refused").toBe(false);
  return result.ok ? "" : result.reason;
}

/** The sample points the planner reads along a straight plan's piece `i`. */
function wetAlong(terrain: Terrain, p: RoadPlan, i: number): boolean[] {
  const a = nth(p.stops, i);
  const b = nth(p.stops, i + 1);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.ceil(length / ROAD_BUILD.groundSampleStep);
  const out: boolean[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    out.push(heightAt(terrain, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) <= terrain.waterLevel);
  }
  return out;
}

describe("the test map", () => {
  it("has the inlet these tests cross", () => {
    const t = terrainOf(SEED);
    expect(heightAt(t, RIVER.x0, RIVER.z)).toBeGreaterThan(t.waterLevel);
    expect(heightAt(t, RIVER.x1, RIVER.z)).toBeGreaterThan(t.waterLevel);
    expect(heightAt(t, 3500, RIVER.z)).toBeLessThan(t.waterLevel);
    expect(heightAt(t, 3590, RIVER.z)).toBeLessThan(t.waterLevel);
  });
});

describe("a road across water", () => {
  it("becomes ground, bridge and ground, with a node on each bank", () => {
    const state = createState(SEED);
    build(state, road([RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z]));
    const net = state.roads;
    const t = terrainOf(SEED);
    expect(segmentCount(net)).toBe(3);
    expect(Array.from(net.segLevel)).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
    const a = nth(net.segA, 1);
    const b = nth(net.segB, 1);
    for (const node of [a, b]) {
      expect(heightAt(t, nth(net.nodeX, node), nth(net.nodeZ, node))).toBeGreaterThan(t.waterLevel);
      expect(net.nodeHeight[node]).toBe(heightAt(t, nth(net.nodeX, node), nth(net.nodeZ, node)));
    }
    // The bridge spans every wet point, and the ground pieces have none.
    expect(net.nodeX[a]).toBeLessThan(3488);
    expect(net.nodeX[b]).toBeGreaterThan(3600);
  });

  it("only bridges the wet stretch, and its ramps reach the deck by the water", () => {
    const t = terrainOf(SEED);
    const p = plan(createState(SEED).roads, t, road([RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z]));
    expect(p.levels).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
    expect(wetAlong(t, p, 0).some(Boolean)).toBe(false);
    expect(wetAlong(t, p, 2).some(Boolean)).toBe(false);
    const a = nth(p.stops, 1);
    const b = nth(p.stops, 2);
    const length = b.x - a.x;
    const deck = bridgeDeckLevel(t.waterLevel);
    const hA = heightAt(t, a.x, a.z);
    const hB = heightAt(t, b.x, b.z);
    for (let s = 0; s <= length; s += 2) {
      const x = a.x + s;
      const y = bridgeDeckHeight(hA, hB, length, s, deck, street.maxSlope);
      if (heightAt(t, x, RIVER.z) <= t.waterLevel) expect(y).toBeCloseTo(deck, 9);
      expect(y).toBeGreaterThanOrEqual(Math.min(hA, hB) - 1e-9);
    }
  });

  it("costs the bridge's length at the type's multiplier", () => {
    const t = terrainOf(SEED);
    const p = plan(createState(SEED).roads, t, road([RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z]));
    expect(p.bridgeLength).toBe(nth(p.stops, 2).x - nth(p.stops, 1).x);
    const ground = p.length - p.bridgeLength;
    const price = street.buildCostPerMetre;
    expect(p.cost).toBe(Math.round(ground * price + p.bridgeLength * price * street.bridge.costMultiplier));
    expect(p.cost).toBeGreaterThan(Math.round(p.length * price));
  });

  it("is refused when the crossing is longer than the type's limit", () => {
    const t = terrainOf(SEED);
    const wide = road([3200, 6800], [3900, 6800]);
    expect(reason(createState(SEED).roads, t, wide)).toBe(
      `Too long for a bridge: 453 m, and the street limit is ${street.bridge.maxLength} m`,
    );
    // An avenue may bridge further than a street.
    const avenue = typeOf("avenue");
    expect(avenue.bridge.maxLength).toBeGreaterThan(street.bridge.maxLength);
  });

  it("is refused when it starts or ends in water", () => {
    const t = terrainOf(SEED);
    const net = createState(SEED).roads;
    expect(reason(net, t, road([3500, RIVER.z], [3700, RIVER.z]))).toBe("A road cannot start or end in water");
    expect(reason(net, t, road([3400, RIVER.z], [3550, RIVER.z]))).toBe("A road cannot start or end in water");
    expect(reason(createRoadNetwork(), CANAL, road([450, 500], [700, 500]))).toBe("A road cannot start or end in water");
  });

  it("is refused when the bank is too steep for the ramp down to the deck", () => {
    // A 30 m cliff on the west bank, 25 m above the deck.
    const cliff = synthetic((x) => (x < 400 ? 40 : x <= 520 ? 0 : 11));
    expect(reason(createRoadNetwork(), cliff, road([200, 500], [700, 500]))).toBe(
      "The bank is too steep for the bridge: the ramp down to the deck would be a 13% grade, and the street limit is 12%",
    );
  });

  it("is refused when there is no room on a low bank for the ramp up", () => {
    // The ramp from a bank 1 m above the water needs 4 m of rise, 33 m at 12 percent.
    expect(reason(createRoadNetwork(), CANAL, road([360, 500], [700, 500]))).toMatch(
      /^Not enough room on the bank for the ramp up to the bridge: it would be a \d+% grade, and the street limit is 12%$/,
    );
    const p = plan(createRoadNetwork(), CANAL, road([300, 500], [700, 500]));
    expect(p.levels).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
    // The bank nodes stand back from the water by at least the ramp's length.
    const ramp = (bridgeDeckLevel(CANAL.waterLevel) - 11) / street.maxSlope;
    let firstWet = 300;
    while (heightAt(CANAL, firstWet, 500) > CANAL.waterLevel) firstWet++;
    let lastWet = 700;
    while (heightAt(CANAL, lastWet, 500) > CANAL.waterLevel) lastWet--;
    expect(firstWet - nth(p.stops, 1).x).toBeGreaterThanOrEqual(ramp);
    expect(nth(p.stops, 2).x - lastWet).toBeGreaterThanOrEqual(ramp);
  });

  it("puts one bridge over two channels with too little ground between them", () => {
    // Two channels either side of an islet a sample wide.
    const islet = synthetic((x) => (x >= 400 && x <= 560 && x !== 480 ? 0 : 11));
    expect(heightAt(islet, 480, 500)).toBeGreaterThan(islet.waterLevel);
    const p = plan(createRoadNetwork(), islet, road([200, 500], [800, 500]));
    expect(p.levels).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
  });

  it("bridges each crossing of a curve", () => {
    const state = createState(SEED);
    build(state, road([3380, 6640], [3720, 6640], "street", [3550, 6700]));
    expect(Array.from(state.roads.segLevel)).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
  });
});

describe("nothing joins a bridge but at its banks", () => {
  /** A square lake from (440, 440) to (560, 560) with low banks, and a street bridge across it west to east. */
  function lake(): { net: RoadNetwork; terrain: Terrain } {
    const terrain = synthetic((x, z) => (x >= 440 && x <= 560 && z >= 440 && z <= 560 ? 0 : 11));
    const net = createRoadNetwork();
    buildRoad(net, terrain, plan(net, terrain, road([200, 500], [800, 500])));
    expect(Array.from(net.segLevel)).toEqual([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_GROUND]);
    return { net, terrain };
  }
  const CROSSES = "The road would cross a bridge, and roads cannot pass over or under each other yet";

  it("refuses a second bridge across the first over the water", () => {
    const { net, terrain } = lake();
    // On its own it would be a bridge.
    expect(plan(createRoadNetwork(), terrain, road([500, 200], [500, 800])).levels).toContain(LEVEL_BRIDGE);
    expect(reason(net, terrain, road([500, 200], [500, 800]))).toBe(CROSSES);
    // A curved one too.
    expect(reason(net, terrain, road([300, 200], [700, 800], "street", [400, 700]))).toBe(CROSSES);
  });

  it("refuses a ground road across a bridge's ramp", () => {
    const { net, terrain } = lake();
    const bank = nth(net.nodeX, nth(net.segA, 1));
    // Dry all the way, west of the lake, across the land the ramp stands on.
    expect(bank + 10).toBeLessThan(420);
    expect(reason(net, terrain, road([bank + 10, 300], [bank + 10, 700]))).toBe(CROSSES);
  });

  it("lets a road join a bank node", () => {
    const { net, terrain } = lake();
    const node = nth(net.segA, 1);
    const p = plan(net, terrain, road([nth(net.nodeX, node), nth(net.nodeZ, node)], [nth(net.nodeX, node), 300]));
    expect(nth(p.stops, 0).node).toBe(node);
    buildRoad(net, terrain, p);
    expect(isSegment(net, 3)).toBe(true);
    expect(net.segLevel[3]).toBe(LEVEL_GROUND);
  });
});

describe("a bridge in a save and a replay", () => {
  it("survives save and load with the same hash", () => {
    const state = expectReplay(fixture);
    expect(Array.from(state.roads.segLevel).filter((l) => l === LEVEL_BRIDGE)).toHaveLength(3);
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(hashState(state));
    expect(hashState(loaded)).toBe(fixture.hash);
  });
});

describe("the bridge balance", () => {
  it("needs a bridge entry on every type", () => {
    const copy = JSON.parse(JSON.stringify(ROAD_BALANCE)) as unknown as { types: Record<string, unknown>[]; build: Record<string, unknown> };
    delete nth(copy.types, 0)["bridge"];
    copy.build["bridgeClearance"] = 0;
    expect(checkRoadBalance(copy)).toEqual(["build.bridgeClearance must be a positive number", "types[0].bridge is missing"]);
    const bad = JSON.parse(JSON.stringify(ROAD_BALANCE)) as unknown as { types: { bridge: Record<string, unknown> }[] };
    nth(bad.types, 1).bridge["costMultiplier"] = -1;
    delete nth(bad.types, 1).bridge["source"];
    expect(checkRoadBalance(bad)).toEqual(["types[1].bridge.costMultiplier must be a positive number", "types[1].bridge.source is missing"]);
  });

  it("is in the file the sim uses", () => {
    expect(checkRoadBalance(ROAD_BALANCE)).toEqual([]);
    for (const type of ROAD_TYPES) {
      expect(type.bridge.maxLength).toBeGreaterThan(0);
      expect(type.bridge.costMultiplier).toBeGreaterThan(1);
    }
  });
});
