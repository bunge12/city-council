// Which workplaces' open jobs may have changed since job matching last
// looked (M3-09, openings.ts). Not state: it lives in a WeakMap keyed by the
// pops object, like the pop change list (changes.ts), so it is left out of
// the hash and the save, and a city behaves the same whether or not anyone
// reads it. Noting starts the first time the openings are built for those
// pops, so a city that never matches pays nothing.
//
// where.ts notes a building each time a pop joins or leaves its workers,
// and buildings.ts each time a building comes or goes.

import type { PopState } from "./pops";

const notes = new WeakMap<PopState, Set<number>>();

/** Starts noting changes to `p`'s workplaces from now on, dropping any noted before. */
export function watchOpenings(p: PopState): void {
  notes.set(p, new Set());
}

/** The buildings noted since the last call, in no set order, or null for none. */
export function takeOpeningNotes(p: PopState): Set<number> | null {
  const set = notes.get(p);
  if (!set || set.size === 0) return null;
  // A new set rather than clear(), as for the pop changes (issue #209).
  notes.set(p, new Set());
  return set;
}

/** Notes that building `id`'s jobs or jobs filled may have changed. */
export function noteOpening(p: PopState, id: number): void {
  notes.get(p)?.add(id);
}

/** Drops the note on building `id`, for a reader that has just caught up with it itself. */
export function dropOpeningNote(p: PopState, id: number): void {
  notes.get(p)?.delete(id);
}
