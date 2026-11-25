import { describe, expect, it } from "vitest";
import { deserialize, hashState, prepareDerived, serialize, step, submit, type SimState } from "../src/index";
import { NODE_ARRAYS, SEG_ARRAYS, capacityOf, type AnyTypedArray } from "../src/roads/network";
import { syncCells } from "../src/zoning/cell-index";
import jobs from "./fixtures/replay/jobs.json" with { type: "json" };
import { replayFixture, type ReplayFixture } from "./replay-helper";

// A city loaded from a save holds every array at exactly its length, and the
// cell index has no spare buffers yet. The first road built after the load
// used to copy every road array into a bigger one and allocate new zone,
// density and offset arrays for every cell, all inside the step that applied
// it: about 3 ms of the 7 ms that step's command took on the scale cities
// (issue #364). `prepareDerived` makes that room at load now.

/** A street across the fixture's street, through its zoned blocks. */
const CROSSING = { from: { x: 300, z: 3500 }, to: { x: 300, z: 3720 }, type: "street" };

function arrays(state: SimState): AnyTypedArray[] {
  const net = state.roads as unknown as Record<string, AnyTypedArray>;
  return [...NODE_ARRAYS, ...SEG_ARRAYS].map((key) => net[key] as AnyTypedArray);
}

function buildCrossing(state: SimState): void {
  const result = submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: CROSSING });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  step(state);
}

describe("a loaded city's room for its first road (#364)", () => {
  const bytes = serialize(replayFixture(jobs as ReplayFixture));

  it("leaves the city's values, its save and its hash as they were", () => {
    const prepared = deserialize(bytes).state;
    const plain = deserialize(bytes).state;
    prepareDerived(prepared);
    expect(serialize(prepared)).toEqual(bytes);
    expect(hashState(prepared)).toBe(hashState(plain));
    for (const [i, array] of arrays(prepared).entries()) expect(Array.from(array)).toEqual(Array.from(arrays(plain)[i] ?? []));
  });

  it("gives every road array room for a new id, and the cells a spare to lay out into", () => {
    const state = deserialize(bytes).state;
    for (const array of arrays(state)) expect(capacityOf(array)).toBe(array.length);
    prepareDerived(state);
    for (const array of arrays(state)) expect(capacityOf(array)).toBeGreaterThan(array.length);
    const spare = syncCells(state).spare;
    expect(spare).not.toBeNull();
    expect(spare?.zone.buffer.byteLength).toBeGreaterThan(state.cells.zone.length);
    expect(spare?.density.buffer.byteLength).toBeGreaterThan(state.cells.density.length);
    expect(spare?.offset.buffer.byteLength).toBeGreaterThan(state.cells.offset.byteLength);
  });

  it("copies no road array and allocates no cell array for the first road after the load", () => {
    const state = deserialize(bytes).state;
    prepareDerived(state);
    const before = arrays(state).map((array) => array.buffer);
    const spare = syncCells(state).spare;
    buildCrossing(state);
    expect(arrays(state).map((array) => array.buffer)).toEqual(before);
    // The layout went into the spare made at load.
    expect(state.cells.zone.buffer).toBe(spare?.zone.buffer);
    expect(state.cells.density.buffer).toBe(spare?.density.buffer);
    expect(state.cells.offset.buffer).toBe(spare?.offset.buffer);
  });

  it("builds the same city as a load that made no room", () => {
    const prepared = deserialize(bytes).state;
    const plain = deserialize(bytes).state;
    prepareDerived(prepared);
    buildCrossing(prepared);
    buildCrossing(plain);
    for (let k = 0; k < 50; k++) {
      step(prepared);
      step(plain);
    }
    expect(hashState(prepared)).toBe(hashState(plain));
    expect(serialize(prepared)).toEqual(serialize(plain));
  });
});
