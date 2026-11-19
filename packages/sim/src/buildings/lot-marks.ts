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
//
// The overlay builds a chunk's marks with its mesh (issue #164). It passes
// the cells it has read for the mesh, since reading a chunk's cells again
// took most of the time, and most free columns are settled by
// `plainLotFits`, a quick walk of the strip, before the finder is asked.

import type { SimState } from "../state";
import { CELL_OPEN, cellShapesInChunk, syncCells, type ChunkCellShapes } from "../zoning/cell-index";
import { ZONING_BALANCE } from "../zoning/balance";
import { ZONE_NONE, cellSlot, fromLocal, segmentOfSlot, type CellRef } from "../zoning/cells";
import { blockIndexOf } from "../roads/blocks";
import { BUILDING_TYPES } from "./balance";
import { findLot, plainLotFits, type LotResult } from "./lots";

/** Whether a finder's answer at a front cell is one the overlay marks. */
function marks(result: LotResult): result is Extract<LotResult, { ok: false }> {
  return !result.ok && (result.problem === "too-shallow" || result.problem === "too-narrow" || result.problem === "no-types");
}

/** Zone and density pairs, as `zone * 16 + density`, that some building type grows on. */
const GROWS = new Set(BUILDING_TYPES.map((t) => t.zoneNumber * 16 + t.density));

const DEPTH = ZONING_BALANCE.zoneDepthCells;

/** Whether nothing grows on the zoned cell at `slot`: then it is marked wherever it is free, whatever lies in front of it. */
function barren(state: SimState, slot: number): boolean {
  const zone = state.cells.zone[slot] ?? ZONE_NONE;
  return zone !== ZONE_NONE && !GROWS.has(zone * 16 + (state.cells.density[slot] ?? 0));
}

/** The barren cell's own reason, which the finder gives as "no-types", or null. */
function barrenReason(state: SimState, ref: CellRef): string | null {
  const own = findLot(state, ref);
  return !own.ok && own.problem === "no-types" ? own.reason : null;
}

/**
 * The mark of a free cell `depth` back in a column, from the answer at the
 * column's front cell, where null means a type fits there.
 */
function markFrom(front: LotResult | null, depth: number): string | null {
  if (front === null || !marks(front)) return null;
  if (depth === 0) return front.reason;
  // Behind the front cell, only the free run of the front cell's zone and density.
  return front.problem !== "no-types" && depth < (front.room?.depth ?? 0) ? front.reason : null;
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
  if (slot < 0) return null;
  if (ref.depth > 0 && barren(state, slot)) return barrenReason(state, ref);
  return markFrom(findLot(state, { ...ref, depth: 0 }), ref.depth);
}

/**
 * For each cell of chunk `chunk`, in `cellsInChunk` order, 1 where the
 * overlay marks it as `lotMarkAt` says and 0 elsewhere. `shapes` is the
 * chunk's cells as `cellShapesInChunk` gives them, read from this same
 * state; pass the ones already read for the chunk's mesh rather than have
 * them read again. One question a column with a free zoned cell, not one
 * a cell, and the finder only where `plainLotFits` cannot say.
 */
export function lotMarksInChunk(state: SimState, chunk: number, shapes: Pick<ChunkCellShapes, "slots" | "statuses"> = cellShapesInChunk(state, chunk)): Uint8Array {
  syncCells(state);
  const { slots, statuses } = shapes;
  const out = new Uint8Array(slots.length);
  // The answer at each column's front cell, by that cell's slot: a column's cells sit in a row from it.
  const fronts = new Map<number, LotResult | null>();
  const known = new Map<number, number>();
  const { zone, offset } = state.cells;
  // The finder needs the block index for through-lots, and builds it on first use. Built here, so
  // that one-off lands on the first chunk's marks, whichever chunk is first to ask the finder.
  blockIndexOf(state.roads);
  let seg = -1;
  const open = CELL_OPEN;
  const n = slots.length;
  for (let k = 0; k < n; k++) {
    // Most cells of a chunk can be blocked, so this test comes first and alone.
    if (statuses[k] !== open) continue;
    const slot = slots[k] ?? -1;
    if (slot < 0 || (zone[slot] ?? ZONE_NONE) === ZONE_NONE) continue;
    // Slots come segment by segment, so mostly the last cell's segment again.
    seg = segmentOfSlot(offset, slot, seg);
    const local = slot - (offset[seg] ?? 0);
    const depth = local % DEPTH;
    if (depth > 0 && barren(state, slot)) {
      if (barrenReason(state, { segment: seg, ...fromLocal(local) }) !== null) out[k] = 1;
      continue;
    }
    const frontSlot = slot - depth;
    let front = fronts.get(frontSlot);
    if (front === undefined) {
      const ref: CellRef = { segment: seg, ...fromLocal(local - depth) };
      front = plainLotFits(state, ref, known) ? null : findLot(state, ref);
      fronts.set(frontSlot, front);
    }
    if (markFrom(front, depth) !== null) out[k] = 1;
  }
  return out;
}
