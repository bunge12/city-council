// Cell deltas (M2-05): the zoning cells that changed since a host last
// looked, as a client copies them into its own read-only copy of the city.
//
// Only zones and densities travel. Where a cell is and whether it is blocked
// are derived on both sides by the same code (cell-index.ts), from roads the
// copy already has. So is the layout of the arrays: how many cells a segment
// has follows from its row (cells.ts).
//
// A delta names cells the way state does, by segment and place in the
// segment's run, grouped by segment. It carries two kinds of change:
//   - cells a ZoneCells command painted, each with what it holds now,
//   - segments whose cells a change of roads laid out again, in `relaid`.
//     The copy cannot tell which zones such a segment kept (cell-index.ts,
//     `relayout`), so its run starts unzoned and the delta carries every
//     cell of it that has a zone.
// Like a road delta, the cells are read when the delta is built, so
// whatever happened to a cell between two deltas, it goes out once, as what
// it is now. A cell delta is built together with the road delta of the same
// steps and applied right after it.

import { segmentIdLimit, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "./balance";
import { CELL_KEY_STRIDE, drainCellChanges, recordCellChangesOf } from "./cell-changes";
import { followCells } from "./cell-index";
import { DENSITY_NONE, ZONE_NONE, cellCountOf, type CellState } from "./cells";

/**
 * The cells that changed, as a delta message carries them. Plain fields and
 * typed arrays only, so it crosses a worker or a socket.
 */
export interface CellDelta {
  /** `cellsReadyAt` after the change. */
  readyAt: number;
  /** Ids of the segments whose cells were laid out again, ascending. Each one's run starts unzoned. */
  relaid: Int32Array;
  /** Ids of the segments with cells below, ascending. */
  segIds: Int32Array;
  /** The cells of segment `segIds[i]` are entries `segStart[i]` up to `segStart[i + 1]` of the three arrays below. One longer than `segIds`. */
  segStart: Int32Array;
  /** Each cell's place in its segment's run, ascending within a segment. */
  local: Int32Array;
  /** Each cell's zone now, as `CellState.zone` holds it. */
  zone: Uint8Array;
  /** Each cell's density now. */
  density: Uint8Array;
}

/**
 * Starts recording changes to `state`'s cells, if nothing is yet. Changes
 * made before this call are in no later delta; a host sends a snapshot for
 * those.
 */
export function recordCellChanges(state: SimState): void {
  recordCellChangesOf(state.roads);
}

/**
 * The cells of `state` that changed since the last call, or since recording
 * started, read as they are now. Null if none changed or nothing is
 * recording. Call it between steps, when the road delta of the same steps
 * is built.
 */
export function drainCellDelta(state: SimState): CellDelta | null {
  const changes = drainCellChanges(state.roads);
  if (!changes) return null;
  const cells = state.cells;
  const limit = cells.offset.length - 1;
  const runOf = (seg: number) => (cells.offset[seg + 1] ?? 0) - (cells.offset[seg] ?? 0);
  // An id past the limit was taken back by an undo: its cells went with it.
  const relaid = Int32Array.from([...changes.relaid].filter((seg) => seg < limit)).sort();
  const keys: number[] = [];
  for (const seg of relaid) {
    const start = cells.offset[seg] ?? 0;
    const run = runOf(seg);
    for (let local = 0; local < run; local++) if (cells.zone[start + local] !== ZONE_NONE) keys.push(seg * CELL_KEY_STRIDE + local);
  }
  for (const key of changes.painted) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    // Painted, then laid out again: the segment's whole run is above.
    if (seg >= limit || changes.relaid.has(seg) || key - seg * CELL_KEY_STRIDE >= runOf(seg)) continue;
    keys.push(key);
  }
  const sorted = Float64Array.from(keys).sort();
  const segIds: number[] = [];
  const segStart: number[] = [];
  const local = new Int32Array(sorted.length);
  const zone = new Uint8Array(sorted.length);
  const density = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const key = sorted[i] ?? 0;
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    if (segIds[segIds.length - 1] !== seg) {
      segIds.push(seg);
      segStart.push(i);
    }
    local[i] = key - seg * CELL_KEY_STRIDE;
    const slot = (cells.offset[seg] ?? 0) + (local[i] ?? 0);
    zone[i] = cells.zone[slot] ?? 0;
    density[i] = cells.density[slot] ?? 0;
  }
  segStart.push(sorted.length);
  return { readyAt: state.cellsReadyAt, relaid, segIds: Int32Array.from(segIds), segStart: Int32Array.from(segStart), local, zone, density };
}

