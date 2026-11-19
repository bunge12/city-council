// What undo needs to put zoning back (issue 111, PRD "Undo").
//
// A zone journal holds what some cells of one segment held. Two kinds of
// undo record carry them:
//
//   - A ZoneCells record holds, for each segment it painted, the zone and
//     density each changed cell had before. Undoing it puts those back,
//     while each segment is still the road it was and each cell still holds
//     what the paint gave it.
//   - A road record holds the zoning of every segment the command took away
//     for good: a bulldozed road, or one upgraded to a type with no cells.
//     When the undo brings the segment back, its cells take that zoning
//     again. A road that was only split needs nothing: its pieces carry the
//     zones on their anchor, and give them back when they are joined again
//     (cell-index.ts).
//
// A journal names its segment by id and by a 32-bit hash of its cell
// anchor, ends included. Ids are reused, and a road that has since been cut
// or reversed numbers its cells differently, so a journal only applies to a
// segment with the same anchor and the same number of cells.
//
// The cells go in runs of one value, in the order side, depth, place along
// the road. A stroke runs along a street, so a strip painted on one side,
// whatever its depth, is a few runs per segment, not one per place.
//
// A record's journals are one flat Int32Array, one journal after another:
//
//   segment id, anchor hash, run count, then per run: cells, zone, density
//
// A stroke at the cap touches about a thousand segments, and as objects its
// journals cost a host 100 ms to copy into a delta for a long history. As
// one typed array they are a copy of memory, and a save writes them as
// binary.

import { Fnv64 } from "../hash";
import type { NetworkOp, RoadNetwork, SegmentAnchor } from "../roads/network";
import { isSegment, readAnchor } from "../roads/network";
import { ROAD_TYPES } from "../roads/balance";
import { ZONING_BALANCE } from "./balance";
import { DENSITY_NONE, ZONE_NONE, localIndex, type CellState } from "./cells";

/** The zone of a run of cells a ZoneCells left alone: undo does not touch them. */
export const ZONE_UNTOUCHED = 255;

/** No journals. */
export const NO_JOURNALS = new Int32Array(0);

/** A zone and a density, as `state.cells` holds them. */
export interface ZoneValue {
  zone: number;
  density: number;
}

/** One journal in a record's flat array: its segment, anchor hash, and where its runs are. */
export interface Journal {
  seg: number;
  anchor: number;
  /** Index of its first run's cell count in the array. */
  from: number;
  /** Index just past its last run. */
  to: number;
}

// One hasher for every anchor, and one buffer to hash its eight numbers
// from: a stroke at the cap hashes about a thousand, and a new hasher or
// anchor object each time is garbage for the collector. Not state.
const anchorHasher = new Fnv64();
const anchorFloats = new Float64Array(8);
// The bytes of the eight numbers. Every engine the game targets is little
// endian, as `hashState` already assumes, so these are the bytes
// `Fnv64.f64` feeds, in its order.
const anchorBytes = new Uint8Array(anchorFloats.buffer);

function hashAnchorFloats(): number {
  const h = anchorHasher;
  h.reset();
  h.bytes(anchorBytes);
  return h.lo | 0;
}

/** A 32-bit hash of a segment's cell anchor, from the bits of its eight numbers. */
export function anchorHash(a: SegmentAnchor): number {
  const f = anchorFloats;
  f[0] = a.ax;
  f[1] = a.az;
  f[2] = a.cx;
  f[3] = a.cz;
  f[4] = a.bx;
  f[5] = a.bz;
  f[6] = a.tA;
  f[7] = a.tB;
  return hashAnchorFloats();
}

/** `anchorHash` of segment `seg`'s anchor as `net` holds it, read in place. */
function anchorHashOf(net: RoadNetwork, seg: number): number {
  const f = anchorFloats;
  f[0] = net.segAnchorAX[seg] ?? 0;
  f[1] = net.segAnchorAZ[seg] ?? 0;
  f[2] = net.segAnchorCX[seg] ?? 0;
  f[3] = net.segAnchorCZ[seg] ?? 0;
  f[4] = net.segAnchorBX[seg] ?? 0;
  f[5] = net.segAnchorBZ[seg] ?? 0;
  f[6] = net.segAnchorTA[seg] ?? 0;
  f[7] = net.segAnchorTB[seg] ?? 0;
  return hashAnchorFloats();
}

