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
// Every segment is the straight line between its nodes until curves arrive
// (issue 09).

import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  NETWORK_ROAD,
  NODE_ALIVE,
  NONE,
  ROAD_TYPES,
  SEG_ALIVE,
  heightAt,
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

/** A segment as a straight line: start, unit direction, left normal, length and half-width. */
export interface SegFrame {
  seg: number;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** The left normal, (-dz, dx). */
  nx: number;
  nz: number;
  length: number;
  half: number;
  type: RoadType;
}

export function segFrame(net: RoadNet, seg: number): SegFrame {
  const a = net.segA[seg] ?? 0;
  const b = net.segB[seg] ?? 0;
  const ax = net.nodeX[a] ?? 0;
  const az = net.nodeZ[a] ?? 0;
  const ex = (net.nodeX[b] ?? 0) - ax;
  const ez = (net.nodeZ[b] ?? 0) - az;
  const length = Math.sqrt(ex * ex + ez * ez);
  const dx = length > 0 ? ex / length : 1;
  const dz = length > 0 ? ez / length : 0;
  const type = roadTypeOf(net, seg);
  return { seg, ax, az, dx, dz, nx: -dz, nz: dx, length, half: type.width / 2, type };
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
  out.sort((x, y) => x - y);
  // Drop stations too close to the one before; keep t1 exactly.
  const merged: number[] = [];
  for (const t of out) {
    const prev = merged[merged.length - 1];
    if (prev === undefined || t - prev > 1e-6) merged.push(t);
    else if (t === t1) merged[merged.length - 1] = t1;
  }
  return merged;
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
}

