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
import { segmentOfSlot, type CellState } from "./cells";

/**
 * A painted cell is kept as `segment * CELL_KEY_STRIDE + its place in the
 * segment's run`, so sorting the keys groups them by segment.
 */
export const CELL_KEY_STRIDE = 2_097_152; // 2^21

/** What changed since the last drain. */
export interface CellChanges {
  /** Segment ids whose cells were laid out again. */
  relaid: Set<number>;
  /**
   * Keys of cells a command painted, in no order, a cell painted twice
   * maybe listed twice. A view on the recorder's buffer: read it before
   * the cells change again.
   */
  painted: Float64Array;
}

/**
 * The painted cells as a list of keys, not a set: a stroke at the cap
 * paints tens of thousands of cells, and a set of keys past 2^31 boxes
 * every one, which on the scale city was megabytes of garbage a stroke
 * (issue #155). Repeats are dropped when the list fills, and by the delta.
 */
interface Recorder {
  relaid: Set<number>;
  painted: Float64Array;
  paintedCount: number;
}

const recorders = new WeakMap<RoadNetwork, Recorder>();

/**
 * Starts recording changes to the cells along `net`, if nothing is yet.
 * Changes made before this call are in no later drain; a host sends a
 * snapshot for those.
 */
export function recordCellChangesOf(net: RoadNetwork): void {
  if (!recorders.has(net)) recorders.set(net, { relaid: new Set(), painted: new Float64Array(1024), paintedCount: 0 });
}

/** Notes that the cells of segments `ids` were laid out again. */
export function noteCellsRelaid(net: RoadNetwork, ids: readonly { id: number }[]): void {
  const rec = recorders.get(net);
  if (!rec) return;
  for (const { id } of ids) rec.relaid.add(id);
}

/** Sorts the recorder's keys and drops repeats, in place. */
function compact(rec: Recorder): void {
  const keys = rec.painted.subarray(0, rec.paintedCount).sort();
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (n === 0 || keys[i] !== keys[n - 1]) keys[n++] = keys[i] ?? 0;
  rec.paintedCount = n;
}

/** Makes room for `more` keys, dropping repeats first when the list is full. */
function room(rec: Recorder, more: number): void {
  if (rec.paintedCount + more <= rec.painted.length) return;
  compact(rec);
  // Grown only once repeats are gone, so the list stays within twice the cells painted.
  if (rec.paintedCount + more <= rec.painted.length / 2) return;
  let size = rec.painted.length * 2;
  while (size < rec.paintedCount + more) size *= 2;
  const grown = new Float64Array(size);
  grown.set(rec.painted.subarray(0, rec.paintedCount));
  rec.painted = grown;
}

/** Notes that a command painted the cells at `slots` of `cells.zone`. */
export function noteCellsPainted(net: RoadNetwork, cells: CellState, slots: ArrayLike<number>): void {
  const rec = recorders.get(net);
  if (!rec) return;
  room(rec, slots.length);
  const offset = cells.offset;
  const painted = rec.painted;
  let n = rec.paintedCount;
  let seg = -1;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] ?? 0;
    seg = segmentOfSlot(offset, slot, seg);
    painted[n++] = seg * CELL_KEY_STRIDE + (slot - (offset[seg] ?? 0));
  }
  rec.paintedCount = n;
}

/** What changed since the last drain, and clears it. Null if nothing did or nothing is recording. */
export function drainCellChanges(net: RoadNetwork): CellChanges | null {
  const rec = recorders.get(net);
  if (!rec || (rec.relaid.size === 0 && rec.paintedCount === 0)) return null;
  const out = { relaid: rec.relaid, painted: rec.painted.subarray(0, rec.paintedCount) };
  rec.relaid = new Set();
  rec.paintedCount = 0;
  return out;
}
