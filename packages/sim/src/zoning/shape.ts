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

/** Pieces in the polyline that measures a curve. The same as `curveLength`. */
const CURVE_STEPS = 16;

/**
 * Two shapes overlap only by more than this many metres. Cells that share an
 * edge, and a cell that starts exactly at a road's edge, then do not count as
 * overlapping, whatever the rounding. A tolerance, not a balance number.
 */
export const OVERLAP_TOLERANCE = 0.01;

/**
 * A segment with less than this left past its last whole cell, in metres,
 * gets no extra surface piece. Stops a rounding sliver making a piece of no
 * length.
 */
const STATION_TOLERANCE = 1e-6;

/** Floats per station in a station array: x, z, then the left normal's x and z. */
export const STATION_FLOATS = 4;

/** Whole cells along a segment of `length` metres, for cells of `cellSize`. */
export function cellsAlong(length: number, cellSize: number): number {
  // A length snapped to whole cells can come back a hair short from the
  // square root that measures it, so a whole cell is allowed that hair.
  const n = Math.floor(length / cellSize + 1e-9);
  return n > 0 ? n : 0;
}

/**
 * The stations of the curve from (ax, az) through (cx, cz) to (bx, bz),
 * `length` metres long: one every `step` metres from A for `whole` steps,
 * then one at B if B lies past the last of them. Four floats each, as
 * STATION_FLOATS says.
 */
export function stationsOf(
  ax: number,
  az: number,
  cx: number,
  cz: number,
  bx: number,
  bz: number,
  length: number,
  step: number,
  whole: number,
): Float64Array {
  const last = whole * step;
  const extra = length - last > STATION_TOLERANCE;
  const count = whole + 1 + (extra ? 1 : 0);
  const out = new Float64Array(count * STATION_FLOATS);
  const straight = cx === (ax + bx) / 2 && cz === (az + bz) / 2;
  // The chord: a straight segment's direction, and a curve's where its own is lost.
  const chordX = bx - ax;
  const chordZ = bz - az;
  // The polyline `curveLength` measures, as running lengths at t = i / 16.
  let cum: Float64Array | null = null;
  if (!straight) {
    cum = new Float64Array(CURVE_STEPS + 1);
    let px = ax;
    let pz = az;
    let run = 0;
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      const x = u * u * ax + 2 * u * t * cx + t * t * bx;
      const z = u * u * az + 2 * u * t * cz + t * t * bz;
      const dx = x - px;
      const dz = z - pz;
      run += Math.sqrt(dx * dx + dz * dz);
      cum[i] = run;
      px = x;
      pz = z;
    }
  }
  let piece = 0;
  for (let k = 0; k < count; k++) {
    const s = k <= whole ? k * step : length;
    let t: number;
    if (k === count - 1 && extra) t = 1;
    else if (cum === null) t = length > 0 ? s / length : 0;
    else {
      while (piece < CURVE_STEPS - 1 && (cum[piece + 1] ?? 0) < s) piece++;
      const from = cum[piece] ?? 0;
      const span = (cum[piece + 1] ?? 0) - from;
      let f = span > 0 ? (s - from) / span : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      t = (piece + f) / CURVE_STEPS;
    }
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let x: number;
    let z: number;
    // Direction of travel: half the curve's derivative.
    let dx: number;
    let dz: number;
    if (straight) {
      // Along the chord, so a road on a whole-metre line puts its cells on whole metres too.
      x = ax + t * chordX;
      z = az + t * chordZ;
      dx = chordX;
      dz = chordZ;
    } else {
      const u = 1 - t;
      x = u * u * ax + 2 * u * t * cx + t * t * bx;
      z = u * u * az + 2 * u * t * cz + t * t * bz;
      dx = cx - ax + t * (ax - 2 * cx + bx);
      dz = cz - az + t * (az - 2 * cz + bz);
    }
    let len: number = Math.sqrt(dx * dx + dz * dz);
    if (len === 0) {
      dx = chordX;
      dz = chordZ;
      len = Math.sqrt(dx * dx + dz * dz);
    }
    if (len === 0) {
      dx = 1;
      dz = 0;
      len = 1;
    }
    const at = k * STATION_FLOATS;
    out[at] = x;
    out[at + 1] = z;
    // Left of travel with north up: x east, z south, so (dz, -dx).
    out[at + 2] = dz / len;
    out[at + 3] = -dx / len;
  }
  return out;
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
 * right at `to`, right at `from`.
 */
export function surfaceInto(stations: Float64Array, from: number, to: number, half: number, out: Float64Array): void {
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
  out[0] = x0 + nx0 * half;
  out[1] = z0 + nz0 * half;
  out[2] = x1 + nx1 * half;
  out[3] = z1 + nz1 * half;
  out[4] = x1 - nx1 * half;
  out[5] = z1 - nz1 * half;
  out[6] = x0 - nx0 * half;
  out[7] = z0 - nz0 * half;
}

/** The box around a quad: writes min x, min z, max x, max z into `out`. */
export function quadBoxInto(q: Float64Array, out: Float64Array): void {
  let minX = q[0] ?? 0;
  let maxX = minX;
  let minZ = q[1] ?? 0;
  let maxZ = minZ;
  for (let i = 2; i < 8; i += 2) {
    const x = q[i] ?? 0;
    const z = q[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out[0] = minX;
  out[1] = minZ;
  out[2] = maxX;
  out[3] = maxZ;
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

/** Whether some edge of `p` separates the two quads, allowing them to overlap by the tolerance. */
function separatedByEdgeOf(p: Float64Array, q: Float64Array): boolean {
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
    if (overlap <= OVERLAP_TOLERANCE * Math.sqrt(len2)) return true;
  }
  return false;
}

/**
 * Whether two convex quads overlap by more than the tolerance. Quads that
 * only touch along an edge or at a corner do not.
 */
export function quadsOverlap(p: Float64Array, q: Float64Array): boolean {
  return !separatedByEdgeOf(p, q) && !separatedByEdgeOf(q, p);
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
