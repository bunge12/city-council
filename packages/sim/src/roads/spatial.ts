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
// Until curves land (issue 09) every segment is the straight line between its
// nodes.

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "../chunks";
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

/** Calls `visit` with each cell index segment `seg` touches. */
function forSegmentCells(index: Grid, seg: number, visit: (cell: number) => void): void {
  const { net, cellsPerSide: n, cellSize: size } = index;
  const a = net.segA[seg] ?? NONE;
  const b = net.segB[seg] ?? NONE;
  const ax = net.nodeX[a] ?? 0;
  const az = net.nodeZ[a] ?? 0;
  const bx = net.nodeX[b] ?? 0;
  const bz = net.nodeZ[b] ?? 0;
  const loX = ax < bx ? ax : bx;
  const hiX = ax > bx ? ax : bx;
  const loZ = az < bz ? az : bz;
  const hiZ = az > bz ? az : bz;
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
      if (segmentTouchesBox(ax, az, bx, bz, x0 - CELL_MARGIN, z0 - CELL_MARGIN, x1 + CELL_MARGIN, z1 + CELL_MARGIN)) {
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

function segmentOnNetworks(net: RoadNetwork, seg: number, networks: number): boolean {
  return ((1 << (net.segNetwork[seg] ?? 0)) & networks) !== 0;
}

/**
 * Whether node `node` belongs to a network in the filter: at least one
 * segment on it does. A node with no segments matches only NETWORKS_ALL.
 */
export function nodeOnNetworks(net: RoadNetwork, node: number, networks: number): boolean {
  if (networks === NETWORKS_ALL) return true;
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
    if (segmentOnNetworks(net, seg, networks)) return true;
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
 * in the filter, or null. Of nodes at the same distance, the lowest id.
 */
export function nearestNode(
  index: RoadIndex,
  x: number,
  z: number,
  radius: number,
  networks: number = NETWORKS_ALL,
): NearestNode | null {
  checkPoint(x, z);
  checkRadius(radius);
  checkNetworks(networks);
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
        if (!nodeOnNetworks(net, node, networks)) continue;
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
  /** How far along the segment from node A to node B, 0 to 1. */
  t: number;
  distance: number;
}

/**
 * The point on a segment nearest (x, z), no further than `radius` metres
 * away, on a network in the filter, or null. Of segments at the same
 * distance, the lowest id.
 */
export function nearestPointOnSegment(
  index: RoadIndex,
  x: number,
  z: number,
  radius: number,
  networks: number = NETWORKS_ALL,
): NearestPoint | null {
  checkPoint(x, z);
  checkRadius(radius);
  checkNetworks(networks);
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
        if (seg === best || !segmentOnNetworks(net, seg, networks)) continue;
        const a = net.segA[seg] ?? NONE;
        const b = net.segB[seg] ?? NONE;
        const ax = net.nodeX[a] ?? 0;
        const az = net.nodeZ[a] ?? 0;
        const sx = (net.nodeX[b] ?? 0) - ax;
        const sz = (net.nodeZ[b] ?? 0) - az;
        const len2 = sx * sx + sz * sz;
        let t = len2 > 0 ? ((x - ax) * sx + (z - az) * sz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * sx;
        const pz = az + t * sz;
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

/** Ids of the segments that touch the box, edges included, ascending. */
export function segmentsInBox(
  index: RoadIndex,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  networks: number = NETWORKS_ALL,
): number[] {
  checkPoint(minX, minZ);
  checkPoint(maxX, maxZ);
  if (minX > maxX || minZ > maxZ) throw new RangeError("the box's minimum is past its maximum");
  checkNetworks(networks);
  const { net, cellsPerSide: n } = index;
  const found: number[] = [];
  for (let cj = cellOf(index, minZ); cj <= cellOf(index, maxZ); cj++) {
    for (let ci = cellOf(index, minX); ci <= cellOf(index, maxX); ci++) {
      for (const seg of index.segCells[cj * n + ci] ?? []) {
        if (!segmentOnNetworks(net, seg, networks)) continue;
        const a = net.segA[seg] ?? NONE;
        const b = net.segB[seg] ?? NONE;
        const touches = segmentTouchesBox(
          net.nodeX[a] ?? 0,
          net.nodeZ[a] ?? 0,
          net.nodeX[b] ?? 0,
          net.nodeZ[b] ?? 0,
          minX,
          minZ,
          maxX,
          maxZ,
        );
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
