// Blocks: the areas fully enclosed by ground-level roads (issue M1-18).
//
// Roads split wherever they cross (issue 04), so the ground-level road
// segments form a planar graph and each bounded face of it is one block.
// Bridges, tunnels, rail and paths are left out, so they never split a
// block or close one.
//
// The faces come from a walk over half-edges. Half-edge `2 * seg` runs along
// segment `seg` from its node A to node B, and `2 * seg + 1` from B to A,
// the same numbering as the routing graph's edges. Around each node the
// half-edges leaving it are put in counterclockwise order by the direction
// they leave in: the tangent, so a curve is placed by the way it sets off.
// Arriving at a node along half-edge h, the walk goes on along the half-edge
// that comes just clockwise of h's reverse. Here counterclockwise means
// turning from +x toward +z, which on a map with north up looks clockwise,
// since z points south. With that rule a bounded face is walked
// counterclockwise and has a positive signed area, and the outside of each
// separate piece of network comes out clockwise, with a negative one. A dead end is walked out and back, so it
// stays inside the face around it and its two passes add no area. A piece of
// network with no loop has only one face, of no area.
//
// A face is a block when its area is positive. Its id is the lowest
// half-edge on its walk, and its boundary starts there, so both come from
// the graph alone: a block kept current and one rebuilt from a save get the
// same id and the same loop.
//
// The order around a node uses exact comparisons only: which half of the
// plane a direction is in, then a cross product, then for two that leave in
// the same direction, which one bends further clockwise. Areas use only
// multiply and add, plus the exact two thirds for a curve. So every machine
// walks the same faces (CLAUDE.md rule 6).
//
// Blocks are derived data (PRD, "Derived data"), cached by network object
// like the spatial index and the routing graph. A change only marks the
// faces it touches, through the observer hooks in network.ts or
// `applyRoadDelta` on a client's copy, and the next read walks those faces
// again. A road far from the change leaves its faces alone.

import { isStraight, segmentQuad, type Quad } from "./curve";
import {
  LEVEL_GROUND,
  NETWORK_ROAD,
  NONE,
  isNode,
  isSegment,
  nextSegmentAt,
  nodeIdLimit,
  observeNetwork,
  segmentIdLimit,
  type RoadNetwork,
} from "./network";

/**
 * Faces with less area than this, in square metres, are not blocks. The two
 * passes along a dead end, or round a piece of network with no loop, cancel
 * to within rounding, and this keeps that dust out. No real block is this
 * small: the roads around it are wider. A tolerance, not a balance number.
 */
export const BLOCK_MIN_AREA = 1;

/** One block: an area fully enclosed by ground-level roads. */
export interface Block {
  /** The lowest half-edge on the boundary: `2 * segment`, plus 1 when it runs from node B to node A. */
  id: number;
  /**
   * The boundary, counterclockwise as the header describes it, from the
   * half-edge that gives the block its id. A dead end inside the block is in
   * it twice, out and back.
   */
  segments: number[];
  /** For each segment, whether the boundary runs along it from node A to node B. */
  forward: boolean[];
  /** Square metres in plan, curves included. */
  area: number;
}

/** The blocks of one network. Derived data: not state. */
export interface BlockIndex {
  readonly net: RoadNetwork;
  /** 1 where a segment is a ground-level road, so bounds blocks. */
  inGraph: Uint8Array;
  /** The half-edge the face walk takes after each one, or NONE. */
  next: Int32Array;
  /** The face each half-edge is on, as that face's id, or NONE when not yet walked. */
  face: Int32Array;
  /** Every face's half-edges in walk order, from its id. Faces that are not blocks too. */
  faces: Map<number, Int32Array>;
  /** The faces that are blocks, by id. */
  blocks: Map<number, Block>;
  /** Faces a change touched, walked again on the next read. */
  dirtyFaces: Set<number>;
  /** Half-edges added since the last read. */
  fresh: Set<number>;
}

/** Whether segment `seg` bounds blocks: a live road segment at ground level. */
export function boundsBlocks(net: RoadNetwork, seg: number): boolean {
  return isSegment(net, seg) && net.segNetwork[seg] === NETWORK_ROAD && net.segLevel[seg] === LEVEL_GROUND;
}

