// The grower's candidates (M2-10): every free zoned cell by the road, the
// cells a lot can start from. Derived data, like the building index: kept
// in a WeakMap keyed by the buildings object, never saved or hashed, built
// from state on first use (`prepareDerived` does that at load) and kept
// current after, so a grower tick never scans the city.
//
// What a candidate is, and the order they are counted in, follow from
// state alone, so a city loaded from a save takes the same cell as one that
// kept running: a candidate is the front cell of a column, at depth 0, that
// is open, zoned and has no building, and they count in segment id order,
// then by column within the segment, which is the order of their slots in
// `state.cells.zone`. The grower takes them in land value order, that
// order breaking ties (lot-order.ts, M3-25), kept here as they change.
//
// Kept by segment, so a change touches only its own segments. Three things
// change a candidate, and each notes what it touched:
// - a ZoneCells command, the cells it painted (zoning/zone.ts);
// - a building added or removed, its lot's columns (buildings.ts);
// - a change of roads, the segments laid out again and the nodes at their
//   ends, and the front cells of other segments whose status the walk
//   changed (`CellIndex.watch`, zoning/cell-index.ts).
// A building's lot can run on past a segment's end, so a change of roads
// also looks again at the segments a lot could reach from those nodes: the
// ones at each node, and on through shorter segments while the places
// passed are fewer than the widest lot (`segmentsNear`). A lot that no longer fits its roads
// stands on no cells (where.ts), and those cells come back as candidates.
//
// Counted by zone too (M3-07), so the grower can draw among the free cells
// of one zone alone: a zone whose demand bar is at or below zero then costs
// no draws. Each column holds its zone's number, or 0 when it is not a
// candidate, and every count is kept for each zone and for all of them.

import { WIDEST_LOT } from "./balance";
import type { LotReads } from "./lots";
import { blockIndexOf } from "../roads/blocks";
import type { BuildingState } from "./buildings";
import { NONE, isNode, nextSegmentAt, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { CELL_OPEN, type CellIndex, type Column } from "../zoning/cell-index";
import { ZONE_NONE, segmentOfSlot, type CellRef } from "../zoning/cells";
import {
  addCandidate,
  bestCandidate as bestInOrder,
  bringBackNear,
  bringBackBlocked,
  createLotOrder,
  dropSegment,
  fileWaiting,
  isSetAside,
  notePollution as notePollutionIn,
  removeCandidate,
  resetSegment,
  setAside as setAsideIn,
  type LotOrder,
} from "./lot-order";

const DEPTH = ZONING_BALANCE.zoneDepthCells;
/** Zone numbers run from 1 to this. Counts at index 0 are for every zone together. */
const ZONES = ZONING_BALANCE.zones.length;
/** As where.ts has it. Not imported, to keep this module free of the building index. */
const NO_BUILDING = -1;
// Imported constants the loops below read, copied: under the test runner,
// which the benches time, each read of an import is a property read on a
// module object, and a bulldoze of thousands of buildings reads them per
// column (issue #306).
const STRIDE = CELL_KEY_STRIDE;
const OPEN = CELL_OPEN;
const NO_ZONE = ZONE_NONE;

interface Candidates {
  /** The cell index this was built from. */
  index: CellIndex;
  /** By segment id: per column, `place * 2 + side`, the zone number of a candidate, 0 for none. Null for a segment with none. */
  bits: (Uint8Array | null)[];
  /** By zone number, 0 for every zone, then by segment id: its candidates. */
  counts: Int32Array[];
  /** By zone number, 0 for every zone: candidates. */
  count: Int32Array;
  /** Segments to look at again whole. */
  segs: Set<number>;
  /**
   * Front cells to look at again, as `segment * CELL_KEY_STRIDE + column`.
   * A plain list, not a set: the keys are past the small integers a set
   * hashes cheaply, and a command that clears thousands of buildings notes
   * tens of thousands (issue #162). A key listed twice is looked at twice,
   * which changes nothing. `noteFront` keeps it from growing without bound.
   */
  fronts: number[];
  /** How long `fronts` may grow before `noteFront` drops its repeats: `MOST_FRONTS`, or twice what the last drop left. */
  frontsCap: number;
  /** The candidates in land value order (lot-order.ts, M3-25), built on the grower's first ask. */
  order: LotOrder | null;
  /** Front columns a building was just added on, as `segment * CELL_KEY_STRIDE + column`: the set-aside cells beside them come back (lot-order.ts). */
  added: number[];
  /** Columns zoned, or a building was removed from, the same way: the set-aside cells on the runs they touch come back. */
  changed: number[];
}

const live = new WeakMap<BuildingState, Candidates>();

/**
 * The building on each cell, by segment and place in its run, as
 * `segmentBuildings` gives it (where.ts). Asked only for a front cell that
 * is open and zoned, so a city with no zoned frontage never builds the
 * building index.
 */
export type OnCell = () => readonly (Int32Array | null)[];

/** Notes that a command painted the cells at `slots` of `state.cells.zone`. Only front cells matter. */
export function noteFrontCells(state: SimState, slots: ArrayLike<number>): void {
  const c = live.get(state.buildings);
  if (!c) return;
  const offset = state.cells.offset;
  let seg = -1;
  let last = -1;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] ?? 0;
    // Any depth counts for a set-aside cell: zoning behind a strip changes how deep a lot fits.
    if (c.order && slot % DEPTH !== 0) {
      seg = segmentOfSlot(offset, slot, seg);
      const key = seg * CELL_KEY_STRIDE + Math.floor((slot - (offset[seg] ?? 0)) / DEPTH);
      if (key !== last) c.changed.push(key);
      last = key;
      continue;
    }
    if (slot % DEPTH !== 0) continue;
    seg = segmentOfSlot(offset, slot, seg);
    const key = seg * CELL_KEY_STRIDE + (slot - (offset[seg] ?? 0)) / DEPTH;
    noteFront(c, key);
    if (c.order && key !== last) c.changed.push(key);
    last = key;
  }
}

