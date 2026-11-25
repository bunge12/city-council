import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  LINE,
  ROAD_TYPES,
  SEG_FIXED,
  SYSTEMS,
  TIME_BALANCE,
  UPKEEP_SYSTEM,
  chargeUpkeep,
  createBareState,
  createState,
  dailyShare,
  deserialize,
  hashState,
  prepareDerived,
  recountRoadUpkeep,
  replay,
  roadUpkeepPerYear,
  segmentUpkeepPerYear,
  serialize,
  step,
  type Command,
  type RoadType,
  type SimState,
} from "../src/index";
import { isMonthStart, yearDays } from "../src/calendar";
import { checkRoadBalance, ROAD_BALANCE } from "../src/roads/balance";
import { NETWORK_RAIL, addNode, addSegment, createRoadNetwork, isSegment, restyleSegment, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { churnNetwork, growNetwork } from "./road-network-helper";
import { submit, withEnds } from "./seen-ends";
import { watchTreasury } from "./treasury-helper";

// Issue M4-04: road upkeep, a yearly share of build cost, charged a day at a time.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), and an inlet along z = 6600 from x = 3488 to 3600
// (bridges.test.ts).
const SEED = 2026;
const RIVER = { x0: 3400, x1: 3700, z: 6600 };
const DAY = TIME_BALANCE.ticksPerDay;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}
const road = (from: [number, number], to: [number, number], type = "street") => command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });

function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function typeOf(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(id);
  return type;
}

function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

/** The segment's upkeep worked out by hand from the balance file, as the PRD words it. */
function byHand(net: RoadNetwork, seg: number): number {
  if (((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0) return 0;
  const type = ROAD_TYPES[net.segType[seg] ?? 0] as RoadType;
  const buildCost = (net.segLength[seg] ?? 0) * type.buildCostPerMetre * (net.segLevelA[seg] === LEVEL_BRIDGE ? type.bridge.costMultiplier : 1);
  return Math.round(buildCost * type.upkeepShare);
}

/** A street, an avenue, a one-way and a street bridge over the inlet. */
function town(state = createBareState(SEED)): SimState {
  ok(state, road([4200, 4450], [4500, 4450], "street"));
  ok(state, road([4200, 4550], [4500, 4550], "avenue"));
  ok(state, road([4200, 4650], [4500, 4650], "oneWay"));
  ok(state, road([RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z], "street"));
  return state;
}

describe("the upkeep balance", () => {
  it("is a yearly share of build cost per type, in place of a price per metre", () => {
    for (const type of ROAD_BALANCE.types) {
      expect(type).not.toHaveProperty("upkeepPerMetrePerYear");
      expect(type.upkeepShare.source.length, type.id).toBeGreaterThan(0);
      expect(type.upkeepShare.sourceYear, type.id).toBeLessThanOrEqual(ROAD_BALANCE.escalation.toYear);
    }
    expect(checkRoadBalance(ROAD_BALANCE)).toEqual([]);
  });
});

describe("the yearly total", () => {
  it("equals a sum over the segments, for each type and a bridge", () => {
    const state = town();
    const net = state.roads;
    const segs = liveSegments(net);
    const types = new Set(segs.map((s) => ROAD_TYPES[net.segType[s] ?? 0]?.id));
    expect([...types].sort()).toEqual(["avenue", "oneWay", "street"]);
    const bridge = segs.find((s) => net.segLevelA[s] === LEVEL_BRIDGE);
    expect(bridge, "the inlet road has a bridge").toBeDefined();
    let sum = 0;
    for (const seg of segs) {
      expect(segmentUpkeepPerYear(net, seg), `segment ${seg}`).toBe(byHand(net, seg));
      expect(Number.isSafeInteger(segmentUpkeepPerYear(net, seg))).toBe(true);
      sum += byHand(net, seg);
    }
    expect(roadUpkeepPerYear(net)).toBe(sum);
    expect(recountRoadUpkeep(net)).toBe(sum);
    expect(sum).toBeGreaterThan(0);
    // A metre of bridge costs its multiplier times a metre of ground to keep.
    const street = typeOf("street");
    const b = bridge as number;
    const perMetre = segmentUpkeepPerYear(net, b) / (net.segLength[b] ?? 1);
    expect(perMetre).toBeCloseTo(street.buildCostPerMetre * street.bridge.costMultiplier * street.upkeepShare, 0);
  });

  it("leaves out the outside connections' fixed stubs", () => {
    const state = createState(SEED);
    const fixed = liveSegments(state.roads).filter((s) => ((state.roads.segFlags[s] ?? 0) & SEG_FIXED) !== 0);
    expect(fixed.length).toBeGreaterThan(0);
    for (const seg of fixed) expect(segmentUpkeepPerYear(state.roads, seg)).toBe(0);
    expect(roadUpkeepPerYear(state.roads)).toBe(0);
  });

  it("leaves out rail, paths and removed ids", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 0, 0, 0);
    const b = addNode(net, 100, 0, 0);
    const rail = addSegment(net, a, b, { type: 0, network: NETWORK_RAIL });
    expect(segmentUpkeepPerYear(net, rail)).toBe(0);
    expect(segmentUpkeepPerYear(net, rail + 1)).toBe(0);
    expect(roadUpkeepPerYear(net)).toBe(0);
  });

  it("is the same on a city loaded from its save", () => {
    const state = town();
    const loaded = deserialize(serialize(state)).state;
    prepareDerived(loaded);
    expect(roadUpkeepPerYear(loaded.roads)).toBe(roadUpkeepPerYear(state.roads));
  });
});

