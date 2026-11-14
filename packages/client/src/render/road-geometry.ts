// Road geometry, as plain typed arrays. No three.js here, so the shapes can
// be tested in Node.
//
// Everything is built from the mirror's read-only copy of the road graph and
// the terrain. The sim knows nothing about meshes, and nothing here is saved.
//
// A road segment is a strip between its two nodes, cut back at each end by
// the junction there. A junction is one polygon around its node that meets
// every strip's cut edge exactly, so strips and junctions tile the road area
// with no gaps and no overlaps. The polygon is a fan from the node:
//
// - Between two neighbouring roads whose angle is under 180 degrees, the
//   kerbs meet at a corner. Each road is cut back far enough to clear the
//   corner on both of its sides.
// - Between two roads more than 180 degrees apart, the outer kerbs are
//   joined by a miter point, or by a bevel at the node when the miter would
//   reach too far.
// - A road with nothing on the other side (a dead end) ends square at its
//   node, with no junction.
//
// Positions are world metres. Pieces of a strip are split at chunk lines and
// every piece belongs to the chunk holding its middle, and a junction belongs
// to its node's chunk. So each chunk's mesh is built on its own from the
// graph, and a vertex on a chunk line is computed the same way on both sides.
//
// A segment is the straight line between its nodes, or one quadratic curve
// through its control point (issue 09). Either way it is drawn along a path
// measured in metres from node A: a curve is cut into short straight pieces,
// closer together where it bends harder, and fewer for the city band's
// lines than for the street-level surface. A junction cuts a curved road
// back along the curve, and its polygon meets the cut edge exactly where the
// strip ends, so there is no gap.
//
// A bridge (issue 11) is drawn at its deck's height, which the sim's
// `bridgeDeckHeight` gives from its bank nodes and the water, not on the
// ground: the deck, a fascia and railing along each edge, and piers from
// under the deck down to the ground or the lake bed below.
//
// A segment on another level (issue 22) is drawn the same way at its own
// height, `levelOffset` above the ground under it, with piers along it when
// it is above the ground. A junction whose roads are all on one such level
// is drawn at that height too. A tunnel is drawn below the ground, where the
// terrain hides it until M5's underground view.

import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  LEVEL_BRIDGE,
  LEVEL_GROUND,
  NETWORK_ROAD,
  NODE_ALIVE,
  NONE,
  ROAD_TYPES,
  SEG_ALIVE,
  bridgeDeckHeight,
  bridgeDeckLevel,
  bridgeRamps,
  heightAt,
  isStraight,
  levelOffset,
  minRadius,
  quadPoint,
  segmentQuad,
  type Quad,
  type RoadNetwork,
  type RoadType,
  type Terrain,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import { ROADS } from "./config";
import { normalAt } from "./terrain-chunks";

/** The road graph as the client holds it. */
export type RoadNet = ReadonlyDeep<RoadNetwork>;

// ---------------------------------------------------------------------------
// Reading the graph

export function liveRoadSegment(net: RoadNet, seg: number): boolean {
  return seg >= 0 && seg < net.segFlags.length && ((net.segFlags[seg] ?? 0) & SEG_ALIVE) !== 0 && net.segNetwork[seg] === NETWORK_ROAD;
}

export function liveNode(net: RoadNet, node: number): boolean {
  return node >= 0 && node < net.nodeFlags.length && ((net.nodeFlags[node] ?? 0) & NODE_ALIVE) !== 0;
}

/**
 * How far above the ground under it segment `seg` is drawn, `s` metres
 * along it, when it is on a level other than the ground and not a bridge.
 * Runs evenly from one end's level to the other's on a ramp.
 */
export function levelLift(net: RoadNet, seg: number, s: number, length: number): number {
  const a = levelOffset(net.segLevelA[seg] ?? LEVEL_GROUND);
  const b = levelOffset(net.segLevelB[seg] ?? LEVEL_GROUND);
  return length > 0 ? a + ((b - a) * s) / length : a;
}

/** Whether segment `seg` is off the ground at either end and not a bridge: an elevated road, a tunnel or a ramp. */
export function isRaised(net: RoadNet, seg: number): boolean {
  const a = net.segLevelA[seg] ?? LEVEL_GROUND;
  const b = net.segLevelB[seg] ?? LEVEL_GROUND;
  return a !== LEVEL_BRIDGE && (a !== LEVEL_GROUND || b !== LEVEL_GROUND);
}

/**
 * How far above the ground a junction at `node` is drawn: the height of the
 * level its road segments all have there, or 0 when they are on the ground
 * or do not agree.
 */
export function nodeLift(net: RoadNet, node: number): number {
  let level = -1;
  for (const seg of roadSegmentsAt(net, node)) {
    const here = (net.segA[seg] === node ? net.segLevelA[seg] : net.segLevelB[seg]) ?? LEVEL_GROUND;
    if (level === -1) level = here;
    else if (level !== here) return 0;
  }
  return level === -1 || level === LEVEL_BRIDGE ? 0 : levelOffset(level);
}

/** Road segments at `node`, in list order. */
export function roadSegmentsAt(net: RoadNet, node: number): number[] {
  const out: number[] = [];
  if (!liveNode(net, node)) return out;
  let steps = 0;
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE && steps <= net.segFlags.length; steps++) {
    if (liveRoadSegment(net, seg)) out.push(seg);
    seg = (net.segA[seg] === node ? net.segNextA[seg] : net.segNextB[seg]) ?? NONE;
  }
  return out;
}

export function roadTypeOf(net: RoadNet, seg: number): RoadType {
  return ROAD_TYPES[net.segType[seg] ?? 0] ?? (ROAD_TYPES[0] as RoadType);
}

/** Chunk index `cj * CHUNKS_PER_SIDE + ci` holding (x, z), with off-map points in the nearest edge chunk. */
export function chunkAt(x: number, z: number): number {
  const last = CHUNKS_PER_SIDE - 1;
  const ci = Math.min(last, Math.max(0, Math.floor(x / CHUNK_SIZE)));
  const cj = Math.min(last, Math.max(0, Math.floor(z / CHUNK_SIZE)));
  return cj * CHUNKS_PER_SIDE + ci;
}

/** A point on a road's centre line, its unit direction toward node B and its left normal, (-dz, dx). */
export interface PathFrame {
  x: number;
  z: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
}

/**
 * A road segment's centre line, by distance `s` in metres from node A. A
 * straight one is the line between its nodes. A curve is measured along a
 * dense polyline, and a distance maps to the curve parameter through it, so
 * every point drawn is on the true curve.
 */
export class SegPath {
  readonly seg: number;
  readonly type: RoadType;
  readonly half: number;
  /** Length along the centre line, metres. */
  readonly length: number;
  readonly curved: boolean;
  /** Node A. */
  readonly ax: number;
  readonly az: number;
  /** Straight only: the unit direction from A to B. */
  readonly dx: number;
  readonly dz: number;
  /** Tightest radius, metres. Infinity when straight. */
  readonly radius: number;
  private readonly quad: Quad;
  /** Curve only: distance from A at parameter i / steps. */
  private readonly dist: Float64Array;
  private readonly steps: number;

  constructor(net: RoadNet, seg: number) {
    const quad = segmentQuad(net as RoadNetwork, seg);
    this.seg = seg;
    this.quad = quad;
    this.type = roadTypeOf(net, seg);
    this.half = this.type.width / 2;
    this.ax = quad.ax;
    this.az = quad.az;
    this.curved = !isStraight(quad);
    if (!this.curved) {
      const ex = quad.bx - quad.ax;
      const ez = quad.bz - quad.az;
      const length = Math.sqrt(ex * ex + ez * ez);
      this.length = length;
      this.dx = length > 0 ? ex / length : 1;
      this.dz = length > 0 ? ez / length : 0;
      this.radius = Infinity;
      this.dist = new Float64Array(0);
      this.steps = 0;
      return;
    }
    const hull = Math.hypot(quad.cx - quad.ax, quad.cz - quad.az) + Math.hypot(quad.bx - quad.cx, quad.bz - quad.cz);
    const steps = Math.min(ROADS.curves.maxTableSteps, Math.max(32, Math.ceil(hull / ROADS.curves.tableStep)));
    const dist = new Float64Array(steps + 1);
    let prev = quadPoint(quad, 0);
    for (let i = 1; i <= steps; i++) {
      const p = quadPoint(quad, i / steps);
      dist[i] = (dist[i - 1] ?? 0) + Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    this.steps = steps;
    this.dist = dist;
    this.length = dist[steps] ?? 0;
    const d = quadDirection(quad, 0);
    this.dx = d.dx;
    this.dz = d.dz;
    this.radius = minRadius(quad);
  }

  /** The curve parameter at distance `s` from node A. */
  private paramAt(s: number): number {
    const { dist, steps } = this;
    if (s <= 0) return 0;
    if (s >= this.length) return 1;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((dist[mid] ?? 0) <= s) lo = mid;
      else hi = mid;
    }
    const d0 = dist[lo] ?? 0;
    const d1 = dist[lo + 1] ?? d0;
    return (lo + (d1 > d0 ? (s - d0) / (d1 - d0) : 0)) / steps;
  }

  /** Distance from node A at curve parameter `t`. */
  private distanceAt(t: number): number {
    if (!this.curved) return t * this.length;
    const k = t * this.steps;
    const i = Math.min(this.steps - 1, Math.max(0, Math.floor(k)));
    const d0 = this.dist[i] ?? 0;
    const d1 = this.dist[i + 1] ?? d0;
    return d0 + (d1 - d0) * (k - i);
  }

  /** The point at distance `s` from node A. */
  point(s: number): { x: number; z: number } {
    if (!this.curved) return { x: this.ax + this.dx * s, z: this.az + this.dz * s };
    return quadPoint(this.quad, this.paramAt(s));
  }

