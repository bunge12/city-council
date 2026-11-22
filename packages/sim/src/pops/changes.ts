// Which buildings' people or jobs filled a step touched (M3-05). Not state:
// it lives in a WeakMap keyed by the pops object, like the building change
// list (buildings/changes.ts), so it is left out of the hash and the save,
// and a city behaves the same whether or not anyone reads it. Recording
// starts the first time a host asks for it.
//
// where.ts notes a building each time it adds to or takes from its people
// or its jobs filled. A pop that leaves a home another then moves into
// touches the home twice and leaves its numbers where they were, so the
// recorder keeps the numbers it last handed out and a drain gives only the
// buildings whose numbers differ from them.

import type { PopState } from "./pops";

interface Recorder {
  /** Buildings touched since the last drain. */
  ids: Set<number>;
  /** By building: the people and jobs filled as of the last drain, or of when recording started. */
  people: Int32Array;
  filled: Int32Array;
}

const recorders = new WeakMap<PopState, Recorder>();

/** Starts recording changes to `p`, if nothing is yet, from the numbers `people` and `filled` hold now. */
export function recordPopChangesOf(p: PopState, people: Int32Array, filled: Int32Array): void {
  if (!recorders.has(p)) recorders.set(p, { ids: new Set(), people: people.slice(), filled: filled.slice() });
}

/** Notes that building `id`'s people or jobs filled may have changed. */
export function notePopBuilding(p: PopState, id: number): void {
  recorders.get(p)?.ids.add(id);
}

/** The buildings whose people or jobs filled differ from the last drain, ascending, with the numbers they have now. */
export interface PopChanges {
  ids: number[];
  people: number[];
  filled: number[];
}

function grownTo(array: Int32Array, length: number): Int32Array {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2, 64));
  next.set(array);
  return next;
}

/**
 * The buildings touched since the last drain whose numbers differ from it,
 * read from `people` and `filled` as they are now. Null if none or nothing
 * is recording.
 */
export function drainPopChanges(p: PopState, people: Int32Array, filled: Int32Array): PopChanges | null {
  const rec = recorders.get(p);
  if (!rec || rec.ids.size === 0) return null;
  const touched = [...rec.ids].sort((a, b) => a - b);
  // A new set rather than clear(), as for the buildings (issue #209).
  rec.ids = new Set();
  const out: PopChanges = { ids: [], people: [], filled: [] };
  for (const id of touched) {
    rec.people = grownTo(rec.people, id + 1);
    rec.filled = grownTo(rec.filled, id + 1);
    const nowPeople = people[id] ?? 0;
    const nowFilled = filled[id] ?? 0;
    if (nowPeople === rec.people[id] && nowFilled === rec.filled[id]) continue;
    rec.people[id] = nowPeople;
    rec.filled[id] = nowFilled;
    out.ids.push(id);
    out.people.push(nowPeople);
    out.filled.push(nowFilled);
  }
  return out.ids.length > 0 ? out : null;
}