function ensureSegments(index: BlockIndex, seg: number): void {
  if (index.inGraph.length > seg) return;
  let size = Math.max(16, index.inGraph.length);
  while (size <= seg) size *= 2;
  const inGraph = new Uint8Array(size);
  inGraph.set(index.inGraph);
  const next = new Int32Array(2 * size).fill(NONE);
  next.set(index.next);
  const face = new Int32Array(2 * size).fill(NONE);
  face.set(index.face);
  index.inGraph = inGraph;
  index.next = next;
  index.face = face;
}

// ---- The order of half-edges around a node ----

/** How half-edge `h` leaves its start node: tangent (dx, dz) and the curve's bend (kx, kz). */
interface Leaving {
  h: number;
  dx: number;
  dz: number;
  /** Twice the second derivative over two: start - 2 * control + end. Zero for a straight segment. */
  kx: number;
  kz: number;
}

function leaving(net: RoadNetwork, h: number): Leaving {
  const q: Quad = segmentQuad(net, h >> 1);
  const fromA = (h & 1) === 0;
  const sx = fromA ? q.ax : q.bx;
  const sz = fromA ? q.az : q.bz;
  const ex = fromA ? q.bx : q.ax;
  const ez = fromA ? q.bz : q.az;
  let dx = q.cx - sx;
  let dz = q.cz - sz;
  // A control point on the node itself leaves no tangent: go by the chord.
  if (dx === 0 && dz === 0) {
    dx = ex - sx;
    dz = ez - sz;
  }
  return { h, dx, dz, kx: sx - 2 * q.cx + ex, kz: sz - 2 * q.cz + ez };
}

/** 0 for a direction at an angle in [0, 180) degrees from +x toward +z, 1 for [180, 360). */
function halfOf(dx: number, dz: number): number {
  return dz > 0 || (dz === 0 && dx > 0) ? 0 : 1;
}

/** Negative when `p` comes before `q` counterclockwise from +x, positive after. Never 0 for two half-edges. */
function compareLeaving(p: Leaving, q: Leaving): number {
  const hp = halfOf(p.dx, p.dz);
  const hq = halfOf(q.dx, q.dz);
  if (hp !== hq) return hp - hq;
  const cross = p.dx * q.dz - p.dz * q.dx;
  if (cross > 0) return -1;
  if (cross < 0) return 1;
  // Same tangent. The curve that bends further clockwise comes first. The
  // bend is cross(d, k) / |d|^3; with q's tangent lambda times p's, compare
  // cross(dp, kp) * lambda^3 with cross(dq, kq), with no square roots.
  const lambda = (q.dx * p.dx + q.dz * p.dz) / (p.dx * p.dx + p.dz * p.dz);
  const bp = (p.dx * p.kz - p.dz * p.kx) * lambda * lambda * lambda;
  const bq = q.dx * q.kz - q.dz * q.kx;
  if (bp < bq) return -1;
  if (bp > bq) return 1;
  return p.h - q.h;
}

/** Points `next` at the right half-edge for every half-edge arriving at `node`. */
function relinkNode(index: BlockIndex, node: number): void {
  const { net } = index;
  const out: Leaving[] = [];
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
    if (!index.inGraph[seg]) continue;
    out.push(leaving(net, net.segA[seg] === node ? 2 * seg : 2 * seg + 1));
  }
  out.sort(compareLeaving);
  for (let i = 0; i < out.length; i++) {
    const back = out[i]?.h ?? NONE;
    // Arriving along the reverse of `back`, go on clockwise of it.
    const cw = out[(i + out.length - 1) % out.length]?.h ?? NONE;
    index.next[back ^ 1] = cw;
  }
}

/** Marks the faces of every half-edge at `node` for walking again. */
function dirtyNode(index: BlockIndex, node: number): void {
  const { net } = index;
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
    if (!index.inGraph[seg]) continue;
    dirtyHalfEdge(index, 2 * seg);
    dirtyHalfEdge(index, 2 * seg + 1);
  }
}