  /** The point, direction and left normal at distance `s` from node A. */
  frame(s: number): PathFrame {
    if (!this.curved) return { x: this.ax + this.dx * s, z: this.az + this.dz * s, dx: this.dx, dz: this.dz, nx: -this.dz, nz: this.dx };
    const t = this.paramAt(s);
    const p = quadPoint(this.quad, t);
    const d = quadDirection(this.quad, t);
    return { x: p.x, z: p.z, dx: d.dx, dz: d.dz, nx: -d.dz, nz: d.dx };
  }

  /** The unit direction leaving node A (`fromA`) or node B, away from the node. */
  leaving(fromA: boolean): { dx: number; dz: number } {
    if (!this.curved) return fromA ? { dx: this.dx, dz: this.dz } : { dx: -this.dx, dz: -this.dz };
    const d = quadDirection(this.quad, fromA ? 0 : 1);
    return fromA ? d : { dx: -d.dx, dz: -d.dz };
  }

  /**
   * Distances from `s0` to `s1` where the road is cut into pieces, in
   * ascending order: both ends, every chunk line crossing between, and
   * enough in between that no piece is longer than `step` or, on a curve,
   * turns through more than `turn` radians. Each piece lies in one chunk.
   */
  stations(s0: number, s1: number, step: number, turn: number = ROADS.curves.surfaceTurn): number[] {
    if (!this.curved) return stations(this.ax, this.az, this.dx, this.dz, s0, s1, step);
    const bend = Math.max(ROADS.curves.minPiece, this.radius * turn);
    const spacing = step > 0 ? Math.min(step, bend) : bend;
    const out = [s0, s1];
    for (let s = Math.floor(s0 / spacing + 1) * spacing; s < s1; s += spacing) out.push(s);
    for (const t of chunkLineParams(this.quad)) {
      const s = this.distanceAt(t);
      if (s > s0 && s < s1) out.push(s);
    }
    return mergeStations(out, s1);
  }
}

/** The unit direction of a curve at parameter `t`. */
function quadDirection(q: Quad, t: number): { dx: number; dz: number } {
  let vx = q.cx - q.ax + t * (q.ax - 2 * q.cx + q.bx);
  let vz = q.cz - q.az + t * (q.az - 2 * q.cz + q.bz);
  let len = Math.hypot(vx, vz);
  if (len < 1e-12) {
    // The control point sits on an end, so the direction there is toward the other end.
    vx = q.bx - q.ax;
    vz = q.bz - q.az;
    len = Math.hypot(vx, vz) || 1;
  }
  return { dx: vx / len, dz: vz / len };
}

/** Parameters strictly inside (0, 1) where a curve crosses a chunk line. */
function chunkLineParams(q: Quad): number[] {
  const out: number[] = [];
  for (const [a, c, b] of [
    [q.ax, q.cx, q.bx],
    [q.az, q.cz, q.bz],
  ] as const) {
    // a(1-t)^2 + 2c t(1-t) + b t^2 = k: (a - 2c + b) t^2 + 2(c - a) t + (a - k) = 0.
    const lo = Math.ceil(Math.min(a, b, c) / CHUNK_SIZE);
    const hi = Math.floor(Math.max(a, b, c) / CHUNK_SIZE);
    const qa = a - 2 * c + b;
    const qb = 2 * (c - a);
    for (let k = lo; k <= hi; k++) {
      const qc = a - k * CHUNK_SIZE;
      const roots: number[] = [];
      if (Math.abs(qa) < 1e-12) {
        if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
      } else {
        const disc = qb * qb - 4 * qa * qc;
        if (disc >= 0) {
          const r = Math.sqrt(disc);
          roots.push((-qb - r) / (2 * qa), (-qb + r) / (2 * qa));
        }
      }
      for (const t of roots) if (t > 0 && t < 1) out.push(t);
    }
  }
  return out;
}

/** Sorts stations and drops any too close to the one before, keeping `s1` exactly. */
function mergeStations(out: number[], s1: number): number[] {
  out.sort((x, y) => x - y);
  const merged: number[] = [];
  for (const t of out) {
    const prev = merged[merged.length - 1];
    if (prev === undefined || t - prev > 1e-6) merged.push(t);
    else if (t === s1) merged[merged.length - 1] = s1;
  }
  return merged;
}

/** Segment `seg`'s path. */
export function segPath(net: RoadNet, seg: number): SegPath {
  return new SegPath(net, seg);
}

/**
 * Distances along a line where it crosses a chunk line, strictly between
 * `t0` and `t1`, plus `t0`, `t1` and every multiple of `step` between, in
 * ascending order. Each gap between two stations lies in one chunk.
 */
export function stations(ax: number, az: number, dx: number, dz: number, t0: number, t1: number, step: number): number[] {
  const out = [t0, t1];
  if (step > 0) for (let t = Math.floor(t0 / step + 1) * step; t < t1; t += step) out.push(t);
  for (const [p, d] of [
    [ax, dx],
    [az, dz],
  ] as const) {
    if (Math.abs(d) < 1e-12) continue;
    const from = p + d * t0;
    const to = p + d * t1;
    const lo = Math.ceil(Math.min(from, to) / CHUNK_SIZE);
    const hi = Math.floor(Math.max(from, to) / CHUNK_SIZE);
    for (let k = lo; k <= hi; k++) {
      const t = (k * CHUNK_SIZE - p) / d;
      if (t > t0 && t < t1) out.push(t);
    }
  }
  // Drop stations too close to the one before; keep t1 exactly.
  return mergeStations(out, t1);
}

/** Chunks the pieces of `path` between `s0` and `s1` lie in. */
function pathChunks(path: SegPath, s0: number, s1: number, into: Set<number>): void {
  const st = path.stations(s0, s1, 0);
  if (st.length < 2) {
    const p = path.point(s0);
    into.add(chunkAt(p.x, p.z));
  }
  for (let k = 0; k + 1 < st.length; k++) {
    const p = path.point(((st[k] ?? 0) + (st[k + 1] ?? 0)) / 2);
    into.add(chunkAt(p.x, p.z));
  }
}

/** Chunks a straight line from (ax, az) through `length` metres along (dx, dz) passes through. */
export function lineChunks(ax: number, az: number, dx: number, dz: number, length: number, into: Set<number>): void {
  const st = stations(ax, az, dx, dz, 0, length, 0);
  if (st.length < 2) into.add(chunkAt(ax, az));
  for (let k = 0; k + 1 < st.length; k++) {
    const mid = ((st[k] ?? 0) + (st[k + 1] ?? 0)) / 2;
    into.add(chunkAt(ax + dx * mid, az + dz * mid));
  }
}

// ---------------------------------------------------------------------------
// Junctions

/** The shape where roads meet at a node. */
export interface Junction {
  node: number;
  x: number;
  z: number;
  /** Road segments at the node, by angle. */
  segs: number[];
  /** How far each road in `segs` is cut back from the node, metres. */
  trims: number[];
  /** Polygon around the node, x and z pairs in angle order. Empty when no polygon is needed. */
  ring: number[];
  /** The widest road type at the node, which colours the polygon. */
  type: RoadType;
}

interface Arm {
  seg: number;
  /** The node at the road's other end. */
  far: number;
  /** Unit direction away from the node, and left normal. */
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  half: number;
  length: number;
  angle: number;
  type: RoadType;
  /** The road's path, and whether it leaves this node from its node A. */
  path: SegPath;
  fromA: boolean;
}

function armsAt(net: RoadNet, node: number): Arm[] {
  const arms: Arm[] = [];
  for (const seg of roadSegmentsAt(net, node)) {
    const path = segPath(net, seg);
    const fromA = net.segA[seg] === node;
    const { dx, dz } = path.leaving(fromA);
    const far = (fromA ? net.segB[seg] : net.segA[seg]) ?? NONE;
    arms.push({ seg, far, dx, dz, nx: -dz, nz: dx, half: path.half, length: path.length, angle: Math.atan2(dz, dx), type: path.type, path, fromA });
  }
  // By angle, ties by id, so the order never depends on list order.
  arms.sort((p, q) => p.angle - q.angle || p.seg - q.seg);
  return arms;
}

/**
 * Where the left kerb of `i` meets the right kerb of `j`, as distances along
 * each arm from the node. Null when the kerbs are parallel.
 */
function kerbMeet(i: Arm, j: Arm): { ti: number; tj: number } | null {
  // node + n_i h_i + t d_i = node - n_j h_j + s d_j
  const rx = -(j.nx * j.half + i.nx * i.half);
  const rz = -(j.nz * j.half + i.nz * i.half);
  const det = -(i.dx * j.dz - i.dz * j.dx);
  if (Math.abs(det) < 1e-9) return null;
  let ti = (-rx * j.dz + j.dx * rz) / det;
  let tj = (i.dx * rz - i.dz * rx) / det;
  if (!i.path.curved && !j.path.curved) return { ti, tj };
  // A curved kerb bends away from its tangent. Meet the kerbs' tangent
  // lines where they are now, step to that meeting, and repeat.
  for (let k = 0; k < KERB_STEPS; k++) {
    const p = armKerb(i, ti, 1);
    const q = armKerb(j, tj, -1);
    const d = -(p.dx * q.dz - p.dz * q.dx);
    if (Math.abs(d) < 1e-9) break;
    const ex = q.x - p.x;
    const ez = q.z - p.z;
    const a = (-ex * q.dz + q.dx * ez) / d;
    const b = (p.dx * ez - p.dz * ex) / d;
    ti += a;
    tj += b;
    if (Math.abs(a) < 1e-7 && Math.abs(b) < 1e-7) break;
  }
  return { ti, tj };
}

/** Steps that walk a corner along two curved kerbs. */
const KERB_STEPS = 12;

