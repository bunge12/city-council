import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, SNAPSHOT_VERSION, buildingJobs, cellAt, findLot, jobsFilled, popsAtHome, TIME_BALANCE, connectionEnd, createBareState, createState, hashState, migrateState, popCount, step, submit, travelTimesReady, type SimState } from "../src/index";
import { checkConnections, chooseConnectionSites } from "../src/roads/connections";
import { LEVEL_BRIDGE, addNode, addSegment, createRoadNetwork, isNode, readSegment, removeNode, removeSegment, segmentCount } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import { checkUndoHistory } from "../src/undo";
import { createDemand } from "../src/demand/demand";
import { STAT_TOTALS, createStats, recountTotals, sampleCount, statsFor } from "../src/stats/stats";
import { addBuilding } from "../src/buildings/buildings";
import { addPop, setPopWork } from "../src/pops/pops";
import { withEnds } from "./seen-ends";
import { withoutSatisfaction } from "./before-satisfaction";
import { withoutVacancy } from "./before-vacancy";

/**
 * `state` as an older version: its fields minus the ones that version did
 * not have. Every version before 10 also lacks the zoning cells and the tick
 * they settle by, every version before 11 the buildings, every version
 * before 13 the grower's plan, every version before 14 the zoning in its
 * undo history, every version before 15 the count of cell commands,
 * every version before 16 the pops, every version before 17 the city
 * centre, every version before 18 the statistics, every version before 19
 * the tick the travel times are ready by and every version before 20 the
 * demand bars. Versions 13 to 20 held the grower's plan, which version 21
 * dropped: they get a new city's, with nothing planned.
 */
function older(state: SimState, version: number, ...drop: (keyof SimState)[]): { version: number } & Record<string, unknown> {
  const gone: string[] = [...drop];
  if (version < 10) gone.push("cells", "cellsReadyAt");
  if (version < 11) gone.push("buildings");
  if (version < 13) gone.push("growth");
  if (version < 15) gone.push("cellReads");
  if (version < 16) gone.push("pops");
  if (version < 17) gone.push("centre");
  if (version < 18) gone.push("stats");
  if (version < 19) gone.push("travelReadyAt");
  if (version < 20) gone.push("demand");
  if (version < 26) gone.push("redevelopedToday");
  const kept = Object.fromEntries(Object.entries(state).filter(([key]) => !gone.includes(key)));
  // Before version 14 a ZoneCells left no undo record and no record held zoning.
  if (version < 14 && Array.isArray(kept["undo"])) {
    kept["undo"] = withoutZones(kept["undo"] as SimState["undo"]).map((record) => {
      const { zones, ...rest } = record;
      void zones;
      return rest;
    });
  }
  if (version >= 13 && version < 21) kept["growth"] = { quota: 0, day: -1, deadline: 0, free: 0, used: 0 };
  // Before version 22 the pops had no plan of arrivals.
  if (version < 22 && typeof kept["pops"] === "object" && kept["pops"] !== null) {
    const { owed, ...pops } = kept["pops"] as Record<string, unknown>;
    void owed;
    kept["pops"] = pops;
  }
  // Before version 25 the pops had no queue of displaced pops.
  if (version < 25 && typeof kept["pops"] === "object" && kept["pops"] !== null) {
    const { displaced, ...pops } = kept["pops"] as Record<string, unknown>;
    void displaced;
    kept["pops"] = pops;
  }
  // Before version 23 nothing kept satisfaction but the pops' scores.
  if (version < 23) return { ...withoutSatisfaction(kept), version };
  // Before version 24 no building said when it became what it is.
  if (version < 24) return { ...withoutVacancy(kept), version };
  return { ...kept, version };
}

/** An undo history as the version 14 migration leaves it, from one of today's: no ZoneCells records, and no zoning on any other. */
function withoutZones(undo: SimState["undo"]): SimState["undo"] {
  return undo
    .filter((r) => r.type !== "ZoneCells")
    .map((record) => {
      const { painted, ...rest } = record;
      void painted;
      return { ...rest, zones: new Int32Array(0) };
    });
}

