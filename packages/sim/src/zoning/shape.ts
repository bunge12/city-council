// The shape of zoning cells and road surfaces (M2-03).
//
// A segment is measured along its length at stations every cell size from
// node A. Each station has a point on the road's centre line and the unit
// normal to its left, travelling from A to B with north up. A cell spans two
// stations in a row and one band of distance from the centre line: its
// corners are the two stations pushed out along their normals. On a straight
// road every cell is a square; on a curve the cells fan out on the outside
// and close up on the inside, so they follow the road and neighbours share
// their corners exactly.
//
// A road surface is the same construction one road width across, from the
// first station to the last, with a last short piece to the segment's end. A
// straight surface is one rectangle.
//
// Cells are recomputed from the graph whenever a city loads, so everything
// here uses only add, subtract, multiply, divide, Math.sqrt and Math.floor
// (CLAUDE.md rule 6). Distances along a curve come from the same sixteen-piece
// polyline `curveLength` measures, so a station's place agrees with the
// segment's stored length.

import { ROAD_BUILD } from "../roads/balance";
import { CURVE_STEPS, curvePolyline, isStraight, quadPoint } from "../roads/curve";

/**
 * Two shapes overlap only by more than this many metres. Cells that share an
 * edge, and a cell that starts exactly at a road's edge, then do not count as
 * overlapping, whatever the rounding. A tolerance, not a balance number.
 */
export const OVERLAP_TOLERANCE = 0.01;

/**
 * Two cells that face each other back to back, reaching into a block from
 * the roads on either side of it, overlap only by more than this many
 * metres. Every road end is snapped to the build grid, so on a road that is
 * not on a whole axis each end can sit up to `gridStep` / sqrt(2) off its
 * line, and two roads drawn a whole number of cells apart can come up to
 * `gridStep` * sqrt(2) short of it somewhere along the block. Without this
 * the last rows of the two strips overlap by that sliver and one of them is
 * lost (#348). A tolerance, not a balance number.
 */
export const FACING_TOLERANCE = 2 * ROAD_BUILD.gridStep;

/**
 * A segment with less than this left past its last whole cell, in metres,
 * gets no extra surface piece. Stops a rounding sliver making a piece of no
 * length.
 */
const STATION_TOLERANCE = 1e-6;

/** Floats per station in a station array: x, z, then the left normal's x and z. */
export const STATION_FLOATS = 4;

/** The least whole number at or above `x`, from Math.floor alone, which rule 6 lists. */
export function ceilOf(x: number): number {
  return -Math.floor(-x);
}

/** Whole cells along a segment of `length` metres, for cells of `cellSize`. */
export function cellsAlong(length: number, cellSize: number): number {
  // A length snapped to whole cells can come back a hair short from the
  // square root that measures it, so a whole cell is allowed that hair.
  const n = Math.floor(length / cellSize + 1e-9);
  return n > 0 ? n : 0;
}

/** A curve ready to be measured: its shape, and the polyline lengths `curveLength` uses. */
export interface MeasuredCurve {
  ax: number;
  az: number;
  cx: number;
  cz: number;
  bx: number;
  bz: number;
  straight: boolean;
  /** Plan length, the same number `curveLength` gives. */
  length: number;
  /** Running lengths of the sixteen-piece polyline at t = i / 16; null when straight. */
  cum: Float64Array | null;
}

/** The curve from (ax, az) through (cx, cz) to (bx, bz), measured. */
export function measureCurve(ax: number, az: number, cx: number, cz: number, bx: number, bz: number): MeasuredCurve {
  const shape = { ax, az, cx, cz, bx, bz };
  if (isStraight(shape)) {
    const dx = bx - ax;
    const dz = bz - az;
    return { ...shape, straight: true, length: Math.sqrt(dx * dx + dz * dz), cum: null };
  }
  // The polyline `curveLength` measures, so the total is the segment's stored length to the last bit.
  const cum = curvePolyline(ax, az, cx, cz, bx, bz);
  return { ...shape, straight: false, length: cum[CURVE_STEPS] ?? 0, cum };
}

