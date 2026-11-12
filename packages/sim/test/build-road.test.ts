import { describe, expect, it } from "vitest";
import {
  ROAD_BALANCE,
  ROAD_BUILD,
  createState,
  deserialize,
  generateTerrain,
  hashTerrain,
  serialize,
  hashState,
  heightAt,
  mapSize,
  planStraightRoad,
  replay,
  snapToGrid,
  step,
  submit,
  type Command,
  type CommandResult,
  type SimState,
} from "../src/index";
import { cosDegrees, segmentsMeet } from "../src/roads/build";
import { checkRoadBalance, roadTypeIndex } from "../src/roads/balance";
import { isNode, isSegment, nodeCount, segmentCount, segmentsAt } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/build-roads.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

// Places on the map of seed 2026, found by scanning its terrain. The first
// test checks each is still what these tests think it is.
const SEED = 2026;
/** A dry, nearly flat square from (4100, 4400) to (4700, 5000). */
const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };
/** Dry land at (3350, 6650), water 100 m east. */
const SHORE = { x: 3350, z: 6650 };
/** Dry ground climbing about 33 percent from (1800, 1450) to 40 m east. */
const SLOPE = { x: 1800, z: 1450 };

const fixture = fixtureJson as ReplayFixture;

let seq = 0;
function road(from: [number, number], to: [number, number], type = "street", playerId = "p1"): Command {
  return { seq: ++seq, playerId, type: "BuildRoad", payload: { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type } };
}

/** Submits and steps, returning what submit said. */
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

describe("the test map", () => {
  it("has the places these tests use", () => {
    const t = terrainOf(SEED);
    for (let x = FLAT.x0; x <= FLAT.x1; x += 50) {
      for (let z = FLAT.z0; z <= FLAT.z1; z += 50) expect(heightAt(t, x, z)).toBeGreaterThan(t.waterLevel + 1);
    }
    expect(heightAt(t, SHORE.x, SHORE.z)).toBeGreaterThan(t.waterLevel);
    expect(heightAt(t, SHORE.x + 100, SHORE.z)).toBeLessThan(t.waterLevel);
    expect(heightAt(t, SLOPE.x, SLOPE.z) - heightAt(t, SLOPE.x + 40, SLOPE.z)).toBeGreaterThan(10);
  });
});

describe("BuildRoad", () => {
  it("builds a straight street with nodes on the ground", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4500, 4500]))).toEqual({ ok: true });
    const net = state.roads;
    expect(nodeCount(net)).toBe(2);
    expect(segmentCount(net)).toBe(1);
    expect(isSegment(net, 0)).toBe(true);
    expect(net.segType[0]).toBe(roadTypeIndex("street"));
    expect(net.segLength[0]).toBe(300);
    const t = terrainOf(SEED);
    expect([net.nodeX[0], net.nodeZ[0], net.nodeHeight[0]]).toEqual([4200, 4500, heightAt(t, 4200, 4500)]);
    expect([net.nodeX[1], net.nodeZ[1], net.nodeHeight[1]]).toEqual([4500, 4500, heightAt(t, 4500, 4500)]);
    expect(state.log).toHaveLength(1);
    expect(state.log[0]).toMatchObject({ tick: 0, playerId: "p1", type: "BuildRoad" });
  });

  it("builds each buildable type", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4500, 4500], "avenue"))).toEqual({ ok: true });
    expect(build(state, road([4200, 4600], [4500, 4600], "oneWay"))).toEqual({ ok: true });
    expect([...state.roads.segType]).toEqual([roadTypeIndex("avenue"), roadTypeIndex("oneWay")]);
  });

  it("rounds positions to the build grid", () => {
    expect(ROAD_BUILD.gridStep).toBe(0.125);
    expect(snapToGrid(4200.06)).toBe(4200);
    expect(snapToGrid(4200.07)).toBe(4200.125);
    expect(snapToGrid(-0.01)).toBe(0);
    const state = createState(SEED);
    expect(build(state, road([4200.04, 4500.3], [4400.9, 4500.3]))).toEqual({ ok: true });
    expect([state.roads.nodeX[0], state.roads.nodeZ[0]]).toEqual([4200, 4500.25]);
    expect([state.roads.nodeX[1], state.roads.nodeZ[1]]).toEqual([4400.875, 4500.25]);
  });

  it("joins two roads drawn to the same point at one node", () => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4500, 4500]))).toEqual({ ok: true });
    expect(build(state, road([4500, 4800], [4500, 4500]))).toEqual({ ok: true });
    expect(nodeCount(state.roads)).toBe(3);
    expect(segmentsAt(state.roads, 1)).toEqual([1, 0]);
  });

  it("joins an end within the merge distance of a node, and moves it there", () => {
    const state = createState(SEED);
    build(state, road([4200, 4500], [4500, 4500]));
    const near = ROAD_BUILD.mergeDistance - 0.5;
    expect(build(state, road([4500 + near, 4800], [4500 + near, 4500]))).toEqual({ ok: true });
    expect(nodeCount(state.roads)).toBe(3);
    expect(state.roads.segB[1]).toBe(1);
    expect(state.roads.nodeX[1]).toBe(4500);
  });

  it("makes a new node for an end just past the merge distance", () => {
    const state = createState(SEED);
    build(state, road([4200, 4500], [4500, 4500]));
    const far = ROAD_BUILD.mergeDistance + 0.5;
    expect(build(state, road([4500, 4800], [4500 + far, 4500 - far]))).toEqual({ ok: true });
    expect(nodeCount(state.roads)).toBe(4);
  });

  it("drops a command made invalid by an earlier one in the same tick, and does not log it", () => {
    const state = createState(SEED);
    expect(submit(state, road([4200, 4500], [4500, 4500], "street", "p1"))).toEqual({ ok: true });
    expect(submit(state, road([4500, 4500], [4200, 4500], "avenue", "p2"))).toEqual({ ok: true });
    step(state);
    expect(segmentCount(state.roads)).toBe(1);
    expect(state.log.map((e) => e.playerId)).toEqual(["p1"]);
  });
});