/** `state` as a version 12 save of it migrates to. */
function asMigrated(state: SimState): SimState {
  return {
    ...state,
    undo: withoutZones(state.undo),
    centre: { x: 0, z: 0, weight: 0, due: state.tick },
    stats: statsFor(state),
    demand: createDemand(),
    redevelopedToday: 0,
  };
}

/** Along the north side of a street at z 4600 from x 4200, adds at each free place the building `findLot` picks there, with the most residents its type holds, and returns their ids. */
function growAll(state: SimState): number[] {
  const built: number[] = [];
  for (let p = 0; p < 50; p++) {
    const cell = cellAt(state, 4200 + 8 * p + 4, 4591);
    if (!cell) continue;
    const found = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth });
    const type = found.ok ? BUILDING_TYPES[found.lot.type] : undefined;
    if (!found.ok || !type) continue;
    built.push(addBuilding(state, { ...found.lot, residents: type.residents[1], variant: 0 }));
  }
  return built;
}

/** Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000) (build-road.test.ts). */
const SEED_WITH_FLAT_GROUND = 2026;

describe("migrateState", () => {
  it("upgrades a version 1 state by adding an empty activity log and an empty road network", () => {
    const v1 = {
      version: 1,
      tick: 42,
      seed: 5,
      rng: createBareState(5).rng,
      speed: 2,
      pending: [],
    };
    const state = migrateState(v1);
    expect(SNAPSHOT_VERSION).toBe(26);
    const fresh = createState(5);
    expect(state).toEqual({
      ...v1,
      version: SNAPSHOT_VERSION,
      log: [],
      logOffset: 0,
      roads: fresh.roads,
      undo: [],
      connections: fresh.connections,
      balance: "",
      cells: fresh.cells,
      cellsReadyAt: 0,
      buildings: fresh.buildings,
      cellReads: 0,
      pops: fresh.pops,
      centre: { x: 0, z: 0, weight: 0, due: 42 },
      stats: createStats(),
      travelReadyAt: 0,
      demand: createDemand(),
      redevelopedToday: 0,
    });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 2 state by adding a road network with only the outside connections", () => {
    const v2 = older(createBareState(9), 2, "roads", "undo", "connections", "balance");
    const state = migrateState(v2);
    const fresh = createState(9);
    expect(state).toEqual({
      ...v2,
      version: SNAPSHOT_VERSION,
      roads: fresh.roads,
      undo: [],
      connections: fresh.connections,
      balance: "",
      cells: fresh.cells,
      cellsReadyAt: 0,
      buildings: fresh.buildings,
      cellReads: 0,
      pops: fresh.pops,
      centre: { x: 0, z: 0, weight: 0, due: 0 },
      stats: createStats(),
      travelReadyAt: 0,
      demand: createDemand(),
      redevelopedToday: 0,
    });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 3 state by adding an empty undo history", () => {
    const state = migrateState(older(createBareState(9), 3, "undo", "connections", "balance"));
    expect(state.undo).toEqual([]);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 4 state by adding the connections a new city of its seed gets", () => {
    const state = migrateState(older(createBareState(9), 4, "connections", "balance"));
    // All but the balance stamp, which an old save does not have.
    expect(hashState(state)).toBe(hashState({ ...asMigrated(createState(9)), balance: "" }));
  });

  it("keeps a version 4 city's own roads and ids, and places its connections clear of them", () => {
    const seed = 2026;
    const v4 = createBareState(seed);
    // A street right where a new city of this seed has its first connection.
    const first = chooseConnectionSites(createRoadNetwork(), terrainOf(seed), seed)[0];
    if (!first) throw new Error("seed 2026 has no connection");
    // Across the middle of the stub that site would have.
    const mx = (first.x + first.innerX) / 2;
    const mz = (first.z + first.innerZ) / 2;
    const px = (first.innerZ - first.z) / 200;
    const pz = (first.x - first.innerX) / 200;
    const a = addNode(v4.roads, mx + 50 * px, mz + 50 * pz, 10);
    const b = addNode(v4.roads, mx - 50 * px, mz - 50 * pz, 10);
    const street = addSegment(v4.roads, a, b, { type: 0 });
    const state = migrateState(older(v4, 4, "connections", "balance"));
    expect(checkConnections(state.connections, state.roads)).toBeNull();
    expect(state.connections.length).toBeGreaterThanOrEqual(2);
    expect(isNode(state.roads, a) && isNode(state.roads, b)).toBe(true);
    expect(state.roads.segA[street]).toBe(a);
    expect(segmentCount(state.roads)).toBe(1 + state.connections.length);
    // The blocked site is not used.
    for (const edge of state.connections) {
      expect([state.roads.nodeX[edge], state.roads.nodeZ[edge]]).not.toEqual([first.x, first.z]);
      expect(connectionEnd(state.roads, edge)).toBeGreaterThan(b);
    }
  });

  it("upgrades a version 5 state by giving each segment its level at both ends, in the network and the undo history", () => {
    const state = createState(9);
    const net = state.roads;
    const a = addNode(net, 1000, 1000, 10);
    const b = addNode(net, 1100, 1000, 10);
    addSegment(net, a, b, { type: 0, level: LEVEL_BRIDGE });
    // The version 5 shape: one level per segment and per undo row.
    const roads5: Record<string, unknown> = { ...net, segLevel: net.segLevelA };
    delete roads5["segLevelA"];
    delete roads5["segLevelB"];
    const row = { a, b, type: 0, network: 0, level: LEVEL_BRIDGE, flags: 1, cx: 1050, cz: 1000, length: 100 };
    const undo5 = [{ playerId: "p1", entry: 0, type: "BuildRoad", ops: [{ op: "addNode", id: a, grown: true }, { op: "addSeg", id: 9, grown: true, row }] }];
    const migrated = migrateState({ ...older(state, 5, "roads", "undo"), roads: roads5, undo: undo5 });
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated.roads)).toEqual(Object.keys(createRoadNetwork()));
    expect(migrated.roads).toEqual(net);
    expect(migrated.undo[0]?.ops[0]).toEqual({ op: "addNode", id: a, grown: true });
    const want: Record<string, unknown> = { ...row, levelA: LEVEL_BRIDGE, levelB: LEVEL_BRIDGE };
    delete want["level"];
    // Version 9 adds a build order. No segment 9 is live or held, so the
    // add cannot be undone and says 0, and it is not fresh.
    want["order"] = 0;
    // Version 10 adds a cell anchor. Segment 9 is gone, so its ends are not known.
    want["anchor"] = { ax: 0, az: 0, cx: 0, cz: 0, bx: 0, bz: 0, tA: 0, tB: 1 };
    expect(migrated.undo[0]?.ops[1]).toEqual({ op: "addSeg", id: 9, grown: true, fresh: false, row: want });
  });

  it("upgrades a version 6 state by giving each undo op the ends of the road it means", () => {
    const state = createState(9);
    const net = state.roads;
    const a = addNode(net, 1000, 1000, 10);
    const b = addNode(net, 1100, 1000, 10);
    const c = addNode(net, 1100, 1100, 10);
    // Segment `kept` was reversed twice and upgraded once. Segment `lost`
    // stood from b to c and was bulldozed, and so was node c after it.
    const kept = addSegment(net, a, b, { type: 1 });
    const lost = addSegment(net, b, c, { type: 0 });
    const lostRow = readSegment(net, lost);
    removeSegment(net, lost);
    removeNode(net, c);
    const undo6 = [
      { playerId: "p1", entry: 0, type: "UpgradeRoad", ops: [{ op: "restyle", id: kept, from: 2, to: 2, reverse: true }] },
      { playerId: "p2", entry: 1, type: "BulldozeRoad", ops: [{ op: "removeSeg", id: lost, row: lostRow, atA: 0, atB: 0 }, { op: "removeNode", id: c, x: 1100, z: 1100, height: 10, flags: 1 }] },
      { playerId: "p1", entry: 2, type: "UpgradeRoad", ops: [{ op: "restyle", id: kept, from: 2, to: 2, reverse: true }] },
      { playerId: "p1", entry: 3, type: "UpgradeRoad", ops: [{ op: "restyle", id: kept, from: 2, to: 1, reverse: false }] },
      // A restyle of an id that names no road any more.
      { playerId: "p3", entry: 4, type: "UpgradeRoad", ops: [{ op: "restyle", id: lost, from: 0, to: 1, reverse: false }] },
    ];
    const migrated = migrateState({ ...older(state, 6, "undo"), undo: undo6 });
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(migrated.roads).toEqual(net);
    const ops = migrated.undo.map((r) => r.ops[0]);
    // Walking back from the road as it is: a to b now, so b to a before the
    // newest reverse, and a to b before the oldest.
    expect(ops[3]).toMatchObject({ op: "restyle", a, b });
    expect(ops[2]).toMatchObject({ op: "restyle", a: b, b: a });
    expect(ops[0]).toMatchObject({ op: "restyle", a, b });
    // The removed segment's ends: b where it stands, c where its record says it stood.
    expect(ops[1]).toMatchObject({ op: "removeSeg", ax: 1100, az: 1000, bx: 1100, bz: 1100 });
    expect(migrated.undo[1]?.ops[1]).toEqual(undo6[1]?.ops[1]);
    // Ends no road has, so that undo is refused.
    expect(ops[4]).toMatchObject({ op: "restyle", a: 0, b: 0 });
  });

  it("upgrades a version 7 state by adding an empty balance stamp", () => {
    const state = createState(9);
    const migrated = migrateState(older(state, 7, "balance"));
    expect(migrated).toEqual({ ...asMigrated(state), balance: "" });
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
  });

  it("upgrades a version 9 state by giving every zonable road its cells, unzoned", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    expect(state.cells.zone.length).toBe(24 * 2 * 6);
    const migrated = migrateState(older(state, 9));
    expect(migrated).toEqual(asMigrated(state));
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
  });

  it("upgrades a version 10 state by adding the buildings, none of them", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const migrated = migrateState(older(state, 10));
    expect(migrated).toEqual(asMigrated(state));
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(migrated.buildings.flags).toHaveLength(0);
    expect(migrated.buildings.free).toHaveLength(0);
  });

  it("upgrades a version 11 state by giving every building an empty back lot", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    for (let i = 0; i < 3 * 100; i++) step(state);
    const b = state.buildings;
    expect(b.flags.length).toBeGreaterThan(0);
    // The version 11 shape: no back-lot arrays.
    const backKeys = ["backSeg", "backSide", "backPlace", "backDir", "backDepth"];
    const buildings11 = Object.fromEntries(Object.entries(b).filter(([key]) => !backKeys.includes(key)));
    const migrated = migrateState({ ...older(state, 11, "buildings"), buildings: buildings11 });
    expect(migrated).toEqual(asMigrated(state));
    expect(Object.keys(migrated.buildings)).toEqual(Object.keys(b));
    for (const key of backKeys) expect(Array.from(migrated.buildings[key as "backSeg"]).every((v) => v === 0), key).toBe(true);
    expect(hashState(migrated)).toBe(hashState(asMigrated(state)));
  });

  it("upgrades a version 12 state mid-day, and grows on as a city that never had a plan", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    const day = TIME_BALANCE.ticksPerDay;
    while (state.tick < 2 * day + 40) step(state);
    const migrated = migrateState(older(state, 12));
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect("growth" in migrated).toBe(false);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(hashState(migrated)).toBe(hashState(asMigrated(state)));
    // Its bars start again from 0 (version 20), and the pull from outside
    // brings them back above it within the day, so the street keeps growing.
    const count = () => Array.from(migrated.buildings.flags).filter(Boolean).length;
    const before = count();
    while (migrated.tick < 4 * day) step(migrated);
    expect(migrated.demand.residential.value).toBeGreaterThan(0);
    expect(count()).toBeGreaterThan(before);
  });

  it("upgrades a version 13 state by giving every undo record an empty list of zone journals", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    const send = (seq: number, type: string, payload: unknown) => {
      expect(submit(state, { seq, playerId: "p1", type, payload })).toEqual({ ok: true });
      step(state);
    };
    send(1, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
    send(2, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }] });
    const street = state.undo[0]?.ops.find((op) => op.op === "addSeg")?.id ?? -1;
    send(3, "BulldozeRoad", withEnds(state.roads, { segments: [street] }));
    expect(state.undo.map((r) => [r.type, r.zones.length > 0])).toEqual([["BuildRoad", false], ["ZoneCells", true], ["BulldozeRoad", true]]);
    const migrated = migrateState(older(state, 13));
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(migrated.undo.map((r) => [r.type, r.zones])).toEqual([["BuildRoad", new Int32Array(0)], ["BulldozeRoad", new Int32Array(0)]]);
    expect(checkUndoHistory(migrated.undo)).toBeNull();
    // The bulldozed street still comes back, unzoned, as a version 13 city had it.
    expect(submit(migrated, { seq: 4, playerId: "p1", type: "Undo", payload: {} })).toEqual({ ok: true });
    step(migrated);
    expect(migrated.cells.zone.length).toBeGreaterThan(0);
    expect(migrated.cells.zone.every((z) => z === 0)).toBe(true);
  });

  it("upgrades a version 18 state by adding no rebuild of the travel times under way, so they read at once", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const migrated = migrateState(older(state, 18));
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(migrated.travelReadyAt).toBe(0);
    expect(travelTimesReady(migrated)).toBe(true);
    expect(hashState(migrated)).toBe(hashState({ ...state, travelReadyAt: 0, demand: createDemand() }));
  });

  it("upgrades a version 19 city by adding the demand bars at 0, which take their first step on the next day's first tick", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    while (state.tick < 150) step(state);
    // The bars a city of this age has: the pull from outside, a day's share in.
    expect(state.demand.residential.value).toBeGreaterThan(0);
    const migrated = migrateState(older(state, 19));
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(migrated.demand).toEqual(createDemand());
    expect(hashState(migrated)).toBe(hashState({ ...state, demand: createDemand() }));
    while (migrated.tick <= 200) step(migrated);
    // On day 2 the migrated city takes its first step and the other its second.
    expect(migrated.demand.residential.value).toBeGreaterThan(0);
    expect(migrated.demand.residential.value).toBeLessThan(state.demand.residential.value + 1e-9);
  });

  it("upgrades a version 20 city by dropping the grower's plan, and grows on as one that never had it", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    while (state.tick < 250) step(state);
    const v20 = older(structuredClone(state), 20);
    v20["growth"] = { quota: 40, day: 2, deadline: 30, free: 48, used: 3 };
    const migrated = migrateState(v20);
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect("growth" in migrated).toBe(false);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(hashState(migrated)).toBe(hashState(state));
    // Whatever the plan said, the grower follows the bars from here.
    while (state.tick < 600) {
      step(state);
      step(migrated);
    }
    expect(hashState(migrated)).toBe(hashState(state));
  });

  it("upgrades a version 24 city with pops by giving them an empty queue of displaced pops, and changes nothing else", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    while (state.tick < 250) step(state);
    const homes: number[] = [];
    for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && (state.buildings.residents[id] ?? 0) > 0) homes.push(id);
    for (const home of homes) addPop(state, { home, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 60 });
    expect(popCount(state.pops)).toBeGreaterThan(0);
    const v24 = older(structuredClone(state), 24);
    expect("displaced" in (v24["pops"] as object)).toBe(false);
    const migrated = migrateState(v24);
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated.pops)).toEqual(Object.keys(state.pops));
    expect(migrated.pops.displaced).toEqual(new Int32Array(0));
    expect(hashState(migrated)).toBe(hashState(state));
    while (migrated.tick < 600) step(migrated);
    expect(migrated.stats.totals).toEqual(recountTotals(migrated));
  });

  it("upgrades a version 23 city with buildings by giving each the tick it was built as the tick it came into use, and changes nothing else", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    while (state.tick < 450) step(state);
    const built = Array.from(state.buildings.flags).filter((f) => f !== 0).length;
    expect(built).toBeGreaterThan(1);
    const v23 = older(structuredClone(state), 23);
    expect("statusSince" in (v23["buildings"] as object)).toBe(false);
    const migrated = migrateState(v23);
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated.buildings)).toEqual(Object.keys(state.buildings));
    expect(Array.from(migrated.buildings.statusSince)).toEqual(Array.from(migrated.buildings.builtAt));
    expect(Array.from(migrated.buildings.flags)).toEqual(Array.from(state.buildings.flags));
    // Nothing went vacant in the first days, so it is the city as it was.
    expect(hashState(migrated)).toBe(hashState(state));
    // And it steps on.
    while (migrated.tick < 900) step(migrated);
    expect(migrated.stats.totals).toEqual(recountTotals(migrated));
  });

  it("upgrades a version 22 city with pops by giving them no days low, no plan of departures, the summed satisfaction counted and the bar's part at 0", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    while (state.tick < 250) step(state);
    const homes: number[] = [];
    for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && (state.buildings.residents[id] ?? 0) > 0) homes.push(id);
    expect(homes.length).toBeGreaterThan(0);
    for (const [i, home] of homes.entries()) addPop(state, { home, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 10 + i, daysLow: 3 });
    const v22 = older(structuredClone(state), 22);
    expect("daysLow" in (v22["pops"] as object)).toBe(false);
    const migrated = migrateState(v22);
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(migrated.pops)).toEqual(Object.keys(state.pops));
    expect(Array.from(migrated.pops.daysLow).every((d) => d === 0)).toBe(true);
    expect(migrated.pops.leaveScore).toBe(-1);
    expect(migrated.pops.leaveAtScore).toBe(0);
    expect(migrated.stats.totals).toEqual(recountTotals(migrated));
    expect(migrated.stats.totals["residentSatisfaction"]).toBe(state.stats.totals["residentSatisfaction"]);
    expect(Object.keys(migrated.stats.totals)).toEqual(STAT_TOTALS);
    expect(Object.keys(migrated.stats.history)).toEqual(STAT_TOTALS);
    expect(migrated.stats.history["residentSatisfaction"]?.length).toBe(sampleCount(migrated.stats));
    expect(Object.keys(migrated.demand.residential.parts)).toEqual(Object.keys(state.demand.residential.parts));
    expect(migrated.demand.residential.parts["satisfaction"]).toBe(0);
    // Everything else is the city as it was.
    expect(hashState(withoutSatisfaction(migrated))).toBe(hashState(withoutSatisfaction(state)));
    // And it steps on.
    while (migrated.tick < 600) step(migrated);
    expect(migrated.stats.totals).toEqual(recountTotals(migrated));
  });

  it("upgrades a version 21 city by giving its pops a plan of arrivals at 0, and changes nothing else", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    while (state.tick < 150) step(state);
    const v21 = older(state, 21);
    expect("owed" in (v21["pops"] as object)).toBe(false);
    const migrated = migrateState(v21);
    expect(migrated.version).toBe(SNAPSHOT_VERSION);
    expect(migrated.pops.owed).toBe(0);
    expect(Object.keys(migrated.pops)).toEqual(Object.keys(state.pops));
    expect(hashState(migrated)).toBe(hashState(state));
  });

  it("upgrades a version 15 state by adding the pops, none of them, and changes nothing else", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    const v15 = older(state, 15);
    expect(v15).not.toHaveProperty("pops");
    const migrated = migrateState(v15);
    // The version 17 migration then adds a city centre, due on the tick it
    // was saved on, and the version 18 one statistics with no history yet.
    // The version 20 one adds the bars at 0.
    const expected = { ...state, centre: { x: 0, z: 0, weight: 0, due: state.tick }, stats: createStats(), demand: createDemand() };
    expect(migrated).toEqual(expected);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    expect(migrated.pops.flags).toHaveLength(0);
    expect(migrated.pops.free).toHaveLength(0);
    expect(migrated.pops.sweep).toBe(0);
    expect(hashState(migrated)).toBe(hashState(expected));
  });

  it("upgrades a version 16 state by adding a city centre, none yet, due on its tick", () => {
    const state = createState(9);
    state.tick = 1234;
    const v16 = older(state, 16);
    const migrated = migrateState(v16);
    const { growth, ...kept } = v16;
    void growth;
    expect(migrated).toEqual({ ...kept, version: SNAPSHOT_VERSION, buildings: state.buildings, pops: state.pops, centre: { x: 0, z: 0, weight: 0, due: 1234 }, stats: createStats(), travelReadyAt: 0, demand: createDemand(), redevelopedToday: 0 });
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
  });

  it("upgrades a version 17 city with buildings and pops by counting them, with the history empty until the next month", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    const send = (type: string, payload: unknown) => {
      expect(submit(state, { seq: state.log.length + 1, playerId: "p1", type, payload })).toEqual({ ok: true });
      step(state);
    };
    send("BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4600, z: 4600 }, type: "street" });
    state.speed = 0;
    // On the street's north side: houses from x 4200, shops from x 4300 and an office tower from x 4400.
    const zone = (zone: string, density: number, x0: number, x1: number) =>
      send("ZoneCells", { zone, density, rects: [{ from: { x: x0 + 2, z: 4571 }, to: { x: x1 - 2, z: 4571 }, width: 44 }] });
    zone("residential", 1, 4200, 4296);
    zone("commercial", 2, 4296, 4392);
    zone("office", 3, 4392, 4496);
    const built = growAll(state);
    expect(built.length).toBeGreaterThan(5);
    const homes = built.filter((id) => (state.buildings.residents[id] ?? 0) > 0);
    const work = built.find((id) => buildingJobs(state.buildings, id) >= 10) ?? -1;
    const size = (home: number) => Math.min(4, state.buildings.residents[home] ?? 0);
    for (const home of homes) addPop(state, { home, size: size(home), education: 2, wealth: 0, children: 1, satisfaction: 50 });
    const people = homes.reduce((n, home) => n + size(home), 0);
    const first = homes[0] ?? -1;
    setPopWork(state, popsAtHome(state, first)[0] ?? -1, work);
    state.tick = 31 * TIME_BALANCE.ticksPerDay + 7;
    const v17 = older(state, 17);
    expect(v17).not.toHaveProperty("stats");
    const migrated = migrateState(v17);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
    const totals = migrated.stats.totals;
    const t = (name: string) => totals[name] ?? 0;
    const count = (zone: number, density: number) => built.filter((id) => state.buildings.zone[id] === zone && state.buildings.density[id] === density).length;
    expect([count(1, 1), count(2, 2), count(3, 3)].every((n) => n > 0)).toBe(true);
    expect(t("buildingsR1")).toBe(count(1, 1));
    expect(t("buildingsC2")).toBe(count(2, 2));
    expect(t("buildingsO3")).toBe(count(3, 3));
    expect(t("buildingsR1") + t("buildingsC2") + t("buildingsO3")).toBe(built.length);
    expect(STAT_TOTALS.filter((name) => name.startsWith("buildings")).reduce((n, name) => n + t(name), 0)).toBe(built.length);
    expect(t("jobsCommercial") + t("jobsOffice")).toBe(built.reduce((n, id) => n + buildingJobs(state.buildings, id), 0));
    expect(t("population")).toBe(people);
    expect(t("pops")).toBe(homes.length);
    expect(t("popsWithChildren")).toBe(homes.length);
    expect(t("residentsEducationHigh")).toBe(people);
    expect(t("residentsWealthLow")).toBe(people);
    expect(t("workersEmployed")).toBeGreaterThan(0);
    expect(t("filledOffice") + t("filledCommercial")).toBe(jobsFilled(state, work));
    expect(totals).toEqual(recountTotals(state));
    expect(migrated.stats.highestPopulation).toBe(people);
    expect(migrated.stats.year).toEqual({ births: 0, deaths: 0, arrivals: 0, departures: 0 });
    expect(sampleCount(migrated.stats)).toBe(0);
    // Its first sample comes on the first tick of the next month, 1 March.
    migrated.speed = 1;
    const march = (31 + 28) * TIME_BALANCE.ticksPerDay;
    while (migrated.tick < march) step(migrated);
    expect(sampleCount(migrated.stats)).toBe(0);
    step(migrated);
    expect(sampleCount(migrated.stats)).toBe(1);
  });

  it("leaves a current state as it is", () => {
    const state = createBareState(5);
    expect(migrateState({ ...state })).toEqual(state);
  });

  it("refuses a newer version", () => {
    expect(() => migrateState({ version: SNAPSHOT_VERSION + 1 })).toThrow(/newer than this build/);
  });

  it("refuses a version that is not a positive integer", () => {
    for (const version of [0, 1.5, "1", undefined]) {
      expect(() => migrateState({ version })).toThrow(/unknown snapshot version/);
    }
  });
});