const NO_IDS = new Int32Array(0);

// The zone and density buffers a copy held before its last new layout, by
// its network, kept to write the next one into, as the sim keeps its own
// (cell-index.ts, `spare`). A layout is about 6 MB on a big city, and a new
// one for every road change keeps the garbage collector busy enough to
// stall whatever shares the thread. Not state.
const spares = new WeakMap<RoadNetwork, { zone: Uint8Array; density: Uint8Array }>();

/**
 * An array of `length` for a new layout: a view on the spare buffer when it
 * is big enough, else a new buffer with room to grow. Not cleared: the
 * caller writes every cell.
 */
function layoutBuffer(spare: Uint8Array | undefined, length: number): Uint8Array {
  if (spare && spare.buffer.byteLength >= length) return new Uint8Array(spare.buffer, 0, length);
  return new Uint8Array(new ArrayBuffer(Math.floor(length * 1.25) + 1024), 0, length);
}

/** Whether `list` holds ids from 0 up to `limit`, ascending without repeats. */
function ascendingBelow(list: Int32Array, limit: number): boolean {
  return list.every((id, i) => id >= 0 && id < limit && (i === 0 || id > (list[i - 1] ?? 0)));
}

/**
 * Copies a delta's cells into `state`, a client's copy of the city the
 * delta was built from, whose roads already hold the road rows of the same
 * delta. `roadSegs` are the segment ids those rows were for, ascending, and
 * `delta` is null when the message carried no cells.
 *
 * Returns the 500 m chunks whose cells changed, as `followCells` gives them:
 * none until something has asked the copy about its cells. Returns a reason
 * instead, leaving the cells as they were, if the delta cannot belong to
 * this copy; the client then asks for a snapshot.
 */
