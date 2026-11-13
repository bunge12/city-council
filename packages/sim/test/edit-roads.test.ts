import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  ROAD_BUILD,
  ROAD_TYPES,
  SEG_FIXED,
  createState,
  deserialize,
  hashState,
  planBulldoze,
  planRoad,
  planUpgrade,
  serialize,
  step,
  submit,
  type Command,
  type CommandResult,
  type RoadType,
  type SimState,
  type Terrain,
} from "../src/index";
import { cloneState } from "../src/state";
import { minRadius, segmentQuad } from "../src/roads/curve";
import { recordRoadChanges, drainRoadChanges } from "../src/roads/delta";
import {
  NODE_FIXED,
  addNode,
  addSegment,
  checkRoadNetwork,
  isNode,
  otherEnd,
  isSegment,
  nodeCount,
  nodeIdLimit,
  segmentCount,
  segmentIdLimit,
  segmentsAt,
  type RoadNetwork,
} from "../src/roads/network";
import { buildRoadIndex, roadIndexOf } from "../src/roads/spatial";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/edit-roads.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

// Issue M1-12: BulldozeRoad and UpgradeRoad.

const fixture = fixtureJson as ReplayFixture;

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), and an inlet along z = 6600 (bridges.test.ts).
const SEED = 2026;

function typeOf(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(id);
  return type;
}

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

function road(from: [number, number], to: [number, number], type = "street", control?: [number, number]): Command {
  const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  return command("BuildRoad", control ? { ...payload, control: { x: control[0], z: control[1] } } : payload);
}

function bulldoze(...segments: number[]): Command {
  return command("BulldozeRoad", { segments });
}

function upgrade(type: string, segments: number[], from?: number[]): Command {
  return command("UpgradeRoad", from ? { segments, type, from } : { segments, type });
}

function run(state: SimState, c: Command): CommandResult {
  const result = submit(state, c);
  step(state);
  return result;
}

function ok(state: SimState, c: Command): void {
  expect(run(state, c)).toEqual({ ok: true });
}

function rejection(state: SimState, c: Command): string {
  const result = submit(state, c);
  expect(result.ok, "the command should be refused").toBe(false);
  step(state);
  return result.ok ? "" : result.reason;
}

/**
 * Two streets crossing at (4300, 4500): an east-west one from (4200, 4500)
 * to (4500, 4500), and a north-south one from (4300, 4400) to (4300, 4700).
 * Returns the segment ids by where they run from the crossing.
 */
function crossroads(): { state: SimState; centre: number; west: number; east: number; north: number; south: number } {
  const state = createState(SEED);
  ok(state, road([4200, 4500], [4500, 4500]));
  ok(state, road([4300, 4400], [4300, 4700]));
  const net = state.roads;
  const centre = findNode(net, 4300, 4500);
  const at = (x: number, z: number) => {
    const node = findNode(net, x, z);
    const seg = segmentsAt(net, node)[0];
    if (seg === undefined) throw new Error("no segment");
    return seg;
  };
  return { state, centre, west: at(4200, 4500), east: at(4500, 4500), north: at(4300, 4400), south: at(4300, 4700) };
}

function findNode(net: RoadNetwork, x: number, z: number): number {
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id) && net.nodeX[id] === x && net.nodeZ[id] === z) return id;
  throw new Error(`no node at (${x}, ${z})`);
}

function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

