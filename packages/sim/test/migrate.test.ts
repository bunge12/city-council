import { describe, expect, it } from "vitest";
import { SNAPSHOT_VERSION, connectionEnd, createBareState, createState, hashState, migrateState, type SimState } from "../src/index";
import { checkConnections, chooseConnectionSites } from "../src/roads/connections";
import { addNode, addSegment, createRoadNetwork, isNode, segmentCount } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";

/** `state` as an older version: its fields minus the ones that version did not have. */
function older(state: SimState, version: number, ...drop: (keyof SimState)[]): { version: number } & Record<string, unknown> {
  const kept = Object.entries(state).filter(([key]) => !(drop as string[]).includes(key));
  return { ...Object.fromEntries(kept), version };
}

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
    expect(SNAPSHOT_VERSION).toBe(5);
    const fresh = createState(5);
    expect(state).toEqual({ ...v1, version: 5, log: [], logOffset: 0, roads: fresh.roads, undo: [], connections: fresh.connections });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 2 state by adding a road network with only the outside connections", () => {
    const v2 = older(createBareState(9), 2, "roads", "undo", "connections");
    const state = migrateState(v2);
    const fresh = createState(9);
    expect(state).toEqual({ ...v2, version: 5, roads: fresh.roads, undo: [], connections: fresh.connections });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 3 state by adding an empty undo history", () => {
    const state = migrateState(older(createBareState(9), 3, "undo", "connections"));
    expect(state.undo).toEqual([]);
    expect(state.version).toBe(5);
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 4 state by adding the connections a new city of its seed gets", () => {
    const state = migrateState(older(createBareState(9), 4, "connections"));
    expect(hashState(state)).toBe(hashState(createState(9)));
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
    const state = migrateState(older(v4, 4, "connections"));
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
