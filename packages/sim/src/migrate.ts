import { createBuildings } from "./buildings/buildings";
import { TIME_BALANCE } from "./calendar";
import { NO_LEAVING, createPops } from "./pops/pops";
import { STAT_TOTALS, emptyMoney, recountTotals, statsFor } from "./stats/stats";
import { ECONOMY } from "./economy/balance";
import { emptyBudget } from "./economy/budget";
import { DEMAND_PARTS, createDemand } from "./demand/demand";
import { placeConnections } from "./roads/connections";
import { NO_TIER, createRoadNetwork, isNode, isSegment, type RoadNetwork } from "./roads/network";
import { terrainOf } from "./terrain/cache";
import { SNAPSHOT_VERSION, type SimState } from "./state";
import { unzonedCells } from "./zoning/cells";

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/** Upgrades state from the version it is keyed by to the next one. */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // Version 2 adds the activity log.
  1: (old) => ({ ...old, version: 2, log: [], logOffset: 0 }),
  // Version 3 adds the road graph, empty.
  2: (old) => ({ ...old, version: 3, roads: createRoadNetwork() }),
  // Version 4 adds every player's undo history, empty. Ids a version 3
  // network removed are all on its free lists, so none is held.
  3: (old) => ({ ...old, version: 4, undo: [] }),
  // Version 5 adds the outside connections, placed as a new city of the
  // seed places them but clear of the roads the save already has. They go
  // into its network under new ids and nothing is journalled, so undo
  // never takes them back.
  //
  // Placing them runs today's road code, so the network takes today's level
  // fields, build order, cell anchors and strip tiers first (see versions
  // 6, 9, 10 and 28).
  4: (old) => {
    old = stripTiers(cellAnchors(buildOrder(levelsAtBothEnds(old))));
    const roads = old["roads"] as RoadNetwork;
    const connections = placeConnections(roads, terrainOf(old["seed"] as number), old["seed"] as number);
    return { ...old, version: 5, roads, connections };
  },
  // Version 6 stores a level at each end of a segment, so a ramp can change
  // level along its length (issue 22). See `levelsAtBothEnds`.
  5: (old) => ({ ...levelsAtBothEnds(old), version: 6 }),
  // Version 7 has each undo op say which road it means, not only its id:
  // a removed segment where its end nodes stood, a restyle the ends the
  // segment had (M1 review, issue 80). See `opsWithEnds`.
  6: (old) => ({ ...old, version: 7, undo: opsWithEnds(old) }),
  // Version 8 adds the stamp of the balance the city was created under
  // (balance-stamp.ts). An older save does not say, so its stamp is empty
  // and it is not taken to replay from its log.
  7: (old) => ({ ...old, version: 8, balance: "" }),
  // Version 9 gives every segment a build order number, so the older of two
  // roads can keep its cells (M2-01). See `buildOrder`.
  8: (old) => ({ ...buildOrder(old), version: 9 }),
  // Version 10 adds the zoning cells along every zonable road, all unzoned,
  // and the cell anchor each segment measures them along (M2-03). Nothing
  // could be painted before them. See `cellAnchors`.
  9: (old) => {
    const next = cellAnchors(old);
    return { ...next, version: 10, cells: unzonedCells(next["roads"] as RoadNetwork), cellsReadyAt: 0 };
  },
  // Version 11 adds the buildings, none of them (M2-09). Nothing could grow
  // before them.
  10: (old) => ({ ...old, version: 11, buildings: createBuildings() }),
  // Version 12 gives each building the back lot of a through-lot (M2-14).
  // No building before it had one, so every back field is 0.
  11: (old) => ({ ...old, version: 12, buildings: withBackLots(old["buildings"]) }),
  // Version 13 adds the grower's plan for the day (issue 135). A version 12
  // city grew one building a day, so the day it was saved on keeps that
  // quota. Its free cells are counted as none, so the next day's plan sees
  // them as new and gives them a full `fillDays`.
  12: (old) => {
    const day = Math.floor((old["tick"] as number) / TIME_BALANCE.ticksPerDay);
    return { ...old, version: 13, growth: { quota: 1, day, deadline: day + 1, free: 0, used: 0 } };
  },
  // Version 14 gives every undo record the zoning it brings back (issue
  // 111). No record before it held any: a ZoneCells left none, and a
  // bulldozed road came back unzoned, as it still does for these.
  13: (old) => ({ ...old, version: 14, undo: ((old["undo"] ?? []) as Record<string, unknown>[]).map((record) => ({ ...record, zones: new Int32Array(0) })) }),
  // Version 15 (M2 review, #147) lets a ZoneCells undo record carry the id
  // of the stroke it is a part of. It is optional, and no record before it
  // had one: each part of a split stroke stays a step of its own. It also
  // adds `cellReads`, the cell commands applied this tick, which starts at
  // none.
  14: (old) => ({ ...old, version: 15, cellReads: 0 }),
  // Version 16 adds the pops, none of them, and the daily sweep's limit,
  // 0 (M3-03). Nothing could create a pop before them.
  15: (old) => ({ ...old, version: 16, pops: createPops() }),
  // Version 17 adds the city centre land value measures from (M3-13). An
  // older city has none yet and is due one on the tick it was saved on, so
  // the first settled step after loading works it out from its buildings.
  16: (old) => ({ ...old, version: 17, centre: { x: 0, z: 0, weight: 0, due: old["tick"] as number } }),
  // Version 18 adds the city statistics (M3-04): the running totals counted
  // from the city's buildings and pops, the highest population today's, the
  // yearly counts at 0 and the history empty. Its first sample is taken on
  // the next month's first tick.
  17: (old) => ({ ...old, version: 18, stats: statsFor(old as unknown as SimState) }),
  // Version 19 adds `travelReadyAt`, the tick from which the travel times
  // between zones may be read (issue #177). A city saved before it has no
  // rebuild under way: its table is built from its roads at load.
  18: (old) => ({ ...old, version: 19, travelReadyAt: 0 }),
  // Version 20 adds the demand bars (M3-06), all at 0. They take their first
  // step toward what the city's totals say on the next day's first tick.
  19: (old) => ({ ...old, version: 20, demand: createDemand() }),
  // Version 21 drops the grower's plan for the day (M3-07). The grower's
  // pace now follows the demand bars, which are already in state, so it
  // keeps no plan of its own. The buildings stay as they are.
  20: (old) => {
    const { growth, ...rest } = old;
    void growth;
    return { ...rest, version: 21 };
  },
  // Version 22 adds the day's plan of arrivals to the pops (M3-08). Nobody
  // could arrive before it, so nobody is owed.
  21: (old) => ({ ...old, version: 22, pops: { ...(old["pops"] as Record<string, unknown>), owed: 0 } }),
  // Version 23 (M3-10) gives every pop the game days its satisfaction has
  // been low, none yet, and the pops the day's plan of departures, nobody.
  // The statistics gain the residents' summed satisfaction, counted from
  // the pops, with a history of zeros as long as the others, and the
  // residential bar gains its satisfaction part at 0, which takes its
  // first step on the next day's first tick.
  22: (old) => ({ ...old, version: 23, pops: popsWithDaysLow(old["pops"]), stats: statsWithSatisfaction(old), demand: demandWithSatisfaction(old["demand"]) }),
  // Version 24 (M3-24) gives every building the tick it became what it is.
  // No building was vacant or abandoned before it, so each is in use since
  // the tick it was built, and its flags stay as they are.
  23: (old) => ({ ...old, version: 24, buildings: withStatusSince(old["buildings"]) }),
  // Version 25 adds the queue of displaced pops (M3-12), empty: before it a
  // removed home took its pops with it, so nobody is waiting for a home.
  24: (old) => ({ ...old, version: 25, pops: { ...(old["pops"] as Record<string, unknown>), displaced: new Int32Array(0) } }),
  // Version 26 adds `redevelopedToday`, the buildings redevelopment replaced
  // or cleared since the day's first tick (M3-14). A city saved before it
  // had no redevelopment, so none today.
  25: (old) => ({ ...old, version: 26, redevelopedToday: 0 }),
  // Version 27 adds the last whole travel-time table, held while a rebuild
  // runs so job matching need not stop (#313). A city saved before it has
  // none: if a rebuild was under way, nobody is matched until it is ready,
  // as before.
  26: (old) => ({ ...old, version: 27, travelLast: null }),
  // Version 28 adds the tiers of each segment's strips of zoning cells
  // (#341). A city saved before it never had them, so every strip, live or
  // in the undo history, fronted no block: its cells claim as they did, and
  // nothing a player built moves.
  27: (old) => ({ ...stripTiers(old), version: 28 }),
  // Version 29 gives every pop the game days of grace it has left before
  // the residential bar counts its workers as unemployed (#361), and the
  // statistics the unemployed workers still in their grace, with a history
  // of zeros as long as the others. A city saved before it had no grace, so
  // every pop has settled in, none is left, and the bar reads what it did.
  28: (old) => ({ ...old, version: 29, pops: popsWithGrace(old["pops"]), stats: statsWithNewcomers(old["stats"]) }),
  // Version 30 adds the treasury and the ledger (M4-02), and the money
  // series of the statistics' history. A city saved before it had no money:
  // it is given the starting grant, as its opening balance and on no line,
  // an empty ledger, the tax rates at their defaults, and money series of
  // zeros as long as the rest of its history.
  29: (old) => ({ ...old, version: 30, stats: statsWithMoney(old["stats"]), budget: emptyBudget(ECONOMY.startingGrant) }),
  // Version 31 keeps the money each command moved (M4-03): beside each live
  // log entry, and on each undo record. Nothing cost money before it, so
  // every amount is 0, and an undo of an older command moves none.
  30: (old) => ({
    ...old,
    version: 31,
    undo: (old["undo"] as Record<string, unknown>[]).map((record) => ({ ...record, spent: 0 })),
    logSpent: (old["log"] as unknown[]).map(() => 0),
  }),
  // Version 32 keeps the expropriations of the last game year, marks each
  // building the city has paid to clear, and counts on each undo record the
  // buildings its command took (M4-09). Clearing a building cost nothing
  // before it and left no record, so an older city has no records, no
  // building paid for, and undo records that took none: they undo as they
  // did.
  31: (old) => ({
    ...old,
    version: 32,
    undo: (old["undo"] as Record<string, unknown>[]).map((record) => ({ ...record, took: 0 })),
    buildings: buildingsWithPaid(old["buildings"]),
    expropriations: [],
  }),
};

