// People in the protocol (M3-05). A delta carries, for each building whose
// people or jobs filled changed since the last one, both numbers as they
// stand when the delta is built, like road and building rows. Pop rows do
// not travel in deltas: turnover changes thousands a game day and nothing
// on screen draws a single pop before M5. A client's copy of the pop table
// is the one its last snapshot carried, and is not to be read. What it
// reads instead is an `Occupancy`, counted from the snapshot's pops and
// moved by each delta.

import { buildingIdLimit } from "../buildings/buildings";
import type { SimState } from "../state";
import { drainPopChanges, recordPopChangesOf } from "./changes";
import { NO_WORK, POP_ALIVE, workersFor } from "./pops";
import { popIndexOf } from "./where";

/** The buildings whose numbers changed. Plain typed arrays (CLAUDE.md rule 7). */
export interface PopDelta {
  /** Building ids, ascending. Entry `i` of the other arrays is building `ids[i]`. */
  ids: Int32Array;
  /** The people living in each, as `buildingPeople` gives them. */
  people: Int32Array;
  /** The jobs filled at each, as `jobsFilled` gives them. */
  filled: Int32Array;
}

/** By building id: the people living there and its jobs filled. A client's copy of what the pop index holds. */
export interface Occupancy {
  people: Int32Array;
  filled: Int32Array;
}

/**
 * Starts recording which buildings' numbers change in `state`, if nothing
 * is yet. Changes made before this call are in no later delta; a host
 * sends a snapshot for those.
 */
export function recordPopChanges(state: SimState): void {
  const index = popIndexOf(state);
  recordPopChangesOf(state.pops, index.people, index.filled);
}

/** The buildings of `state` whose people or jobs filled changed since the last call, read as they are now. Null if none or nothing is recording. */
export function drainPopDelta(state: SimState): PopDelta | null {
  const index = popIndexOf(state);
  const changes = drainPopChanges(state.pops, index.people, index.filled);
  if (!changes) return null;
  return { ids: Int32Array.from(changes.ids), people: Int32Array.from(changes.people), filled: Int32Array.from(changes.filled) };
}

/**
 * Every building's people and jobs filled, counted from `state`'s pop rows
 * without the pop index, one entry per building id. For a client's copy,
 * from the snapshot it was just given.
 */
export function countOccupancy(state: Pick<SimState, "pops" | "buildings">): Occupancy {
  const limit = buildingIdLimit(state.buildings);
  const people = new Int32Array(limit);
  const filled = new Int32Array(limit);
  const p = state.pops;
  for (let id = 0; id < p.flags.length; id++) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    const home = p.home[id] ?? 0;
    if (home < limit) people[home] = (people[home] ?? 0) + (p.size[id] ?? 0);
    const work = p.work[id] ?? NO_WORK;
    if (work !== NO_WORK && work < limit) filled[work] = (filled[work] ?? 0) + workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
  }
  return { people, filled };
}

/** Why `delta` is malformed, or null if it is not. Changes nothing. */
export function popDeltaProblem(delta: PopDelta): string | null {
  const { ids, people, filled } = delta;
  if (!(ids instanceof Int32Array) || !(people instanceof Int32Array) || !(filled instanceof Int32Array)) return "the people delta is not three Int32Arrays";
  if (people.length !== ids.length || filled.length !== ids.length) return "the people delta's arrays differ in length";
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] ?? 0;
    if (id < 0 || (i > 0 && id <= (ids[i - 1] ?? 0))) return "the people delta's building ids are out of range or order";
    if ((people[i] ?? 0) < 0 || (filled[i] ?? 0) < 0) return `building ${id} has fewer than no people or jobs filled`;
  }
  return null;
}

function fitted(array: Int32Array, length: number): Int32Array {
  if (array.length >= length) return array;
  const next = new Int32Array(length);
  next.set(array);
  return next;
}

/**
 * `occupancy` with `delta`'s numbers written in, its arrays grown to hold
 * every id it names and at least `buildings` ids. Changes `occupancy`'s
 * arrays in place where they are long enough. Returns a reason instead,
 * changing nothing, if the delta is malformed.
 */
export function applyPopDelta(occupancy: Occupancy, delta: PopDelta, buildings = 0): Occupancy | string {
  const problem = popDeltaProblem(delta);
  if (problem) return problem;
  const length = Math.max(buildings, (delta.ids[delta.ids.length - 1] ?? -1) + 1);
  const people = fitted(occupancy.people, length);
  const filled = fitted(occupancy.filled, length);
  for (let i = 0; i < delta.ids.length; i++) {
    const id = delta.ids[i] ?? 0;
    people[id] = delta.people[i] ?? 0;
    filled[id] = delta.filled[i] ?? 0;
  }
  return { people, filled };
}
