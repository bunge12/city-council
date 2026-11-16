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

/** A 32-bit hash of a segment's cell anchor, from the bits of its eight numbers. */
export function anchorHash(a: SegmentAnchor): number {
  const h = new Fnv64();
  for (const v of [a.ax, a.az, a.cx, a.cz, a.bx, a.bz, a.tA, a.tB]) h.f64(v);
  return h.lo | 0;
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
  return isSegment(net, journal.seg) && anchorHash(readAnchor(net, journal.seg)) === journal.anchor;
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

/** Appends a journal for `count` cells of segment `seg`, their zone and density read through `localIndex`. */
function write(out: number[], seg: number, anchor: number, count: number, zoneAt: (local: number) => number, densityAt: (local: number) => number): void {
  const depth = ZONING_BALANCE.zoneDepthCells;
  const places = count / (2 * depth);
  const head = out.length;
  out.push(seg, anchor, 0);
  for (let side = 0; side < 2; side++) {
    for (let d = 0; d < depth; d++) {
      for (let place = 0; place < places; place++) {
        const local = localIndex(side, place, d);
        const zone = zoneAt(local);
        const density = densityAt(local);
        const last = out.length - 3;
        if (last > head && out[last + 1] === zone && out[last + 2] === density) out[last] = (out[last] ?? 0) + 1;
        else {
          out.push(1, zone, density);
          out[head + 2] = (out[head + 2] ?? 0) + 1;
        }
      }
    }
  }
}

/**
 * The journals of a ZoneCells about to paint the cells at `slots` of
 * `cells`: what each held. Read before the paint.
 */
export function journalPaint(net: RoadNetwork, cells: CellState, slots: readonly number[]): Int32Array {
  const sorted = Int32Array.from(slots).sort();
  const out: number[] = [];
  const offset = cells.offset;
  let seg = 0;
  let i = 0;
  while (i < sorted.length) {
    const slot = sorted[i] ?? 0;
    // The segment whose run holds the slot. Slots go up, so so does it.
    while ((offset[seg + 1] ?? 0) <= slot) seg++;
    const start = offset[seg] ?? 0;
    const count = (offset[seg + 1] ?? 0) - start;
    const touched = new Uint8Array(count);
    for (; i < sorted.length && (sorted[i] ?? 0) < start + count; i++) touched[(sorted[i] ?? 0) - start] = 1;
    write(
      out,
      seg,
      anchorHash(readAnchor(net, seg)),
      count,
      (local) => (touched[local] === 1 ? (cells.zone[start + local] ?? 0) : ZONE_UNTOUCHED),
      (local) => (touched[local] === 1 ? (cells.density[start + local] ?? 0) : 0),
    );
    seg++;
  }
  return Int32Array.from(out);
}

/**
 * The zoning a road command that has just applied to `net` would lose for
 * good, from the journal of network changes it made: every segment there
 * before it that it removed, or upgraded to a type with no cells, and that
 * no segment it added carries on the same anchor. Read with `cells` still
 * laid out for the roads before the command. An upgrade keeps a segment's
 * anchor, so it is read from the network. Segments with no zoned cell are
 * left out.
 */
export function journalLostZones(net: RoadNetwork, cells: CellState, ops: readonly NetworkOp[]): Int32Array {
  const seen = new Set<number>();
  const lost: { seg: number; anchor: SegmentAnchor }[] = [];
  const carried = new Set<string>();
  const curveKey = (a: SegmentAnchor) => `${a.ax},${a.az},${a.cx},${a.cz},${a.bx},${a.bz}`;
  for (const op of ops) {
    if (op.op === "addSeg") {
      carried.add(curveKey(op.row.anchor));
      seen.add(op.id);
      continue;
    }
    if (op.op !== "removeSeg" && op.op !== "restyle") continue;
    // Only the first change to an id is to the segment there before.
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    if (op.op === "removeSeg") lost.push({ seg: op.id, anchor: op.row.anchor });
    else if (ROAD_TYPES[op.from]?.zonable === true && ROAD_TYPES[op.to]?.zonable !== true) lost.push({ seg: op.id, anchor: readAnchor(net, op.id) });
  }
  const out: number[] = [];
  for (const { seg, anchor } of lost) {
    if (carried.has(curveKey(anchor)) || seg >= cells.offset.length - 1) continue;
    const start = cells.offset[seg] ?? 0;
    const count = (cells.offset[seg + 1] ?? 0) - start;
    let zoned = false;
    for (let k = 0; k < count && !zoned; k++) zoned = (cells.zone[start + k] ?? ZONE_NONE) !== ZONE_NONE;
    if (!zoned) continue;
    write(
      out,
      seg,
      anchorHash(anchor),
      count,
      (local) => cells.zone[start + local] ?? ZONE_NONE,
      (local) => cells.density[start + local] ?? DENSITY_NONE,
    );
  }
  return out.length === 0 ? NO_JOURNALS : Int32Array.from(out);
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