describe("the running sum", () => {
  /** Holds the kept sum to a recount from the arrays. */
  const sound = (state: SimState) => expect(roadUpkeepPerYear(state.roads)).toBe(recountRoadUpkeep(state.roads));

  it("matches a recount after builds, upgrades, bulldozes, splits and undos", () => {
    const state = town();
    const net = state.roads;
    roadUpkeepPerYear(net);
    sound(state);
    const streetAt = (z: number) => liveSegments(net).find((s) => net.nodeZ[net.segA[s] ?? 0] === z && net.nodeZ[net.segB[s] ?? 0] === z) as number;
    // A cross street splits all three.
    ok(state, road([4350, 4400], [4350, 4700], "street"));
    sound(state);
    // Upgrade a piece of the street to an avenue.
    const piece = streetAt(4450);
    ok(state, command("UpgradeRoad", withEnds(net, { segments: [piece], type: "avenue" })));
    expect(net.segType[piece]).toBe(typeOf("avenue").index);
    sound(state);
    // Take the middle of a piece of the avenue, which cuts it in three and removes one.
    const cut = streetAt(4550);
    ok(state, command("BulldozeRoad", withEnds(net, { segments: [cut], sections: [[0.25, 0.75]] })));
    sound(state);
    // Bulldoze the bridge whole.
    const bridge = liveSegments(net).find((s) => net.segLevelA[s] === LEVEL_BRIDGE) as number;
    ok(state, command("BulldozeRoad", withEnds(net, { segments: [bridge] })));
    sound(state);
    // Undo each in turn, back to the town.
    for (let k = 0; k < 4; k++) {
      ok(state, command("Undo", {}));
      sound(state);
    }
    expect(roadUpkeepPerYear(net)).toBe(recountRoadUpkeep(town().roads));
  });

  it("matches a recount through random adds, removals and changes of type", () => {
    const net = createRoadNetwork();
    growNetwork(net, 7, 300);
    roadUpkeepPerYear(net);
    for (let round = 0; round < 20; round++) {
      churnNetwork(net, 100 + round, 25);
      const segs = liveSegments(net);
      const seg = segs[round % segs.length] as number;
      restyleSegment(net, seg, round % 3, round % 2 === 0);
      expect(roadUpkeepPerYear(net), `round ${round}`).toBe(recountRoadUpkeep(net));
    }
  });
});

describe("the daily charge", () => {
  it("runs as a system the debug panel times, after the statistics", () => {
    expect(SYSTEMS.map((s) => s.name).slice(0, 2)).toEqual(["stats", UPKEEP_SYSTEM]);
  });

  it("charges only on a day's first tick, the day's share of the yearly total", () => {
    const state = town();
    const yearly = roadUpkeepPerYear(state.roads);
    state.tick = 37 * DAY + 1;
    const before = state.budget.month[LINE.roadUpkeep] as number;
    chargeUpkeep(state);
    expect(state.budget.month[LINE.roadUpkeep]).toBe(before);
    state.tick = 37 * DAY;
    const treasury = state.budget.treasury;
    chargeUpkeep(state);
    expect(state.budget.month[LINE.roadUpkeep]).toBe(before + dailyShare(yearly, 37));
    expect(state.budget.treasury).toBe(treasury - dailyShare(yearly, 37));
  });

  it("charges a full year of days equal to the yearly total exactly", () => {
    const state = town();
    const yearly = roadUpkeepPerYear(state.roads);
    // Not a multiple of the days, so the days differ.
    expect(yearly % yearDays()).not.toBe(0);
    const year = 3;
    state.budget.month[LINE.roadUpkeep] = 0;
    for (let d = 0; d < yearDays(); d++) {
      state.tick = (year * yearDays() + d) * DAY;
      chargeUpkeep(state);
    }
    expect(state.budget.month[LINE.roadUpkeep]).toBe(yearly);
  });

  it("stepped through a whole year, files the yearly total on the road upkeep line", () => {
    const state = town();
    // Start the watched year on 1 January of the next.
    while (state.tick % (DAY * yearDays()) !== 0) step(state);
    const yearly = roadUpkeepPerYear(state.roads);
    const watch = watchTreasury(state);
    let paid = 0;
    const end = state.tick + DAY * yearDays();
    while (state.tick < end) {
      step(state);
      watch.check(state);
      // The step onto a month's first tick filed the month just ended.
      if (isMonthStart(state.tick)) paid += state.budget.lastMonth[LINE.roadUpkeep] as number;
    }
    // The year's last close has filed December; nothing of the new year is charged yet.
    expect(state.budget.month[LINE.roadUpkeep]).toBe(0);
    expect(paid).toBe(yearly);
    expect(watch.closes).toBe(12);
  });

  it("goes on past the overdraft", () => {
    const state = town();
    state.budget.treasury -= 1e12;
    state.budget.opening -= 1e12;
    const treasury = state.budget.treasury;
    while (state.tick % DAY !== 0) step(state);
    step(state);
    expect(state.budget.treasury).toBeLessThan(treasury);
  });
});

describe("a replay", () => {
  it("gives the same state hash", () => {
    // A replay starts from a new city, with its outside connections.
    const state = town(createState(SEED));
    for (let k = 0; k < 3 * DAY; k++) step(state);
    expect(state.budget.month[LINE.roadUpkeep]).toBeGreaterThan(0);
    const again = replay(SEED, state.log, state.tick);
    expect(hashState(again)).toBe(hashState(state));
    const loaded = deserialize(serialize(state)).state;
    const resumed = [state, loaded];
    for (const s of resumed) for (let k = 0; k < 2 * DAY; k++) step(s);
    expect(hashState(loaded)).toBe(hashState(state));
  });
});