/** Version 29 statistics with money series of zeros as long as the history, after `next`. */
function statsWithMoney(value: unknown): Record<string, unknown> {
  const stats = value as Record<string, unknown> & { history: Record<string, Int32Array> };
  // A save from before version 18 got its statistics from today's `statsFor`, which has the money already.
  if (stats["money"] !== undefined) return stats;
  return { ...stats, money: emptyMoney(stats.history["population"]?.length ?? 0) };
}

/** A version 28 set of pops with the days of grace version 29 adds, none, in the order a new state has them. */
function popsWithGrace(value: unknown): Record<string, unknown> {
  const pops = value as Record<string, unknown> & { flags: Uint8Array };
  const out: Record<string, unknown> = {};
  // Only the keys the save has and the one this version adds, so a later version's fields are its own migration's to add.
  for (const key of Object.keys(createPops())) {
    if (key === "graceDays") out[key] = new Uint8Array(pops.flags.length);
    else if (key in pops) out[key] = pops[key];
  }
  return out;
}

/** Version 28 statistics with the unemployed workers in their grace, none, and a history of zeros. Totals and history keep `STAT_TOTALS` order. */
function statsWithNewcomers(value: unknown): Record<string, unknown> {
  const stats = value as Record<string, unknown> & { totals: Record<string, number>; history: Record<string, Int32Array> };
  const length = stats.history["population"]?.length ?? 0;
  const totals: Record<string, number> = {};
  const history: Record<string, Int32Array> = {};
  for (const name of STAT_TOTALS) {
    totals[name] = stats.totals[name] ?? 0;
    history[name] = stats.history[name] ?? new Int32Array(length);
  }
  return { ...stats, totals, history };
}

