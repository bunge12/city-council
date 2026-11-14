// Which zoning cells changed since a host last looked (M2-05). Not state: it
// lives in a WeakMap keyed by the road network, like the road change list
// (roads/delta.ts), so it is left out of the hash and the save, and a city
// behaves the same whether or not anyone reads it. Recording starts the
// first time a host asks for it.
//
// Two things change cells. A ZoneCells command paints some, and those are
// kept one by one. A change of roads lays a segment's cells out again
// (cell-index.ts), and that segment is kept whole: what its cells hold is
// read when the delta is built (delta.ts).

import type { RoadNetwork } from "../roads/network";
import type { CellState } from "./cells";

/**
 * A painted cell is kept as `segment * CELL_KEY_STRIDE + its place in the
 * segment's run`, so sorting the keys groups them by segment.
 */
export const CELL_KEY_STRIDE = 2 ** 21;

/** What changed since the last drain. */
export interface CellChanges {
  /** Segment ids whose cells were laid out again. */
  relaid: Set<number>;
  /** Keys of cells a command painted. */
  painted: Set<number>;
}

const recorders = new WeakMap<RoadNetwork, CellChanges>();

/**
 * Starts recording changes to the cells along `net`, if nothing is yet.
 * Changes made before this call are in no later drain; a host sends a
 * snapshot for those.
 */
export function recordCellChangesOf(net: RoadNetwork): void {
  if (!recorders.has(net)) recorders.set(net, { relaid: new Set(), painted: new Set() });
}

/** Notes that the cells of segments `ids` were laid out again. */
export function noteCellsRelaid(net: RoadNetwork, ids: readonly { id: number }[]): void {
  const rec = recorders.get(net);
  if (!rec) return;
  for (const { id } of ids) rec.relaid.add(id);
}

/** Notes that a command painted the cells at `slots` of `cells.zone`. */
export function noteCellsPainted(net: RoadNetwork, cells: CellState, slots: readonly number[]): void {
  const rec = recorders.get(net);
  if (!rec) return;
  const offset = cells.offset;
  const last = offset.length - 1;
  for (const slot of slots) {
    // The last segment whose run starts at or before the slot. Segments
    // with no cells share a start with the next one, so take the last.
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((offset[mid] ?? 0) <= slot) lo = mid;
      else hi = mid;
    }
    rec.painted.add(lo * CELL_KEY_STRIDE + (slot - (offset[lo] ?? 0)));
  }
}

/** What changed since the last drain, and clears it. Null if nothing did or nothing is recording. */
export function drainCellChanges(net: RoadNetwork): CellChanges | null {
  const rec = recorders.get(net);
  if (!rec || (rec.relaid.size === 0 && rec.painted.size === 0)) return null;
  const out = { relaid: rec.relaid, painted: rec.painted };
  rec.relaid = new Set();
  rec.painted = new Set();
  return out;
}
