// Lot marks for the zoning overlay (M2-15, PRD "Lot marks"): the free zoned
// ground where no building type fits, and why.
//
// A lot always starts at the road and runs back from it, so any lot holding
// a cell also holds the front cell of its column. If no type fits at the
// front cell, none fits anywhere in the free ground behind it either. So
// the finder is asked once per column, at its front cell, and the answer
// stands for the free run behind it.
//
// Only ground that could hold a building if it were bigger is marked: a
// strip too shallow or too narrow for the smallest type of its zone and
// density, and a zone and density no type grows on. The back rows of a C1
// strip six deep, which no C1 type reaches, and the ground behind a
// building, a road or ground of another zone are not marked: a lot by the
// road takes the front of a column, and marking the rest would cover most
// of every zoned street.
//
// Read only, like the lot finder, so the client runs it on its copy.

import type { SimState } from "../state";
import { CELL_OPEN, cellsInChunk, type CellInfo } from "../zoning/cell-index";
import { ZONE_NONE, cellSlot, type CellRef } from "../zoning/cells";
import { BUILDING_TYPES } from "./balance";
import { findLot, type LotResult } from "./lots";

/** Whether a finder's answer at a front cell is one the overlay marks. */
function marks(result: LotResult): result is Extract<LotResult, { ok: false }> {
  return !result.ok && (result.problem === "too-shallow" || result.problem === "too-narrow" || result.problem === "no-types");
}

/**
 * Why no building type fits on the free ground at `ref`, as the overlay
 * marks it, or null when the cell is not marked: a type fits, or the cell
 * is not free, or it is free ground no type reaches but a lot by the road
 * could still take the front of. The reason is the lot finder's at the
 * front cell of the cell's column.
 */
export function lotMarkAt(state: SimState, ref: CellRef): string | null {
  const slot = cellSlot(state.roads, state.cells, ref);
  return slot < 0 ? null : markWith(state, ref, slot, new Map());
}

/** Zone and density pairs, as `zone * 16 + density`, that some building type grows on. */
const GROWS = new Set(BUILDING_TYPES.map((t) => t.zoneNumber * 16 + t.density));

function markWith(state: SimState, ref: CellRef, slot: number, fronts: Map<number, LotResult>): string | null {
  const zone = state.cells.zone[slot] ?? ZONE_NONE;
  if (ref.depth > 0 && zone !== ZONE_NONE && !GROWS.has(zone * 16 + (state.cells.density[slot] ?? 0))) {
    // Nothing grows on it: marked wherever it is free, whatever lies in front of it.
    const own = findLot(state, ref);
    return !own.ok && own.problem === "no-types" ? own.reason : null;
  }
  // One entry a column: segment, side and place, as the cell index keys them less the depth.
  const key = (ref.segment * 2 + ref.side) * 1_000_000 + ref.place;
  let front = fronts.get(key);
  if (!front) {
    front = findLot(state, { segment: ref.segment, side: ref.side, place: ref.place, depth: 0 });
    fronts.set(key, front);
  }
  if (!marks(front)) return null;
  if (ref.depth === 0) return front.reason;
  // Behind the front cell, only the free run of the front cell's zone and density.
  return front.problem !== "no-types" && ref.depth < (front.room?.depth ?? 0) ? front.reason : null;
}

/**
 * For each cell of chunk `chunk`, in `cellsInChunk` order, 1 where the
 * overlay marks it as `lotMarkAt` says and 0 elsewhere. One finder call per
 * column with a free zoned cell, not one per cell.
 */
export function lotMarksInChunk(state: SimState, chunk: number, cells: readonly CellInfo[] = cellsInChunk(state, chunk)): Uint8Array {
  const out = new Uint8Array(cells.length);
  const fronts = new Map<number, LotResult>();
  const zone = state.cells.zone;
  cells.forEach((cell, k) => {
    if (cell.status !== CELL_OPEN || (zone[cell.index] ?? ZONE_NONE) === ZONE_NONE) return;
    if (markWith(state, cell, cell.index, fronts) !== null) out[k] = 1;
  });
  return out;
}
