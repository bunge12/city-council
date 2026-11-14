// Building deltas (M2-09): the buildings that came or went since a host last
// looked, as whole rows a client copies into its own read-only copy, like
// road rows (roads/delta.ts). A removed id arrives as a row of zeros. Rows
// are read when the delta is built, so a building added and removed between
// two deltas goes out once, as what its id holds now.

import { resized, type AnyTypedArray } from "../roads/network";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { BUILDING_TYPES } from "./balance";
import { BUILDING_ALIVE, BUILDING_ARRAYS, type BuildingKey, type BuildingState } from "./buildings";
import { drainBuildingChanges, recordBuildingChangesOf } from "./changes";
import { NO_BUILDING, filedChunk, fileBuilding, hasBuildingIndex, unfileBuilding } from "./where";

/** The rows of the buildings that changed. Plain fields and typed arrays only. */
export interface BuildingDelta {
  /** `buildingIdLimit` after the change. */
  limit: number;
  /** Changed ids, ascending. Row `i` of each array is building `ids[i]`. */
  ids: Int32Array;
  rows: Pick<BuildingState, BuildingKey>;
  /** The whole free list, when it changed. */
  free?: Int32Array;
}

/**
 * Starts recording changes to `state`'s buildings, if nothing is yet.
 * Changes made before this call are in no later delta; a host sends a
 * snapshot for those.
 */
export function recordBuildingChanges(state: SimState): void {
  recordBuildingChangesOf(state.buildings);
}

/** The buildings of `state` that changed since the last call, read as they are now. Null if none or nothing is recording. */
export function drainBuildingDelta(state: SimState): BuildingDelta | null {
  const b = state.buildings;
  const changes = drainBuildingChanges(b);
  if (!changes) return null;
  const ids = Int32Array.from(changes.ids);
  const rows = {} as Record<BuildingKey, AnyTypedArray>;
  for (const key of BUILDING_ARRAYS) {
    const source = b[key] as AnyTypedArray;
    const Type = source.constructor as new (n: number) => AnyTypedArray;
    const out = new Type(ids.length);
    for (let i = 0; i < ids.length; i++) out[i] = source[ids[i] ?? 0] ?? 0;
    rows[key] = out;
  }
  const delta: BuildingDelta = { limit: b.flags.length, ids, rows: rows as unknown as Pick<BuildingState, BuildingKey> };
  if (changes.free) delta.free = b.free.slice();
  return delta;
}

/** Why `delta` cannot apply to `b`, or null if it can. */
function deltaProblem(b: BuildingState, delta: BuildingDelta): string | null {
  const { limit, ids, rows } = delta;
  if (!Number.isSafeInteger(limit) || limit < 0) return "the id limit is not a whole number";
  if (!ids.every((id, i) => id >= 0 && id < Math.max(limit, b.flags.length) && (i === 0 || id > (ids[i - 1] ?? 0)))) return "building ids are out of range or order";
  if (BUILDING_ARRAYS.some((key) => !rows[key] || rows[key].length !== ids.length)) return "building rows differ in length";
  // Every id past the old limit was handed out since, so it has a row.
  const listed = new Set(ids);
  for (let id = b.flags.length; id < limit; id++) if (!listed.has(id)) return "new building ids have no rows";
  for (let i = 0; i < ids.length; i++) {
    if ((rows.flags[i] ?? 0) === 0) continue;
    const type = BUILDING_TYPES[rows.type[i] ?? 0];
    if ((rows.flags[i] ?? 0) !== BUILDING_ALIVE || !type) return `building ${ids[i]} has an unknown type`;
    if ((rows.zone[i] ?? 0) > ZONING_BALANCE.zones.length) return `building ${ids[i]} has an unknown zone`;
  }
  if (delta.free && !delta.free.every((id) => id >= 0 && id < limit)) return "the free list names ids past the limit";
  return null;
}

/**
 * Copies a delta's rows into `state`, a client's copy of the city, after
 * the roads and cells of the same delta. Returns the 500 m chunks a
 * changed building was or is in, ascending, once something has asked the
 * copy about buildings; none before, since nothing drawn can be out of date.
 * Returns a reason instead, changing nothing, if the delta cannot belong to
 * this copy; the client then asks for a snapshot.
 */
export function applyBuildingDelta(state: SimState, delta: BuildingDelta): number[] | string {
  const b = state.buildings;
  const problem = deltaProblem(b, delta);
  if (problem) return problem;
  const tracked = hasBuildingIndex(state);
  const chunks = new Set<number>();
  const note = (id: number) => {
    const chunk = filedChunk(state, id);
    if (chunk !== NO_BUILDING) chunks.add(chunk);
  };
  if (tracked) {
    for (const id of delta.ids) {
      note(id);
      unfileBuilding(state, id);
    }
  }
  const arrays = b as unknown as Record<BuildingKey, AnyTypedArray>;
  for (const key of BUILDING_ARRAYS) {
    const target = resized(arrays[key], Math.max(delta.limit, arrays[key].length));
    const source = delta.rows[key] as AnyTypedArray;
    for (let i = 0; i < delta.ids.length; i++) target[delta.ids[i] ?? 0] = source[i] ?? 0;
    arrays[key] = resized(target, delta.limit);
  }
  if (delta.free) b.free = delta.free.slice();
  if (tracked && hasBuildingIndex(state)) {
    for (const id of delta.ids) {
      if (id >= delta.limit || ((b.flags[id] ?? 0) & BUILDING_ALIVE) === 0) continue;
      fileBuilding(state, id);
      note(id);
    }
  }
  return [...chunks].sort((p, q) => p - q);
}
