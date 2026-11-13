// Spatial index over the road graph: what road is near a point, without a
// scan of every segment.
//
// One grid cell per 500 m chunk. Each cell lists, in ascending id order, the
// nodes inside it and the segments that touch it. Positions off the map fall
// in the nearest edge cell, so a road partly off the map is still found and a
// stray coordinate cannot make the grid grow.
//
// The index is derived data (PRD, "Derived data"). It is never saved or
// hashed. `roadIndexOf` builds it from the graph arrays the first time a
// network is asked about and then keeps it current as nodes and segments are
// added and removed. Every list is kept sorted and every query breaks ties by
// the lower id, so an index kept current gives the same answers as one built
// from scratch, whatever order the changes came in.
//
// Answers feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Distances are compared squared; one `Math.sqrt` gives the result.
//
// A curved segment is filed under every cell it touches and tested against a
// box by its shape (curve.ts); a straight one by the line between its nodes.

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "../chunks";
import { curveBox, curveTouchesBox, nearestOnQuad, segmentQuad, segmentTouchesBox } from "./curve";
import { LEVELS_ALL, levelAtNode, segmentLevelBits } from "./levels";
import {
  NETWORK_PATH,
  NETWORK_RAIL,
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

/** A network filter bit for each network type. Combine with `|`. */
export const NETWORKS_ROAD = 1 << NETWORK_ROAD;
export const NETWORKS_RAIL = 1 << NETWORK_RAIL;
export const NETWORKS_PATH = 1 << NETWORK_PATH;
/** Every network. A node with no segments matches only this filter. */
export const NETWORKS_ALL = NETWORKS_ROAD | NETWORKS_RAIL | NETWORKS_PATH;

/**
 * How far past its edges a cell reaches when deciding which segments touch
 * it, in metres. Rounding in the touch test can then only add a segment to a
 * cell, never leave one out, so a query cannot miss a segment that grazes a
 * cell corner.
 */
const CELL_MARGIN = 1e-3;

/** A grid index over one network. Derived data: not state. */
export interface RoadIndex {
  readonly net: RoadNetwork;
  /** Cells along each side. Cell (ci, cj) is at `cj * cellsPerSide + ci`. */
  readonly cellsPerSide: number;
  /** Side of a cell in metres. */
  readonly cellSize: number;
  /** Ids of the live nodes in each cell, ascending. */
  readonly nodeCells: number[][];
  /** Ids of the live segments that touch each cell, ascending. */
  readonly segCells: number[][];
}

/** The grid an index lays over its network, without the cell lists. */
type Grid = Pick<RoadIndex, "net" | "cellsPerSide" | "cellSize">;

/** Grid column or row holding coordinate `v`, with off-map values in the edge cell. */
function cellOf(index: Grid, v: number): number {
  const c = Math.floor(v / index.cellSize);
  return c < 0 ? 0 : c >= index.cellsPerSide ? index.cellsPerSide - 1 : c;
}

/** Inserts `id` into ascending `list` if it is not there. */
function insertSorted(list: number[], id: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? 0) < id) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] !== id) list.splice(lo, 0, id);
}

/** Removes `id` from ascending `list`. */
function removeSorted(list: number[], id: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? 0) < id) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] !== id) throw new Error(`id ${id} is missing from a spatial index cell`);
  list.splice(lo, 1);
}

export { segmentTouchesBox };

/** Calls `visit` with each cell index segment `seg` touches. */
function forSegmentCells(index: Grid, seg: number, visit: (cell: number) => void): void {
  const { net, cellsPerSide: n, cellSize: size } = index;
  const q = segmentQuad(net, seg);
  const { minX: loX, minZ: loZ, maxX: hiX, maxZ: hiZ } = curveBox(q);
  const i0 = cellOf(index, loX);
  const i1 = cellOf(index, hiX);
  const j0 = cellOf(index, loZ);
  const j1 = cellOf(index, hiZ);
  for (let cj = j0; cj <= j1; cj++) {
    // An edge cell reaches out to cover whatever of the segment is off the map.
    const z0 = cj === 0 && loZ < 0 ? loZ : cj * size;
    const z1 = cj === n - 1 && hiZ > n * size ? hiZ : (cj + 1) * size;
    for (let ci = i0; ci <= i1; ci++) {
      const x0 = ci === 0 && loX < 0 ? loX : ci * size;
      const x1 = ci === n - 1 && hiX > n * size ? hiX : (ci + 1) * size;
      if (curveTouchesBox(q, x0 - CELL_MARGIN, z0 - CELL_MARGIN, x1 + CELL_MARGIN, z1 + CELL_MARGIN)) {
        visit(cj * n + ci);
      }
    }
  }
}

