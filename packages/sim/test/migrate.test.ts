import { describe, expect, it } from "vitest";
import { SNAPSHOT_VERSION, connectionEnd, createBareState, createState, hashState, migrateState, step, submit, type SimState } from "../src/index";
import { checkConnections, chooseConnectionSites } from "../src/roads/connections";
import { LEVEL_BRIDGE, addNode, addSegment, createRoadNetwork, isNode, readSegment, removeNode, removeSegment, segmentCount } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";

/**
 * `state` as an older version: its fields minus the ones that version did
 * not have. Every version before 10 also lacks the zoning cells.
 */
function older(state: SimState, version: number, ...drop: (keyof SimState)[]): { version: number } & Record<string, unknown> {
  const gone: string[] = version < 10 ? [...drop, "cells"] : drop;
  const kept = Object.entries(state).filter(([key]) => !gone.includes(key));
  return { ...Object.fromEntries(kept), version };
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
    expect(SNAPSHOT_VERSION).toBe(10);
    const fresh = createState(5);
    expect(state).toEqual({
      ...v1,
      version: 10,
      log: [],
      logOffset: 0,
      roads: fresh.roads,
      undo: [],
      connections: fresh.connections,
      balance: "",
      cells: fresh.cells,
    });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 2 state by adding a road network with only the outside connections", () => {
    const v2 = older(createBareState(9), 2, "roads", "undo", "connections", "balance");
    const state = migrateState(v2);
    const fresh = createState(9);
    expect(state).toEqual({ ...v2, version: 10, roads: fresh.roads, undo: [], connections: fresh.connections, balance: "", cells: fresh.cells });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 3 state by adding an empty undo history", () => {
    const state = migrateState(older(createBareState(9), 3, "undo", "connections", "balance"));
    expect(state.undo).toEqual([]);
    expect(state.version).toBe(10);
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 4 state by adding the connections a new city of its seed gets", () => {
    const state = migrateState(older(createBareState(9), 4, "connections", "balance"));
    // All but the balance stamp, which an old save does not have.
    expect(hashState(state)).toBe(hashState({ ...createState(9), balance: "" }));
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
    expect(migrated.version).toBe(10);
    expect(Object.keys(migrated.roads)).toEqual(Object.keys(createRoadNetwork()));
    expect(migrated.roads).toEqual(net);
    expect(migrated.undo[0]?.ops[0]).toEqual({ op: "addNode", id: a, grown: true });
    const want: Record<string, unknown> = { ...row, levelA: LEVEL_BRIDGE, levelB: LEVEL_BRIDGE };
    delete want["level"];
    // Version 9 adds a build order. No segment 9 is live or held, so the
    // add cannot be undone and says 0, and it is not fresh.
    want["order"] = 0;
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
    expect(migrated.version).toBe(10);
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
    expect(migrated).toEqual({ ...state, balance: "" });
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
  });

  it("upgrades a version 9 state by giving every zonable road its cells, unzoned", () => {
    const state = createState(SEED_WITH_FLAT_GROUND);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    expect(state.cells.zone.length).toBe(24 * 2 * 6);
    const migrated = migrateState(older(state, 9));
    expect(migrated).toEqual(state);
    expect(Object.keys(migrated)).toEqual(Object.keys(state));
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