describe("BuildRoad refuses", () => {
  const ok = (): SimState => {
    const state = createState(SEED);
    expect(build(state, road([4200, 4500], [4500, 4500]))).toEqual({ ok: true });
    return state;
  };

  it("a payload without two points and a type", () => {
    const state = createState(SEED);
    const base = road([4200, 4500], [4500, 4500]);
    expect(rejection(state, { ...base, payload: null })).toMatch(/start, an end and a road type/);
    expect(rejection(state, { ...base, payload: { from: { x: 1 }, to: { x: 2, z: 2 }, type: "street" } })).toMatch(/finite x and z/);
    expect(rejection(state, { ...base, payload: { from: { x: NaN, z: 1 }, to: { x: 2, z: 2 }, type: "street" } })).toMatch(/finite/);
    expect(rejection(state, { ...base, payload: { from: { x: 1, z: 1 }, to: { x: 2, z: 2 } } })).toMatch(/road type/);
  });

  it("an unknown road type", () => {
    expect(rejection(createState(SEED), road([4200, 4500], [4500, 4500], "boulevard"))).toBe('There is no road type "boulevard"');
  });

  it("a highway, until M5", () => {
    expect(rejection(createState(SEED), road([4200, 4500], [4500, 4500], "highway"))).toBe("Highways cannot be built yet");
  });

  it("a road outside the map", () => {
    const size = mapSize(terrainOf(SEED));
    const state = createState(SEED);
    expect(rejection(state, road([-5, 4500], [100, 4500]))).toBe("The road runs off the map");
    expect(rejection(state, road([size - 100, 4500], [size + 1, 4500]))).toBe("The road runs off the map");
    expect(rejection(state, road([4200, 4500], [4200, size + 50]))).toBe("The road runs off the map");
  });

  it("a road shorter than the minimum length", () => {
    const short = ROAD_BUILD.minLength - 1;
    const state = createState(SEED);
    expect(rejection(state, road([4200, 4500], [4200 + short, 4500]))).toMatch(/^Too short: a road must be at least 10 m/);
    expect(rejection(state, road([4200, 4500], [4200, 4500]))).toMatch(/^Too short/);
  });

  it("a road whose two ends join the same node", () => {
    const state = ok();
    expect(rejection(state, road([4200, 4500], [4202, 4501]))).toMatch(/^Too short/);
  });

  it("a duplicate of an existing segment, either way round", () => {
    const state = ok();
    expect(rejection(state, road([4200, 4500], [4500, 4500]))).toBe("A road already joins these two points");
    expect(rejection(state, road([4501, 4501], [4199, 4499], "avenue"))).toBe("A road already joins these two points");
  });

  it("too sharp an angle against a segment at a shared node", () => {
    const state = ok();
    // 20 degrees off the street at its east end: tan(20°) is about 0.364.
    expect(rejection(state, road([4500, 4500], [4300, 4500 - 0.364 * 200]))).toMatch(/too sharp: it must be at least 25 degrees/);
    // At its west end too.
    expect(rejection(state, road([4400, 4500 + 0.364 * 200], [4200, 4500]))).toMatch(/too sharp/);
    // 30 degrees is fine: tan(30°) is about 0.577.
    expect(build(state, road([4500, 4500], [4300, 4500 - 0.577 * 200]))).toEqual({ ok: true });
  });

  it("a road that crosses another, until intersections land", () => {
    const state = ok();
    const crosses = "The road crosses another road, and intersections are not available yet";
    expect(rejection(state, road([4350, 4400], [4350, 4600]))).toBe(crosses);
    // Ending on the middle of a segment is meeting it too.
    expect(rejection(state, road([4350, 4400], [4350, 4500]))).toBe(crosses);
    // Running along it from a point that is not one of its nodes.
    expect(rejection(state, road([4100, 4500], [4300, 4500]))).toBe(crosses);
  });

  it("a road over water", () => {
    expect(rejection(createState(SEED), road([SHORE.x, SHORE.z], [SHORE.x + 200, SHORE.z]))).toBe(
      "The road crosses water, and bridges are not available yet",
    );
  });

  it("a road steeper than its type allows", () => {
    expect(rejection(createState(SEED), road([SLOPE.x, SLOPE.z], [SLOPE.x + 40, SLOPE.z]))).toMatch(
      /^Too steep: a \d+% grade, and the street limit is 12%$/,
    );
  });

  it("checks the grade along the road, by the limit of its type", () => {
    // Find a short run in the flat square whose grade is between the avenue
    // limit and the street limit, and build each type on it.
    const t = terrainOf(SEED);
    const net = createState(SEED).roads;
    const between = (x: number, z: number): boolean => {
      const plan = planStraightRoad(net, t, { from: { x, z }, to: { x: x + 16, z }, type: "street" });
      const avenue = planStraightRoad(net, t, { from: { x, z }, to: { x: x + 16, z }, type: "avenue" });
      return plan.ok && !avenue.ok;
    };
    let found: [number, number] | null = null;
    for (let x = 1000; x < 11000 && !found; x += 16) {
      for (let z = 1000; z < 11000 && !found; z += 64) if (between(x, z)) found = [x, z];
    }
    expect(found).not.toBeNull();
    const [x, z] = found ?? [0, 0];
    const state = createState(SEED);
    expect(rejection(state, road([x, z], [x + 16, z], "avenue"))).toMatch(/^Too steep: .* the avenue limit is 10%$/);
    expect(build(state, road([x, z], [x + 16, z], "street"))).toEqual({ ok: true });
  });
});