/** The state with `segTierL` and `segTierR` on the network at `NO_TIER`, and both on every row in the undo history. */
function stripTiers(old: Record<string, unknown>): Record<string, unknown> {
  const net = old["roads"] as RoadNetwork;
  const limit = net.segFlags.length;
  // A dead id's row is all zeros, as `removeSegment` leaves it.
  const segTierL = new Int32Array(limit);
  const segTierR = new Int32Array(limit);
  for (let id = 0; id < limit; id++) {
    if (!isSegment(net, id)) continue;
    segTierL[id] = NO_TIER;
    segTierR[id] = NO_TIER;
  }
  const fields: Record<string, unknown> = { ...net, segTierL, segTierR };
  // In the order a new network has its fields, so it saves the same way.
  const roads = Object.fromEntries(Object.keys(createRoadNetwork()).map((key) => [key, fields[key]]));
  const history = (old["undo"] ?? []) as { ops: OldSegOp[] }[];
  const undo = history.map((record) => ({
    ...record,
    ops: record.ops.map((op) => (op.row ? { ...op, row: { ...op.row, tierL: NO_TIER, tierR: NO_TIER } } : op)),
  }));
  return { ...old, roads, undo };
}

/** A version 31 set of buildings with `paid`, none paid for, after `statusSince` as a new state has it. Left as it is when it has one. */
function buildingsWithPaid(value: unknown): Record<string, unknown> {
  const b = value as Record<string, unknown> & { flags: Uint8Array };
  if (b["paid"] !== undefined) return b;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(b)) {
    out[key] = field;
    if (key === "statusSince") out["paid"] = new Uint8Array(b.flags.length);
  }
  return out;
}