export function applyCellDelta(state: SimState, delta: CellDelta | null, roadSegs: ArrayLike<number>): number[] | string {
  const net = state.roads;
  const cells = state.cells;
  const limit = segmentIdLimit(net);
  const oldLimit = cells.offset.length - 1;
  const relaid = delta?.relaid ?? NO_IDS;
  if (!ascendingBelow(relaid, limit)) return "relaid segment ids are out of range or order";
  if (delta && !(Number.isSafeInteger(delta.readyAt) && delta.readyAt >= 0)) return "the tick the cells are ready at is not a whole number";
  const oldRun = (seg: number) => (seg < oldLimit ? (cells.offset[seg + 1] ?? 0) - (cells.offset[seg] ?? 0) : 0);
  // A segment whose row changed and whose cells were not laid out again
  // must have the cells it had. One that has not is a delta that is not
  // this copy's.
  const isRelaid = new Set<number>(relaid);
  for (let i = 0; i < roadSegs.length; i++) {
    const seg = roadSegs[i] as number;
    if (seg < limit && !isRelaid.has(seg) && cellCountOf(net, seg) !== oldRun(seg)) return `segment ${seg} changed its cells and they were not sent`;
  }

  // The layout the roads give now: a segment laid out again has the cells
  // its row says, and every other segment the cells it had.
  let offset = cells.offset;
  const moved = relaid.length > 0 || limit !== oldLimit;
  if (moved) {
    offset = new Int32Array(limit + 1);
    let total = 0;
    for (let seg = 0; seg < limit; seg++) {
      offset[seg] = total;
      total += isRelaid.has(seg) ? cellCountOf(net, seg) : oldRun(seg);
    }
    offset[limit] = total;
  }

  if (delta) {
    const { segIds, segStart, local, zone, density } = delta;
    if (!ascendingBelow(segIds, limit)) return "cell segment ids are out of range or order";
    const count = local.length;
    if (segStart.length !== segIds.length + 1 || segStart[0] !== 0 || segStart[segIds.length] !== count) return "cells are not grouped by segment";
    if (zone.length !== count || density.length !== count) return "cell rows differ in length";
    const zones = ZONING_BALANCE.zones.length;
    const densities = ZONING_BALANCE.densities.length;
    for (let g = 0; g < segIds.length; g++) {
      const seg = segIds[g] ?? 0;
      const run = (offset[seg + 1] ?? 0) - (offset[seg] ?? 0);
      const from = segStart[g] ?? 0;
      const to = segStart[g + 1] ?? 0;
      if (to <= from) return "a segment's group of cells is empty or out of order";
      for (let i = from; i < to; i++) {
        const at = local[i] ?? 0;
        if (at < 0 || at >= run || (i > from && at <= (local[i - 1] ?? 0))) return `segment ${seg} has no such cell, or its cells are out of order`;
        const z = zone[i] ?? 0;
        const d = density[i] ?? 0;
        if (z > zones || d > densities || (z === ZONE_NONE) !== (d === DENSITY_NONE)) return `a cell of segment ${seg} has an unknown zone or density`;
      }
    }
  }

  // Nothing above changed the copy. From here on nothing can fail.
  let next: CellState = cells;
  if (moved) {
    const total = offset[limit] ?? 0;
    const spare = spares.get(net);
    next = { offset, zone: layoutBuffer(spare?.zone, total), density: layoutBuffer(spare?.density, total) };
    // The copy lets go of the old arrays below, so they become the spare.
    spares.set(net, { zone: cells.zone, density: cells.density });
    // Segments in a row that kept their cells have their runs side by side
    // in both layouts, so each such stretch is one copy.
    const known = limit < oldLimit ? limit : oldLimit;
    let stretch = 0;
    const copyStretch = (end: number) => {
      if (end <= stretch) return;
      const from = cells.offset[stretch] ?? 0;
      const upTo = cells.offset[end] ?? 0;
      next.zone.set(cells.zone.subarray(from, upTo), offset[stretch] ?? 0);
      next.density.set(cells.density.subarray(from, upTo), offset[stretch] ?? 0);
    };
    for (const seg of relaid) {
      // The buffers are not cleared, so a run laid out again starts unzoned here.
      next.zone.fill(0, offset[seg] ?? 0, offset[seg + 1] ?? 0);
      next.density.fill(0, offset[seg] ?? 0, offset[seg + 1] ?? 0);
      if (seg >= known) continue;
      copyStretch(seg);
      stretch = seg + 1;
    }
    copyStretch(known);
  }
  const painted: number[] = [];
  if (delta) {
    for (let g = 0; g < delta.segIds.length; g++) {
      const seg = delta.segIds[g] ?? 0;
      const start = next.offset[seg] ?? 0;
      for (let i = delta.segStart[g] ?? 0; i < (delta.segStart[g + 1] ?? 0); i++) {
        const at = delta.local[i] ?? 0;
        next.zone[start + at] = delta.zone[i] ?? 0;
        next.density[start + at] = delta.density[i] ?? 0;
        painted.push(seg * CELL_KEY_STRIDE + at);
      }
    }
    state.cellsReadyAt = delta.readyAt;
  }
  state.cells = next;
  const segs = new Set<number>(relaid);
  for (let i = 0; i < roadSegs.length; i++) segs.add(roadSegs[i] as number);
  return followCells(state, [...segs], painted);
}