/**
 * A kerb of arm `a` at distance `t` from the node: left with `side` 1,
 * right with -1. The point, and the direction away from the node. Before
 * the node and on a straight road, along the line the road leaves on.
 */
function armKerb(a: Arm, t: number, side: number): { x: number; z: number; dx: number; dz: number } {
  const node = a.path.frame(a.fromA ? 0 : a.path.length);
  if (!a.path.curved || t <= 0) {
    return { x: node.x + a.dx * t + a.nx * a.half * side, z: node.z + a.dz * t + a.nz * a.half * side, dx: a.dx, dz: a.dz };
  }
  const f = a.path.frame(a.fromA ? Math.min(t, a.path.length) : Math.max(0, a.path.length - t));
  const s = a.fromA ? side : -side;
  return { x: f.x + f.nx * a.half * s, z: f.z + f.nz * a.half * s, dx: a.fromA ? f.dx : -f.dx, dz: a.fromA ? f.dz : -f.dz };
}

/** Angle from arm `i` round to arm `j`, in (0, 2pi]. */
function gapAngle(i: Arm, j: Arm): number {
  let g = j.angle - i.angle;
  while (g <= 0) g += 2 * Math.PI;
  return g;
}

/** Near 180 degrees, two kerbs are one straight line and need no corner. */
const STRAIGHT = 1e-4;

/** The junction at `node`, or null if fewer than two roads meet there. */
export function junctionAt(net: RoadNet, node: number): Junction | null {
  const arms = armsAt(net, node);
  if (arms.length < 2) return null;
  const x = net.nodeX[node] ?? 0;
  const z = net.nodeZ[node] ?? 0;
  const k = arms.length;
  const trims = arms.map(() => 0);
  const gaps = arms.map((a, i) => gapAngle(a, arms[(i + 1) % k] as Arm));
  const meets = arms.map((a, i) => kerbMeet(a, arms[(i + 1) % k] as Arm));
  const at = (a: Arm, t: number) =>
    a.path.curved ? armKerb(a, t, 1) : { x: x + a.dx * t + a.nx * a.half, z: z + a.dz * t + a.nz * a.half };

  // First the corners under 180 degrees, which set how far each road is cut
  // back. Where a narrow road meets a wide one nearly head on, the kerbs
  // meet behind the wide road's node, and the narrow road tapers into it.
  const corners: ({ x: number; z: number } | "bevel" | null)[] = arms.map(() => null);
  // Corners whose kerbs turn through an arc rather than meet at a point,
  // and how far along each kerb the arc's ends lie: before the cut, when
  // another corner cuts the road back further.
  const rounded = arms.map(() => false);
  const arcFrom = arms.map(() => 0);
  const arcTo = arms.map(() => 0);
  const taper = taperArms(arms, gaps);
  for (let i = 0; i < k; i++) {
    const meet = meets[i];
    const gap = gaps[i] ?? 0;
    if (!meet || gap >= Math.PI - STRAIGHT) continue;
    if ((meet.ti < 0 && meet.tj < 0) || meet.ti > ROADS.maxTrim || meet.tj > ROADS.maxTrim) continue;
    const a = arms[i] as Arm;
    const b = arms[(i + 1) % k] as Arm;
    // Room for the arc: each kerb gives up the arc's tangent length past the sharp corner.
    let cut = 0;
    if (!taper && meet.ti >= 0 && meet.tj >= 0) {
      const radius = Math.min(cornerRadius(a.type), cornerRadius(b.type));
      cut = Math.min(ROADS.corners.maxCut, radius / Math.tan(gap / 2));
      rounded[i] = cut > 1e-3;
      arcFrom[i] = meet.ti + cut;
      arcTo[i] = meet.tj + cut;
    }
    trims[i] = Math.max(trims[i] ?? 0, meet.ti + cut);
    trims[(i + 1) % k] = Math.max(trims[(i + 1) % k] ?? 0, meet.tj + cut);
    corners[i] = at(a, meet.ti);
  }
  // A narrow road running on into a wide one widens over a stretch of its own length.
  if (taper) {
    const narrow = taper.narrow;
    const n = arms[narrow] as Arm;
    const w = arms[1 - narrow] as Arm;
    trims[narrow] = Math.max(trims[narrow] ?? 0, Math.min(ROADS.maxTrim, (w.half - n.half) * ROADS.taper.ratio));
  }
  // A short road cannot give more than half its length to each end, or all
  // of it when the far end is a dead end. Where that leaves a corner short
  // of the cut, the kerbs join straight across.
  for (let i = 0; i < k; i++) {
    const a = arms[i] as Arm;
    const share = roadSegmentsAt(net, a.far).length > 1 ? a.length / 2 : a.length;
    trims[i] = Math.min(trims[i] ?? 0, share);
  }
  for (let i = 0; i < k; i++) {
    const meet = meets[i];
    if (!corners[i] || !meet) continue;
    if ((trims[i] ?? 0) < meet.ti - 1e-9 || (trims[(i + 1) % k] ?? 0) < meet.tj - 1e-9) corners[i] = null;
  }

  // Then the corners over 180 degrees, round the outside. A miter point is
  // used only when it is near and lies on neither road's strip, so it fills
  // the outer corner without covering road the strips already draw.
  for (let i = 0; i < k; i++) {
    const gap = gaps[i] ?? 0;
    // Round the outside of a taper the kerbs run straight from the narrow road's cut to the wide one's.
    if (gap <= Math.PI + STRAIGHT || taper) continue;
    const a = arms[i] as Arm;
    const b = arms[(i + 1) % k] as Arm;
    const meet = meets[i];
    corners[i] = "bevel";
    if (!meet || meet.ti > (trims[i] ?? 0) || meet.tj > (trims[(i + 1) % k] ?? 0)) continue;
    const p = at(a, meet.ti);
    const reach = Math.sqrt((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z));
    if (reach <= ROADS.miterLimit * Math.max(a.half, b.half)) corners[i] = p;
  }

  // A wide road's kerbs at the node can stand out past a narrow
  // neighbour's, as at a sharp fork. Every kerb corner at the node that
  // lies on no other road's strip, past its cut, goes into the polygon
  // below. A corner it falls in stays sharp, so the polygon still reaches it.
  const onStrip = (px: number, pz: number) =>
    arms.some((b, i) => {
      const t = px * b.dx + pz * b.dz;
      const o = px * b.nx + pz * b.nz;
      return t > (trims[i] ?? 0) + 1e-6 && Math.abs(o) < b.half - 1e-6;
    });
  const kerbCorners: [number, number][] = [];
  for (const a of arms) {
    for (const side of [1, -1]) {
      const px = a.nx * a.half * side;
      const pz = a.nz * a.half * side;
      if (!onStrip(px, pz)) kerbCorners.push([px, pz]);
    }
  }
  /** The corner between arm i and the next that the ray from the node through (px, pz) passes, or -1. */
  const cornerOf = (px: number, pz: number): number => {
    const ang = Math.atan2(pz, px);
    for (let i = 0; i < k; i++) {
      let off = ang - (arms[i] as Arm).angle;
      while (off < 0) off += 2 * Math.PI;
      while (off >= 2 * Math.PI) off -= 2 * Math.PI;
      if (off > 1e-9 && off < (gaps[i] ?? 0) - 1e-9) return i;
    }
    return -1;
  };

  const makeRing = (): number[] => {
    const ring: number[] = [];
    for (let i = 0; i < k; i++) {
      const a = arms[i] as Arm;
      const t = trims[i] ?? 0;
      if (a.path.curved) {
        // A curved kerb bends away from the straight line between the corner
        // and the cut, so the polygon follows it there.
        const before = (i + k - 1) % k;
        kerbRun(ring, a, kerbStart(corners[before], rounded[before] ? Math.min(arcTo[before] ?? 0, t) : undefined, meets[before]?.tj), t, -1);
        // The strip's cut edge, on the curve: the same points the strip ends on.
        const f = a.path.frame(a.fromA ? t : a.path.length - t);
        const side = a.fromA ? 1 : -1;
        ring.push(f.x - f.nx * a.half * side, f.z - f.nz * a.half * side);
        ring.push(f.x + f.nx * a.half * side, f.z + f.nz * a.half * side);
        kerbRun(ring, a, t, kerbStart(corners[i], rounded[i] ? Math.min(arcFrom[i] ?? 0, t) : undefined, meets[i]?.ti), 1);
      } else {
        ring.push(x + a.dx * t - a.nx * a.half, z + a.dz * t - a.nz * a.half);
        ring.push(x + a.dx * t + a.nx * a.half, z + a.dz * t + a.nz * a.half);
      }
      const c = corners[i];
      if (c === "bevel") {
        const b = arms[(i + 1) % k] as Arm;
        ring.push(x + a.nx * a.half, z + a.nz * a.half);
        ring.push(x - b.nx * b.half, z - b.nz * b.half);
      } else if (c && rounded[i]) {
        const b = arms[(i + 1) % k] as Arm;
        const tb = trims[(i + 1) % k] ?? 0;
        const ta = Math.min(arcFrom[i] ?? 0, t);
        const tc = Math.min(arcTo[i] ?? 0, tb);
        const from = kerbAt(a, ta, 1, x, z);
        const to = kerbAt(b, tc, -1, x, z);
        // On a curved kerb the arc leaves along the kerb, so it bends toward where the kerbs' tangents there meet.
        const control = a.path.curved || b.path.curved ? (tangentMeet(armKerb(a, ta, 1), armKerb(b, tc, -1)) ?? c) : c;
        if (ta < t - 1e-6) ring.push(from.x, from.z);
        roundCorner(ring, from, to, control);
        if (tc < tb - 1e-6) ring.push(to.x, to.z);
      } else if (c) {
        ring.push(c.x, c.z);
      }
    }
    return ring;
  };
  let ring = makeRing();
  // A rounded corner that leaves a kerb corner outside stays sharp, as the
  // polygon reached it before corners were rounded.
  for (let pass = 0; pass < k; pass++) {
    let changed = false;
    for (const [px, pz] of kerbCorners) {
      const i = cornerOf(px, pz);
      if (i < 0 || !rounded[i] || outsideAt(ring, px, pz, x, z) < 0) continue;
      rounded[i] = false;
      changed = true;
    }
    if (!changed) break;
    ring = makeRing();
  }
  // Take in each of those kerb corners that lies outside the polygon so
  // far, so no road is left uncovered.
  for (const [px, pz] of kerbCorners) widen(ring, px, pz, x, z);
  let widest = arms[0] as Arm;
  for (const a of arms) if (a.half > widest.half) widest = a;
  return { node, x, z, segs: arms.map((a) => a.seg), trims, ring, type: widest.type };
}

