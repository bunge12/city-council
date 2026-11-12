import { describe, expect, it } from "vitest";
import { SNAPSHOT_VERSION, createState, hashState, migrateState } from "../src/index";
import { createRoadNetwork } from "../src/roads/network";

describe("migrateState", () => {
  it("upgrades a version 1 state by adding an empty activity log and an empty road network", () => {
    const v1 = {
      version: 1,
      tick: 42,
      seed: 5,
      rng: createState(5).rng,
      speed: 2,
      pending: [],
    };
    const state = migrateState(v1);
    expect(SNAPSHOT_VERSION).toBe(3);
    expect(state).toEqual({ ...v1, version: 3, log: [], logOffset: 0, roads: createRoadNetwork() });
    expect(() => hashState(state)).not.toThrow();
  });

  it("upgrades a version 2 state by adding an empty road network", () => {
    const { roads, ...rest } = createState(9);
    const v2 = { ...rest, version: 2 };
    const state = migrateState(v2);
    expect(state).toEqual({ ...v2, version: 3, roads });
    expect(state.roads.nodeFlags.length).toBe(0);
    expect(state.roads.segFlags.length).toBe(0);
    expect(() => hashState(state)).not.toThrow();
  });

  it("leaves a current state as it is", () => {
    const state = createState(5);
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