/** Front-cell keys `fronts` may hold before `noteFront` drops the repeats. */
const MOST_FRONTS = 1 << 20;

/**
 * Lists front cell `key` to look at again. Commands made while paused note
 * cells with no grower tick to look at them, so past `frontsCap` the list
 * keeps one of each key. Which keys it holds is what counts, not their order.
 * A city with more distinct front cells than `MOST_FRONTS` keeps more than
 * that after the drop, so the cap then doubles from what was left, and the
 * sorts stay a fixed share of the notes.
 */
function noteFront(c: Candidates, key: number): void {
  c.fronts.push(key);
  if (c.fronts.length <= c.frontsCap) return;
  const sorted = Float64Array.from(c.fronts).sort();
  c.fronts.length = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) c.fronts.push(sorted[i] ?? 0);
  c.frontsCap = Math.max(MOST_FRONTS, 2 * c.fronts.length);
}

/** Notes that buildings were filed again on these columns after a change of roads, or went from them. */
export function noteColumns(state: SimState, cols: readonly Column[]): void {
  const c = live.get(state.buildings);
  if (!c) return;
  for (const col of cols) {
    const key = col.seg * CELL_KEY_STRIDE + col.place * 2 + col.side;
    noteFront(c, key);
    if (c.order) c.changed.push(key);
  }
}

/** Notes that a building was just added on these columns: the set-aside cells on the free runs beside them come back (lot-order.ts). */
export function noteAddedColumns(state: SimState, cols: readonly Column[]): void {
  const c = live.get(state.buildings);
  if (!c) return;
  for (const col of cols) {
    const key = col.seg * CELL_KEY_STRIDE + col.place * 2 + col.side;
    noteFront(c, key);
    if (c.order) c.added.push(key);
  }
}

/** Notes that buildings went from these columns, each as `segment * CELL_KEY_STRIDE + column`. */
export function noteFrontColumns(state: SimState, keys: readonly number[]): void {
  const c = live.get(state.buildings);
  if (!c) return;
  for (const key of keys) noteFront(c, key);
  if (c.order) c.changed.push(...keys);
}

/**
 * Notes that pollution changed around (x, z), out to `radius` metres, so
 * the land value order looks at the candidates there again (M3-25). Keyed
 * by the buildings, as the building index that stamps pollution is.
 */
export function notePollution(buildings: BuildingState, x: number, z: number, radius: number): void {
  const order = live.get(buildings)?.order;
  if (order) notePollutionIn(order, x, z, radius);
}