/** A kerb of arm `a` at distance `t` from the node at (x, z): left with `side` 1, right with -1. */
function kerbAt(a: Arm, t: number, side: number, x: number, z: number): { x: number; z: number } {
  if (a.path.curved) return armKerb(a, t, side);
  return { x: x + a.dx * t + a.nx * a.half * side, z: z + a.dz * t + a.nz * a.half * side };
}

/** Where two kerbs' tangent lines meet, each running back toward the node from its point. Null when they do not meet in front. */
function tangentMeet(p: { x: number; z: number; dx: number; dz: number }, q: { x: number; z: number; dx: number; dz: number }): { x: number; z: number } | null {
  const det = -(p.dx * q.dz - p.dz * q.dx);
  if (Math.abs(det) < 1e-9) return null;
  const ex = q.x - p.x;
  const ez = q.z - p.z;
  const a = (-ex * q.dz + q.dx * ez) / det;
  const b = (p.dx * ez - p.dz * ex) / det;
  // Both back toward the node from the cut, not out along the road.
  if (a > 1e-6 || b > 1e-6) return null;
  return { x: p.x + p.dx * a, z: p.z + p.dz * a };
}

/**
 * How far from the node a kerb runs straight from its corner: from the
 * sharp corner, from the end of its arc when the corner is rounded, or
 * from the node when it is bevelled, mitred or open.
 */
function kerbStart(corner: { x: number; z: number } | "bevel" | null | undefined, arcEnd: number | undefined, meet: number | undefined): number {
  if (arcEnd !== undefined && corner && corner !== "bevel") return arcEnd;
  if (corner && corner !== "bevel") return Math.max(0, meet ?? 0);
  return 0;
}

/** Points on arm `a`'s kerb on `side`, strictly between distances `from` and `to` from the node, in that order, about every 2 m. */
function kerbRun(ring: number[], a: Arm, from: number, to: number, side: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  const span = to - from;
  const n = Math.ceil(Math.abs(span) / KERB_RUN_STEP);
  for (let s = 1; s < n; s++) {
    const p = armKerb(a, from + (span * s) / n, side);
    ring.push(p.x, p.z);
  }
}

/** Metres between points the junction polygon takes along a curved kerb. */
const KERB_RUN_STEP = 2;

/** The kerb radius of a corner on a road of `type`, metres. */
function cornerRadius(type: RoadType): number {
  return ROADS.corners.radius[type.id] ?? ROADS.corners.radiusDefault;
}

/**
 * Whether the two roads at a node are a taper: different widths, bent by
 * no more than `ROADS.taper.maxBend`. Returns which of the two is narrow.
 */
function taperArms(arms: readonly Arm[], gaps: readonly number[]): { narrow: number } | null {
  if (arms.length !== 2) return null;
  const [a, b] = arms as [Arm, Arm];
  if (Math.abs(a.half - b.half) < 1e-6) return null;
  const bend = Math.abs((gaps[0] ?? Math.PI) - Math.PI);
  if (bend > ROADS.taper.maxBend) return null;
  return { narrow: a.half < b.half ? 0 : 1 };
}

/**
 * Pushes the inside points of a kerb's arc round a corner onto `ring`,
 * from `from` on one road's kerb to `to` on the next, bending toward the
 * sharp corner `c` the kerbs would make. A quadratic with `c` as its
 * control point leaves each kerb along it, so the turn has no kink.
 */
function roundCorner(ring: number[], from: { x: number; z: number }, to: { x: number; z: number }, c: { x: number; z: number }): void {
  const steps = ROADS.corners.steps;
  for (let s = 1; s < steps; s++) {
    const u = s / steps;
    const w0 = (1 - u) * (1 - u);
    const w1 = 2 * u * (1 - u);
    const w2 = u * u;
    ring.push(w0 * from.x + w1 * c.x + w2 * to.x, w0 * from.z + w1 * c.z + w2 * to.z);
  }
}

/**
 * Inserts point (x + px, z + pz) into `ring`, a polygon star-shaped about
 * (x, z) in angle order, if it lies outside it. The polygon stays star-shaped.
 */
function widen(ring: number[], px: number, pz: number, x: number, z: number): void {
  const at = outsideAt(ring, px, pz, x, z);
  if (at >= 0) ring.splice(at * 2, 0, x + px, z + pz);
}

/**
 * Where point (x + px, z + pz) would go into `ring`, a polygon star-shaped
 * about (x, z) in angle order, as a vertex index, when it lies outside it.
 * -1 when it lies inside.
 */
function outsideAt(ring: readonly number[], px: number, pz: number, x: number, z: number): number {
  const n = ring.length / 2;
  const reach = Math.sqrt(px * px + pz * pz);
  if (reach === 0) return -1;
  const ux = px / reach;
  const uz = pz / reach;
  for (let k = 0; k < n; k++) {
    const ax = (ring[k * 2] ?? 0) - x;
    const az = (ring[k * 2 + 1] ?? 0) - z;
    const bx = (ring[((k + 1) % n) * 2] ?? 0) - x;
    const bz = (ring[((k + 1) % n) * 2 + 1] ?? 0) - z;
    // Ray s * u meets a + w * (b - a)?
    const ex = bx - ax;
    const ez = bz - az;
    const det = uz * ex - ux * ez;
    if (Math.abs(det) < 1e-12) continue;
    const s = (az * ex - ax * ez) / det;
    const w = (ux * az - uz * ax) / det;
    if (s <= 0 || w < 0 || w > 1) continue;
    // The edge the ray crosses, and the side of the ring the point is on.
    return reach > s + 1e-6 ? k + 1 : -1;
  }
  return -1;
}

/** How far `seg` is cut back at `node`, given the junction there. */
export function trimAt(junction: Junction | null, seg: number): number {
  if (!junction) return 0;
  const i = junction.segs.indexOf(seg);
  return i < 0 ? 0 : (junction.trims[i] ?? 0);
}

// ---------------------------------------------------------------------------
// Mesh building