/** A version 23 set of buildings with `statusSince`, each building's `builtAt`, after `builtAt` as a new state has it. */
function withStatusSince(value: unknown): Record<string, unknown> {
  const b = value as Record<string, unknown> & { builtAt: Float64Array };
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(b)) {
    out[key] = field;
    if (key === "builtAt") out["statusSince"] = b.builtAt.slice();
  }
  return out;
}

/** A version 22 set of pops with the version 23 fields, in the order a new state has them: no days low, and no plan of departures. */
function popsWithDaysLow(value: unknown): Record<string, unknown> {
  const pops = value as Record<string, unknown> & { flags: Uint8Array };
  const added: Record<string, unknown> = { daysLow: new Uint8Array(pops.flags.length), leaveScore: NO_LEAVING, leaveAtScore: 0 };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(createPops())) {
    if (key in added) out[key] = added[key];
    else if (key in pops) out[key] = pops[key];
  }
  return out;
}

/** Version 22 statistics with the residents' summed satisfaction, counted from the pops, and its history all zeros. Totals and history keep `STAT_TOTALS` order. */
function statsWithSatisfaction(old: Record<string, unknown>): Record<string, unknown> {
  const stats = old["stats"] as Record<string, unknown> & { totals: Record<string, number>; history: Record<string, Int32Array> };
  const counted = recountTotals({ pops: old["pops"], buildings: old["buildings"] } as unknown as SimState)["residentSatisfaction"] ?? 0;
  const length = stats.history["population"]?.length ?? 0;
  const totals: Record<string, number> = {};
  const history: Record<string, Int32Array> = {};
  for (const name of STAT_TOTALS) {
    // Totals a later version adds are that version's migration's to add.
    if (!(name in stats.totals) && name !== "residentSatisfaction") continue;
    totals[name] = name in stats.totals ? (stats.totals[name] ?? 0) : counted;
    history[name] = stats.history[name] ?? new Int32Array(length);
  }
  return { ...stats, totals, history };
}