/** The zone number of column `col` of segment `seg` if it is a candidate, with the cells as they are now, else 0. */
function isCandidate(state: SimState, index: CellIndex, onCell: OnCell, seg: number, col: number): number {
  const status = index.segs[seg]?.status;
  if (!status || status[col * DEPTH] !== OPEN) return 0;
  const slot = (state.cells.offset[seg] ?? 0) + col * DEPTH;
  const zone = state.cells.zone[slot] ?? NO_ZONE;
  return zone !== NO_ZONE && (onCell()[seg]?.[col * DEPTH] ?? NO_BUILDING) === NO_BUILDING ? zone : 0;
}

/** Makes room for segment ids below `limit`. */
function fit(c: Candidates, limit: number): void {
  for (let z = 0; z <= ZONES; z++) {
    const old = c.counts[z] as Int32Array;
    if (old.length >= limit) continue;
    const counts = new Int32Array(Math.max(limit, old.length * 2));
    counts.set(old);
    c.counts[z] = counts;
  }
  while (c.bits.length < limit) c.bits.push(null);
}

/** Adds `n`, which may be below 0, to the candidates of `seg` in zone `zone`, and in every zone. */
function addCount(c: Candidates, seg: number, zone: number, n: number): void {
  if (n === 0) return;
  // Two calls, not a loop over [0, zone]: this runs per candidate, and an array a call is garbage (issue #209).
  addZoneCount(c, seg, 0, n);
  addZoneCount(c, seg, zone, n);
}

function addZoneCount(c: Candidates, seg: number, z: number, n: number): void {
  const counts = c.counts[z] as Int32Array;
  counts[seg] = (counts[seg] ?? 0) + n;
  c.count[z] = (c.count[z] ?? 0) + n;
}

/** Looks at every column of `seg` again. */
function refreshSegment(c: Candidates, state: SimState, onCell: OnCell, seg: number): void {
  const places = c.index.segs[seg]?.places ?? 0;
  for (let z = 1; z <= ZONES; z++) addCount(c, seg, z, -((c.counts[z] as Int32Array)[seg] ?? 0));
  const order = c.order;
  if (order) {
    dropSegment(order, seg);
    resetSegment(order, seg, places * 2);
  }
  if (places === 0) {
    c.bits[seg] = null;
    return;
  }
  let bits: Uint8Array | null = null;
  for (let col = 0; col < places * 2; col++) {
    const zone = isCandidate(state, c.index, onCell, seg, col);
    if (zone === 0) continue;
    bits ??= new Uint8Array(places * 2);
    bits[col] = zone;
    addCount(c, seg, zone, 1);
    if (order) addCandidate(order, state, c.index, seg, col, zone);
  }
  c.bits[seg] = bits;
}

/**
 * Adds to `out` every segment a lot could reach from `node`, as the header
 * says: the segments at the node, and on through a segment to the node at
 * its far end while the places passed on the way leave room for a lot that
 * reaches back to `node`. A lot `WIDEST_LOT` columns wide that holds a
 * column of a segment past others covers every place of those others, so
 * the walk stops once the places it has passed reach that width. A
 * segment with no cells passes none, and the walk takes at most that many
 * segments in a row. The building index (where.ts) looks again at the
 * same ones.
 */
export function segmentsNear(index: CellIndex, net: RoadNetwork, node: number, out: Set<number>): void {
  const reach = WIDEST_LOT;
  // The fewest places passed to reach each node so far.
  const best = new Map<number, number>([[node, 0]]);
  let ring: [number, number][] = [[node, 0]];
  for (let hop = 0; hop < reach && ring.length > 0; hop++) {
    const next: [number, number][] = [];
    for (const [n, passed] of ring) {
      if (!isNode(net, n) || (best.get(n) ?? 0) < passed) continue;
      for (let seg = net.nodeFirstSeg[n] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, n)) {
        out.add(seg);
        const through = passed + (index.segs[seg]?.places ?? 0);
        if (through >= reach) continue;
        const other = net.segA[seg] === n ? (net.segB[seg] ?? NONE) : (net.segA[seg] ?? NONE);
        if ((best.get(other) ?? Infinity) <= through) continue;
        best.set(other, through);
        next.push([other, through]);
      }
    }
    ring = next;
  }
}

