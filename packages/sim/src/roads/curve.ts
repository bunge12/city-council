// The shape of a segment: a quadratic curve from node A through its control
// point to node B. A straight segment has its control point exactly at the
// midpoint of its nodes, and every function here takes a short path for it
// that gives the same answers the straight-line code always gave.
//
// Everything here feeds command validation, so only add, subtract, multiply,
// divide and Math.sqrt (CLAUDE.md rule 6). Where a closed form would need
// more, the curve is cut in halves a fixed way until each piece is flat to
// within FLAT metres, so every engine takes the same steps to the same
// answer.

import type { RoadNetwork } from "./network";

/** A quadratic curve: start, control point and end, metres east and south. */
export interface Quad {
  ax: number;
  az: number;
  cx: number;
  cz: number;
  bx: number;
  bz: number;
}

/** A piece is flat once its curve is within this many metres of its chord. */
const FLAT = 1e-4;
/** Halvings before a piece counts as flat whatever it looks like. */
const MAX_DEPTH = 40;
/**
 * Two curves meet at most four times. Past this many separate meetings they
 * run along each other, and the search stops.
 */
const MAX_MEETINGS = 8;
/** Meetings closer than this along both curves are one meeting. */
const SAME_MEETING = 1e-7;
/** Samples taken before refining a nearest point. */
const NEAREST_SAMPLES = 16;
/** Newton steps that refine a nearest point. */
const NEAREST_STEPS = 12;

/** Pieces in the polyline that measures a curve's length (`curveLength`, and the zoning cells along it). */
export const CURVE_STEPS = 16;

/**
 * The running lengths of the polyline that measures the curve from (ax, az)
 * through (cx, cz) to (bx, bz): CURVE_STEPS pieces at t = i / CURVE_STEPS,
 * entry i the length up to piece i, entry CURVE_STEPS the whole. Only exact
 * operations, so every engine gets the same numbers. A segment's stored
 * length and the places of its zoning cells both come from here, so the two
 * can never disagree.
 */
export function curvePolyline(ax: number, az: number, cx: number, cz: number, bx: number, bz: number): Float64Array {
  const cum = new Float64Array(CURVE_STEPS + 1);
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
  return cum;
}

/** Whether the control point sits exactly at the midpoint, which makes a straight segment. */
export function isStraight(q: Quad): boolean {
  return q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
}

/** Segment `seg` of `net` as a curve, from node A to node B. */
export function segmentQuad(net: RoadNetwork, seg: number): Quad {
  const a = net.segA[seg] ?? 0;
  const b = net.segB[seg] ?? 0;
  return {
    ax: net.nodeX[a] ?? 0,
    az: net.nodeZ[a] ?? 0,
    cx: net.segCX[seg] ?? 0,
    cz: net.segCZ[seg] ?? 0,
    bx: net.nodeX[b] ?? 0,
    bz: net.nodeZ[b] ?? 0,
  };
}

/** A straight segment from (ax, az) to (bx, bz) as a curve. */
export function straightQuad(ax: number, az: number, bx: number, bz: number): Quad {
  return { ax, az, cx: (ax + bx) / 2, cz: (az + bz) / 2, bx, bz };
}

/** The point at parameter `t`, 0 at A and 1 at B. Exactly A at 0 and exactly B at 1. */
export function quadPoint(q: Quad, t: number): { x: number; z: number } {
  const u = 1 - t;
  return {
    x: u * u * q.ax + 2 * u * t * q.cx + t * t * q.bx,
    z: u * u * q.az + 2 * u * t * q.cz + t * t * q.bz,
  };
}

/**
 * The control point of the piece of `q` from parameter `t0` to `t1`. That
 * piece, from `quadPoint(q, t0)` through this to `quadPoint(q, t1)`, traces
 * the same path as `q` between them.
 */
export function subControl(q: Quad, t0: number, t1: number): { x: number; z: number } {
  const u0 = 1 - t0;
  const u1 = 1 - t1;
  const mid = u0 * t1 + t0 * u1;
  return {
    x: u0 * u1 * q.ax + mid * q.cx + t0 * t1 * q.bx,
    z: u0 * u1 * q.az + mid * q.cz + t0 * t1 * q.bz,
  };
}