/** The curve parameter `s` metres along `c` from its start, held to the curve. */
export function paramAt(c: MeasuredCurve, s: number): number {
  let t: number;
  if (c.cum === null) t = c.length > 0 ? s / c.length : 0;
  else {
    const cum = c.cum;
    let piece = 0;
    while (piece < CURVE_STEPS - 1 && (cum[piece + 1] ?? 0) < s) piece++;
    const from = cum[piece] ?? 0;
    const span = (cum[piece + 1] ?? 0) - from;
    let f = span > 0 ? (s - from) / span : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    t = (piece + f) / CURVE_STEPS;
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** How far along `c` from its start parameter `t` is, in metres: the inverse of `paramAt`. */
export function lengthAt(c: MeasuredCurve, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return c.length;
  if (c.cum === null) return t * c.length;
  const g = t * CURVE_STEPS;
  const i = Math.floor(g);
  const from = c.cum[i] ?? 0;
  return from + (g - i) * ((c.cum[i + 1] ?? 0) - from);
}

/** Writes the station of `c` at parameter `t`, four floats, into `out` at `at`. */
function stationInto(c: MeasuredCurve, t: number, out: Float64Array, at: number): void {
  const chordX = c.bx - c.ax;
  const chordZ = c.bz - c.az;
  let x: number;
  let z: number;
  // Direction of travel: half the curve's derivative.
  let dx: number;
  let dz: number;
  if (c.straight) {
    // Along the chord, so a road on a whole-metre line puts its cells on whole metres too.
    x = c.ax + t * chordX;
    z = c.az + t * chordZ;
    dx = chordX;
    dz = chordZ;
  } else {
    ({ x, z } = quadPoint(c, t));
    dx = c.cx - c.ax + t * (c.ax - 2 * c.cx + c.bx);
    dz = c.cz - c.az + t * (c.az - 2 * c.cz + c.bz);
  }
  let len: number = Math.sqrt(dx * dx + dz * dz);
  if (len === 0) {
    // The chord, where a curve's own direction is lost.
    dx = chordX;
    dz = chordZ;
    len = Math.sqrt(dx * dx + dz * dz);
  }
  if (len === 0) {
    dx = 1;
    dz = 0;
    len = 1;
  }
  out[at] = x;
  out[at + 1] = z;
  // Left of travel with north up: x east, z south, so (dz, -dx).
  out[at + 2] = dz / len;
  out[at + 3] = -dx / len;
}

/**
 * The stations of `c` every `step` metres from its start, for its whole
 * steps, then one at its end if the end lies past the last of them. Four
 * floats each, as STATION_FLOATS says. For a road's surface.
 */
export function stationsOf(c: MeasuredCurve, step: number): Float64Array {
  const out = new Float64Array(stationCount(c, step) * STATION_FLOATS);
  stationsInto(c, step, out);
  return out;
}

/** How many stations `stationsOf` gives `c`. */
export function stationCount(c: MeasuredCurve, step: number): number {
  const whole = cellsAlong(c.length, step);
  return whole + 1 + (c.length - whole * step > STATION_TOLERANCE ? 1 : 0);
}

/** `stationsOf` written into `out`, which has room for `stationCount` stations. */
export function stationsInto(c: MeasuredCurve, step: number, out: Float64Array): void {
  const whole = cellsAlong(c.length, step);
  const count = stationCount(c, step);
  for (let k = 0; k <= whole; k++) stationInto(c, paramAt(c, k * step), out, k * STATION_FLOATS);
  if (count > whole + 1) stationInto(c, 1, out, (count - 1) * STATION_FLOATS);
}

/**
 * The cells of anchor `c` that the stretch between parameters `tA` and
 * `tB` owns: cells `from` up to but not including `to`, counted every
 * `step` metres from the anchor's start. A stretch owns the whole cells
 * whose midpoint lies in it, from its low end and short of its high end,
 * so the pieces of a cut road own every cell of the road between them,
 * the one that straddles a cut included. A cell owned this way can reach
 * past its piece's ends, and a road that made the cut blocks it like any
 * surface. `reversed` when `tA` is past `tB`.
 */
export function anchorSpan(c: MeasuredCurve, tA: number, tB: number, step: number): { from: number; to: number; reversed: boolean } {
  const sA = lengthAt(c, tA);
  const sB = lengthAt(c, tB);
  const lo = sA < sB ? sA : sB;
  const hi = sA < sB ? sB : sA;
  // Every whole cell of the anchor, and no part cell past its last. A
  // length snapped to whole cells can come back a hair short.
  const whole = Math.floor(c.length / step + 1e-6);
  const from = ownerBound(lo, step, whole);
  const to = ownerBound(hi, step, whole);
  return { from, to: to > from ? to : from, reversed: tA > tB };
}

/** The first cell, of `whole`, whose midpoint is at or past `s`. Two pieces that meet at `s` get the same answer, so a cell goes to exactly one. */
function ownerBound(s: number, step: number, whole: number): number {
  const k = ceilOf(s / step - 0.5);
  return k > 0 ? (k < whole ? k : whole) : 0;
}

/**
 * Stations `from` to `to` of anchor `c`, every `step` metres from its
 * start. Station k is the same bits whichever segment asks, so the pieces
 * of a split road have exactly their parent's cells.
 */
export function anchorStations(c: MeasuredCurve, from: number, to: number, step: number): Float64Array {
  const out = new Float64Array((to - from + 1) * STATION_FLOATS);
  anchorStationsInto(c, from, to, step, out);
  return out;
}

/** `anchorStations` written into the start of `out`. */
export function anchorStationsInto(c: MeasuredCurve, from: number, to: number, step: number, out: Float64Array): void {
  for (let k = from; k <= to; k++) stationInto(c, paramAt(c, k * step), out, (k - from) * STATION_FLOATS);
}

/**
 * Writes the corners of the cell between stations `place` and `place + 1`,
 * on side `side` (0 left, 1 right), reaching from `inner` to `outer` metres
 * out from the centre line, into `out` as x0, z0, ..., x3, z3. The corners
 * go inner start, inner end, outer end, outer start.
 */
export function cellCornersInto(
  stations: Float64Array,
  place: number,
  side: number,
  inner: number,
  outer: number,
  out: Float64Array,
): void {
  const sign = side === 0 ? 1 : -1;
  const i0 = place * STATION_FLOATS;
  const i1 = i0 + STATION_FLOATS;
  const x0 = stations[i0] ?? 0;
  const z0 = stations[i0 + 1] ?? 0;
  const nx0 = sign * (stations[i0 + 2] ?? 0);
  const nz0 = sign * (stations[i0 + 3] ?? 0);
  const x1 = stations[i1] ?? 0;
  const z1 = stations[i1 + 1] ?? 0;
  const nx1 = sign * (stations[i1 + 2] ?? 0);
  const nz1 = sign * (stations[i1 + 3] ?? 0);
  out[0] = x0 + nx0 * inner;
  out[1] = z0 + nz0 * inner;
  out[2] = x1 + nx1 * inner;
  out[3] = z1 + nz1 * inner;
  out[4] = x1 + nx1 * outer;
  out[5] = z1 + nz1 * outer;
  out[6] = x0 + nx0 * outer;
  out[7] = z0 + nz0 * outer;
}

/**
 * Writes the road surface between stations `from` and `to`, `half` metres
 * either side of the centre line, into `out`: left at `from`, left at `to`,
 * right at `to`, right at `from`, from `at` on.
 */
export function surfaceInto(stations: Float64Array, from: number, to: number, half: number, out: Float64Array, at = 0): void {
  const i0 = from * STATION_FLOATS;
  const i1 = to * STATION_FLOATS;
  const x0 = stations[i0] ?? 0;
  const z0 = stations[i0 + 1] ?? 0;
  const nx0 = stations[i0 + 2] ?? 0;
  const nz0 = stations[i0 + 3] ?? 0;
  const x1 = stations[i1] ?? 0;
  const z1 = stations[i1 + 1] ?? 0;
  const nx1 = stations[i1 + 2] ?? 0;
  const nz1 = stations[i1 + 3] ?? 0;
  out[at + 0] = x0 + nx0 * half;
  out[at + 1] = z0 + nz0 * half;
  out[at + 2] = x1 + nx1 * half;
  out[at + 3] = z1 + nz1 * half;
  out[at + 4] = x1 - nx1 * half;
  out[at + 5] = z1 - nz1 * half;
  out[at + 6] = x0 - nx0 * half;
  out[at + 7] = z0 - nz0 * half;
}

/** The box around a quad: writes min x, min z, max x, max z into `out`. `qAt` and `outAt` are where each starts in its array. */
export function quadBoxInto(q: Float64Array, out: Float64Array, qAt = 0, outAt = 0): void {
  let minX = q[qAt] ?? 0;
  let maxX = minX;
  let minZ = q[qAt + 1] ?? 0;
  let maxZ = minZ;
  for (let i = 2; i < 8; i += 2) {
    const x = q[qAt + i] ?? 0;
    const z = q[qAt + i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out[outAt] = minX;
  out[outAt + 1] = minZ;
  out[outAt + 2] = maxX;
  out[outAt + 3] = maxZ;
}

/**
 * Whether the quad's corners turn the same way all round, so it is convex
 * and does not fold over itself. A cell on the inside of a bend tighter than
 * its reach fails this.
 */
export function isConvexQuad(q: Float64Array): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[i * 2] ?? 0;
    const az = q[i * 2 + 1] ?? 0;
    const bx = q[((i + 1) % 4) * 2] ?? 0;
    const bz = q[((i + 1) % 4) * 2 + 1] ?? 0;
    const cx = q[((i + 2) % 4) * 2] ?? 0;
    const cz = q[((i + 2) % 4) * 2 + 1] ?? 0;
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (cross === 0) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Whether some edge of `p` separates the two quads, allowing them to overlap by `tolerance` metres. */
function separatedByEdgeOf(p: Float64Array, q: Float64Array, tolerance: number): boolean {
  for (let i = 0; i < 4; i++) {
    const ex = (p[((i + 1) % 4) * 2] ?? 0) - (p[i * 2] ?? 0);
    const ez = (p[((i + 1) % 4) * 2 + 1] ?? 0) - (p[i * 2 + 1] ?? 0);
    // The edge's normal, not made unit: the tolerance is scaled instead.
    const ax = -ez;
    const az = ex;
    const len2 = ax * ax + az * az;
    if (len2 === 0) continue;
    let minP = Infinity;
    let maxP = -Infinity;
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const dp = (p[k] ?? 0) * ax + (p[k + 1] ?? 0) * az;
      if (dp < minP) minP = dp;
      if (dp > maxP) maxP = dp;
      const dq = (q[k] ?? 0) * ax + (q[k + 1] ?? 0) * az;
      if (dq < minQ) minQ = dq;
      if (dq > maxQ) maxQ = dq;
    }
    const overlap = (maxP < maxQ ? maxP : maxQ) - (minP > minQ ? minP : minQ);
    if (overlap <= tolerance * Math.sqrt(len2)) return true;
  }
  return false;
}

/**
 * Whether two convex quads overlap by more than the tolerance. Quads that
 * only touch along an edge or at a corner do not.
 */
export function quadsOverlap(p: Float64Array, q: Float64Array): boolean {
  return !separatedByEdgeOf(p, q, OVERLAP_TOLERANCE) && !separatedByEdgeOf(q, p, OVERLAP_TOLERANCE);
}

/**
 * Whether two cells, corners as `cellCornersInto` writes them, face each
 * other back to back: the ways they reach from their roads point opposite
 * ways within 30 degrees. Only multiply, add and compare, with
 * tan^2(30 degrees) = 1/3, so every machine agrees.
 */
function cellsFace(p: Float64Array, q: Float64Array): boolean {
  // Outer start minus inner start: the way each reaches from its road.
  const px = (p[6] ?? 0) - (p[0] ?? 0);
  const pz = (p[7] ?? 0) - (p[1] ?? 0);
  const qx = (q[6] ?? 0) - (q[0] ?? 0);
  const qz = (q[7] ?? 0) - (q[1] ?? 0);
  const dot = px * qx + pz * qz;
  const cross = px * qz - pz * qx;
  return dot < 0 && 3 * cross * cross < dot * dot;
}

/**
 * Whether two cells overlap enough that only one may hold the ground: by
 * more than `OVERLAP_TOLERANCE`, or by more than `FACING_TOLERANCE` when
 * they face each other back to back. For cell against cell only; a cell
 * against a road surface is `quadsOverlap`.
 */
export function cellsOverlap(p: Float64Array, q: Float64Array): boolean {
  const tolerance = cellsFace(p, q) ? FACING_TOLERANCE : OVERLAP_TOLERANCE;
  return !separatedByEdgeOf(p, q, tolerance) && !separatedByEdgeOf(q, p, tolerance);
}

/** Whether point (x, z) is inside convex quad `q` or on its edge. */
export function quadContains(q: Float64Array, x: number, z: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[i * 2] ?? 0;
    const az = q[i * 2 + 1] ?? 0;
    const bx = q[((i + 1) % 4) * 2] ?? 0;
    const bz = q[((i + 1) % 4) * 2 + 1] ?? 0;
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** The centre of a quad, the mean of its corners. */
export function quadCentre(q: Float64Array): { x: number; z: number } {
  return {
    x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4,
    z: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4,
  };
}