function build(state: SimState, index: CellIndex, onCell: OnCell): Candidates {
  const limit = index.segs.length;
  const c: Candidates = {
    index,
    bits: new Array<Uint8Array | null>(limit).fill(null),
    counts: Array.from({ length: ZONES + 1 }, () => new Int32Array(limit)),
    count: new Int32Array(ZONES + 1),
    segs: new Set(),
    fronts: [],
    frontsCap: MOST_FRONTS,
    order: null,
    added: [],
    changed: [],
  };
  for (let seg = 0; seg < limit; seg++) refreshSegment(c, state, onCell, seg);
  return c;
}

/** Builds `c`'s land value order from its candidates. */
function buildOrder(c: Candidates, state: SimState): LotOrder {
  const order = createLotOrder();
  for (let seg = 0; seg < c.bits.length; seg++) {
    const bits = c.bits[seg];
    resetSegment(order, seg, (c.index.segs[seg]?.places ?? 0) * 2);
    if (!bits) continue;
    for (let col = 0; col < bits.length; col++) if ((bits[col] ?? 0) !== 0) addCandidate(order, state, c.index, seg, col, bits[col] ?? 0);
  }
  return order;
}

/** Whether `state` has candidates built, by `prepareDerived` or a first grower read. */
export function candidatesBuilt(state: SimState): boolean {
  return live.has(state.buildings);
}

/**
 * The candidates of `state`, current. `index` and `onCell` are the cell
 * index and the building on each cell, as `syncCells` and `segmentBuildings`
 * give them now.
 */
function candidatesOf(state: SimState, index: CellIndex, ask: OnCell): Candidates {
  let c = live.get(state.buildings);
  // Nearly every call, from a grower draw: nothing noted since the last, so nothing to allocate (issue 166).
  const watch = index.watch;
  if (c && c.index === index && c.segs.size === 0 && c.fronts.length === 0 && (!watch || (watch.segs.size === 0 && watch.nodes.size === 0 && watch.fronts.size === 0 && watch.columns.size === 0))) return capNotes(c, state);
  let found: readonly (Int32Array | null)[] | null = null;
  const onCell = (): readonly (Int32Array | null)[] => (found ??= ask());
  if (!c || c.index !== index) {
    c = build(state, index, onCell);
    live.set(state.buildings, c);
    index.watch = { segs: new Set(), nodes: new Set(), fronts: new Set(), columns: new Set() };
    return c;
  }
  if (watch) {
    for (const seg of watch.segs) c.segs.add(seg);
    for (const node of watch.nodes) segmentsNear(c.index, state.roads, node, c.segs);
    for (const key of watch.fronts) noteFront(c, key);
    // Cells whose status changed bring back the set-aside cells on the runs they touch (lot-order.ts).
    if (c.order) {
      for (const key of watch.fronts) c.changed.push(key);
      for (const key of watch.columns) c.changed.push(key);
    }
    // New sets rather than clear(), and only when there is something to
    // let go of: see `CellWatch` in zoning/cell-index.ts. Cleared on every
    // grower draw, empty or not, they were a share of the garbage behind
    // the major collections on the sim's thread (issue #209).
    if (watch.segs.size > 0) watch.segs = new Set();
    if (watch.nodes.size > 0) watch.nodes = new Set();
    if (watch.fronts.size > 0) watch.fronts = new Set();
    if (watch.columns.size > 0) watch.columns = new Set();
  }
  if (c.segs.size === 0 && c.fronts.length === 0) return capNotes(c, state);
  catchUp(c, state, onCell);
  return capNotes(c, state);
}

/**
 * Looks again at what was noted since the last catch-up. Kept out of
 * `candidatesOf`, which a grower draw calls thousands of times a tick with
 * nothing noted: compiled with this inside it, the engine threw that code
 * away each time a bulldoze took this path, and ran the loop slowly
 * (issue #306).
 */