/** Linear RGB from sRGB hex, as the renderer's working space wants. */
export function linearRgb(hex: number): [number, number, number] {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

class Mesh {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  /** City lines only: the side each vertex is pushed to, and the road's half-width. */
  readonly sides: number[] = [];
  readonly halves: number[] = [];
  vertices = 0;

  vertex(x: number, y: number, z: number, rgb: readonly number[]): number {
    this.positions.push(x, y, z);
    this.colors.push(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);
    return this.vertices++;
  }

  /** A triangle that faces up, whichever way round its corners come. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const ax = p[a * 3] ?? 0;
    const az = p[a * 3 + 2] ?? 0;
    const cross = ((p[b * 3 + 2] ?? 0) - az) * ((p[c * 3] ?? 0) - ax) - ((p[b * 3] ?? 0) - ax) * ((p[c * 3 + 2] ?? 0) - az);
    if (Math.abs(cross) < 1e-9) return;
    if (cross > 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number): void {
    // a-b along one side, d-c along the other.
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  done(): MeshArrays {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colors: Float32Array.from(this.colors),
      sides: Float32Array.from(this.sides),
      halves: Float32Array.from(this.halves),
      indices: this.vertices > 0xffff ? Uint32Array.from(this.indices) : Uint16Array.from(this.indices),
    };
  }
}

/** One mesh's arrays. `normals` is empty for unlit meshes; `sides` and `halves` are for city lines only. */
export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  sides: Float32Array;
  halves: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** A chunk's road geometry: one mesh per zoom band layer. */
export interface RoadChunkGeometry {
  /** Road surfaces and junctions. */
  surface: MeshArrays;
  /** Lane markings and one-way arrows. */
  markings: MeshArrays;
  /** Avenues and highways as lines, for the city band. */
  lines: MeshArrays;
  /** Segments and junctions drawn. */
  segments: number;
  junctions: number;
  /** Traffic lights and yield signs to stand in this chunk: x, y, z and turn about y for each, `PROP_STRIDE` numbers apiece. */
  signals: Float32Array;
  yields: Float32Array;
}

/** Numbers per prop in `RoadChunkGeometry.signals` and `yields`: x, y, z and turn about y. */
export const PROP_STRIDE = 4;

/** Whether `type` gets zebra crossings. */
function crosses(type: RoadType): boolean {
  return ROADS.crossings.types.includes(type.id);
}

/**
 * Where segment `seg`'s zebra crossings lie, as distances from node A: one
 * at each end that is a junction of three or more roads, when the segment
 * is on the ground and of a type that has them, and the crossing with a gap
 * each side fits between the cut and the segment's middle. `t0` and `t1`
 * are the cuts. Null at an end with none. Each end depends only on its own
 * junction, since a junction never cuts a road back past its middle, so a
 * change at one end never moves the crossing at the other.
 */
export function crossingsOf(
  net: RoadNet,
  seg: number,
  f: SegPath,
  t0: number,
  t1: number,
  junctions: (node: number) => Junction | null,
): { a: [number, number] | null; b: [number, number] | null } {
  const none = { a: null, b: null };
  if (!crosses(f.type) || isRaised(net, seg) || net.segLevelA[seg] === LEVEL_BRIDGE) return none;
  const c = ROADS.crossings;
  const at = (node: number) => (junctions(node)?.segs.length ?? 0) >= 3 && nodeLift(net, node) === 0;
  const room = 2 * c.gap + c.length;
  const atA = f.length / 2 - t0 >= room && at(net.segA[seg] ?? NONE);
  const atB = t1 - f.length / 2 >= room && at(net.segB[seg] ?? NONE);
  return {
    a: atA ? [t0 + c.gap, t0 + c.gap + c.length] : null,
    b: atB ? [t1 - c.gap - c.length, t1 - c.gap] : null,
  };
}

const surfaceColour = (type: RoadType) => linearRgb(ROADS.surface[type.id] ?? ROADS.surfaceDefault);

/** A painted line along a road: offset from the centre (left positive), colour, dashed or solid. */
interface Paint {
  offset: number;
  rgb: readonly number[];
  dashed: boolean;
}

/** The lines painted on a road of `type`. */
export function paintFor(type: RoadType): Paint[] {
  const m = ROADS.markings;
  const white = linearRgb(m.white);
  const yellow = linearRgb(m.yellow);
  const half = type.width / 2;
  const lanes = Math.max(1, type.lanes);
  const lane = type.width / lanes;
  const out: Paint[] = [];
  if (type.oneWay) {
    for (let k = 1; k < lanes; k++) out.push({ offset: -half + k * lane, rgb: white, dashed: true });
  } else {
    if (lanes >= 4) {
      const o = m.doubleGap / 2 + m.width / 2;
      out.push({ offset: -o, rgb: yellow, dashed: false }, { offset: o, rgb: yellow, dashed: false });
    } else {
      out.push({ offset: 0, rgb: white, dashed: true });
    }
    for (let k = 1; k < lanes / 2; k++) out.push({ offset: -k * lane, rgb: white, dashed: true }, { offset: k * lane, rgb: white, dashed: true });
  }
  if (lanes >= 4) {
    out.push({ offset: -half + m.edgeInset, rgb: white, dashed: false }, { offset: half - m.edgeInset, rgb: white, dashed: false });
  }
  return out;
}

/** Heights of one piece of a strip: right and left kerb at its start and end. */
interface Piece {
  t0: number;
  t1: number;
  r0: number;
  l0: number;
  r1: number;
  l1: number;
}

/** Height on a strip piece at distance `t` and offset `o` from the centre, on the plane the surface draws. */
function pieceHeight(f: SegPath, p: Piece, t: number, o: number): number {
  const u = p.t1 > p.t0 ? (t - p.t0) / (p.t1 - p.t0) : 0;
  const v = (o + f.half) / (2 * f.half);
  const h0 = p.r0 + (p.l0 - p.r0) * v;
  const h1 = p.r1 + (p.l1 - p.r1) * v;
  return h0 + (h1 - h0) * u;
}

/** Builds the road meshes of chunk `chunk` from the segments and nodes that might draw in it. */
export function buildRoadChunk(
  net: RoadNet,
  terrain: Terrain,
  chunk: number,
  segs: Iterable<number>,
  nodes: Iterable<number>,
  junctions: (node: number) => Junction | null = (node) => junctionAt(net, node),
): RoadChunkGeometry {
  const surface = new Mesh();
  const markings = new Mesh();
  const lines = new Mesh();
  const normal = new Float32Array(3);
  const m = ROADS.markings;
  let segCount = 0;
  let junctionCount = 0;
  const signals: number[] = [];
  const yields: number[] = [];

  const ground = (mesh: Mesh, x: number, z: number, rgb: readonly number[]): number => {
    const v = mesh.vertex(x, heightAt(terrain, x, z), z, rgb);
    normalAt(terrain, x, z, normal, 0);
    mesh.normals.push(normal[0] ?? 0, normal[1] ?? 1, normal[2] ?? 0);
    return v;
  };

  const deck = bridgeDeckLevel(terrain.waterLevel);
  const sorted = [...segs].sort((a, b) => a - b);
  for (const seg of sorted) {
    if (!liveRoadSegment(net, seg)) continue;
    const f = segPath(net, seg);
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const t0 = trimAt(junctions(a), seg);
    const t1 = f.length - trimAt(junctions(b), seg);
    const isBridge = net.segLevelA[seg] === LEVEL_BRIDGE;
    const raised = isRaised(net, seg);
    // Drawn as a deck rather than draped on the ground.
    const bridge = isBridge || raised;
    const hA = net.nodeHeight[a] ?? 0;
    const hB = net.nodeHeight[b] ?? 0;
    /** The deck's height at distance `t` along a bridge, or along a raised road over the ground under its centre line. */
    const deckAt = (t: number): number => {
      if (isBridge) return bridgeDeckHeight(hA, hB, f.length, t, deck, f.type.maxSlope);
      const p = f.point(t);
      return heightAt(terrain, p.x, p.z) + levelLift(net, seg, t, f.length);
    };
    let st = f.stations(0, f.length, ROADS.sampleStep);
    if (isBridge) {
      // A station where each ramp meets the level deck, so the kink is drawn where it is.
      const ramps = bridgeRamps(hA, hB, f.length, deck, f.type.maxSlope);
      st = [...st, ramps.a, f.length - ramps.b].filter((t) => t > 1e-3 && t < f.length - 1e-3);
      st = [0, ...st, f.length].sort((p, q) => p - q).filter((t, i, all) => i === 0 || t - (all[i - 1] ?? 0) > 1e-3);
    }
    /** A surface vertex: on the ground, or on a bridge's deck facing straight up. */
    const onRoad = (x: number, z: number, t: number): number => {
      if (!bridge) return ground(surface, x, z, rgb);
      const v = surface.vertex(x, deckAt(t), z, rgb);
      surface.normals.push(0, 1, 0);
      return v;
    };
    const inChunk = (mid: number) => {
      const p = f.point(mid);
      return chunkAt(p.x, p.z) === chunk;
    };
    const lineColour = ROADS.cityLines.colours[f.type.id];
    const lineRgb = lineColour === undefined ? null : linearRgb(lineColour);
    const rgb = surfaceColour(f.type);
    const paints = paintFor(f.type);
    const cross = crossingsOf(net, seg, f, t0, t1, junctions);
    // Lane lines and arrows stop short of a crossing.
    const paintFrom = cross.a ? cross.a[1] + m.width + ROADS.crossings.gap : t0;
    const paintTo = cross.b ? cross.b[0] - m.width - ROADS.crossings.gap : t1;
    let drew = false;

    // City lines run the whole centre line; they are one colour and unlit, so overlaps at junctions do not show.
    if (lineRgb) {
      // Far away, so a curve gets fewer pieces than its surface.
      const lst = f.stations(0, f.length, ROADS.cityLines.sampleStep, ROADS.curves.lineTurn);
      let prev: [number, number] | null = null;
      for (let k = 0; k + 1 < lst.length; k++) {
        const s0 = lst[k] ?? 0;
        const s1 = lst[k + 1] ?? 0;
        const mid = (s0 + s1) / 2;
        if (!inChunk(mid)) {
          prev = null;
          continue;
        }
        const pair = (t: number): [number, number] => {
          const { x, z, nx, nz } = f.frame(t);
          const y = bridge ? deckAt(t) : heightAt(terrain, x, z);
          const r = lines.vertex(x, y, z, lineRgb);
          lines.sides.push(-nx, -nz);
          lines.halves.push(f.half);
          const l = lines.vertex(x, y, z, lineRgb);
          lines.sides.push(nx, nz);
          lines.halves.push(f.half);
          return [r, l];
        };
        const start = prev ?? pair(s0);
        const end = pair(s1);
        // Wound to face up once the sides are pushed apart.
        lines.indices.push(start[0], end[1], end[0], start[0], start[1], end[1]);
        prev = end;
        drew = true;
      }
    }

    // Surface and paint between the cuts.
    if (t1 - t0 > 1e-3) {
      const body = [t0, ...st.filter((t) => t > t0 + 1e-6 && t < t1 - 1e-6), t1];
      let prev: { r: number; l: number; hr: number; hl: number } | null = null;
      for (let k = 0; k + 1 < body.length; k++) {
        const s0 = body[k] ?? 0;
        const s1 = body[k + 1] ?? 0;
        const mid = (s0 + s1) / 2;
        if (!inChunk(mid)) {
          prev = null;
          continue;
        }
        const edge = (t: number) => {
          const { x: cx, z: cz, nx, nz } = f.frame(t);
          const r = onRoad(cx - nx * f.half, cz - nz * f.half, t);
          const l = onRoad(cx + nx * f.half, cz + nz * f.half, t);
          const p = surface.positions;
          return { r, l, hr: p[r * 3 + 1] ?? 0, hl: p[l * 3 + 1] ?? 0 };
        };
        const start = prev ?? edge(s0);
        const end = edge(s1);
        surface.quad(start.r, end.r, end.l, start.l);
        prev = end;
        drew = true;
        const piece: Piece = { t0: s0, t1: s1, r0: start.hr, l0: start.hl, r1: end.hr, l1: end.hl };
        for (const paint of paints) paintPiece(markings, f, piece, paint, m.width, paintFrom, paintTo);
        if (f.type.oneWay) arrows(markings, f, piece, paintFrom, paintTo);
        for (const span of [cross.a, cross.b]) if (span) zebra(markings, f, piece, span);
        if (bridge) bridgeSides(surface, f, s0, s1, deckAt);
      }
    }
    if (isBridge) {
      for (const t of pierStations(f.length, deckAt, deck)) {
        const p = f.point(t);
        if (chunkAt(p.x, p.z) === chunk) pier(surface, f, t, deckAt(t), heightAt(terrain, p.x, p.z));
      }
    } else if (raised) {
      for (const t of raisedPierStations(f.length)) {
        const p = f.point(t);
        const ground = heightAt(terrain, p.x, p.z);
        const top = deckAt(t);
        // A pier only where the deck stands above the ground: none under a tunnel or a ramp's foot.
        if (chunkAt(p.x, p.z) === chunk && top - ROADS.bridges.deckDepth > ground) pier(surface, f, t, top, ground);
      }
    }
    if (drew) segCount++;
  }

  for (const node of [...nodes].sort((p, q) => p - q)) {
    if (!liveNode(net, node) || chunkAt(net.nodeX[node] ?? 0, net.nodeZ[node] ?? 0) !== chunk) continue;
    const j = junctions(node);
    // City line caps: fill the corner where two lines meet.
    const lineArms = roadSegmentsAt(net, node).filter((s) => ROADS.cityLines.colours[roadTypeOf(net, s).id] !== undefined);
    if (lineArms.length > 0) {
      let widest = roadTypeOf(net, lineArms[0] ?? 0);
      for (const s of lineArms) if (roadTypeOf(net, s).width > widest.width) widest = roadTypeOf(net, s);
      const lineRgb = linearRgb(ROADS.cityLines.colours[widest.id] ?? 0);
      const x = net.nodeX[node] ?? 0;
      const z = net.nodeZ[node] ?? 0;
      const y = heightAt(terrain, x, z) + nodeLift(net, node);
      const centre = lines.vertex(x, y, z, lineRgb);
      lines.sides.push(0, 0);
      lines.halves.push(widest.width / 2);
      const ring: number[] = [];
      const sides = ROADS.cityLines.capSides;
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * 2 * Math.PI;
        ring.push(lines.vertex(x, y, z, lineRgb));
        lines.sides.push(Math.cos(ang), Math.sin(ang));
        lines.halves.push(widest.width / 2);
      }
      for (let k = 0; k < sides; k++) lines.indices.push(centre, ring[(k + 1) % sides] ?? 0, ring[k] ?? 0);
    }
    if (j) props(net, terrain, j, junctions, signals, yields);
    if (!j || j.ring.length < 6) continue;
    const rgb = surfaceColour(j.type);
    const lift = nodeLift(net, node);
    const atJunction = (x: number, z: number): number => {
      if (lift === 0) return ground(surface, x, z, rgb);
      // Level with the decks that meet here, which take the ground under their centre lines.
      const v = surface.vertex(x, heightAt(terrain, j.x, j.z) + lift, z, rgb);
      surface.normals.push(0, 1, 0);
      return v;
    };
    const centre = atJunction(j.x, j.z);
    const ring: number[] = [];
    for (let k = 0; k < j.ring.length; k += 2) ring.push(atJunction(j.ring[k] ?? 0, j.ring[k + 1] ?? 0));
    const before = surface.indices.length;
    for (let k = 0; k < ring.length; k++) surface.triangle(centre, ring[k] ?? 0, ring[(k + 1) % ring.length] ?? 0);
    if (surface.indices.length > before) junctionCount++;
  }

  return {
    surface: surface.done(),
    markings: markings.done(),
    lines: lines.done(),
    segments: segCount,
    junctions: junctionCount,
    signals: Float32Array.from(signals),
    yields: Float32Array.from(yields),
  };
}

/**
 * The traffic lights or yield signs at junction `j`, pushed onto `signals`
 * or `yields`. A junction of three or more roads on the ground gets lights
 * when one of its roads is of a `ROADS.props.signalTypes` type, and yield
 * signs when all are of `yieldTypes`. Each road that brings traffic in gets
 * one, outside the kerb on that traffic's right, just back from the
 * crossing, turned to face it. A spot on another road is left empty.
 */
function props(
  net: RoadNet,
  terrain: Terrain,
  j: Junction,
  junctions: (node: number) => Junction | null,
  signals: number[],
  yields: number[],
): void {
  if (j.segs.length < 3 || nodeLift(net, j.node) !== 0) return;
  const P = ROADS.props;
  const types = j.segs.map((s) => roadTypeOf(net, s).id);
  const into = types.some((t) => P.signalTypes.includes(t)) ? signals : types.every((t) => P.yieldTypes.includes(t)) ? yields : null;
  if (!into) return;
  const paths = j.segs.map((s) => segPath(net, s));
  if (j.segs.some((s) => isRaised(net, s) || net.segLevelA[s] === LEVEL_BRIDGE)) return;
  const arms = j.segs.map((s, i) => {
    const f = paths[i] as SegPath;
    const fromA = net.segA[s] === j.node;
    return { seg: s, f, fromA, ...f.leaving(fromA) };
  });
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i] as (typeof arms)[number];
    // A one-way runs from node A to node B, so it brings traffic in only at B.
    if (a.f.type.oneWay && a.fromA) continue;
    const trim = j.trims[i] ?? 0;
    const other = a.fromA ? (net.segB[a.seg] ?? NONE) : (net.segA[a.seg] ?? NONE);
    const t0 = a.fromA ? trim : trimAt(junctions(other), a.seg);
    const t1 = a.fromA ? a.f.length - trimAt(junctions(other), a.seg) : a.f.length - trim;
    const cross = crossingsOf(net, a.seg, a.f, t0, t1, junctions);
    const span = a.fromA ? cross.a : cross.b;
    const back = trim + (span ? ROADS.crossings.gap + ROADS.crossings.length : 0) + P.setback;
    if (back > a.f.length / 2) continue;
    const fr = a.f.frame(a.fromA ? back : a.f.length - back);
    // The frame runs from node A; turn it to run away from this node.
    const dx = a.fromA ? fr.dx : -fr.dx;
    const dz = a.fromA ? fr.dz : -fr.dz;
    // Incoming traffic runs toward the node, along (-dx, -dz). Its right,
    // forward cross up in this right-handed frame with y up, is (dz, -dx).
    const out = a.f.half + P.kerbGap;
    const x = fr.x + dz * out;
    const z = fr.z - dx * out;
    const clear = arms.every((b, k) => {
      if (k === i) return true;
      const px = x - j.x;
      const pz = z - j.z;
      const t = px * b.dx + pz * b.dz;
      const o = -px * b.dz + pz * b.dx;
      return !(t > -P.kerbGap && t < b.f.length && Math.abs(o) < b.f.half + P.kerbGap / 2);
    });
    if (!clear) continue;
    into.push(x, heightAt(terrain, x, z), z, Math.atan2(dx, dz));
  }
}