/** The journals in `zones`, in order. */
export function readJournals(zones: Int32Array): Journal[] {
  const out: Journal[] = [];
  let at = 0;
  while (at + 3 <= zones.length) {
    const runs = zones[at + 2] ?? 0;
    out.push({ seg: zones[at] ?? 0, anchor: zones[at + 1] ?? 0, from: at + 3, to: at + 3 + runs * 3 });
    at += 3 + runs * 3;
  }
  return out;
}

/** Whether segment `journal.seg` of `net` is the road the journal was written for, by its anchor. */
export function journalFits(net: RoadNetwork, journal: Journal): boolean {
  return isSegment(net, journal.seg) && anchorHashOf(net, journal.seg) === journal.anchor;
}

/** How many cells `journal` covers. */
export function journalCells(zones: Int32Array, journal: Journal): number {
  let n = 0;
  for (let i = journal.from; i < journal.to; i += 3) n += zones[i] ?? 0;
  return n;
}

/**
 * Calls `visit` with each cell's place in its segment's run and the zone
 * and density `journal` holds for it. `count` is the segment's cell count,
 * which the caller has checked is `journalCells`.
 */
export function forJournalCells(zones: Int32Array, journal: Journal, count: number, visit: (local: number, zone: number, density: number) => void): void {
  const depth = ZONING_BALANCE.zoneDepthCells;
  const places = count / (2 * depth);
  let at = journal.from;
  let left = zones[at] ?? 0;
  for (let side = 0; side < 2; side++) {
    for (let d = 0; d < depth; d++) {
      for (let place = 0; place < places; place++) {
        while (left === 0) {
          at += 3;
          if (at >= journal.to) return;
          left = zones[at] ?? 0;
        }
        visit(localIndex(side, place, d), zones[at + 1] ?? 0, zones[at + 2] ?? 0);
        left--;
      }
    }
  }
}

// Where journals are written before they are copied out as a record's
// array, and which cells of a segment a paint touched. Kept between calls,
// so a stroke at the cap leaves no garbage but the record itself: as a
// list of numbers and a mark array per segment it made a few megabytes,
// and the collections that followed pushed the step past the tick budget
// (issue #155). Not state.
let journalBuf = new Int32Array(1 << 14);
let journalLength = 0;
let touched = new Uint8Array(0);

/** Makes room for `more` numbers after the ones written. */
function reserve(more: number): void {
  if (journalLength + more <= journalBuf.length) return;
  let size = journalBuf.length * 2;
  while (size < journalLength + more) size *= 2;
  const grown = new Int32Array(size);
  grown.set(journalBuf.subarray(0, journalLength));
  journalBuf = grown;
}

/**
 * Appends a journal for the `count` cells of segment `seg` that start at
 * `start` in `cells`. With `marks`, a cell whose mark is not 1 goes in as
 * untouched.
 */
function write(seg: number, anchor: number, cells: CellState, start: number, count: number, marks: Uint8Array | null): void {
  const depth = ZONING_BALANCE.zoneDepthCells;
  const places = count / (2 * depth);
  const zones = cells.zone;
  const densities = cells.density;
  // At worst every cell starts a run of its own.
  reserve(3 + count * 3);
  const buf = journalBuf;
  let at = journalLength;
  const head = at;
  buf[at++] = seg;
  buf[at++] = anchor;
  buf[at++] = 0;
  let runs = 0;
  let run = -1;
  let runZone = -1;
  let runDensity = -1;
  for (let side = 0; side < 2; side++) {
    for (let d = 0; d < depth; d++) {
      // `localIndex(side, place, d)`, a place at a time.
      for (let place = 0, local = side * depth + d; place < places; place++, local += 2 * depth) {
        let zone = ZONE_UNTOUCHED;
        let density = 0;
        if (marks === null || marks[local] === 1) {
          zone = zones[start + local] ?? ZONE_NONE;
          density = densities[start + local] ?? DENSITY_NONE;
        }
        if (run >= 0 && zone === runZone && density === runDensity) {
          buf[run] = (buf[run] ?? 0) + 1;
          continue;
        }
        run = at;
        runZone = zone;
        runDensity = density;
        buf[at++] = 1;
        buf[at++] = zone;
        buf[at++] = density;
        runs++;
      }
    }
  }
  buf[head + 2] = runs;
  journalLength = at;
}