function dirtyHalfEdge(index: BlockIndex, h: number): void {
  const f = index.face[h] ?? NONE;
  if (f !== NONE) index.dirtyFaces.add(f);
}

// ---- Keeping it current ----

/**
 * Takes in segment `seg` as it is now, if it bounds blocks. Its nodes'
 * faces are walked again on the next read.
 */
export function addBlockSegment(index: BlockIndex, seg: number): void {
  const { net } = index;
  if (!boundsBlocks(net, seg)) return;
  ensureSegments(index, seg);
  if (index.inGraph[seg]) removeBlockSegment(index, seg);
  const a = net.segA[seg] ?? NONE;
  const b = net.segB[seg] ?? NONE;
  dirtyNode(index, a);
  dirtyNode(index, b);
  index.inGraph[seg] = 1;
  index.face[2 * seg] = NONE;
  index.face[2 * seg + 1] = NONE;
  index.fresh.add(2 * seg);
  index.fresh.add(2 * seg + 1);
  relinkNode(index, a);
  relinkNode(index, b);
}

/**
 * Lets go of segment `seg`. Its fields must still hold the values it was
 * taken in with; it may or may not still be in its nodes' lists.
 */
export function removeBlockSegment(index: BlockIndex, seg: number): void {
  if (seg >= index.inGraph.length || !index.inGraph[seg]) return;
  const { net } = index;
  const a = net.segA[seg] ?? NONE;
  const b = net.segB[seg] ?? NONE;
  dirtyNode(index, a);
  dirtyNode(index, b);
  dirtyHalfEdge(index, 2 * seg);
  dirtyHalfEdge(index, 2 * seg + 1);
  index.inGraph[seg] = 0;
  index.next[2 * seg] = NONE;
  index.next[2 * seg + 1] = NONE;
  index.face[2 * seg] = NONE;
  index.face[2 * seg + 1] = NONE;
  index.fresh.delete(2 * seg);
  index.fresh.delete(2 * seg + 1);
  relinkNode(index, a);
  relinkNode(index, b);
}

/** Twice the signed area half-edge `h` adds, measured from (ox, oz). */
function twiceArea(net: RoadNetwork, h: number, ox: number, oz: number): number {
  const q = segmentQuad(net, h >> 1);
  const fromA = (h & 1) === 0;
  const sx = (fromA ? q.ax : q.bx) - ox;
  const sz = (fromA ? q.az : q.bz) - oz;
  const ex = (fromA ? q.bx : q.ax) - ox;
  const ez = (fromA ? q.bz : q.az) - oz;
  const chord = sx * ez - ex * sz;
  if (isStraight(q)) return chord;
  // The chord plus two thirds of the triangle from the ends to the control
  // point: (s x e + 2 s x c + 2 c x e) / 3.
  const cx = q.cx - ox;
  const cz = q.cz - oz;
  return (chord + 2 * (sx * cz - cx * sz) + 2 * (cx * ez - ex * cz)) / 3;
}