function nodeCell(index: Grid, node: number): number {
  return cellOf(index, index.net.nodeZ[node] ?? 0) * index.cellsPerSide + cellOf(index, index.net.nodeX[node] ?? 0);
}

/**
 * The 500 m chunk node `node` is in, as `cj * CHUNKS_PER_SIDE + ci`, with
 * off-map positions in the nearest edge chunk. The same cell the index files
 * it under.
 */
export function chunkOfNode(net: RoadNetwork, node: number): number {
  return nodeCell({ net, cellsPerSide: CHUNKS_PER_SIDE, cellSize: CHUNK_SIZE }, node);
}

/** Calls `visit` with each 500 m chunk segment `seg` touches: the cells the index files it under. */
export function forSegmentChunks(net: RoadNetwork, seg: number, visit: (chunk: number) => void): void {
  forSegmentCells({ net, cellsPerSide: CHUNKS_PER_SIDE, cellSize: CHUNK_SIZE }, seg, visit);
}

/** Adds live node `node` to the index. */
export function indexNode(index: RoadIndex, node: number): void {
  insertSorted(index.nodeCells[nodeCell(index, node)] ?? [], node);
}

/** Takes node `node` out of the index. Call before its fields are cleared. */
export function unindexNode(index: RoadIndex, node: number): void {
  removeSorted(index.nodeCells[nodeCell(index, node)] ?? [], node);
}

/** Adds live segment `seg` to the index. */
export function indexSegment(index: RoadIndex, seg: number): void {
  forSegmentCells(index, seg, (cell) => insertSorted(index.segCells[cell] ?? [], seg));
}

/** Takes segment `seg` out of the index. Call before its fields are cleared. */
export function unindexSegment(index: RoadIndex, seg: number): void {
  forSegmentCells(index, seg, (cell) => removeSorted(index.segCells[cell] ?? [], seg));
}

/**
 * A new index over `net` as it is now. It does not follow later changes; for
 * that, use `roadIndexOf`. The client builds one over its read-only copy.
 */
export function buildRoadIndex(net: RoadNetwork): RoadIndex {
  const n = CHUNKS_PER_SIDE;
  const index: RoadIndex = {
    net,
    cellsPerSide: n,
    cellSize: CHUNK_SIZE,
    nodeCells: Array.from({ length: n * n }, () => []),
    segCells: Array.from({ length: n * n }, () => []),
  };
  // Ascending ids, so each cell list is filled already sorted.
  for (let node = 0; node < nodeIdLimit(net); node++) {
    if (isNode(net, node)) index.nodeCells[nodeCell(index, node)]?.push(node);
  }
  for (let seg = 0; seg < segmentIdLimit(net); seg++) {
    if (isSegment(net, seg)) forSegmentCells(index, seg, (cell) => index.segCells[cell]?.push(seg));
  }
  return index;
}

// Live indexes by network object. A network loaded from a save, cloned or
// replayed is a new object, so it gets a fresh index built from its arrays.
const live = new WeakMap<RoadNetwork, RoadIndex>();

/**
 * The index of `net`, kept current through every change made with the
 * functions in network.ts. Built on first use.
 */
export function roadIndexOf(net: RoadNetwork): RoadIndex {
  let index = live.get(net);
  if (!index) {
    const built = buildRoadIndex(net);
    observeNetwork(net, {
      nodeAdded: (id) => indexNode(built, id),
      nodeRemoving: (id) => unindexNode(built, id),
      segmentAdded: (id) => indexSegment(built, id),
      segmentRemoving: (id) => unindexSegment(built, id),
    });
    live.set(net, built);
    index = built;
  }
  return index;
}