/**
 * A quad facing `normal`: its corners in order around it, wound so the
 * front face is the side `normal` points to.
 */
function face(mesh: Mesh, a: number, b: number, c: number, d: number, normal: readonly [number, number, number]): void {
  const p = mesh.positions;
  const at = (v: number, k: number) => p[v * 3 + k] ?? 0;
  const ux = at(b, 0) - at(a, 0);
  const uy = at(b, 1) - at(a, 1);
  const uz = at(b, 2) - at(a, 2);
  const vx = at(c, 0) - at(a, 0);
  const vy = at(c, 1) - at(a, 1);
  const vz = at(c, 2) - at(a, 2);
  const dot = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
  if (dot >= 0) mesh.indices.push(a, b, c, a, c, d);
  else mesh.indices.push(a, c, b, a, d, c);
}

/** A vertex with its own normal. */
function lit(mesh: Mesh, x: number, y: number, z: number, rgb: readonly number[], n: readonly [number, number, number]): number {
  const v = mesh.vertex(x, y, z, rgb);
  mesh.normals.push(n[0], n[1], n[2]);
  return v;
}

/**
 * Both edges of a bridge piece from `s0` to `s1`: a fascia from under the
 * deck up to a railing, the railing's inner face and its top, and the
 * deck's underside between the fascias.
 */
function bridgeSides(mesh: Mesh, f: SegPath, s0: number, s1: number, deckAt: (t: number) => number): void {
  const b = ROADS.bridges;
  const rgb = linearRgb(b.railing);
  const under = linearRgb(b.underside);
  const f0 = f.frame(s0);
  const f1 = f.frame(s1);
  const y0 = deckAt(s0);
  const y1 = deckAt(s1);
  const outer = f.half + b.railingThickness;
  for (const side of [1, -1]) {
    // Outward from the road on this side, in plan.
    const n0: [number, number, number] = [f0.nx * side, 0, f0.nz * side];
    const n1: [number, number, number] = [f1.nx * side, 0, f1.nz * side];
    const at = (fr: PathFrame, o: number, y: number, n: readonly [number, number, number], colour = rgb) =>
      lit(mesh, fr.x + fr.nx * side * o, y, fr.z + fr.nz * side * o, colour, n);
    // Outer face, from under the deck to the top of the railing.
    face(mesh, at(f0, outer, y0 - b.deckDepth, n0), at(f1, outer, y1 - b.deckDepth, n1), at(f1, outer, y1 + b.railingHeight, n1), at(f0, outer, y0 + b.railingHeight, n0), n0);
    // Inner face, from the deck up.
    const in0: [number, number, number] = [-n0[0], 0, -n0[2]];
    const in1: [number, number, number] = [-n1[0], 0, -n1[2]];
    face(mesh, at(f0, f.half, y0, in0), at(f1, f.half, y1, in1), at(f1, f.half, y1 + b.railingHeight, in1), at(f0, f.half, y0 + b.railingHeight, in0), in0);
    // The railing's top.
    const up: [number, number, number] = [0, 1, 0];
    face(mesh, at(f0, f.half, y0 + b.railingHeight, up), at(f1, f.half, y1 + b.railingHeight, up), at(f1, outer, y1 + b.railingHeight, up), at(f0, outer, y0 + b.railingHeight, up), up);
  }
  const down: [number, number, number] = [0, -1, 0];
  const u = (fr: PathFrame, side: number, y: number) =>
    lit(mesh, fr.x + fr.nx * side * outer, y - b.deckDepth, fr.z + fr.nz * side * outer, under, down);
  face(mesh, u(f0, 1, y0), u(f1, 1, y1), u(f1, -1, y1), u(f0, -1, y0), down);
}