/** The spatial index's cells, for comparing a kept index with a fresh one. */
function cells(net: RoadNetwork): { nodes: number[][]; segs: number[][] } {
  const index = roadIndexOf(net);
  return { nodes: index.nodeCells, segs: index.segCells };
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

describe("BulldozeRoad", () => {
  it("removes a middle segment and leaves the junction nodes where they are", () => {
    const { state, centre } = crossroads();
    const net = state.roads;
    // The middle piece of a three-segment road: build a second crossing.
    ok(state, road([4400, 4400], [4400, 4700]));
    const east = findNode(net, 4400, 4500);
    const middle = segmentsAt(net, centre).find((s) => net.segA[s] === east || net.segB[s] === east);
    expect(middle).toBeDefined();
    const nodes = nodeCount(net);
    ok(state, bulldoze(middle ?? -1));
    expect(isSegment(net, middle ?? -1)).toBe(false);
    // Both ends still join three segments, so nothing else moves.
    expect(nodeCount(net)).toBe(nodes);
    expect(segmentsAt(net, centre)).toHaveLength(3);
    expect(segmentsAt(net, east)).toHaveLength(3);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("removes a dead end and the node at its open end", () => {
    const { state, centre, west } = crossroads();
    const net = state.roads;
    const tip = findNode(net, 4200, 4500);
    ok(state, bulldoze(west));
    expect(isNode(net, tip)).toBe(false);
    // The crossing now joins exactly three segments and stays.
    expect(isNode(net, centre)).toBe(true);
    expect(segmentsAt(net, centre)).toHaveLength(3);
  });

  it("keeps a node left joining exactly two segments, unmerged", () => {
    const { state, centre, west, north } = crossroads();
    const net = state.roads;
    const before = { x: net.nodeX[centre], z: net.nodeZ[centre] };
    ok(state, bulldoze(west, north));
    expect(segmentsAt(net, centre)).toHaveLength(2);
    expect({ x: net.nodeX[centre], z: net.nodeZ[centre] }).toEqual(before);
    expect(segmentCount(net)).toBe(2);
  });

  it("removes the last segment at a node, and the node with it", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    const net = state.roads;
    ok(state, bulldoze(0));
    expect(nodeCount(net)).toBe(0);
    expect(segmentCount(net)).toBe(0);
  });

  it("refuses a fixed segment, and keeps a fixed node its segments leave", () => {
    const state = createState(SEED);
    const net = state.roads;
    const a = addNode(net, 4200, 4500, 0, true);
    const b = addNode(net, 4300, 4500, 0);
    const c = addNode(net, 4400, 4500, 0);
    const fixed = addSegment(net, a, b, { type: 0, fixed: true });
    const free = addSegment(net, b, c, { type: 0 });
    expect((net.segFlags[fixed] ?? 0) & SEG_FIXED).toBe(SEG_FIXED);
    expect(rejection(state, bulldoze(fixed))).toBe(`Segment ${fixed} is fixed and cannot be bulldozed`);
    expect(rejection(state, upgrade("avenue", [fixed]))).toBe(`Segment ${fixed} is fixed and cannot be changed`);
    expect(isSegment(net, fixed)).toBe(true);

    // A fixed node at the end of a bulldozed segment stays.
    const lone = addNode(net, 4500, 4500, 0);
    const toFixed = addSegment(net, c, lone, { type: 0 });
    net.nodeFlags[lone] = (net.nodeFlags[lone] ?? 0) | NODE_FIXED;
    ok(state, bulldoze(toFixed, free));
    expect(isNode(net, lone)).toBe(true);
    expect(isNode(net, c)).toBe(false);
    expect(isNode(net, b)).toBe(true);
  });

  it("refuses a whole list that names one missing segment", () => {
    const { state, west, east } = crossroads();
    const before = cloneState(state).roads;
    expect(rejection(state, bulldoze(west, 999, east))).toBe("Segment 999 does not exist");
    expect(state.roads).toEqual(before);
    expect(rejection(state, bulldoze(west, west))).toBe(`Segment ${west} is named twice`);
    expect(rejection(state, bulldoze())).toMatch(/one or more segment ids/);
    expect(rejection(state, command("BulldozeRoad", { segments: [1.5] }))).toMatch(/whole-number/);
    expect(rejection(state, command("BulldozeRoad", null))).toMatch(/list of segment ids/);
  });

  it("leaves empty arrays and a full free list after bulldozing every segment", () => {
    const { state } = crossroads();
    ok(state, road([4250, 4600], [4450, 4800], "avenue"));
    ok(state, road([4300, 4900], [4600, 4900], "oneWay", [4450, 4800]));
    const net = state.roads;
    ok(state, bulldoze(...liveSegments(net)));
    expect(segmentCount(net)).toBe(0);
    expect(nodeCount(net)).toBe(0);
    expect(net.segFree.length).toBe(segmentIdLimit(net));
    expect(net.nodeFree.length).toBe(nodeIdLimit(net));
    expect([...net.segFlags].every((f) => f === 0)).toBe(true);
    expect([...net.nodeFlags].every((f) => f === 0)).toBe(true);
    expect([...net.segLength].every((v) => v === 0)).toBe(true);
    expect(roadIndexOf(net).segCells.every((c) => c.length === 0)).toBe(true);
    expect(roadIndexOf(net).nodeCells.every((c) => c.length === 0)).toBe(true);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("prices a demolition from the balance file", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "avenue"));
    const result = planBulldoze(state.roads, { segments: [0] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual({ segments: [0], nodes: [0, 1], length: 300, cost: 300 * typeOf("avenue").demolitionCostPerMetre });
    expect(Number.isSafeInteger(result.plan.cost)).toBe(true);
  });

  it("frees ids in a fixed order whatever order the list names them in", () => {
    const one = crossroads();
    const two = crossroads();
    ok(one.state, bulldoze(one.west, one.north, one.east));
    ok(two.state, bulldoze(two.east, two.west, two.north));
    expect(two.state.roads).toEqual(one.state.roads);
  });
});

describe("UpgradeRoad", () => {
  it("changes a street to an avenue in place and prices it", () => {
    const { state, west, east } = crossroads();
    const net = state.roads;
    const ends = [net.segA[west], net.segB[west]];
    const plan = planUpgrade(net, terrainOf(SEED), { segments: [west, east], type: "avenue" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const street = typeOf("street");
    const avenue = typeOf("avenue");
    const length = (net.segLength[west] ?? 0) + (net.segLength[east] ?? 0);
    expect(plan.plan.length).toBe(length);
    expect(plan.plan.cost).toBe(Math.round(length * (avenue.buildCostPerMetre - street.buildCostPerMetre * ROAD_BUILD.upgradeCredit)));
    ok(state, upgrade("avenue", [west, east]));
    expect(net.segType[west]).toBe(avenue.index);
    expect(net.segType[east]).toBe(avenue.index);
    expect([net.segA[west], net.segB[west]]).toEqual(ends);
    expect(segmentCount(net)).toBe(4);
    expect(checkRoadNetwork(net)).toBeNull();
  });

  it("never prices a downgrade below zero", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "avenue"));
    const plan = planUpgrade(state.roads, terrainOf(SEED), { segments: [0], type: "street" });
    expect(plan.ok && plan.plan.cost).toBe(0);
  });

  it("refuses a type whose slope limit the road breaks", () => {
    // A short run whose grade is between the avenue limit and the street limit.
    const t = terrainOf(SEED);
    const net = createState(SEED).roads;
    let found: [number, number] | null = null;
    for (let x = 1000; x < 11000 && !found; x += 16) {
      for (let z = 1000; z < 11000 && !found; z += 64) {
        const street = planRoad(net, t, { from: { x, z }, to: { x: x + 16, z }, type: "street" });
        const avenue = planRoad(net, t, { from: { x, z }, to: { x: x + 16, z }, type: "avenue" });
        if (street.ok && !avenue.ok) found = [x, z];
      }
    }
    const [x, z] = found ?? [0, 0];
    const state = createState(SEED);
    ok(state, road([x, z], [x + 16, z]));
    expect(rejection(state, upgrade("avenue", [0]))).toMatch(/^Too steep: .* the avenue limit is 10%$/);
    expect(state.roads.segType[0]).toBe(typeOf("street").index);
    // One-way has the street's limits.
    ok(state, upgrade("oneWay", [0]));
  });

  it("refuses a type whose curve limit the road breaks", () => {
    const state = createState(SEED);
    // A street curve with a radius between the street and avenue limits.
    ok(state, road([4200, 4600], [4260, 4600], "street", [4230, 4640]));
    const radius = minRadius(segmentQuad(state.roads, 0));
    expect(radius).toBeGreaterThanOrEqual(typeOf("street").minCurveRadius);
    expect(radius).toBeLessThan(typeOf("avenue").minCurveRadius);
    expect(rejection(state, upgrade("avenue", [0]))).toMatch(/^The curve is too tight: .* the avenue limit is 40 m$/);
  });

  it("refuses a bridge too long for the new type, or whose ramps it cannot climb", () => {
    const state = createState(SEED);
    ok(state, road([3400, 6600], [3700, 6600], "street"));
    const net = state.roads;
    const bridge = liveSegments(net).find((s) => net.segLevel[s] === LEVEL_BRIDGE) ?? -1;
    expect(bridge).toBeGreaterThanOrEqual(0);
    // Avenue ramps are held to 10% rather than 12%, so either the bridge fits
    // or the reason names the ramp. A one-way has the street's limits.
    const avenue = planUpgrade(net, terrainOf(SEED), { segments: [bridge], type: "avenue" });
    if (!avenue.ok) expect(avenue.reason).toMatch(/ramp|bank/);
    ok(state, upgrade("oneWay", [bridge]));
    // A bridge price uses the bridge multiplier.
    const back = planUpgrade(net, terrainOf(SEED), { segments: [bridge], type: "street" });
    const street = typeOf("street");
    const oneWay = typeOf("oneWay");
    const length = net.segLength[bridge] ?? 0;
    const expected = length * street.buildCostPerMetre * street.bridge.costMultiplier
      - length * oneWay.buildCostPerMetre * oneWay.bridge.costMultiplier * ROAD_BUILD.upgradeCredit;
    expect(back.ok && back.plan.cost).toBe(Math.round(expected));
  });

  it("refuses a bridge longer than the new type's limit, or whose ramps are too steep for it", () => {
    // Ground at 20 m with the water at 10 m from x = 160 to 240, so the deck
    // is at 15 m and each ramp falls 5 m.
    const terrain = synthetic((x) => (x >= 160 && x <= 240 ? 0 : 20));
    const net = createState(SEED).roads;
    const bridgeAt = (x0: number, x1: number, z: number) =>
      addSegment(net, addNode(net, x0, z, 20), addNode(net, x1, z, 20), { type: typeOf("avenue").index, level: LEVEL_BRIDGE });
    // 350 m: an avenue spans it, a street cannot.
    const long = bridgeAt(0, 350, 100);
    expect(planUpgrade(net, terrain, { segments: [long], type: "street" })).toEqual({
      ok: false,
      reason: "Too long for a bridge: 350 m, and the street limit is 300 m",
    });
    // 44 m from the bank to the shore: enough for a street's 12%, not an avenue's 10%.
    const short = addSegment(net, addNode(net, 100, 300, 20), addNode(net, 300, 300, 20), {
      type: typeOf("street").index,
      level: LEVEL_BRIDGE,
    });
    expect(planUpgrade(net, terrain, { segments: [short], type: "avenue" })).toEqual({
      ok: false,
      reason: expect.stringMatching(/^The bank is too steep for the bridge: the ramp down to the deck would be a \d+% grade, and the avenue limit is 10%$/),
    });
    expect(planUpgrade(net, terrain, { segments: [short], type: "oneWay" }).ok).toBe(true);
  });

  it("sets a one-way's direction, and reverses it when upgraded to its own type", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    const net = state.roads;
    const [a, b] = [net.segA[0] ?? -1, net.segB[0] ?? -1];
    // Run it from node B.
    ok(state, upgrade("oneWay", [0], [b]));
    expect(net.segType[0]).toBe(typeOf("oneWay").index);
    expect([net.segA[0], net.segB[0]]).toEqual([b, a]);
    expect(checkRoadNetwork(net)).toBeNull();
    // The same type reverses it, for nothing.
    expect(planUpgrade(net, terrainOf(SEED), { segments: [0], type: "oneWay" })).toMatchObject({ ok: true, plan: { cost: 0, reverse: [true] } });
    ok(state, upgrade("oneWay", [0]));
    expect([net.segA[0], net.segB[0]]).toEqual([a, b]);
    // The length and control point stay.
    expect(net.segLength[0]).toBe(300);
    expect(net.segCX[0]).toBe(4350);
    // Back to a street, which has no direction.
    ok(state, upgrade("street", [0]));
    expect([net.segA[0], net.segB[0]]).toEqual([a, b]);
  });

  it("keeps every node's segment list sound when a segment in the middle of one reverses", () => {
    const { state, centre, west, east, north, south } = crossroads();
    const net = state.roads;
    const before = segmentsAt(net, centre);
    // West and north leave the centre; east and south run into it.
    const from = [centre, otherEnd(net, east, centre), centre, otherEnd(net, south, centre)];
    ok(state, upgrade("oneWay", [west, east, north, south], from));
    expect(segmentsAt(net, centre)).toEqual(before);
    expect(checkRoadNetwork(net)).toBeNull();
    expect(net.segA[west]).toBe(centre);
    expect(net.segA[north]).toBe(centre);
    expect(net.segB[east]).toBe(centre);
    expect(net.segB[south]).toBe(centre);
  });

  it("refuses bad upgrades whole", () => {
    const { state, west, east } = crossroads();
    const before = cloneState(state).roads;
    expect(rejection(state, upgrade("avenue", [west, 999, east]))).toBe("Segment 999 does not exist");
    expect(rejection(state, upgrade("street", [west]))).toBe(`Segment ${west} is already a street`);
    expect(rejection(state, upgrade("highway", [west]))).toBe("Highways cannot be built yet");
    expect(rejection(state, upgrade("lane", [west]))).toBe('There is no road type "lane"');
    expect(rejection(state, upgrade("avenue", [west], [0]))).toBe("Only an upgrade to a one-way takes a direction");
    expect(rejection(state, upgrade("oneWay", [west, east], [0]))).toMatch(/one starting node for each segment/);
    expect(rejection(state, upgrade("oneWay", [west], [12345]))).toMatch(/does not start or end at node 12345/);
    expect(rejection(state, upgrade("avenue", [west, west]))).toBe(`Segment ${west} is named twice`);
    expect(state.roads).toEqual(before);
  });

  it("reports each change to a delta recorder and the spatial index", () => {
    const { state, west } = crossroads();
    const net = state.roads;
    recordRoadChanges(net);
    drainRoadChanges(net);
    ok(state, upgrade("avenue", [west]));
    expect(drainRoadChanges(net)?.segs).toContain(west);
    expect(cells(net)).toEqual({ nodes: buildRoadIndex(net).nodeCells, segs: buildRoadIndex(net).segCells });
  });
});

describe("builds, upgrades and bulldozes together", () => {
  it("keep a spatial index equal to a rebuilt one, and survive a save", () => {
    const state = createState(SEED);
    const net = state.roads;
    roadIndexOf(net);
    let rng = 12345;
    const next = (n: number) => {
      rng = (rng * 1103515245 + 12345) % 2147483648;
      return rng % n;
    };
    const types = ["street", "avenue", "oneWay"];
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const roll = next(10);
      const segs = liveSegments(net);
      let c: Command;
      if (roll < 5 || segs.length === 0) {
        const x = 4120 + next(56) * 10;
        const z = 4420 + next(56) * 10;
        const angle = next(4);
        const len = 40 + next(20) * 10;
        const to: [number, number] = angle === 0 ? [x + len, z] : angle === 1 ? [x, z + len] : angle === 2 ? [x + len, z + len] : [x + len, z - len];
        c = road([x, z], to, types[next(3)]);
      } else if (roll < 8) {
        const picked = [...new Set([segs[next(segs.length)] ?? 0, segs[next(segs.length)] ?? 0])];
        c = upgrade(types[next(3)] ?? "street", picked);
      } else {
        c = bulldoze(...new Set([segs[next(segs.length)] ?? 0, segs[next(segs.length)] ?? 0]));
      }
      if (run(state, c).ok) accepted++;
      if (i % 50 === 0) expect(checkRoadNetwork(net)).toBeNull();
    }
    expect(accepted).toBeGreaterThan(100);
    expect(state.log.some((e) => e.type === "UpgradeRoad")).toBe(true);
    expect(state.log.some((e) => e.type === "BulldozeRoad")).toBe(true);
    expect(checkRoadNetwork(net)).toBeNull();
    const fresh = buildRoadIndex(net);
    expect(roadIndexOf(net).segCells).toEqual(fresh.segCells);
    expect(roadIndexOf(net).nodeCells).toEqual(fresh.nodeCells);
    // A loaded copy hashes the same.
    expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
  });
});

describe("replay fixture edit-roads", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    const types = state.log.map((e) => e.type);
    expect(types).toContain("BulldozeRoad");
    expect(types).toContain("UpgradeRoad");
    expect(state.log).toHaveLength(fixture.log.length);
  });
});