/**
 * The index of `net` if one has been built, or null. For code that changes a
 * network without the functions in network.ts, such as `applyRoadDelta`, so
 * it can keep an existing index current without building one nobody asked for.
 */
export function existingRoadIndex(net: RoadNetwork): RoadIndex | null {
  return live.get(net) ?? null;
}

// ---- Queries ----

function checkPoint(x: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError(`point (${x}, ${z}) is not finite`);
}

function checkRadius(radius: number): void {
  if (!(radius >= 0)) throw new RangeError(`radius must be zero or more, got ${radius}`);
}

function checkNetworks(networks: number): void {
  if (!Number.isInteger(networks) || networks < 0 || networks > NETWORKS_ALL) {
    throw new RangeError(`bad network filter ${networks}`);
  }
}

function checkLevels(levels: number): void {
  if (!Number.isInteger(levels) || levels < 0 || levels > LEVELS_ALL) {
    throw new RangeError(`bad level filter ${levels}`);
  }
}

function segmentOnNetworks(net: RoadNetwork, seg: number, networks: number, levels: number = LEVELS_ALL): boolean {
  if (((1 << (net.segNetwork[seg] ?? 0)) & networks) === 0) return false;
  return levels === LEVELS_ALL || (segmentLevelBits(net, seg) & levels) !== 0;
}

/**
 * Whether node `node` belongs to a network and level in the filters: at
 * least one segment on it does, and on a level filter by its level at this
 * node. A node with no segments matches only NETWORKS_ALL and LEVELS_ALL.
 */
export function nodeOnNetworks(net: RoadNetwork, node: number, networks: number, levels: number = LEVELS_ALL): boolean {
  if (networks === NETWORKS_ALL && levels === LEVELS_ALL) return true;
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
    if (((1 << (net.segNetwork[seg] ?? 0)) & networks) === 0) continue;
    if (((1 << levelAtNode(net, seg, node)) & levels) !== 0) return true;
  }
  return false;
}

/** The nearest node and how far it is, in metres. */
export interface NearestNode {
  node: number;
  distance: number;
}

/**
 * The node nearest (x, z) no further than `radius` metres away, on a network
 * and a level in the filters, or null. Of nodes at the same distance, the
 * lowest id.
 */
export function nearestNode(
  index: RoadIndex,
  x: number,
  z: number,
  radius: number,
  networks: number = NETWORKS_ALL,
  levels: number = LEVELS_ALL,
): NearestNode | null {
  checkPoint(x, z);
  checkRadius(radius);
  checkNetworks(networks);
  checkLevels(levels);
  const { net, cellsPerSide: n } = index;
  const r2 = radius * radius;
  let best = NONE;
  let bestD2 = Infinity;
  const i0 = cellOf(index, x - radius);
  const i1 = cellOf(index, x + radius);
  const j0 = cellOf(index, z - radius);
  const j1 = cellOf(index, z + radius);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      for (const node of index.nodeCells[cj * n + ci] ?? []) {
        const dx = (net.nodeX[node] ?? 0) - x;
        const dz = (net.nodeZ[node] ?? 0) - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || d2 > bestD2 || (d2 === bestD2 && node > best)) continue;
        if (!nodeOnNetworks(net, node, networks, levels)) continue;
        best = node;
        bestD2 = d2;
      }
    }
  }
  return best === NONE ? null : { node: best, distance: Math.sqrt(bestD2) };
}

/** The nearest point on a segment. */
export interface NearestPoint {
  segment: number;
  x: number;
  z: number;
  /** The curve parameter from node A to node B, 0 to 1. On a straight segment, the share of its length. */
  t: number;
  distance: number;
}

/**
 * The point on a segment nearest (x, z), no further than `radius` metres
 * away, on a network and a level in the filters, or null. A segment matches
 * a level filter by either end's level. Of segments at the same distance,
 * the lowest id.
 */