/** Version 22 demand bars with the residential bar's satisfaction part, at 0, in `DEMAND_PARTS` order. */
function demandWithSatisfaction(value: unknown): Record<string, unknown> {
  const demand = value as Record<string, { value: number; parts: Record<string, number> }>;
  const residential = demand["residential"] as { value: number; parts: Record<string, number> };
  const parts: Record<string, number> = {};
  for (const name of DEMAND_PARTS.residential) parts[name] = residential.parts[name] ?? 0;
  return { ...demand, residential: { ...residential, parts } };
}

/** A version 11 set of buildings with the back-lot arrays version 12 adds, all 0, one per id. */
function withBackLots(old: unknown): unknown {
  if (typeof old !== "object" || old === null) return old;
  const b = old as Record<string, unknown>;
  const flags = b["flags"];
  const n = flags instanceof Uint8Array ? flags.length : 0;
  const back: Record<string, unknown> = {
    backSeg: new Int32Array(n),
    backSide: new Uint8Array(n),
    backPlace: new Int32Array(n),
    backDir: new Uint8Array(n),
    backDepth: new Uint8Array(n),
  };
  // In the order a new city's buildings have their fields: the back lot
  // after `depth`.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(b)) {
    out[key] = value;
    if (key === "depth") Object.assign(out, back);
  }
  if (!("depth" in b)) Object.assign(out, back);
  return out;
}

/**
 * The state with a cell anchor on every segment, live or in the undo
 * history: the segment itself, from parameter 0 at node A to 1 at node B.
 * A version 9 save does not say which road a piece was cut from, so each
 * segment starts as its own road. A row whose segment is gone and whose
 * ends the history does not say gets an anchor of zeros; its undo is
 * refused anyway, as it was before.
 */
function cellAnchors(old: Record<string, unknown>): Record<string, unknown> {
  const net = old["roads"] as RoadNetwork;
  const limit = net.segFlags.length;
  const arrays = {
    segAnchorAX: new Float64Array(limit),
    segAnchorAZ: new Float64Array(limit),
    segAnchorCX: new Float64Array(limit),
    segAnchorCZ: new Float64Array(limit),
    segAnchorBX: new Float64Array(limit),
    segAnchorBZ: new Float64Array(limit),
    segAnchorTA: new Float64Array(limit),
    segAnchorTB: new Float64Array(limit),
  };
  const own = (id: number) => {
    const a = net.segA[id] ?? 0;
    const b = net.segB[id] ?? 0;
    return {
      ax: net.nodeX[a] ?? 0,
      az: net.nodeZ[a] ?? 0,
      cx: net.segCX[id] ?? 0,
      cz: net.segCZ[id] ?? 0,
      bx: net.nodeX[b] ?? 0,
      bz: net.nodeZ[b] ?? 0,
      tA: 0,
      tB: 1,
    };
  };
  for (let id = 0; id < limit; id++) {
    if (!isSegment(net, id)) continue;
    const a = own(id);
    arrays.segAnchorAX[id] = a.ax;
    arrays.segAnchorAZ[id] = a.az;
    arrays.segAnchorCX[id] = a.cx;
    arrays.segAnchorCZ[id] = a.cz;
    arrays.segAnchorBX[id] = a.bx;
    arrays.segAnchorBZ[id] = a.bz;
    arrays.segAnchorTB[id] = 1;
  }
  const none = { ax: 0, az: 0, cx: 0, cz: 0, bx: 0, bz: 0, tA: 0, tB: 1 };
  const history = (old["undo"] ?? []) as { ops: OldSegOp[] }[];
  const undo = history.map((record) => ({
    ...record,
    ops: record.ops.map((op) => {
      const row = op.row as (OldRow & { cx: number; cz: number }) | undefined;
      if (op.op === "removeSeg" && row) {
        const anchor = { ax: op["ax"], az: op["az"], cx: row.cx, cz: row.cz, bx: op["bx"], bz: op["bz"], tA: 0, tB: 1 };
        return { ...op, row: { ...row, anchor } };
      }
      if (op.op === "addSeg" && row) return { ...op, row: { ...row, anchor: isSegment(net, op.id) ? own(op.id) : none } };
      return op;
    }),
  }));
  // In the order a new network has its fields, so it saves the same way.
  const fields: Record<string, unknown> = { ...net, ...arrays };
  const roads = Object.fromEntries(Object.keys(createRoadNetwork()).map((key) => [key, fields[key]]));
  return { ...old, roads, undo };
}