/**
 * Where a bridge's piers stand, metres along it: evenly spaced, at most
 * `ROADS.bridges.pierSpacing` apart, along the level deck. None where the
 * ramps run, which meet the ground at the bank nodes.
 */
export function pierStations(length: number, deckAt: (t: number) => number, deck: number): number[] {
  let from = 0;
  while (from < length && deckAt(from) < deck - 1e-6) from += 1;
  let to = length;
  while (to > from && deckAt(to) < deck - 1e-6) to -= 1;
  const span = to - from;
  if (span <= 0) return [];
  const gaps = Math.max(1, Math.ceil(span / ROADS.bridges.pierSpacing));
  const out: number[] = [];
  for (let k = 0; k <= gaps; k++) out.push(from + (span * k) / gaps);
  return out;
}

/** Where a raised road's piers stand, metres along it: evenly spaced, at most `ROADS.bridges.pierSpacing` apart, not at its ends. */
export function raisedPierStations(length: number): number[] {
  const gaps = Math.max(1, Math.ceil(length / ROADS.bridges.pierSpacing));
  const out: number[] = [];
  for (let k = 1; k < gaps; k++) out.push((length * k) / gaps);
  return out.length > 0 ? out : [length / 2];
}

/** A pier at `t` along a bridge: a box from under the deck at `top` down into the ground at `bottom`. */
function pier(mesh: Mesh, f: SegPath, t: number, top: number, bottom: number): void {
  const b = ROADS.bridges;
  const fr = f.frame(t);
  const rgb = linearRgb(b.pier);
  const hy = top - b.deckDepth;
  const lo = bottom - b.pierFooting;
  if (hy <= lo) return;
  const along = b.pierThickness / 2;
  const across = f.half * b.pierWidthShare;
  const corner = (sa: number, sc: number, y: number, n: readonly [number, number, number]) =>
    lit(mesh, fr.x + fr.dx * along * sa + fr.nx * across * sc, y, fr.z + fr.dz * along * sa + fr.nz * across * sc, rgb, n);
  const sides: [number, number, number, number][] = [
    [1, -1, 1, 1],
    [-1, 1, -1, -1],
    [-1, 1, 1, 1],
    [1, -1, -1, -1],
  ];
  // Each side as (along, across) at its two corners: the two faces across the road, then the two along it.
  for (const [a0, c0, a1, c1] of sides) {
    const n: [number, number, number] =
      a0 === a1 ? [fr.dx * a0, 0, fr.dz * a0] : [fr.nx * c0, 0, fr.nz * c0];
    face(mesh, corner(a0, c0, lo, n), corner(a1, c1, lo, n), corner(a1, c1, hy, n), corner(a0, c0, hy, n), n);
  }
}

/** A flat quad painted on a strip piece: from `ta` to `tb` along, from `o0` to `o1` across. */
function paintQuad(mesh: Mesh, f: SegPath, p: Piece, ta: number, tb: number, o0: number, o1: number, rgb: readonly number[]): void {
  const lift = ROADS.markingLift;
  const at = (t: number, o: number) => {
    const c = f.frame(t);
    return mesh.vertex(c.x + c.nx * o, pieceHeight(f, p, t, o) + lift, c.z + c.nz * o, rgb);
  };
  mesh.quad(at(ta, o0), at(tb, o0), at(tb, o1), at(ta, o1));
}

/** A painted line on a strip piece, only where it lies between `from` and `to` along the segment. */
function paintPiece(mesh: Mesh, f: SegPath, p: Piece, paint: Paint, width: number, from: number, to: number): void {
  const o0 = paint.offset - width / 2;
  const o1 = paint.offset + width / 2;
  const lo = Math.max(p.t0, from);
  const hi = Math.min(p.t1, to);
  if (hi - lo <= 1e-3) return;
  if (!paint.dashed) {
    paintQuad(mesh, f, p, lo, hi, o0, o1, paint.rgb);
    return;
  }
  const period = ROADS.markings.dash + ROADS.markings.gap;
  // Dashes sit at fixed places along the segment, so they line up across pieces.
  for (let start = Math.floor(lo / period) * period; start < hi; start += period) {
    const ta = Math.max(lo, start);
    const tb = Math.min(hi, start + ROADS.markings.dash);
    if (tb - ta > 1e-3) paintQuad(mesh, f, p, ta, tb, o0, o1, paint.rgb);
  }
}

/** The bars of a zebra crossing from `span[0]` to `span[1]` along the segment, the part on piece `p`. */
function zebra(mesh: Mesh, f: SegPath, p: Piece, span: readonly [number, number]): void {
  const lo = Math.max(p.t0, span[0]);
  const hi = Math.min(p.t1, span[1]);
  if (hi - lo <= 1e-3) return;
  const c = ROADS.crossings;
  const white = linearRgb(ROADS.markings.white);
  const usable = 2 * f.half - 2 * c.margin;
  const count = Math.max(1, Math.floor((usable + c.space) / (c.bar + c.space)));
  const total = count * c.bar + (count - 1) * c.space;
  for (let k = 0; k < count; k++) {
    const o = -total / 2 + k * (c.bar + c.space);
    paintQuad(mesh, f, p, lo, hi, o, o + c.bar, white);
  }
}

/**
 * One-way arrows in every lane, pointing from node A to node B. An arrow
 * belongs to the piece its tail is on. The sim gives one-ways no direction
 * of their own until issue 12, so A to B is the direction.
 */
function arrows(mesh: Mesh, f: SegPath, p: Piece, t0: number, t1: number): void {
  const m = ROADS.markings;
  const length = m.arrowShaft.length + m.arrowHead.length;
  const usable = t1 - t0 - length;
  if (usable < 2) return;
  const white = linearRgb(m.white);
  const lanes = Math.max(1, f.type.lanes);
  const lane = f.type.width / lanes;
  const lift = ROADS.markingLift;
  // Arrows sit at fixed places along the usable stretch, centred in it when only one fits.
  const count = Math.max(1, Math.floor(usable / m.arrowSpacing) + 1);
  const first = t0 + (usable - (count - 1) * m.arrowSpacing) / 2;
  for (let n = 0; n < count; n++) {
    const tail = first + n * m.arrowSpacing;
    if (tail < p.t0 || tail >= p.t1) continue;
    for (let k = 0; k < lanes; k++) {
      const o = -f.half + (k + 0.5) * lane;
      const neck = tail + m.arrowShaft.length;
      const tip = neck + m.arrowHead.length;
      const sw = m.arrowShaft.width / 2;
      paintQuad(mesh, f, p, tail, neck, o - sw, o + sw, white);
      const at = (t: number, off: number) => {
        const c = f.frame(t);
        return mesh.vertex(c.x + c.nx * off, pieceHeight(f, p, t, off) + lift, c.z + c.nz * off, white);
      };
      const hw = m.arrowHead.width / 2;
      mesh.triangle(at(neck, o - hw), at(tip, o), at(neck, o + hw));
    }
  }
}

// ---------------------------------------------------------------------------
// What a change touches

/**
 * Furthest along a road, from its node, that a junction changes what is
 * drawn: its sharpest corner, the room for a rounded kerb past it, and the
 * crossing and the lane lines that stop short of it.
 */
const JUNCTION_REACH =
  ROADS.maxTrim + ROADS.corners.maxCut + 3 * ROADS.crossings.gap + ROADS.crossings.length + ROADS.markings.width;

/**
 * Which chunks each road segment and node draws in, kept current from the
 * mirror's deltas. Client-side derived data, rebuilt from the graph on a
 * snapshot.
 */
export class RoadChunks {
  /** Per chunk: road segments with a piece there, and nodes there. */
  readonly chunkSegs: Set<number>[] = [];
  readonly chunkNodes: Set<number>[] = [];
  /** What each indexed segment was when indexed: its ends and its chunks. */
  private readonly segs = new Map<number, { a: number; b: number; chunks: number[] }>();
  private readonly nodes = new Map<number, number>();

  constructor() {
    for (let c = 0; c < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; c++) {
      this.chunkSegs.push(new Set());
      this.chunkNodes.push(new Set());
    }
  }

  /** Forgets everything and indexes `net` afresh. */
  reset(net: RoadNet): void {
    for (const s of this.chunkSegs) s.clear();
    for (const s of this.chunkNodes) s.clear();
    this.segs.clear();
    this.nodes.clear();
    for (let node = 0; node < net.nodeFlags.length; node++) this.indexNode(net, node);
    for (let seg = 0; seg < net.segFlags.length; seg++) this.indexSeg(net, seg);
  }

  private indexNode(net: RoadNet, node: number): void {
    if (!liveNode(net, node)) return;
    const chunk = chunkAt(net.nodeX[node] ?? 0, net.nodeZ[node] ?? 0);
    this.nodes.set(node, chunk);
    this.chunkNodes[chunk]?.add(node);
  }