function catchUp(c: Candidates, state: SimState, onCell: OnCell): void {
  fit(c, c.index.segs.length);
  for (const seg of c.segs) {
    refreshSegment(c, state, onCell, seg);
    // Its own cells are new to the order, with none set aside; the runs that carry on past its ends come back.
    const places = c.index.segs[seg]?.places ?? 0;
    if (c.order && places > 0) for (const col of [0, 1, places * 2 - 2, places * 2 - 1]) c.changed.push(seg * STRIDE + col);
  }
  // In key order, so each segment's columns are looked at together, and once.
  const keys = Float64Array.from(c.fronts).sort();
  const whole = c.segs.size > 0 ? c.segs : null;
  const order = c.order;
  // Each key's column looked at again, with what a segment's keys share
  // read once a segment: the keys are in segment order, and a bulldoze of
  // thousands of buildings notes tens of thousands.
  const shapes = c.index.segs;
  const { offset, zone: zones } = state.cells;
  let held: readonly (Int32Array | null)[] | null = null;
  let seg = -1;
  let skip = true;
  let columns = 0;
  let status: Uint8Array | null = null;
  let first = 0;
  /** The buildings on `seg`'s cells, undefined until asked for. */
  let onSeg: Int32Array | null | undefined;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as number;
    if (i > 0 && key === keys[i - 1]) continue;
    const s = Math.floor(key / STRIDE);
    if (s !== seg) {
      seg = s;
      skip = whole !== null && whole.has(seg);
      const shape = shapes[seg];
      columns = (shape?.places ?? 0) * 2;
      status = shape?.status ?? null;
      first = offset[seg] ?? 0;
      onSeg = undefined;
    }
    const col = key - seg * STRIDE;
    if (skip || col >= columns) continue;
    // `isCandidate`.
    const at = col * DEPTH;
    let now = 0;
    if (status && status[at] === OPEN) {
      const zone = zones[first + at] ?? NO_ZONE;
      if (zone !== NO_ZONE) {
        // Asked for only here, as `isCandidate` does.
        if (onSeg === undefined) onSeg = (held ??= onCell())[seg] ?? null;
        if ((onSeg?.[at] ?? NO_BUILDING) === NO_BUILDING) now = zone;
      }
    }
    let bits = c.bits[seg] ?? null;
    const was = bits?.[col] ?? 0;
    if (was === now) continue;
    if (!bits) c.bits[seg] = bits = new Uint8Array(columns);
    bits[col] = now;
    if (was !== 0) addCount(c, seg, was, -1);
    if (now !== 0) addCount(c, seg, now, 1);
    // The land value order follows (lot-order.ts): a new candidate waits there to be filed, so this stays a few writes.
    if (order) {
      if (was !== 0) removeCandidate(order, seg, col);
      if (now !== 0) addCandidate(order, state, c.index, seg, col, now);
    }
  }
  if (whole) c.segs = new Set();
  c.fronts.length = 0;
  c.frontsCap = MOST_FRONTS;
}

/** Most change notes kept for the order before they are worked through without waiting for the grower's ask. */
const MOST_NOTES = 1 << 20;

/** `c`, working its change notes through only if they have piled up past `MOST_NOTES`, as a city whose grower never asks would. */
function capNotes(c: Candidates, state: SimState): Candidates {
  return c.changed.length + c.added.length > MOST_NOTES ? settleOrder(c, state) : c;
}

/**
 * Brings set-aside cells back as the changes noted since the last ask
 * require (lot-order.ts), with the candidates current. Only the grower's ask
 * needs it, so it waits for that: a command that frees thousands of cells
 * does not pay for it in its own step. The walks read the cells as they are
 * then, which is enough: a try reads only the cells as they are, and every
 * column changed since is noted.
 */
function settleOrder(c: Candidates, state: SimState): Candidates {
  const order = c.order;
  if (order) {
    // Asked of every road change's faces, wherever it was: `bringBackBlocked` looks only at a count when no face changed.
    if (order.asideBlocks.length > 0) bringBackBlocked(order, blockIndexOf(state.roads));
    bringBackNear(order, c.index, state.roads, c.changed, false);
    bringBackNear(order, c.index, state.roads, c.added, true);
  }
  c.added.length = 0;
  c.changed.length = 0;
  return c;
}

/** How many candidates `state` has now in zone number `zone`, or in every zone for 0, the default. */
export function candidateCount(state: SimState, index: CellIndex, onCell: OnCell, zone = 0): number {
  return candidatesOf(state, index, onCell).count[zone] ?? 0;
}

/** `c`'s land value order, built from its candidates on first use. */
function orderOf(c: Candidates, state: SimState): LotOrder {
  c.order ??= buildOrder(c, state);
  return c.order;
}

