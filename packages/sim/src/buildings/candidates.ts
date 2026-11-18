// The grower's candidates (M2-10): every free zoned cell by the road, the
// cells a lot can start from. Derived data, like the building index: kept
// in a WeakMap keyed by the buildings object, never saved or hashed, built
// from state on first use (`prepareDerived` does that at load) and kept
// current after, so a grower tick never scans the city.
//
// What a candidate is, and the order they are counted in, follow from
// state alone, so a city loaded from a save draws the same cell for the
// same number as one that kept running: a candidate is the front cell of a
// column, at depth 0, that is open, zoned and has no building, and they
// count in segment id order, then by column within the segment, which is
// the order of their slots in `state.cells.zone`.
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

import { WIDEST_LOT } from "./balance";
import type { BuildingState } from "./buildings";
import { NONE, isNode, nextSegmentAt, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { CELL_OPEN, type CellIndex, type Column } from "../zoning/cell-index";
import { ZONE_NONE, segmentOfSlot, type CellRef } from "../zoning/cells";

const DEPTH = ZONING_BALANCE.zoneDepthCells;
/** Segments per counted block. */
const BLOCK = 64;
/** As where.ts has it. Not imported, to keep this module free of the building index. */
const NO_BUILDING = -1;

interface Candidates {
  /** The cell index this was built from. */
  index: CellIndex;
  /** By segment id: per column, `place * 2 + side`, 1 for a candidate. Null for a segment with none. */
  bits: (Uint8Array | null)[];
  /** By segment id: its candidates. */
  counts: Int32Array;
  /** Candidates in each block of BLOCK segment ids. */
  blocks: Int32Array;
  count: number;
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
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] ?? 0;
    if (slot % DEPTH !== 0) continue;
    seg = segmentOfSlot(offset, slot, seg);
    noteFront(c, seg * CELL_KEY_STRIDE + (slot - (offset[seg] ?? 0)) / DEPTH);
  }
}

/** Front-cell keys `fronts` may hold before `noteFront` drops the repeats. */
const MOST_FRONTS = 1 << 20;

/**
 * Lists front cell `key` to look at again. Commands made while paused note
 * cells with no grower tick to look at them, so past `MOST_FRONTS` the list
 * keeps one of each key. Which keys it holds is what counts, not their order.
 */
function noteFront(c: Candidates, key: number): void {
  c.fronts.push(key);
  if (c.fronts.length <= MOST_FRONTS) return;
  const sorted = Float64Array.from(c.fronts).sort();
  c.fronts.length = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) c.fronts.push(sorted[i] ?? 0);
}

/** Notes that a building came or went on these columns. */
export function noteColumns(state: SimState, cols: readonly Column[]): void {
  const c = live.get(state.buildings);
  if (!c) return;
  for (const col of cols) noteFront(c, col.seg * CELL_KEY_STRIDE + col.place * 2 + col.side);
}

/** Notes that a building came or went on these columns, each as `segment * CELL_KEY_STRIDE + column`. */
export function noteFrontColumns(state: SimState, keys: readonly number[]): void {
  const c = live.get(state.buildings);
  if (!c) return;
  for (const key of keys) noteFront(c, key);
}

/** Whether column `col` of segment `seg` is a candidate, with the cells as they are now: 1 or 0. */
function isCandidate(state: SimState, index: CellIndex, onCell: OnCell, seg: number, col: number): number {
  const status = index.segs[seg]?.status;
  if (!status || status[col * DEPTH] !== CELL_OPEN) return 0;
  const slot = (state.cells.offset[seg] ?? 0) + col * DEPTH;
  return state.cells.zone[slot] !== ZONE_NONE && (onCell()[seg]?.[col * DEPTH] ?? NO_BUILDING) === NO_BUILDING ? 1 : 0;
}

/** Makes room for segment ids below `limit`. */
function fit(c: Candidates, limit: number): void {
  if (c.counts.length < limit) {
    const counts = new Int32Array(Math.max(limit, c.counts.length * 2));
    counts.set(c.counts);
    c.counts = counts;
    const blocks = new Int32Array(Math.ceil(counts.length / BLOCK));
    blocks.set(c.blocks);
    c.blocks = blocks;
  }
  while (c.bits.length < limit) c.bits.push(null);
}

function setCount(c: Candidates, seg: number, n: number): void {
  const was = c.counts[seg] ?? 0;
  if (n === was) return;
  c.counts[seg] = n;
  const block = Math.floor(seg / BLOCK);
  c.blocks[block] = (c.blocks[block] ?? 0) + n - was;
  c.count += n - was;
}

/** Looks at every column of `seg` again. */
function refreshSegment(c: Candidates, state: SimState, onCell: OnCell, seg: number): void {
  const places = c.index.segs[seg]?.places ?? 0;
  if (places === 0) {
    c.bits[seg] = null;
    setCount(c, seg, 0);
    return;
  }
  let bits: Uint8Array | null = null;
  let n = 0;
  for (let col = 0; col < places * 2; col++) {
    if (isCandidate(state, c.index, onCell, seg, col) === 0) continue;
    bits ??= new Uint8Array(places * 2);
    bits[col] = 1;
    n++;
  }
  c.bits[seg] = bits;
  setCount(c, seg, n);
}