describe("planStraightRoad", () => {
  it("prices the road from the balance file and changes nothing", () => {
    const state = createState(SEED);
    const before = hashState(state);
    const result = planStraightRoad(state.roads, terrainOf(SEED), road([4200, 4500], [4500, 4500], "avenue").payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.cost).toBe(300 * (result.plan.type.buildCostPerMetre));
    expect(hashState(state)).toBe(before);
    expect(isNode(state.roads, 0)).toBe(false);
  });
});

describe("terrain for commands", () => {
  it("is the map the seed generates, kept between calls", () => {
    const t = terrainOf(SEED);
    expect(terrainOf(SEED)).toBe(t);
    expect(hashTerrain(t)).toBe(hashTerrain(generateTerrain(SEED)));
  });
});

describe("a city saved and reloaded mid-build", () => {
  it("checks and builds the same as one that never stopped", () => {
    const live = createState(SEED);
    build(live, road([4200, 4500], [4500, 4500]));
    build(live, road([4500, 4500], [4500, 4800]));
    const loaded = deserialize(serialize(live)).state;
    const crossing = road([4350, 4400], [4350, 4600]);
    const diagonal = road([4200, 4500], [4500.5, 4801]);
    for (const state of [live, loaded]) {
      expect(rejection(state, crossing)).toMatch(/crosses another road/);
      expect(build(state, diagonal)).toEqual({ ok: true });
    }
    expect(hashState(loaded)).toBe(hashState(live));
  });
});

describe("road geometry", () => {
  it("computes cosines the way Math.cos does", () => {
    for (let d = 0; d <= 180; d += 5) expect(cosDegrees(d)).toBeCloseTo(Math.cos((d * Math.PI) / 180), 12);
  });

  it("finds where two segments meet, ends included", () => {
    expect(segmentsMeet(0, 0, 10, 0, 5, -5, 5, 5)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 10, 0, 20, 5)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 11, -5, 11, 5)).toBe(false);
    expect(segmentsMeet(0, 0, 10, 0, 5, 1, 5, 5)).toBe(false);
    expect(segmentsMeet(0, 0, 10, 0, 4, 0, 20, 0)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 11, 0, 20, 0)).toBe(false);
  });
});

describe("road build balance", () => {
  const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(ROAD_BALANCE)) as Record<string, unknown>;

  it("needs every build setting", () => {
    for (const field of Object.keys(ROAD_BUILD).filter((k) => !k.startsWith("_"))) {
      const data = copy();
      data["build"] = Object.fromEntries(Object.entries(data["build"] as object).filter(([key]) => key !== field));
      expect(checkRoadBalance(data).join(), field).toContain(`build.${field}`);
    }
    const none = copy();
    delete none["build"];
    expect(checkRoadBalance(none)).toContain("build is missing");
  });

  it("needs a grid step that is exact in binary", () => {
    const data = copy();
    (data["build"] as Record<string, unknown>)["gridStep"] = 0.1;
    expect(checkRoadBalance(data)).toContain("build.gridStep must be 1 over a power of two");
  });
});

describe("replay fixture build-roads", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(segmentCount(state.roads)).toBe(4);
    expect(nodeCount(state.roads)).toBe(4);
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
