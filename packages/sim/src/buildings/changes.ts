// Which buildings changed since a host last looked (M2-09). Not state: it
// lives in a WeakMap keyed by the buildings object, like the road and cell
// change lists, so it is left out of the hash and the save, and a city
// behaves the same whether or not anyone reads it. Recording starts the
// first time a host asks for it.

import type { BuildingState } from "./buildings";

interface Recorder {
  ids: Set<number>;
  /** The free list as of the last drain. A new array means it changed. */
  free: Int32Array;
}

const recorders = new WeakMap<BuildingState, Recorder>();

/** Starts recording changes to `b`, if nothing is yet. */
export function recordBuildingChangesOf(b: BuildingState): void {
  if (!recorders.has(b)) recorders.set(b, { ids: new Set(), free: b.free });
}

/** Notes that building `id` was added or removed. */
export function noteBuildingChanged(b: BuildingState, id: number): void {
  recorders.get(b)?.ids.add(id);
}

/** The ids that changed since the last drain, ascending, and whether the free list did. Null if none or nothing is recording. */
export function drainBuildingChanges(b: BuildingState): { ids: number[]; free: boolean } | null {
  const rec = recorders.get(b);
  if (!rec) return null;
  const free = rec.free !== b.free;
  if (rec.ids.size === 0 && !free) return null;
  const ids = [...rec.ids].sort((p, q) => p - q);
  rec.ids.clear();
  rec.free = b.free;
  return { ids, free };
}