/** The journals written since `journalLength` was last set to 0, as an array of their own. */
function written(): Int32Array {
  return journalLength === 0 ? NO_JOURNALS : journalBuf.slice(0, journalLength);
}

/**
 * The journals of a ZoneCells about to paint the cells at `slots` of
 * `cells`: what each held. Read before the paint. `slots` go up.
 */
export function journalPaint(net: RoadNetwork, cells: CellState, slots: Int32Array): Int32Array {
  journalLength = 0;
  const offset = cells.offset;
  let seg = 0;
  let i = 0;
  while (i < slots.length) {
    const slot = slots[i] ?? 0;
    // The segment whose run holds the slot. Slots go up, so so does it.
    while ((offset[seg + 1] ?? 0) <= slot) seg++;
    const start = offset[seg] ?? 0;
    const count = (offset[seg + 1] ?? 0) - start;
    if (touched.length < count) touched = new Uint8Array(Math.max(count, touched.length * 2));
    const first = i;
    for (; i < slots.length && (slots[i] ?? 0) < start + count; i++) touched[(slots[i] ?? 0) - start] = 1;
    write(seg, anchorHashOf(net, seg), cells, start, count, touched);
    for (let k = first; k < i; k++) touched[(slots[k] ?? 0) - start] = 0;
    seg++;
  }
  return written();
}

/**
 * The zoning a road command that has just applied to `net` would lose for
 * good, from the journal of network changes it made: every segment there
 * before it that it removed, or upgraded to a type with no cells, and that
 * no segment it added carries on the same anchor and build order, the key
 * the cell layout carries zones by. Read with `cells` still laid out for
 * the roads before the command. An upgrade keeps a segment's anchor and a
 * reverse swaps its two ends, so the anchor before is read from the
 * network and swapped back. Segments with no zoned cell are left out.
 */