/** The piece of `q` from `t0` to `t1` as a curve of its own. */
export function subQuad(q: Quad, t0: number, t1: number): Quad {
  const a = quadPoint(q, t0);
  const c = subControl(q, t0, t1);
  const b = quadPoint(q, t1);
  return { ax: a.x, az: a.z, cx: c.x, cz: c.z, bx: b.x, bz: b.z };
}

/**
 * The tightest radius along the curve, in metres. Infinity for a straight
 * segment, 0 for one that folds back on itself.
 *
 * The derivative is 2((C - A) + tD) with D = A - 2C + B, and the second
 * derivative is 2D, so the cross product of the two is the constant
 * 4 cross(C - A, D). The radius |B'|^3 / |B' x B''| is smallest where the
 * speed is, and the speed squared is a quadratic in t.
 */
export function minRadius(q: Quad): number {
  const ex = q.cx - q.ax;
  const ez = q.cz - q.az;
  const dx = q.ax - 2 * q.cx + q.bx;
  const dz = q.az - 2 * q.cz + q.bz;
  const cross = ex * dz - ez * dx;
  const d2 = dx * dx + dz * dz;
  if (cross === 0) {
    // On one line. Straight if the control point is between the ends, and a
    // fold back over itself otherwise.
    return ex * (q.bx - q.cx) + ez * (q.bz - q.cz) > 0 ? Infinity : 0;
  }
  let t = d2 > 0 ? -(ex * dx + ez * dz) / d2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const vx = 2 * (ex + t * dx);
  const vz = 2 * (ez + t * dz);
  const speed = Math.sqrt(vx * vx + vz * vz);
  return (speed * speed * speed) / (4 * (cross < 0 ? -cross : cross));
}

/** A box: smallest and largest x and z. */
export interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** The box around a curve's three points, which holds the whole curve. */
export function hullBox(q: Quad): Box {
  const minX = q.ax < q.bx ? q.ax : q.bx;
  const maxX = q.ax > q.bx ? q.ax : q.bx;
  const minZ = q.az < q.bz ? q.az : q.bz;
  const maxZ = q.az > q.bz ? q.az : q.bz;
  return {
    minX: q.cx < minX ? q.cx : minX,
    minZ: q.cz < minZ ? q.cz : minZ,
    maxX: q.cx > maxX ? q.cx : maxX,
    maxZ: q.cz > maxZ ? q.cz : maxZ,
  };
}

/** Where one coordinate of a curve turns, as a parameter strictly inside (0, 1), or null. */
function turning(a: number, c: number, b: number): number | null {
  const d = a - 2 * c + b;
  if (d === 0) return null;
  const t = (a - c) / d;
  return t > 0 && t < 1 ? t : null;
}