export function nearestPointOnSegment(
  index: RoadIndex,
  x: number,
  z: number,
  radius: number,
  networks: number = NETWORKS_ALL,
  levels: number = LEVELS_ALL,
): NearestPoint | null {
  checkPoint(x, z);
  checkRadius(radius);
  checkNetworks(networks);
  checkLevels(levels);
  const { net, cellsPerSide: n } = index;
  const r2 = radius * radius;
  let best = NONE;
  let bestD2 = Infinity;
  let bestT = 0;
  let bestX = 0;
  let bestZ = 0;
  const i0 = cellOf(index, x - radius);
  const i1 = cellOf(index, x + radius);
  const j0 = cellOf(index, z - radius);
  const j1 = cellOf(index, z + radius);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      for (const seg of index.segCells[cj * n + ci] ?? []) {
        // A segment in several cells is seen more than once; the second look
        // finds the same distance and the same id, so changes nothing.
        if (seg === best || !segmentOnNetworks(net, seg, networks, levels)) continue;
        const a = net.segA[seg] ?? NONE;
        const b = net.segB[seg] ?? NONE;
        const ax = net.nodeX[a] ?? 0;
        const az = net.nodeZ[a] ?? 0;
        const bx = net.nodeX[b] ?? 0;
        const bz = net.nodeZ[b] ?? 0;
        let t: number;
        let px: number;
        let pz: number;
        if (net.segCX[seg] === (ax + bx) / 2 && net.segCZ[seg] === (az + bz) / 2) {
          // Straight, the common case: project onto the line, as `nearestOnQuad` does, without building a curve.
          const sx = bx - ax;
          const sz = bz - az;
          const len2 = sx * sx + sz * sz;
          t = len2 > 0 ? ((x - ax) * sx + (z - az) * sz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          px = ax + t * sx;
          pz = az + t * sz;
        } else {
          const near = nearestOnQuad(segmentQuad(net, seg), x, z);
          t = near.t;
          px = near.x;
          pz = near.z;
        }
        const dx = px - x;
        const dz = pz - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || d2 > bestD2 || (d2 === bestD2 && seg > best)) continue;
        best = seg;
        bestD2 = d2;
        bestT = t;
        bestX = px;
        bestZ = pz;
      }
    }
  }
  return best === NONE ? null : { segment: best, x: bestX, z: bestZ, t: bestT, distance: Math.sqrt(bestD2) };
}

/**
 * Ids of the segments that touch the box, edges included, ascending, on a
 * network and a level in the filters. A segment matches a level filter by
 * either end's level.
 */
export function segmentsInBox(
  index: RoadIndex,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  networks: number = NETWORKS_ALL,
  levels: number = LEVELS_ALL,
): number[] {
  checkPoint(minX, minZ);
  checkPoint(maxX, maxZ);
  if (minX > maxX || minZ > maxZ) throw new RangeError("the box's minimum is past its maximum");
  checkNetworks(networks);
  checkLevels(levels);
  const { net, cellsPerSide: n } = index;
  const found: number[] = [];
  for (let cj = cellOf(index, minZ); cj <= cellOf(index, maxZ); cj++) {
    for (let ci = cellOf(index, minX); ci <= cellOf(index, maxX); ci++) {
      for (const seg of index.segCells[cj * n + ci] ?? []) {
        if (!segmentOnNetworks(net, seg, networks, levels)) continue;
        const a = net.segA[seg] ?? NONE;
        const b = net.segB[seg] ?? NONE;
        const ax = net.nodeX[a] ?? 0;
        const az = net.nodeZ[a] ?? 0;
        const bx = net.nodeX[b] ?? 0;
        const bz = net.nodeZ[b] ?? 0;
        const straight = net.segCX[seg] === (ax + bx) / 2 && net.segCZ[seg] === (az + bz) / 2;
        const touches = straight
          ? segmentTouchesBox(ax, az, bx, bz, minX, minZ, maxX, maxZ)
          : curveTouchesBox(segmentQuad(net, seg), minX, minZ, maxX, maxZ);
        if (touches) found.push(seg);
      }
    }
  }
  found.sort((p, q) => p - q);
  let kept = 0;
  for (let i = 0; i < found.length; i++) {
    if (i === 0 || found[i] !== found[kept - 1]) found[kept++] = found[i] ?? 0;
  }
  found.length = kept;
  return found;
}