export function journalLostZones(net: RoadNetwork, cells: CellState, ops: readonly NetworkOp[]): Int32Array {
  // The segments there before the command that it removed or made cell-less,
  // with a zoned cell. Most commands, and every grid on open ground, have none,
  // so the step pays only for one pass over the ops.
  const seen = new Set<number>();
  const lost: { seg: number; anchor: SegmentAnchor; order: number; start: number; count: number }[] = [];
  const isZoned = (seg: number): { start: number; count: number } | null => {
    if (seg >= cells.offset.length - 1) return null;
    const start = cells.offset[seg] ?? 0;
    const count = (cells.offset[seg + 1] ?? 0) - start;
    for (let k = 0; k < count; k++) if ((cells.zone[start + k] ?? ZONE_NONE) !== ZONE_NONE) return { start, count };
    return null;
  };
  for (const op of ops) {
    if (op.op === "addSeg") {
      seen.add(op.id);
      continue;
    }
    if (op.op !== "removeSeg" && op.op !== "restyle") continue;
    // Only the first change to an id is to the segment there before.
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    if (op.op === "restyle" && !(ROAD_TYPES[op.from]?.zonable === true && ROAD_TYPES[op.to]?.zonable !== true)) continue;
    const run = isZoned(op.id);
    if (!run) continue;
    if (op.op === "removeSeg") lost.push({ seg: op.id, anchor: op.row.anchor, order: op.row.order, ...run });
    else {
      const now = readAnchor(net, op.id);
      const anchor = op.reverse ? { ...now, tA: now.tB, tB: now.tA } : now;
      lost.push({ seg: op.id, anchor, order: net.segOrder[op.id] ?? 0, ...run });
    }
  }
  if (lost.length === 0) return NO_JOURNALS;
  // Segments the command added on the same anchor and build order carry
  // the zones, as the cell layout does (cell-index.ts), so nothing is lost
  // where they cover the whole stretch of anchor the old segment had. Only
  // those still standing at the end with cells count: a bulldoze of part of
  // a road cuts it and removes the middle piece, whose zones go with it
  // (issue 86), and so do those of a piece upgraded to a type with none.
  // The pieces of one cut meet at exactly the same parameter, so the check
  // needs no tolerance.
  const curveKey = (a: SegmentAnchor, order: number) => `${order},${a.ax},${a.az},${a.cx},${a.cz},${a.bx},${a.bz}`;
  const added = new Map<number, SegmentAnchor & { key: string }>();
  for (const op of ops) {
    if (op.op === "addSeg") added.set(op.id, { ...op.row.anchor, key: curveKey(op.row.anchor, op.row.order) });
    else if (op.op === "removeSeg") added.delete(op.id);
  }
  const spans = new Map<string, [number, number][]>();
  for (const [id, a] of added) {
    if (!isSegment(net, id) || ROAD_TYPES[net.segType[id] ?? 0]?.zonable !== true) continue;
    let list = spans.get(a.key);
    if (!list) spans.set(a.key, (list = []));
    list.push(a.tA < a.tB ? [a.tA, a.tB] : [a.tB, a.tA]);
  }
  for (const list of spans.values()) list.sort((p, q) => p[0] - q[0]);
  const carried = (anchor: SegmentAnchor, order: number): boolean => {
    const list = spans.get(curveKey(anchor, order));
    if (!list) return false;
    const lo = anchor.tA < anchor.tB ? anchor.tA : anchor.tB;
    const hi = anchor.tA < anchor.tB ? anchor.tB : anchor.tA;
    let reach = lo;
    for (const [from, to] of list) {
      if (to <= reach) continue;
      if (from > reach) break;
      reach = to;
    }
    return reach >= hi;
  };
  journalLength = 0;
  for (const { seg, anchor, order, start, count } of lost) {
    if (carried(anchor, order)) continue;
    write(seg, anchorHash(anchor), cells, start, count, null);
  }
  return written();
}

/** Whether `zone` and `density` are a value a cell can hold: both set, or both not. */
export function isZoneValue(zone: unknown, density: unknown): boolean {
  if (!Number.isSafeInteger(zone) || !Number.isSafeInteger(density)) return false;
  const z = zone as number;
  const d = density as number;
  if (z < 0 || d < 0 || z > ZONING_BALANCE.zones.length || d > ZONING_BALANCE.densities.length) return false;
  return (z === ZONE_NONE) === (d === DENSITY_NONE);
}

/**
 * Whether `value` is a well-formed list of journals. `untouched` allows the
 * runs a paint left alone, which only a ZoneCells record has. For loading a
 * save.
 */
export function checkJournals(value: unknown, untouched: boolean): boolean {
  if (!(value instanceof Int32Array)) return false;
  let at = 0;
  while (at < value.length) {
    if (at + 3 > value.length) return false;
    const runs = value[at + 2] ?? 0;
    if ((value[at] ?? -1) < 0 || runs <= 0 || at + 3 + runs * 3 > value.length) return false;
    for (let i = at + 3; i < at + 3 + runs * 3; i += 3) {
      if ((value[i] ?? 0) <= 0) return false;
      const zone = value[i + 1];
      const density = value[i + 2];
      if (untouched && zone === ZONE_UNTOUCHED && density === 0) continue;
      if (!isZoneValue(zone, density)) return false;
    }
    at += 3 + runs * 3;
  }
  return true;
}