function armsAt(net: RoadNet, node: number): Arm[] {
  const arms: Arm[] = [];
  for (const seg of roadSegmentsAt(net, node)) {
    const f = segFrame(net, seg);
    const away = net.segA[seg] === node ? 1 : -1;
    const dx = f.dx * away;
    const dz = f.dz * away;
    const far = (away === 1 ? net.segB[seg] : net.segA[seg]) ?? NONE;
    arms.push({ seg, far, dx, dz, nx: -dz, nz: dx, half: f.half, length: f.length, angle: Math.atan2(dz, dx), type: f.type });
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
  const ti = (-rx * j.dz + j.dx * rz) / det;
  const tj = (i.dx * rz - i.dz * rx) / det;
  return { ti, tj };
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
  const at = (a: Arm, t: number) => ({ x: x + a.dx * t + a.nx * a.half, z: z + a.dz * t + a.nz * a.half });

  // First the corners under 180 degrees, which set how far each road is cut
  // back. Where a narrow road meets a wide one nearly head on, the kerbs
  // meet behind the wide road's node, and the narrow road tapers into it.
  const corners: ({ x: number; z: number } | "bevel" | null)[] = arms.map(() => null);
  for (let i = 0; i < k; i++) {
    const meet = meets[i];
    const gap = gaps[i] ?? 0;
    if (!meet || gap >= Math.PI - STRAIGHT) continue;
    if ((meet.ti < 0 && meet.tj < 0) || meet.ti > ROADS.maxTrim || meet.tj > ROADS.maxTrim) continue;
    trims[i] = Math.max(trims[i] ?? 0, meet.ti);
    trims[(i + 1) % k] = Math.max(trims[(i + 1) % k] ?? 0, meet.tj);
    corners[i] = at(arms[i] as Arm, meet.ti);
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
    if (gap <= Math.PI + STRAIGHT) continue;
    const a = arms[i] as Arm;
    const b = arms[(i + 1) % k] as Arm;
    const meet = meets[i];
    corners[i] = "bevel";
    if (!meet || meet.ti > (trims[i] ?? 0) || meet.tj > (trims[(i + 1) % k] ?? 0)) continue;
    const p = at(a, meet.ti);
    const reach = Math.sqrt((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z));
    if (reach <= ROADS.miterLimit * Math.max(a.half, b.half)) corners[i] = p;
  }

  const ring: number[] = [];
  let widest = arms[0] as Arm;
  for (let i = 0; i < k; i++) {
    const a = arms[i] as Arm;
    if (a.half > widest.half) widest = a;
    const t = trims[i] ?? 0;
    ring.push(x + a.dx * t - a.nx * a.half, z + a.dz * t - a.nz * a.half);
    ring.push(x + a.dx * t + a.nx * a.half, z + a.dz * t + a.nz * a.half);
    const c = corners[i];
    if (c === "bevel") {
      const b = arms[(i + 1) % k] as Arm;
      ring.push(x + a.nx * a.half, z + a.nz * a.half);
      ring.push(x - b.nx * b.half, z - b.nz * b.half);
    } else if (c) {
      ring.push(c.x, c.z);
    }
  }
  // A wide road's kerbs at the node can stand out past a narrow
  // neighbour's, as at a sharp fork. Take in every kerb corner at the node
  // that lies outside the polygon so far, so no road is left uncovered.
  // A corner already on another road's strip, past its cut, is drawn there.
  const onStrip = (px: number, pz: number) =>
    arms.some((b, i) => {
      const t = px * b.dx + pz * b.dz;
      const o = px * b.nx + pz * b.nz;
      return t > (trims[i] ?? 0) + 1e-6 && Math.abs(o) < b.half - 1e-6;
    });
  for (const a of arms) {
    for (const side of [1, -1]) {
      const px = a.nx * a.half * side;
      const pz = a.nz * a.half * side;
      if (!onStrip(px, pz)) widen(ring, px, pz, x, z);
    }
  }
  return { node, x, z, segs: arms.map((a) => a.seg), trims, ring, type: widest.type };
}

/**
 * Inserts point (x + px, z + pz) into `ring`, a polygon star-shaped about
 * (x, z) in angle order, if it lies outside it. The polygon stays star-shaped.
 */
function widen(ring: number[], px: number, pz: number, x: number, z: number): void {
  const n = ring.length / 2;
  const reach = Math.sqrt(px * px + pz * pz);
  if (reach === 0) return;
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
    if (reach > s + 1e-6) ring.splice((k + 1) * 2, 0, x + px, z + pz);
    return;
  }
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
function pieceHeight(f: SegFrame, p: Piece, t: number, o: number): number {
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

  const ground = (mesh: Mesh, x: number, z: number, rgb: readonly number[]): number => {
    const v = mesh.vertex(x, heightAt(terrain, x, z), z, rgb);
    normalAt(terrain, x, z, normal, 0);
    mesh.normals.push(normal[0] ?? 0, normal[1] ?? 1, normal[2] ?? 0);
    return v;
  };

  const sorted = [...segs].sort((a, b) => a - b);
  for (const seg of sorted) {
    if (!liveRoadSegment(net, seg)) continue;
    const f = segFrame(net, seg);
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const t0 = trimAt(junctions(a), seg);
    const t1 = f.length - trimAt(junctions(b), seg);
    const st = stations(f.ax, f.az, f.dx, f.dz, 0, f.length, ROADS.sampleStep);
    const lineColour = ROADS.cityLines.colours[f.type.id];
    const lineRgb = lineColour === undefined ? null : linearRgb(lineColour);
    const rgb = surfaceColour(f.type);
    const paints = paintFor(f.type);
    let drew = false;

    // City lines run the whole centre line; they are one colour and unlit, so overlaps at junctions do not show.
    if (lineRgb) {
      const lst = stations(f.ax, f.az, f.dx, f.dz, 0, f.length, ROADS.cityLines.sampleStep);
      let prev: [number, number] | null = null;
      for (let k = 0; k + 1 < lst.length; k++) {
        const s0 = lst[k] ?? 0;
        const s1 = lst[k + 1] ?? 0;
        const mid = (s0 + s1) / 2;
        if (chunkAt(f.ax + f.dx * mid, f.az + f.dz * mid) !== chunk) {
          prev = null;
          continue;
        }
        const pair = (t: number): [number, number] => {
          const x = f.ax + f.dx * t;
          const z = f.az + f.dz * t;
          const y = heightAt(terrain, x, z);
          const r = lines.vertex(x, y, z, lineRgb);
          lines.sides.push(-f.nx, -f.nz);
          lines.halves.push(f.half);
          const l = lines.vertex(x, y, z, lineRgb);
          lines.sides.push(f.nx, f.nz);
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
        if (chunkAt(f.ax + f.dx * mid, f.az + f.dz * mid) !== chunk) {
          prev = null;
          continue;
        }
        const edge = (t: number) => {
          const cx = f.ax + f.dx * t;
          const cz = f.az + f.dz * t;
          const r = ground(surface, cx - f.nx * f.half, cz - f.nz * f.half, rgb);
          const l = ground(surface, cx + f.nx * f.half, cz + f.nz * f.half, rgb);
          const p = surface.positions;
          return { r, l, hr: p[r * 3 + 1] ?? 0, hl: p[l * 3 + 1] ?? 0 };
        };
        const start = prev ?? edge(s0);
        const end = edge(s1);
        surface.quad(start.r, end.r, end.l, start.l);
        prev = end;
        drew = true;
        const piece: Piece = { t0: s0, t1: s1, r0: start.hr, l0: start.hl, r1: end.hr, l1: end.hl };
        for (const paint of paints) paintPiece(markings, f, piece, paint, m.width);
        if (f.type.oneWay) arrows(markings, f, piece, t0, t1);
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
      const y = heightAt(terrain, x, z);
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
    if (!j || j.ring.length < 6) continue;
    const rgb = surfaceColour(j.type);
    const centre = ground(surface, j.x, j.z, rgb);
    const ring: number[] = [];
    for (let k = 0; k < j.ring.length; k += 2) ring.push(ground(surface, j.ring[k] ?? 0, j.ring[k + 1] ?? 0, rgb));
    const before = surface.indices.length;
    for (let k = 0; k < ring.length; k++) surface.triangle(centre, ring[k] ?? 0, ring[(k + 1) % ring.length] ?? 0);
    if (surface.indices.length > before) junctionCount++;
  }

  return { surface: surface.done(), markings: markings.done(), lines: lines.done(), segments: segCount, junctions: junctionCount };
}

/** A flat quad painted on a strip piece: from `ta` to `tb` along, from `o0` to `o1` across. */
function paintQuad(mesh: Mesh, f: SegFrame, p: Piece, ta: number, tb: number, o0: number, o1: number, rgb: readonly number[]): void {
  const lift = ROADS.markingLift;
  const at = (t: number, o: number) => {
    const x = f.ax + f.dx * t + f.nx * o;
    const z = f.az + f.dz * t + f.nz * o;
    return mesh.vertex(x, pieceHeight(f, p, t, o) + lift, z, rgb);
  };
  mesh.quad(at(ta, o0), at(tb, o0), at(tb, o1), at(ta, o1));
}

function paintPiece(mesh: Mesh, f: SegFrame, p: Piece, paint: Paint, width: number): void {
  const o0 = paint.offset - width / 2;
  const o1 = paint.offset + width / 2;
  if (!paint.dashed) {
    paintQuad(mesh, f, p, p.t0, p.t1, o0, o1, paint.rgb);
    return;
  }
  const period = ROADS.markings.dash + ROADS.markings.gap;
  // Dashes sit at fixed places along the segment, so they line up across pieces.
  for (let start = Math.floor(p.t0 / period) * period; start < p.t1; start += period) {
    const ta = Math.max(p.t0, start);
    const tb = Math.min(p.t1, start + ROADS.markings.dash);
    if (tb - ta > 1e-3) paintQuad(mesh, f, p, ta, tb, o0, o1, paint.rgb);
  }
}

/**
 * One-way arrows in every lane, pointing from node A to node B. An arrow
 * belongs to the piece its tail is on. The sim gives one-ways no direction
 * of their own until issue 12, so A to B is the direction.
 */
function arrows(mesh: Mesh, f: SegFrame, p: Piece, t0: number, t1: number): void {
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
        const x = f.ax + f.dx * t + f.nx * off;
        const z = f.az + f.dz * t + f.nz * off;
        return mesh.vertex(x, pieceHeight(f, p, t, off) + lift, z, white);
      };
      const hw = m.arrowHead.width / 2;
      mesh.triangle(at(neck, o - hw), at(tip, o), at(neck, o + hw));
    }
  }
}

// ---------------------------------------------------------------------------
// What a change touches

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
    const f = segFrame(net, seg);
    const chunks = new Set<number>();
    lineChunks(f.ax, f.az, f.dx, f.dz, f.length, chunks);
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
      const f = segFrame(net, seg);
      const away = net.segA[seg] === node ? 1 : -1;
      lineChunks(x, z, f.dx * away, f.dz * away, Math.min(ROADS.maxTrim, f.length / 2), into);
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
 * pieces in this chunk or its neighbours.
 */
export function roadMask(net: RoadNet, chunk: number, segs: Iterable<number>): Uint8Array | null {
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
    const f = segFrame(net, seg);
    const treeReach = f.half + ROADS.decorClearance.trees + slack;
    const grassReach = f.half + ROADS.decorClearance.grass + slack;
    const bx = f.ax + f.dx * f.length;
    const bz = f.az + f.dz * f.length;
    const i0 = Math.max(0, Math.floor((Math.min(f.ax, bx) - treeReach - x0) / cell));
    const i1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(f.ax, bx) + treeReach - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(f.az, bz) - treeReach - z0) / cell));
    const j1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(f.az, bz) + treeReach - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell - f.ax;
        const pz = z0 + (j + 0.5) * cell - f.az;
        const t = Math.min(f.length, Math.max(0, px * f.dx + pz * f.dz));
        const ex = px - f.dx * t;
        const ez = pz - f.dz * t;
        const d = Math.sqrt(ex * ex + ez * ez);
        if (d > treeReach) continue;
        mask ??= new Uint8Array(MASK_SIDE * MASK_SIDE);
        const k = j * MASK_SIDE + i;
        mask[k] = (mask[k] ?? 0) | MASK_TREES | (d <= grassReach ? MASK_GRASS : 0);
      }
    }
  }
  return mask;
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