/** Looks at one column again. */
function refreshColumn(c: Candidates, state: SimState, onCell: OnCell, seg: number, col: number): void {
  const columns = (c.index.segs[seg]?.places ?? 0) * 2;
  if (col >= columns) return;
  const now = isCandidate(state, c.index, onCell, seg, col);
  let bits = c.bits[seg] ?? null;
  if ((bits?.[col] ?? 0) === now) return;
  if (!bits) c.bits[seg] = bits = new Uint8Array(columns);
  bits[col] = now;
  setCount(c, seg, (c.counts[seg] ?? 0) + (now === 1 ? 1 : -1));
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
    counts: new Int32Array(limit),
    blocks: new Int32Array(Math.ceil(limit / BLOCK)),
    count: 0,
    segs: new Set(),
    fronts: [],
  };
  for (let seg = 0; seg < limit; seg++) refreshSegment(c, state, onCell, seg);
  return c;
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
  if (c && c.index === index && c.segs.size === 0 && c.fronts.length === 0 && (!watch || (watch.segs.size === 0 && watch.nodes.size === 0 && watch.fronts.size === 0))) return c;
  let found: readonly (Int32Array | null)[] | null = null;
  const onCell = (): readonly (Int32Array | null)[] => (found ??= ask());
  if (!c || c.index !== index) {
    c = build(state, index, onCell);
    live.set(state.buildings, c);
    index.watch = { segs: new Set(), nodes: new Set(), fronts: new Set() };
    return c;
  }
  if (watch) {
    for (const seg of watch.segs) c.segs.add(seg);
    for (const node of watch.nodes) segmentsNear(c.index, state.roads, node, c.segs);
    for (const key of watch.fronts) noteFront(c, key);
    watch.segs.clear();
    watch.nodes.clear();
    watch.fronts.clear();
  }
  if (c.segs.size === 0 && c.fronts.length === 0) return c;
  fit(c, index.segs.length);
  for (const seg of c.segs) refreshSegment(c, state, onCell, seg);
  // In key order, so each segment's columns are looked at together, and once.
  const keys = Float64Array.from(c.fronts).sort();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? 0;
    if (i > 0 && key === keys[i - 1]) continue;
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    if (!c.segs.has(seg)) refreshColumn(c, state, onCell, seg, key - seg * CELL_KEY_STRIDE);
  }
  c.segs.clear();
  c.fronts.length = 0;
  return c;
}

/** How many candidates `state` has now. */
export function candidateCount(state: SimState, index: CellIndex, onCell: OnCell): number {
  return candidatesOf(state, index, onCell).count;
}

/** The `k`-th candidate, from 0, in slot order, as a cell name. `k` must be under `candidateCount`. */
export function candidateAt(state: SimState, index: CellIndex, onCell: OnCell, k: number): CellRef {
  const c = candidatesOf(state, index, onCell);
  if (!(Number.isInteger(k) && k >= 0 && k < c.count)) throw new RangeError(`no candidate ${k} of ${c.count}`);
  let left = k;
  let block = 0;
  while (left >= (c.blocks[block] ?? 0)) left -= c.blocks[block++] ?? 0;
  let seg = block * BLOCK;
  while (left >= (c.counts[seg] ?? 0)) left -= c.counts[seg++] ?? 0;
  const bits = c.bits[seg] as Uint8Array;
  let col = 0;
  for (; ; col++) {
    if (bits[col] !== 1) continue;
    if (left === 0) break;
    left--;
  }
  return { segment: seg, side: col % 2, place: (col - (col % 2)) / 2, depth: 0 };
}

/** Builds the candidates now if they are not, so a host's load pays for it and not a tick. */
export function prepareCandidates(state: SimState, index: CellIndex, onCell: OnCell): void {
  candidatesOf(state, index, onCell);
}

/**
 * Every candidate as `segment * CELL_KEY_STRIDE + column`, from the kept
 * set and from a fresh build, for tests that check the two never part.
 */
export function candidateSets(state: SimState, index: CellIndex, onCell: OnCell): { kept: number[]; fresh: number[] } {
  const list = (c: Candidates): number[] => {
    const out: number[] = [];
    c.bits.forEach((bits, seg) => bits?.forEach((bit, col) => bit === 1 && out.push(seg * CELL_KEY_STRIDE + col)));
    return out;
  };
  const kept = candidatesOf(state, index, onCell);
  const fresh = build(state, index, onCell);
  expectSameCounts(kept, fresh);
  return { kept: list(kept), fresh: list(fresh) };
}

function expectSameCounts(kept: Candidates, fresh: Candidates): void {
  let total = 0;
  for (let block = 0; block < kept.blocks.length; block++) {
    let sum = 0;
    for (let seg = block * BLOCK; seg < (block + 1) * BLOCK && seg < kept.counts.length; seg++) sum += kept.counts[seg] ?? 0;
    if (sum !== kept.blocks[block]) throw new Error(`block ${block} counts ${kept.blocks[block]}, its segments ${sum}`);
    total += sum;
  }
  if (total !== kept.count || kept.count !== fresh.count) throw new Error(`kept ${kept.count} (${total} by block), fresh ${fresh.count}`);
}

/** Drops the kept candidates, so the next use builds them afresh. For benches and tests. */
export function forgetCandidates(state: SimState): void {
  live.delete(state.buildings);
}