/**
 * The candidate of zone number `zone`, or of every zone for 0, the default,
 * with the highest land value, the lower in slot order of two the same,
 * leaving out those set aside (lot-order.ts, M3-25); or null for none.
 * `grid` gives the pollution grid (buildings/where.ts), which this module
 * does not build.
 */
export function bestCandidate(state: SimState, index: CellIndex, onCell: OnCell, grid: () => Int32Array, zone = 0): CellRef | null {
  const c = settleOrder(candidatesOf(state, index, onCell), state);
  if ((c.count[zone] ?? 0) === 0) return null;
  const key = bestInOrder(orderOf(c, state), state, index, zone, grid());
  if (key < 0) return null;
  const seg = Math.floor(key / CELL_KEY_STRIDE);
  const col = key - seg * CELL_KEY_STRIDE;
  return { segment: seg, side: col % 2, place: (col - (col % 2)) / 2, depth: 0 };
}

/**
 * Sets the candidate `ref` names aside: no lot fits there, and the grower
 * passes over it until its ground changes (lot-order.ts). `reads` is what
 * its try read beyond its strip (lots.ts, `LotReads`).
 */
export function setAside(state: SimState, ref: CellRef, reads: Readonly<LotReads>): void {
  const order = live.get(state.buildings)?.order;
  if (order) setAsideIn(order, ref.segment, ref.place * 2 + ref.side, reads, blockIndexOf(state.roads));
}

/** Whether the candidate at column `col` of segment `seg` is set aside. For tests. */
export function isCandidateSetAside(state: SimState, seg: number, col: number): boolean {
  const c = live.get(state.buildings);
  if (c) settleOrder(c, state);
  const order = c?.order;
  return order ? isSetAside(order, seg, col) : false;
}

/** How many cells the grower has set aside on `state` since its candidates were built: one for each try that found no lot. For tests. */
export function setAsideCount(state: SimState): number {
  return live.get(state.buildings)?.order?.setAsideCount ?? 0;
}

/** Builds the candidates and their land value order now if they are not, so a host's load pays for it and not a tick. */
export function prepareCandidates(state: SimState, index: CellIndex, onCell: OnCell): void {
  const c = settleOrder(candidatesOf(state, index, onCell), state);
  fileWaiting(orderOf(c, state), state, c.index);
}

/**
 * Every candidate as `segment * CELL_KEY_STRIDE + column`, from the kept
 * set and from a fresh build, for tests that check the two never part.
 */
export function candidateSets(state: SimState, index: CellIndex, onCell: OnCell): { kept: number[]; fresh: number[] } {
  const list = (c: Candidates): number[] => {
    const out: number[] = [];
    // The zone after the point, so a column filed under the wrong zone shows.
    c.bits.forEach((bits, seg) => bits?.forEach((bit, col) => bit !== 0 && out.push(seg * CELL_KEY_STRIDE + col + bit / 10)));
    return out;
  };
  const kept = candidatesOf(state, index, onCell);
  const fresh = build(state, index, onCell);
  expectSameCounts(kept, fresh);
  return { kept: list(kept), fresh: list(fresh) };
}

function expectSameCounts(kept: Candidates, fresh: Candidates): void {
  let zones = 0;
  for (let z = 0; z <= ZONES; z++) {
    const counts = kept.counts[z] as Int32Array;
    let total = 0;
    for (let seg = 0; seg < counts.length; seg++) total += counts[seg] ?? 0;
    if (total !== kept.count[z] || kept.count[z] !== fresh.count[z]) throw new Error(`zone ${z}: kept ${kept.count[z]} (${total} by segment), fresh ${fresh.count[z]}`);
    if (z > 0) zones += total;
  }
  if (zones !== kept.count[0]) throw new Error(`the zones count ${zones}, all of them together ${kept.count[0]}`);
}

/** How many front-cell keys wait to be looked at again, repeats included. For tests. */
export function frontsWaiting(state: SimState): number {
  return live.get(state.buildings)?.fronts.length ?? 0;
}

/** Drops the kept candidates, so the next use builds them afresh. For benches and tests. */
export function forgetCandidates(state: SimState): void {
  live.delete(state.buildings);
}