type OldRow = Record<string, unknown>;
type OldSegOp = Record<string, unknown> & { op: string; id: number; row?: OldRow };

/**
 * The state with a build order number on every segment, live or in the
 * undo history, and the counter past them all.
 *
 * A version 8 save does not say which road came first, so the numbers are
 * made up in the one order every machine agrees on: live segments in id
 * order from 0. A row in the undo history whose id is live takes that
 * segment's number, which is right for the piece a split left under its
 * parent's id and for a road a command added. A segment the history holds,
 * bulldozed and waiting for its undo, gets the next number, in the order the
 * history removed it, and the record that built it says the same number,
 * so the two undos still apply one after the other. An add whose segment is
 * gone and held by no record cannot be undone anyway, and says 0. Adds are
 * marked as not fresh, so taking one back never moves the counter. No cell
 * exists before version 9, so these numbers change nothing a player built.
 */
function buildOrder(old: Record<string, unknown>): Record<string, unknown> {
  const net = old["roads"] as Omit<RoadNetwork, "segOrder" | "segOrderNext">;
  const live = (id: number) => isSegment(net as RoadNetwork, id);
  const limit = net.segFlags.length;
  const segOrder = new Float64Array(limit);
  let next = 0;
  for (let id = 0; id < limit; id++) if (live(id)) segOrder[id] = next++;
  const history = (old["undo"] ?? []) as { ops: OldSegOp[] }[];
  const held = new Map<number, number>();
  for (const record of history) {
    for (const op of record.ops) if (op.op === "removeSeg" && !live(op.id) && !held.has(op.id)) held.set(op.id, next++);
  }
  const orderOf = (id: number): number => (live(id) ? (segOrder[id] ?? 0) : (held.get(id) ?? 0));
  const undo = history.map((record) => ({
    ...record,
    ops: record.ops.map((op) => {
      if (op.op === "addSeg") return { op: op.op, id: op.id, grown: op["grown"], fresh: false, row: { ...op.row, order: orderOf(op.id) } };
      if (op.op === "removeSeg") return { ...op, row: { ...op.row, order: orderOf(op.id) } };
      return op;
    }),
  }));
  // In the order a new network has its fields, so it saves the same way.
  const fields: Record<string, unknown> = { ...net, segOrder, segOrderNext: next };
  const roads = Object.fromEntries(Object.keys(createRoadNetwork()).map((key) => [key, fields[key]]));
  return { ...old, roads, undo };
}

type OldOp = Record<string, unknown> & { op: string; id: number; row?: { a: number; b: number } };

/**
 * The undo history with the fields version 7 adds, filled in from what the
 * save holds.
 *
 * A removed segment's end nodes are where the network has them now or, for
 * a node that is gone, where the newest record that removed it says it
 * stood. A restyle's ends are found by walking the history backwards from
 * the segment as it is now. Where the save cannot say, as when the id has
 * since gone to another road, the ends are left as ones no road has, and
 * the undo is refused as it should have been.
 */