/** Walks every face a change touched since the last read. */
function settle(index: BlockIndex): void {
  if (index.dirtyFaces.size === 0 && index.fresh.size === 0) return;
  const { net } = index;
  const todo: number[] = [];
  for (const f of index.dirtyFaces) {
    for (const h of index.faces.get(f) ?? []) if (index.inGraph[h >> 1]) todo.push(h);
    index.faces.delete(f);
    index.blocks.delete(f);
  }
  for (const h of index.fresh) todo.push(h);
  index.dirtyFaces.clear();
  index.fresh.clear();
  for (const h of todo) index.face[h] = NONE;
  // A mark for half-edges walked in this pass, before their face id is known.
  const WALKING = -2;
  for (const start of todo) {
    if (index.face[start] !== NONE) continue;
    const walk: number[] = [];
    let low = start;
    let at = 0;
    for (let h = start; ; ) {
      if (index.face[h] !== NONE) throw new Error(`block walk from ${start} ran into half-edge ${h}, already walked`);
      index.face[h] = WALKING;
      if (h < low) {
        low = h;
        at = walk.length;
      }
      walk.push(h);
      h = index.next[h] ?? NONE;
      if (h === start) break;
      if (h === NONE) throw new Error(`block walk from ${start} hit a half-edge with no next`);
    }
    // Start the loop at its lowest half-edge, so its order comes from the graph alone.
    const loop = new Int32Array(walk.length);
    for (let i = 0; i < walk.length; i++) loop[i] = walk[(at + i) % walk.length] ?? NONE;
    for (const h of loop) index.face[h] = low;
    index.faces.set(low, loop);
    // Measured from the loop's first node, so the numbers stay small.
    const first = ((low & 1) === 0 ? net.segA[low >> 1] : net.segB[low >> 1]) ?? 0;
    const ox = net.nodeX[first] ?? 0;
    const oz = net.nodeZ[first] ?? 0;
    let twice = 0;
    for (const h of loop) twice += twiceArea(net, h, ox, oz);
    const area = twice / 2;
    if (area > BLOCK_MIN_AREA) {
      const segments: number[] = [];
      const forward: boolean[] = [];
      for (const h of loop) {
        segments.push(h >> 1);
        forward.push((h & 1) === 0);
      }
      index.blocks.set(low, { id: low, segments, forward, area });
    }
  }
}

function emptyIndex(net: RoadNetwork): BlockIndex {
  const size = Math.max(16, segmentIdLimit(net));
  return {
    net,
    inGraph: new Uint8Array(size),
    next: new Int32Array(2 * size).fill(NONE),
    face: new Int32Array(2 * size).fill(NONE),
    faces: new Map(),
    blocks: new Map(),
    dirtyFaces: new Set(),
    fresh: new Set(),
  };
}

/**
 * The blocks of `net` as it is now, walked from scratch. It does not follow
 * later changes; for that, use `blockIndexOf`.
 */
export function buildBlockIndex(net: RoadNetwork): BlockIndex {
  const index = emptyIndex(net);
  const limit = segmentIdLimit(net);
  for (let seg = 0; seg < limit; seg++) {
    if (!boundsBlocks(net, seg)) continue;
    index.inGraph[seg] = 1;
    index.fresh.add(2 * seg);
    index.fresh.add(2 * seg + 1);
  }
  for (let node = 0; node < nodeIdLimit(net); node++) if (isNode(net, node)) relinkNode(index, node);
  settle(index);
  return index;
}

// Live indexes by network object, as with the spatial index.
const live = new WeakMap<RoadNetwork, BlockIndex>();

/**
 * The blocks of `net`, kept current through every change made with the
 * functions in network.ts. Built on first use.
 */
export function blockIndexOf(net: RoadNetwork): BlockIndex {
  let index = live.get(net);
  if (!index) {
    const built = buildBlockIndex(net);
    observeNetwork(net, {
      nodeAdded: () => undefined,
      nodeRemoving: () => undefined,
      segmentAdded: (id) => addBlockSegment(built, id),
      segmentRemoving: (id) => removeBlockSegment(built, id),
    });
    live.set(net, built);
    index = built;
  }
  return index;
}

/** The block index of `net` if one has been built, or null. For `applyRoadDelta`. */
export function existingBlockIndex(net: RoadNetwork): BlockIndex | null {
  return live.get(net) ?? null;
}

/** Every block, by ascending id. */
export function listBlocks(index: BlockIndex): Block[] {
  settle(index);
  return [...index.blocks.values()].sort((p, q) => p.id - q.id);
}

/** The block with id `id`, or null. */
export function blockById(index: BlockIndex, id: number): Block | null {
  settle(index);
  return index.blocks.get(id) ?? null;
}

/** Whether two indexes hold the same blocks: ids, boundaries and areas. */
export function sameBlocks(p: BlockIndex, q: BlockIndex): boolean {
  const a = listBlocks(p);
  const b = listBlocks(q);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.id !== y.id || !Object.is(x.area, y.area) || x.segments.length !== y.segments.length) return false;
    for (let k = 0; k < x.segments.length; k++) {
      if (x.segments[k] !== y.segments[k] || x.forward[k] !== y.forward[k]) return false;
    }
  }
  return true;
}
