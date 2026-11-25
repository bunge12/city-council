import { describe, expect, it } from "vitest";
import { deserialize, hashState, homesWithRoom, prepareDerived, serialize, step, type SimState } from "../src/index";
import { BUILDING_ARRAYS, buildingIdLimit } from "../src/buildings/buildings";
import { lotCentres } from "../src/buildings/where";
import { POP_ARRAYS, popIdLimit } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { capacityOf, type AnyTypedArray } from "../src/roads/network";
import growth from "./fixtures/replay/growth.json" with { type: "json" };
import jobs from "./fixtures/replay/jobs.json" with { type: "json" };
import redevelopment from "./fixtures/replay/redevelopment.json" with { type: "json" };
import { holdDemand } from "./demand-helper";
import { replayFixture, type ReplayFixture } from "./replay-helper";

// A city loaded from a save holds every building and pop array at exactly
// its length, its pop index is built to fit, and it keeps no land values.
// The first newcomer after the load copied every pop array into a bigger one
// and grew the index's lists by pop, the first building grew its lists by
// building in the next tick's arrivals, and the first tick people were due
// worked out the value of every home with room, all inside the arrivals'
// 4 ms share: up to 3.8 ms on the scale cities, where the ticks after took
// under 1 (issue #372). `prepareDerived` does that work at load now.

function popArrays(state: SimState): AnyTypedArray[] {
  const p = state.pops as unknown as Record<string, AnyTypedArray>;
  return POP_ARRAYS.map((key) => p[key] as AnyTypedArray);
}

function buildingArrays(state: SimState): AnyTypedArray[] {
  const b = state.buildings as unknown as Record<string, AnyTypedArray>;
  return BUILDING_ARRAYS.map((key) => b[key] as AnyTypedArray);
}

/** The pop index's lists by pop, then by building. */
function indexLists(state: SimState): { byPop: Int32Array[]; byBuilding: Int32Array[] } {
  const i = popIndexOf(state);
  return { byPop: [i.homeNext, i.homePrev, i.workNext, i.workPrev], byBuilding: [i.homeHead, i.homeTail, i.workHead, i.workTail, i.people, i.filled, i.filledByEducation] };
}

/** Steps `state` until `limit` hands out an id past the load's last, and returns the arrays and lists as they were on the step before. */
function stepToFirstNewId(state: SimState, limit: (state: SimState) => number, arrays: (state: SimState) => AnyTypedArray[]) {
  const atLoad = limit(state);
  for (let k = 0; k < 3_000; k++) {
    const before = arrays(state).map((array) => array.buffer);
    const lists = indexLists(state);
    step(state);
    if (limit(state) > atLoad) return { before, lists };
  }
  throw new Error("no new id was handed out in 3,000 ticks");
}

describe("a loaded city's room for its first building and newcomer (#372)", () => {
  const jobsBytes = serialize(replayFixture(jobs as ReplayFixture));
  const redevelopmentBytes = serialize(replayFixture(redevelopment as ReplayFixture));
  const growthBytes = serialize(replayFixture(growth as ReplayFixture));

  it("gives every building and pop array room for a new id, and the pop index lists as long", () => {
    const state = deserialize(jobsBytes).state;
    expect(state.pops.free.length).toBe(0);
    expect(state.buildings.free.length).toBe(0);
    for (const array of [...buildingArrays(state), ...popArrays(state)]) expect(capacityOf(array)).toBe(array.length);
    prepareDerived(state);
    for (const array of [...buildingArrays(state), ...popArrays(state)]) expect(capacityOf(array)).toBeGreaterThan(array.length);
    const { byPop, byBuilding } = indexLists(state);
    for (const list of byPop) expect(list.length).toBeGreaterThanOrEqual(capacityOf(state.pops.flags));
    for (const list of byBuilding.slice(0, -1)) expect(list.length).toBeGreaterThanOrEqual(capacityOf(state.buildings.flags));
  });

  it("copies no pop array and grows no pop list for the first newcomer on a new id after the load", () => {
    const state = deserialize(jobsBytes).state;
    prepareDerived(state);
    const { before, lists } = stepToFirstNewId(state, (s) => popIdLimit(s.pops), popArrays);
    for (const [i, array] of popArrays(state).entries()) expect(array.buffer).toBe(before[i]);
    for (const [i, list] of indexLists(state).byPop.entries()) expect(list).toBe(lists.byPop[i]);
  });

  it("copies no building array and grows no pop list for the first building on a new id after the load", () => {
    const state = deserialize(growthBytes).state;
    expect(state.buildings.free.length).toBe(0);
    prepareDerived(state);
    // Every bar held full, so the grower builds within a few ticks.
    const bars = { residential: 100, commercial: 100, office: 100, industrial: 100 };
    const { before, lists } = holdDemand(bars, () => stepToFirstNewId(state, (s) => buildingIdLimit(s.buildings), buildingArrays));
    for (const [i, array] of buildingArrays(state).entries()) expect(array.buffer).toBe(before[i]);
    // The index grows on its next read: the arrivals', on the tick after.
    holdDemand(bars, () => step(state));
    for (const [i, list] of indexLists(state).byBuilding.entries()) expect(list).toBe(lists.byBuilding[i]);
  });

  it("works out the land value of every home with room at load", () => {
    const state = deserialize(redevelopmentBytes).state;
    prepareDerived(state);
    const homes = homesWithRoom(state);
    expect(homes.length).toBeGreaterThan(0);
    const { value, valueEpoch, valueChunk, chunkEpoch } = lotCentres(state);
    for (const home of homes) {
      expect(value[home]).toBeGreaterThanOrEqual(0);
      expect(valueEpoch[home]).toBe(chunkEpoch[valueChunk[home] as number]);
    }
  });

  for (const [name, bytes] of [
    ["jobs", jobsBytes],
    ["redevelopment", redevelopmentBytes],
  ] as const) {
    it(`leaves the ${name} city's save and hash as they were, and runs it as a load that made no room`, () => {
      const prepared = deserialize(bytes).state;
      const plain = deserialize(bytes).state;
      prepareDerived(prepared);
      expect(serialize(prepared)).toEqual(bytes);
      expect(hashState(prepared)).toBe(hashState(plain));
      for (let k = 0; k < 300; k++) {
        step(prepared);
        step(plain);
      }
      expect(popIdLimit(prepared.pops)).toBeGreaterThan(0);
      expect(hashState(prepared)).toBe(hashState(plain));
      expect(serialize(prepared)).toEqual(serialize(plain));
    });
  }
});