  private indexSeg(net: RoadNet, seg: number): void {
    if (!liveRoadSegment(net, seg)) return;
    const f = segPath(net, seg);
    const chunks = new Set<number>();
    if (f.curved) {
      // Every chunk a piece is drawn in, cut exactly as the surface and the lines are.
      for (const st of [f.stations(0, f.length, ROADS.sampleStep), f.stations(0, f.length, ROADS.cityLines.sampleStep, ROADS.curves.lineTurn)]) {
        for (let k = 0; k + 1 < st.length; k++) {
          const p = f.point(((st[k] ?? 0) + (st[k + 1] ?? 0)) / 2);
          chunks.add(chunkAt(p.x, p.z));
        }
      }
    } else {
      lineChunks(f.ax, f.az, f.dx, f.dz, f.length, chunks);
    }
    const list = [...chunks].sort((p, q) => p - q);
    this.segs.set(seg, { a: net.segA[seg] ?? NONE, b: net.segB[seg] ?? NONE, chunks: list });
    for (const c of list) this.chunkSegs[c]?.add(seg);
  }

  private unindexNode(node: number, into: Set<number>): void {
    const chunk = this.nodes.get(node);
    if (chunk === undefined) return;
    into.add(chunk);
    this.chunkNodes[chunk]?.delete(node);
    this.nodes.delete(node);
  }

  private unindexSeg(seg: number, into: Set<number>, ends: Set<number>): void {
    const old = this.segs.get(seg);
    if (!old) return;
    for (const c of old.chunks) {
      into.add(c);
      this.chunkSegs[c]?.delete(seg);
    }
    ends.add(old.a);
    ends.add(old.b);
    this.segs.delete(seg);
  }

  /** Chunks the junction at `node` can reach: its own, and each road's stretch it may cut back. */
  private junctionReach(net: RoadNet, node: number, into: Set<number>): void {
    if (!liveNode(net, node)) return;
    const x = net.nodeX[node] ?? 0;
    const z = net.nodeZ[node] ?? 0;
    into.add(chunkAt(x, z));
    for (const seg of roadSegmentsAt(net, node)) {
      const f = segPath(net, seg);
      const fromA = net.segA[seg] === node;
      const reach = Math.min(JUNCTION_REACH, f.length / 2);
      if (f.curved) {
        if (fromA) pathChunks(f, 0, reach, into);
        else pathChunks(f, f.length - reach, f.length, into);
      } else {
        const away = fromA ? 1 : -1;
        lineChunks(x, z, f.dx * away, f.dz * away, reach, into);
      }
    }
  }

  /**
   * Re-indexes the nodes and segments a delta named, now that `net` holds
   * the new rows, and returns the chunks whose road meshes must rebuild:
   * where each changed segment was and is, and where each junction at a
   * changed node, or at either end of a changed segment, reaches.
   */
  apply(net: RoadNet, nodeIds: Iterable<number>, segIds: Iterable<number>): Set<number> {
    const dirty = new Set<number>();
    const ends = new Set<number>();
    const nodes = [...nodeIds];
    const segs = [...segIds];
    // Junctions reach the same chunks before the change as after it, for
    // every road that stays, so the old reach is the new one plus the
    // removed roads' own chunks, which unindexing adds.
    for (const seg of segs) this.unindexSeg(seg, dirty, ends);
    for (const node of nodes) this.unindexNode(node, dirty);
    for (const node of nodes) this.indexNode(net, node);
    for (const seg of segs) {
      this.indexSeg(net, seg);
      if (liveRoadSegment(net, seg)) {
        for (const c of this.segs.get(seg)?.chunks ?? []) dirty.add(c);
        ends.add(net.segA[seg] ?? NONE);
        ends.add(net.segB[seg] ?? NONE);
      }
    }
    for (const node of [...nodes, ...ends]) this.junctionReach(net, node, dirty);
    return dirty;
  }
}

// ---------------------------------------------------------------------------
// Where decoration must not stand

/** Bits in a road mask cell. */
export const MASK_TREES = 1;
export const MASK_GRASS = 2;

/** Cells along each side of a chunk's road mask. */
export const MASK_SIDE = Math.ceil(CHUNK_SIZE / ROADS.maskCell);

/**
 * Which cells of chunk `chunk` are too close to a road for a tree or a tuft
 * of grass, as `MASK_*` bits per cell, row by row along z. Null when no road
 * comes near. `segs` are the road segments that might come near: those with
 * pieces in this chunk or its neighbours. `rings` are the polygons of the
 * junctions that might: a rounded kerb or a taper reaches past the strips.
 */
export function roadMask(net: RoadNet, chunk: number, segs: Iterable<number>, rings: Iterable<readonly number[]> = []): Uint8Array | null {
  const ci = chunk % CHUNKS_PER_SIDE;
  const cj = Math.floor(chunk / CHUNKS_PER_SIDE);
  const x0 = ci * CHUNK_SIZE;
  const z0 = cj * CHUNK_SIZE;
  const cell = ROADS.maskCell;
  // A cell is masked when any point of it could be within the clearance.
  const slack = (cell * Math.SQRT2) / 2;
  let mask: Uint8Array | null = null;
  for (const seg of segs) {
    if (!liveRoadSegment(net, seg)) continue;
    const f = segPath(net, seg);
    const treeReach = f.half + ROADS.decorClearance.trees + slack;
    const grassReach = f.half + ROADS.decorClearance.grass + slack;
    // A curve is checked piece by piece, each a straight line.
    const st = f.curved ? f.stations(0, f.length, ROADS.sampleStep) : [0, f.length];
    for (let k = 0; k + 1 < st.length; k++) {
      const p0 = f.point(st[k] ?? 0);
      const p1 = f.point(st[k + 1] ?? 0);
      const ex0 = p1.x - p0.x;
      const ez0 = p1.z - p0.z;
      const length = Math.hypot(ex0, ez0);
      const dx = f.curved ? (length > 0 ? ex0 / length : 1) : f.dx;
      const dz = f.curved ? (length > 0 ? ez0 / length : 0) : f.dz;
      const piece = f.curved ? length : f.length;
      const bx = p0.x + dx * piece;
      const bz = p0.z + dz * piece;
      const i0 = Math.max(0, Math.floor((Math.min(p0.x, bx) - treeReach - x0) / cell));
      const i1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(p0.x, bx) + treeReach - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(p0.z, bz) - treeReach - z0) / cell));
      const j1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(p0.z, bz) + treeReach - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * cell - p0.x;
          const pz = z0 + (j + 0.5) * cell - p0.z;
          const t = Math.min(piece, Math.max(0, px * dx + pz * dz));
          const ex = px - dx * t;
          const ez = pz - dz * t;
          const d = Math.sqrt(ex * ex + ez * ez);
          if (d > treeReach) continue;
          mask ??= new Uint8Array(MASK_SIDE * MASK_SIDE);
          const m = j * MASK_SIDE + i;
          mask[m] = (mask[m] ?? 0) | MASK_TREES | (d <= grassReach ? MASK_GRASS : 0);
        }
      }
    }
  }
  const treeReach = ROADS.decorClearance.trees + slack;
  const grassReach = ROADS.decorClearance.grass + slack;
  for (const ring of rings) {
    const n = ring.length / 2;
    if (n < 3) continue;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < n; k++) {
      minX = Math.min(minX, ring[k * 2] ?? 0);
      maxX = Math.max(maxX, ring[k * 2] ?? 0);
      minZ = Math.min(minZ, ring[k * 2 + 1] ?? 0);
      maxZ = Math.max(maxZ, ring[k * 2 + 1] ?? 0);
    }
    const i0 = Math.max(0, Math.floor((minX - treeReach - x0) / cell));
    const i1 = Math.min(MASK_SIDE - 1, Math.floor((maxX + treeReach - x0) / cell));
    const j0 = Math.max(0, Math.floor((minZ - treeReach - z0) / cell));
    const j1 = Math.min(MASK_SIDE - 1, Math.floor((maxZ + treeReach - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = ringDistance(ring, x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell);
        if (d > treeReach) continue;
        mask ??= new Uint8Array(MASK_SIDE * MASK_SIDE);
        const m = j * MASK_SIDE + i;
        mask[m] = (mask[m] ?? 0) | MASK_TREES | (d <= grassReach ? MASK_GRASS : 0);
      }
    }
  }
  return mask;
}

/** Distance from (x, z) to the polygon `ring`, x and z pairs in order: 0 inside it. */
export function ringDistance(ring: readonly number[], x: number, z: number): number {
  const n = ring.length / 2;
  let inside = false;
  let best = Infinity;
  for (let k = 0, l = n - 1; k < n; l = k++) {
    const ax = ring[l * 2] ?? 0;
    const az = ring[l * 2 + 1] ?? 0;
    const bx = ring[k * 2] ?? 0;
    const bz = ring[k * 2 + 1] ?? 0;
    if (az > z !== bz > z && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return inside ? 0 : best;
}

/** True when world point (x, z) in chunk `chunk` falls in a masked cell with `bit` set. */
export function masked(mask: Uint8Array | null, chunk: number, x: number, z: number, bit: number): boolean {
  if (!mask) return false;
  const ci = chunk % CHUNKS_PER_SIDE;
  const cj = Math.floor(chunk / CHUNKS_PER_SIDE);
  const i = Math.floor((x - ci * CHUNK_SIZE) / ROADS.maskCell);
  const j = Math.floor((z - cj * CHUNK_SIZE) / ROADS.maskCell);
  if (i < 0 || j < 0 || i >= MASK_SIDE || j >= MASK_SIDE) return false;
  return ((mask[j * MASK_SIDE + i] ?? 0) & bit) !== 0;
}

/** Chunk `chunk` and its up to eight neighbours. */
export function neighbourhood(chunk: number): number[] {
  const ci = chunk % CHUNKS_PER_SIDE;
  const cj = Math.floor(chunk / CHUNKS_PER_SIDE);
  const out: number[] = [];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i >= 0 && j >= 0 && i < CHUNKS_PER_SIDE && j < CHUNKS_PER_SIDE) out.push(j * CHUNKS_PER_SIDE + i);
    }
  }
  return out;
}