/** The smallest box that holds the curve. For a straight segment, the box of its ends. */
export function curveBox(q: Quad): Box {
  let minX = q.ax < q.bx ? q.ax : q.bx;
  let maxX = q.ax > q.bx ? q.ax : q.bx;
  let minZ = q.az < q.bz ? q.az : q.bz;
  let maxZ = q.az > q.bz ? q.az : q.bz;
  if (isStraight(q)) return { minX, minZ, maxX, maxZ };
  const tx = turning(q.ax, q.cx, q.bx);
  if (tx !== null) {
    const x = quadPoint(q, tx).x;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const tz = turning(q.az, q.cz, q.bz);
  if (tz !== null) {
    const z = quadPoint(q, tz).z;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

function boxesTouch(p: Box, q: Box): boolean {
  return p.minX <= q.maxX && q.minX <= p.maxX && p.minZ <= q.maxZ && q.minZ <= p.maxZ;
}

/** Whether the curve is within FLAT of its chord, measured the same way at every t. */
function flat(q: Quad): boolean {
  // The curve is the chord plus 2t(1 - t)(C - M), with M the chord's
  // midpoint, so it is never further from the chord's point at t than
  // half of |C - M|.
  const ex = q.cx - (q.ax + q.bx) / 2;
  const ez = q.cz - (q.az + q.bz) / 2;
  return ex * ex + ez * ez <= 4 * FLAT * FLAT;
}

/** The two halves of a curve, split at t = 1/2. */
function halves(q: Quad): [Quad, Quad] {
  const lx = (q.ax + q.cx) / 2;
  const lz = (q.az + q.cz) / 2;
  const rx = (q.cx + q.bx) / 2;
  const rz = (q.cz + q.bz) / 2;
  const mx = (lx + rx) / 2;
  const mz = (lz + rz) / 2;
  return [
    { ax: q.ax, az: q.az, cx: lx, cz: lz, bx: mx, bz: mz },
    { ax: mx, az: mz, cx: rx, cz: rz, bx: q.bx, bz: q.bz },
  ];
}

/** Twice the signed area of triangle p, q, r. Its sign says which side of pq r is on. */
export function orient(px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number {
  return (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
}

/** Whether r, known to be on the line through p and q, lies between them. */
function within(px: number, pz: number, qx: number, qz: number, rx: number, rz: number): boolean {
  return (
    (px < qx ? px : qx) <= rx && rx <= (px > qx ? px : qx) && (pz < qz ? pz : qz) <= rz && rz <= (pz > qz ? pz : qz)
  );
}

/** Whether straight segments pq and rs meet anywhere, ends included. */
export function segmentsMeet(
  px: number,
  pz: number,
  qx: number,
  qz: number,
  rx: number,
  rz: number,
  sx: number,
  sz: number,
): boolean {
  const d1 = orient(rx, rz, sx, sz, px, pz);
  const d2 = orient(rx, rz, sx, sz, qx, qz);
  const d3 = orient(px, pz, qx, qz, rx, rz);
  const d4 = orient(px, pz, qx, qz, sx, sz);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && within(rx, rz, sx, sz, px, pz)) return true;
  if (d2 === 0 && within(rx, rz, sx, sz, qx, qz)) return true;
  if (d3 === 0 && within(px, pz, qx, qz, rx, rz)) return true;
  if (d4 === 0 && within(px, pz, qx, qz, sx, sz)) return true;
  return false;
}

/**
 * Whether the straight segment from (ax, az) to (bx, bz) touches the box,
 * edges included. The bounding boxes must overlap and the box's corners must
 * not all lie strictly on one side of the line.
 */
export function segmentTouchesBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  if ((ax > bx ? ax : bx) < minX || (ax < bx ? ax : bx) > maxX) return false;
  if ((az > bz ? az : bz) < minZ || (az < bz ? az : bz) > maxZ) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const c1 = dx * (minZ - az) - dz * (minX - ax);
  const c2 = dx * (minZ - az) - dz * (maxX - ax);
  const c3 = dx * (maxZ - az) - dz * (minX - ax);
  const c4 = dx * (maxZ - az) - dz * (maxX - ax);
  if (c1 > 0 && c2 > 0 && c3 > 0 && c4 > 0) return false;
  if (c1 < 0 && c2 < 0 && c3 < 0 && c4 < 0) return false;
  return true;
}

/**
 * Whether the curve touches the box, edges included. A straight segment is
 * tested exactly. A curve is halved until each piece is either clear of the
 * box, inside it, or flat, and a flat piece is tested by its chord, so the
 * answer can be wrong only within FLAT of the box's edge.
 */
export function curveTouchesBox(q: Quad, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  if (isStraight(q)) return segmentTouchesBox(q.ax, q.az, q.bx, q.bz, minX, minZ, maxX, maxZ);
  const box = { minX, minZ, maxX, maxZ };
  const visit = (p: Quad, depth: number): boolean => {
    const hull = hullBox(p);
    if (!boxesTouch(hull, box)) return false;
    if (hull.minX >= minX && hull.maxX <= maxX && hull.minZ >= minZ && hull.maxZ <= maxZ) return true;
    if (depth >= MAX_DEPTH || flat(p)) return segmentTouchesBox(p.ax, p.az, p.bx, p.bz, minX, minZ, maxX, maxZ);
    const [l, r] = halves(p);
    return visit(l, depth + 1) || visit(r, depth + 1);
  };
  return visit(q, 0);
}

/** Where two curves meet: the parameter on each. */
export interface Meeting {
  t: number;
  u: number;
}

/** What `quadMeetings` found. */
export interface Meetings {
  /** Separate meetings, by `t` and then `u`. */
  at: Meeting[];
  /** True when the curves run along each other for a stretch, so the meetings are not separate points. */
  along: boolean;
}

/**
 * Where straight segments pq and rs meet, as a parameter on each, or null
 * when they do not. When they run along each other, `along` is set.
 */
function chordMeeting(p: Quad, q: Quad): Meeting | "along" | null {
  if (!segmentsMeet(p.ax, p.az, p.bx, p.bz, q.ax, q.az, q.bx, q.bz)) return null;
  const d1 = orient(q.ax, q.az, q.bx, q.bz, p.ax, p.az);
  const d2 = orient(q.ax, q.az, q.bx, q.bz, p.bx, p.bz);
  const d3 = orient(p.ax, p.az, p.bx, p.bz, q.ax, q.az);
  const d4 = orient(p.ax, p.az, p.bx, p.bz, q.bx, q.bz);
  if (d1 === d2 || d3 === d4) {
    // Parallel and touching, so on one line. A single shared end is a
    // meeting; anything longer runs along.
    const pLen = p.ax !== p.bx || p.az !== p.bz;
    const qLen = q.ax !== q.bx || q.az !== q.bz;
    if (!pLen || !qLen) return { t: 0, u: 0 };
    const sameEnd = (x: number, z: number, y: number, w: number) => x === y && z === w;
    const pa = sameEnd(p.ax, p.az, q.ax, q.az) || sameEnd(p.ax, p.az, q.bx, q.bz);
    const pb = sameEnd(p.bx, p.bz, q.ax, q.az) || sameEnd(p.bx, p.bz, q.bx, q.bz);
    const dot = (p.bx - p.ax) * (q.bx - q.ax) + (p.bz - p.az) * (q.bz - q.az);
    // Two pieces of one line that share just an end point away from each other.
    if (pa && !pb && (sameEnd(p.ax, p.az, q.ax, q.az) ? dot < 0 : dot > 0)) {
      return { t: 0, u: sameEnd(p.ax, p.az, q.ax, q.az) ? 0 : 1 };
    }
    if (pb && !pa && (sameEnd(p.bx, p.bz, q.bx, q.bz) ? dot < 0 : dot > 0)) {
      return { t: 1, u: sameEnd(p.bx, p.bz, q.ax, q.az) ? 0 : 1 };
    }
    return "along";
  }
  const t = d1 / (d1 - d2);
  const u = d3 / (d3 - d4);
  return { t: t < 0 ? 0 : t > 1 ? 1 : t, u: u < 0 ? 0 : u > 1 ? 1 : u };
}

/**
 * Every place two curves meet, ends included. The curves are halved, in a
 * fixed order, wherever their boxes overlap, until both pieces are flat;
 * then the pieces' chords are met. Each parameter is within FLAT metres of
 * the true meeting.
 */
export function quadMeetings(p: Quad, q: Quad): Meetings {
  const at: Meeting[] = [];
  let along = false;
  const visit = (pp: Quad, p0: number, p1: number, qq: Quad, q0: number, q1: number, depth: number): void => {
    if (along || !boxesTouch(hullBox(pp), hullBox(qq))) return;
    const pFlat = depth >= MAX_DEPTH || flat(pp);
    const qFlat = depth >= MAX_DEPTH || flat(qq);
    if (pFlat && qFlat) {
      const m = chordMeeting(pp, qq);
      if (m === "along") {
        along = true;
        return;
      }
      if (m === null) return;
      const t = p0 + (p1 - p0) * m.t;
      const u = q0 + (q1 - q0) * m.u;
      for (const seen of at) {
        const dt = seen.t - t;
        const du = seen.u - u;
        if ((dt < 0 ? -dt : dt) < SAME_MEETING && (du < 0 ? -du : du) < SAME_MEETING) return;
      }
      at.push({ t, u });
      if (at.length > MAX_MEETINGS) along = true;
      return;
    }
    // Halve whichever is not flat, the first curve first.
    if (!pFlat) {
      const [l, r] = halves(pp);
      const pm = (p0 + p1) / 2;
      visit(l, p0, pm, qq, q0, q1, depth + 1);
      visit(r, pm, p1, qq, q0, q1, depth + 1);
    } else {
      const [l, r] = halves(qq);
      const qm = (q0 + q1) / 2;
      visit(pp, p0, p1, l, q0, qm, depth + 1);
      visit(pp, p0, p1, r, qm, q1, depth + 1);
    }
  };
  visit(p, 0, 1, q, 0, 1, 0);
  at.sort((m, n) => m.t - n.t || m.u - n.u);
  return { at, along };
}

/** How close to a shared end a meeting can be and still count as that end. */
const AT_END = 1e-3;

/**
 * Whether two curves meet anywhere except at the given shared points, such
 * as a node both end at. Running along each other counts as meeting.
 */
export function quadsMeetAwayFrom(p: Quad, q: Quad, shared: readonly { x: number; z: number }[]): boolean {
  if (shared.length === 0 && isStraight(p) && isStraight(q)) {
    return segmentsMeet(p.ax, p.az, p.bx, p.bz, q.ax, q.az, q.bx, q.bz);
  }
  const found = quadMeetings(p, q);
  if (found.along) return true;
  for (const m of found.at) {
    const pt = quadPoint(p, m.t);
    const near = shared.some((s) => (pt.x - s.x) * (pt.x - s.x) + (pt.z - s.z) * (pt.z - s.z) <= AT_END * AT_END);
    if (!near) return true;
  }
  return false;
}

/** The nearest point on a curve to a point. */
export interface QuadNearest {
  t: number;
  x: number;
  z: number;
  /** Squared distance. */
  d2: number;
}

/**
 * The point on the curve nearest (x, z). A straight segment is projected
 * onto. A curve is sampled at fixed parameters and the best sample refined
 * by a fixed number of Newton steps on the distance's derivative, held
 * between its neighbouring samples.
 */
export function nearestOnQuad(q: Quad, x: number, z: number): QuadNearest {
  if (isStraight(q)) {
    const sx = q.bx - q.ax;
    const sz = q.bz - q.az;
    const len2 = sx * sx + sz * sz;
    let t = len2 > 0 ? ((x - q.ax) * sx + (z - q.az) * sz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = q.ax + t * sx;
    const pz = q.az + t * sz;
    return { t, x: px, z: pz, d2: (px - x) * (px - x) + (pz - z) * (pz - z) };
  }
  const d2At = (t: number): number => {
    const p = quadPoint(q, t);
    return (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
  };
  let bestT = 0;
  let bestD2 = d2At(0);
  for (let i = 1; i <= NEAREST_SAMPLES; i++) {
    const t = i / NEAREST_SAMPLES;
    const d2 = d2At(t);
    if (d2 < bestD2) {
      bestT = t;
      bestD2 = d2;
    }
  }
  const lo = bestT - 1 / NEAREST_SAMPLES < 0 ? 0 : bestT - 1 / NEAREST_SAMPLES;
  const hi = bestT + 1 / NEAREST_SAMPLES > 1 ? 1 : bestT + 1 / NEAREST_SAMPLES;
  const ex = q.cx - q.ax;
  const ez = q.cz - q.az;
  const dx = q.ax - 2 * q.cx + q.bx;
  const dz = q.az - 2 * q.cz + q.bz;
  let t = bestT;
  for (let k = 0; k < NEAREST_STEPS; k++) {
    // Half the derivative of the squared distance, and its derivative.
    const p = quadPoint(q, t);
    const vx = ex + t * dx;
    const vz = ez + t * dz;
    const f = (p.x - x) * vx + (p.z - z) * vz;
    const df = 2 * (vx * vx + vz * vz) + (p.x - x) * dx + (p.z - z) * dz;
    if (df <= 0) break;
    let next = t - f / df;
    next = next < lo ? lo : next > hi ? hi : next;
    if (next === t) break;
    t = next;
  }
  const d2 = d2At(t);
  if (d2 < bestD2) {
    bestT = t;
    bestD2 = d2;
  }
  const p = quadPoint(q, bestT);
  return { t: bestT, x: p.x, z: p.z, d2: bestD2 };
}