function opsWithEnds(old: Record<string, unknown>): unknown[] {
  const net = old["roads"] as RoadNetwork;
  const history = (old["undo"] ?? []) as { ops: OldOp[] }[];
  // Where each node that is gone last stood.
  const gone = new Map<number, { x: number; z: number }>();
  for (const record of history) {
    for (const op of record.ops) {
      if (op.op === "removeNode") gone.set(op.id, { x: op["x"] as number, z: op["z"] as number });
    }
  }
  const nodeAt = (id: number): { x: number; z: number } => {
    if (isNode(net, id)) return { x: net.nodeX[id] ?? 0, z: net.nodeZ[id] ?? 0 };
    return gone.get(id) ?? { x: 0, z: 0 };
  };
  // The ends each segment id has at the point the walk has reached, newest
  // change first. Null once the walk passes the change that made the id's
  // current road, since what the id named before that is not in the save.
  const ends = new Map<number, { a: number; b: number } | null>();
  const endsOf = (id: number): { a: number; b: number } | null => {
    if (!ends.has(id)) ends.set(id, isSegment(net, id) ? { a: net.segA[id] ?? 0, b: net.segB[id] ?? 0 } : null);
    return ends.get(id) ?? null;
  };
  const out: unknown[] = new Array<unknown>(history.length);
  for (let r = history.length - 1; r >= 0; r--) {
    const record = history[r] as { ops: OldOp[] };
    const ops: unknown[] = new Array<unknown>(record.ops.length);
    for (let i = record.ops.length - 1; i >= 0; i--) {
      const op = record.ops[i] as OldOp;
      ops[i] = op;
      if (op.op === "removeSeg" && op.row) {
        const a = nodeAt(op.row.a);
        const b = nodeAt(op.row.b);
        ops[i] = { ...op, ax: a.x, az: a.z, bx: b.x, bz: b.z };
        ends.set(op.id, { a: op.row.a, b: op.row.b });
      } else if (op.op === "addSeg") {
        ends.set(op.id, null);
      } else if (op.op === "restyle") {
        const after = endsOf(op.id);
        const before = after === null ? { a: 0, b: 0 } : op["reverse"] ? { a: after.b, b: after.a } : after;
        ops[i] = { ...op, a: before.a, b: before.b };
        if (after !== null) ends.set(op.id, before);
      }
    }
    out[r] = { ...record, ops };
  }
  return out;
}

/**
 * The state with each segment's one level made the level at both its ends:
 * `segLevel` becomes `segLevelA` and `segLevelB`, in the network and in every
 * segment row the undo history holds. A state already in that shape, as one
 * an earlier migration built with today's code, is returned as it is.
 */
function levelsAtBothEnds(old: Record<string, unknown>): Record<string, unknown> {
  const net = old["roads"] as Record<string, unknown> & { segLevel?: Uint8Array };
  if (!net.segLevel) return old;
  const { segLevel, ...rest } = net;
  const fields: Record<string, unknown> = { ...rest, segLevelA: segLevel, segLevelB: Uint8Array.from(segLevel) };
  // In the order a new network has its fields, so it saves the same way.
  const roads = Object.fromEntries(Object.keys(createRoadNetwork()).map((key) => [key, fields[key]]));
  const undo = ((old["undo"] ?? []) as { ops: { row?: Record<string, unknown> }[] }[]).map((record) => ({
    ...record,
    ops: record.ops.map((op) => {
      if (!op.row || !("level" in op.row)) return op;
      const { level, ...row } = op.row;
      return { ...op, row: { ...row, levelA: level, levelB: level } };
    }),
  }));
  return { ...old, roads, undo };
}

/**
 * Brings state from any older snapshot version up to `SNAPSHOT_VERSION`.
 * Refuses versions it does not know, including newer ones.
 */
export function migrateState(old: { version: unknown } & Record<string, unknown>): SimState {
  let state: Record<string, unknown> = old;
  const from = state.version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
    throw new RangeError(`unknown snapshot version ${String(from)}`);
  }
  if (from > SNAPSHOT_VERSION) {
    throw new RangeError(
      `snapshot version ${from} is newer than this build, which reads up to ${SNAPSHOT_VERSION}`,
    );
  }
  while ((state.version as number) < SNAPSHOT_VERSION) {
    const migrate = MIGRATIONS[state.version as number];
    if (!migrate) throw new RangeError(`no migration from snapshot version ${String(state.version)}`);
    state = migrate(state);
  }
  return state as unknown as SimState;
}
