// M4-03: roads cost what their plan says, and a city that has spent its
// money stops building.

import { describe, expect, it } from "vitest";
import {
  ECONOMY,
  LINE,
  ROAD_TYPES,
  costsReason,
  createBareState,
  deserialize,
  fundCity,
  hashState,
  planBulldoze,
  planRoad,
  planRoadGrid,
  planUpgrade,
  previewBuildRoad,
  previewBuildRoadGrid,
  previewBulldozeRoad,
  previewUpgradeRoad,
  readLogSpent,
  replayFrom,
  serialize,
  step,
  type Command,
  type DroppedCommand,
  type LedgerLine,
  type RoadType,
  type SimState,
} from "../src/index";
import { submit, withEnds } from "./seen-ends";
import { terrainOf } from "../src/terrain/cache";
import { isSegment } from "../src/roads/network";
import { LOG_LIVE_LIMIT, LOG_PAGE_SIZE } from "../src/log";
import { watchTreasury } from "./treasury-helper";
import { withValue } from "./with-value";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), and an inlet along z = 6600 (bridges.test.ts).
const SEED = 2026;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}

function road(from: [number, number], to: [number, number], type = "street"): Command {
  return command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });
}

function grid(origin: [number, number], cols: number, rows: number): Command {
  const [x, z] = origin;
  return command("BuildRoadGrid", { origin: { x, z }, along: { x: x + cols * 96, z }, across: { x, z: z + rows * 96 }, depth: 86, width: 86, type: "street" });
}

const undo = (playerId = "p1") => command("Undo", {}, playerId);
const zone = () => command("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4483 }, to: { x: 4390, z: 4483 }, width: 20 }] });

/** Submits `c`, which must be accepted, and steps once. Returns what the step dropped. */
function run(state: SimState, c: Command): DroppedCommand[] {
  expect(submit(state, c)).toEqual({ ok: true });
  return step(state);
}

/** The segment with ends at `a` and `b`. */
function segmentBetween(state: SimState, a: [number, number], b: [number, number]): number {
  const net = state.roads;
  for (let seg = 0; seg < net.segA.length; seg++) {
    const ends = [net.segA[seg] ?? 0, net.segB[seg] ?? 0].map((n) => [net.nodeX[n], net.nodeZ[n]]);
    const has = (p: [number, number]) => ends.some(([x, z]) => x === p[0] && z === p[1]);
    if (isSegment(net, seg) && has(a) && has(b)) return seg;
  }
  throw new Error(`no segment from ${a} to ${b}`);
}

/** The month's amount on `line`. */
const onLine = (state: SimState, line: LedgerLine) => state.budget.month[LINE[line]] ?? 0;

/**
 * The treasury with the month's road upkeep put back (M4-04): upkeep is
 * charged on each day's first tick, after that tick's commands, so it moves
 * the treasury in steps these tests take for other reasons.
 */
const money = (state: SimState) => state.budget.treasury + onLine(state, "roadUpkeep");
// Where a test sets the treasury with `fundCity`, `paid` is the upkeep already on the line then.

const street = ROAD_TYPES.find((t) => t.id === "street");
if (!street) throw new Error("no street type");

/**
 * Runs `body` with a street's demolition at $1 a metre, below its refund
 * share, so a bulldoze pays in. Under this build's prices taking a road up
 * costs more than its refund for every road type a player can build.
 */
function cheapDemolition<R>(body: () => R): R {
  const type = street as RoadType;
  expect(type.buildCostPerMetre * ECONOMY.eminentDomain.refundShare).toBeGreaterThan(1);
  return withValue(type, "demolitionCostPerMetre", 1, body);
}

describe("construction costs", () => {
  it("charges a road its plan's cost on the construction line, on the tick it applies", () => {
    const state = createBareState(SEED);
    const watch = watchTreasury(state);
    const c = road([4200, 4500], [4500, 4500]);
    const plan = planRoad(state.roads, terrainOf(SEED), c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.cost).toBeGreaterThan(0);
    const before = money(state);
    expect(submit(state, c)).toEqual({ ok: true });
    // Accepted but not applied: nothing moves until the step.
    expect(money(state)).toBe(before);
    step(state);
    expect(money(state)).toBe(before - plan.plan.cost);
    expect(onLine(state, "construction")).toBe(plan.plan.cost);
    expect(state.logSpent).toEqual([plan.plan.cost]);
    expect(state.undo.at(-1)?.spent).toBe(plan.plan.cost);
    watch.check(state);
  });

  it("charges a grid its plan's cost on the construction line", () => {
    const state = createBareState(SEED);
    const c = grid([4200, 4500], 3, 3);
    const plan = planRoadGrid(state.roads, terrainOf(SEED), c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    const before = money(state);
    run(state, c);
    expect(state.log).toHaveLength(1);
    expect(money(state)).toBe(before - plan.plan.cost);
    expect(onLine(state, "construction")).toBe(plan.plan.cost);
    expect(readLogSpent(state, 0)).toEqual([plan.plan.cost]);
  });

  it("charges an upgrade its plan's cost on the construction line, and a reversal nothing", () => {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    const seg = segmentBetween(state, [4200, 4500], [4500, 4500]);
    const c = command("UpgradeRoad", withEnds(state.roads, { segments: [seg], type: "avenue" }));
    const plan = planUpgrade(state.roads, terrainOf(SEED), c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.cost).toBeGreaterThan(0);
    const built = onLine(state, "construction");
    const before = money(state);
    run(state, c);
    expect(money(state)).toBe(before - plan.plan.cost);
    expect(onLine(state, "construction")).toBe(built + plan.plan.cost);
    // A one-way reversed costs nothing.
    run(state, command("UpgradeRoad", withEnds(state.roads, { segments: [seg], type: "oneWay" })));
    const oneWay = money(state);
    run(state, command("UpgradeRoad", withEnds(state.roads, { segments: [seg], type: "oneWay" })));
    expect(money(state)).toBe(oneWay);
    expect(state.logSpent.at(-1)).toBe(0);
  });

  it("charges a bulldoze its demolition less its refund on the demolition line", () => {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    const seg = segmentBetween(state, [4200, 4500], [4500, 4500]);
    const c = command("BulldozeRoad", withEnds(state.roads, { segments: [seg] }));
    const plan = planBulldoze(state.roads, c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    // 300 m of street: its demolition, and the refund share of what it cost to build.
    expect(plan.plan.demolition).toBe(Math.round(300 * street.demolitionCostPerMetre));
    expect(plan.plan.refund).toBe(Math.round(300 * street.buildCostPerMetre * ECONOMY.eminentDomain.refundShare));
    expect(plan.plan.cost).toBe(plan.plan.demolition - plan.plan.refund);
    const before = money(state);
    run(state, c);
    expect(money(state)).toBe(before - plan.plan.cost);
    expect(onLine(state, "demolition")).toBe(plan.plan.cost);
    expect(state.logSpent.at(-1)).toBe(plan.plan.cost);
  });

  it("pays into the treasury for a bulldoze that refunds more than it costs, even past the overdraft", () => cheapDemolition(() => {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    const net = state.roads;
    const c = command("BulldozeRoad", withEnds(net, { segments: [segmentBetween(state, [4200, 4500], [4500, 4500])] }));
    const plan = planBulldoze(net, c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.refund).toBeGreaterThan(plan.plan.demolition);
    expect(plan.plan.cost).toBeLessThan(0);
    // Broke, and the bulldoze still goes through: it costs nothing.
    fundCity(state, -ECONOMY.overdraft - 5);
    const before = money(state);
    run(state, c);
    expect(money(state)).toBe(before - plan.plan.cost);
    expect(money(state)).toBeGreaterThan(before);
    expect(onLine(state, "demolition")).toBe(plan.plan.cost);
    expect(state.logSpent.at(-1)).toBe(plan.plan.cost);
  }));
});

describe("the overdraft", () => {
  /** A city with one street and its treasury at `treasury`. */
  function broke(treasury: number): { state: SimState; seg: number } {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    fundCity(state, treasury);
    return { state, seg: segmentBetween(state, [4200, 4500], [4500, 4500]) };
  }

  it("refuses each costing command past the overdraft with its price and what is left, and lets zoning through", () => {
    const { state, seg } = broke(-ECONOMY.overdraft);
    const left = 0;
    const commands = [
      road([4200, 4700], [4500, 4700]),
      grid([4200, 4800], 1, 1),
      command("UpgradeRoad", withEnds(state.roads, { segments: [seg], type: "avenue" })),
      command("BulldozeRoad", withEnds(state.roads, { segments: [seg] })),
    ];
    const prices = [
      planRoad(state.roads, terrainOf(SEED), commands[0]?.payload),
      planRoadGrid(state.roads, terrainOf(SEED), commands[1]?.payload),
      planUpgrade(state.roads, terrainOf(SEED), commands[2]?.payload),
      planBulldoze(state.roads, commands[3]?.payload),
    ].map((p) => (p.ok ? p.plan.cost : NaN));
    for (let i = 0; i < commands.length; i++) {
      const price = prices[i] as number;
      expect(price).toBeGreaterThan(0);
      expect(submit(state, commands[i] as Command)).toEqual({ ok: false, reason: costsReason(price, left) });
    }
    expect(costsReason(4_200_000, 1_100_000)).toBe("Costs $4.2M, $1.1M available");
    // Zoning is free, and stays open: a broke city recovers by growing.
    const treasury = money(state);
    run(state, zone());
    expect(state.log.at(-1)?.type).toBe("ZoneCells");
    expect(money(state)).toBe(treasury);
  });

  it("lets a command through that leaves the treasury exactly at the overdraft, and refuses one dollar more", () => {
    const c = road([4200, 4700], [4500, 4700]);
    const { state } = broke(0);
    const plan = planRoad(state.roads, terrainOf(SEED), c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    fundCity(state, plan.plan.cost - ECONOMY.overdraft - 1);
    expect(submit(state, c)).toEqual({ ok: false, reason: costsReason(plan.plan.cost, plan.plan.cost - 1) });
    // Rounded alike, the two would read the same, so both are given to the dollar.
    expect(costsReason(plan.plan.cost, plan.plan.cost - 1)).toMatch(/^Costs \$[\d,]+, \$[\d,]+ available$/);
    fundCity(state, plan.plan.cost - ECONOMY.overdraft);
    const paid = onLine(state, "roadUpkeep");
    run(state, c);
    expect(money(state) - paid).toBe(-ECONOMY.overdraft);
  });

  it("says what is left as nothing once upkeep or anything else has run the treasury past the overdraft", () => {
    expect(costsReason(5000, -20_000)).toBe("Costs $5K, $0 available");
  });

  it("applies the first of two commands in one step that together pass the overdraft, and drops the second with the reason", () => {
    const first = road([4200, 4700], [4500, 4700]);
    const second = road([4200, 4800], [4500, 4800]);
    const { state } = broke(0);
    const one = planRoad(state.roads, terrainOf(SEED), first.payload);
    const two = planRoad(state.roads, terrainOf(SEED), second.payload);
    if (!one.ok || !two.ok) throw new Error("the roads do not plan");
    // Enough for either, not both.
    fundCity(state, one.plan.cost + two.plan.cost - ECONOMY.overdraft - 1);
    const paid = onLine(state, "roadUpkeep");
    expect(submit(state, first)).toEqual({ ok: true });
    expect(submit(state, second)).toEqual({ ok: true });
    const dropped = step(state);
    expect(state.log.at(-1)?.seq).toBe(first.seq);
    const left = two.plan.cost - 1;
    expect(dropped).toEqual([{ seq: second.seq, playerId: "p1", type: "BuildRoad", reason: costsReason(two.plan.cost, left) }]);
    expect(money(state) - paid).toBe(left - ECONOMY.overdraft);
  });

  it("gives the tools' previews the price and the refusal, and changes nothing", () => {
    const { state, seg } = broke(-ECONOMY.overdraft);
    const before = hashState(state);
    const built = previewBuildRoad(state, road([4200, 4700], [4500, 4700]).payload);
    const gridded = previewBuildRoadGrid(state, grid([4200, 4800], 1, 1).payload);
    const upgraded = previewUpgradeRoad(state, withEnds(state.roads, { segments: [seg], type: "avenue" }));
    const dozed = previewBulldozeRoad(state, withEnds(state.roads, { segments: [seg] }));
    for (const preview of [built, gridded, upgraded, dozed]) {
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.refusal).toBe(costsReason(preview.plan.cost, 0));
    }
    expect(hashState(state)).toBe(before);
    fundCity(state, 1_000_000);
    const fine = previewBuildRoad(state, road([4200, 4700], [4500, 4700]).payload);
    expect(fine.ok && fine.refusal).toBeNull();
  });
});

describe("undo and money", () => {
  it("refunds a road undone in full, and leaves the treasury where it was", () => {
    const state = createBareState(SEED);
    const before = money(state);
    run(state, road([4200, 4500], [4500, 4500]));
    expect(money(state)).toBeLessThan(before);
    run(state, undo());
    expect(money(state)).toBe(before);
    // Built and taken back in one month: the construction line nets to nothing.
    expect(onLine(state, "construction")).toBe(0);
    expect(state.logSpent.at(-1)).toBe(-(state.logSpent[0] ?? 0));
  });

  it("refunds a grid undone in full", () => {
    const state = createBareState(SEED);
    const before = money(state);
    run(state, grid([4200, 4500], 2, 2));
    run(state, undo());
    expect(money(state)).toBe(before);
  });

  it("takes back a bulldoze's refund when it is undone, and so charges its demolition back", () => {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    const seg = segmentBetween(state, [4200, 4500], [4500, 4500]);
    const built = money(state);
    const c = command("BulldozeRoad", withEnds(state.roads, { segments: [seg] }));
    const plan = planBulldoze(state.roads, c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    run(state, c);
    expect(money(state)).toBe(built - plan.plan.cost);
    run(state, undo());
    expect(money(state)).toBe(built);
    expect(onLine(state, "demolition")).toBe(0);
  });

  it("refuses an undo that cannot pay, like any other command, and keeps its record", () => cheapDemolition(() => {
    // A bulldoze that paid in; its undo takes that back.
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    const net = state.roads;
    const c = command("BulldozeRoad", withEnds(net, { segments: [segmentBetween(state, [4200, 4500], [4500, 4500])] }));
    const plan = planBulldoze(net, c.payload);
    if (!plan.ok) throw new Error(plan.reason);
    run(state, c);
    const records = state.undo.length;
    fundCity(state, -ECONOMY.overdraft);
    const price = -plan.plan.cost;
    expect(submit(state, undo())).toEqual({ ok: false, reason: costsReason(price, 0) });
    expect(state.undo).toHaveLength(records);
    fundCity(state, price - ECONOMY.overdraft);
    const paid = onLine(state, "roadUpkeep");
    run(state, undo());
    expect(money(state) - paid).toBe(-ECONOMY.overdraft);
    expect(state.undo).toHaveLength(records - 1);
  }));

  it("moves no money undoing a paint", () => {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    run(state, zone());
    const treasury = money(state);
    expect(state.undo.at(-1)?.spent).toBe(0);
    run(state, undo());
    expect(money(state)).toBe(treasury);
    expect(state.logSpent.at(-1)).toBe(0);
  });

  it("keeps the amount on the undo record, so an undo after its log entry paged out refunds the same", () => {
    const state = createBareState(SEED);
    const before = money(state);
    run(state, road([4200, 4500], [4500, 4500]));
    // Enough free commands to page the road's entry out of live state.
    for (let i = 0; i < LOG_LIVE_LIMIT; i += LOG_PAGE_SIZE) {
      for (let k = 0; k < LOG_PAGE_SIZE; k++) expect(submit(state, command("NoOp", {}, "p2"))).toEqual({ ok: true });
      step(state);
    }
    expect(state.logOffset).toBeGreaterThan(0);
    expect(state.log).toHaveLength(state.logSpent.length);
    expect(() => readLogSpent(state, 0)).toThrow(RangeError);
    run(state, undo());
    expect(money(state)).toBe(before);
  });
});

describe("money in a save and a replay", () => {
  function session(): SimState {
    const state = createBareState(SEED);
    run(state, road([4200, 4500], [4500, 4500]));
    run(state, grid([4200, 4600], 2, 2));
    const seg = segmentBetween(state, [4200, 4500], [4500, 4500]);
    run(state, command("BulldozeRoad", withEnds(state.roads, { segments: [seg] })));
    run(state, undo());
    run(state, zone());
    // The paint waits for the cells the undo changed to settle.
    while (state.pending.length > 0) step(state);
    expect(state.log.at(-1)?.type).toBe("ZoneCells");
    return state;
  }

  it("keeps the amounts and the treasury through a save", () => {
    const state = session();
    const back = deserialize(serialize(state)).state;
    expect(back.logSpent).toEqual(state.logSpent);
    expect(back.undo.map((r) => r.spent)).toEqual(state.undo.map((r) => r.spent));
    expect(hashState(back)).toBe(hashState(state));
  });

  it("replays to the same hash", () => {
    const state = session();
    const replayed = replayFrom(createBareState(SEED), state.log, state.tick);
    expect(replayed.budget.treasury).toBe(state.budget.treasury);
    expect(replayed.logSpent).toEqual(state.logSpent);
    expect(hashState(replayed)).toBe(hashState(state));
  });
});
