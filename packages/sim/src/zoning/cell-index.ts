// Where each zoning cell is and whether it is blocked (M2-03). Derived data
// (PRD, "Derived data"): rebuilt from the road graph and the terrain, never
// saved or hashed. Only the zone and density of each cell are state
// (cells.ts).
//
// A cell is blocked when
//   - any corner leaves the map,
//   - its centre or any corner is water,
//   - the ground at its centre is steeper than `maxSlope` in zoning.json,
//   - it folds over itself on the inside of a bend too tight for it,
//   - the surface of another segment on the ground or a bridge covers it,
//     whatever its network: road, rail or path,
//   - or it overlaps a cell that claimed the ground first.
// Cells claim ground in a fixed order: the older segment first, by build
// order and then by lower id, since the pieces of one split and the streets
// of one grid share an age. Within a segment, nearer node A first, so where
// the cells of one strip close up on the inside of a bend the earlier one
// stays. A cell that is blocked for any reason claims nothing, so the next
// cell in the order can have that ground.
//
// The result is the same as walking every cell in that order once and
// giving each the ground no earlier cell holds. `buildCellIndex` does that.
// `syncCells` keeps it current after the roads change. It finds the
// segments that changed, from the ones the network reported adding or
// removing, each compared with the copy it took last time, and walks again only the cells that could have changed: the changed
// segments' own, the ones their road surfaces cover or covered, the ones
// their old cells overlapped, and then, in claim order, any cell whose
// overlapping neighbour gained or lost its claim. Each is looked at only
// after every cell that claims before it is settled, so the answer is the
// one a full walk gives, whatever order the changes came in.
//
// `syncCells` also lays out the zone and density arrays in state for the new
// roads (cells.ts). A segment that is unchanged keeps its cells. A segment
// changed in place, as by an upgrade or a reverse, keeps its cells by name:
// they move out with a wider road's edge, and a reverse turns place k on the
// left into place n - 1 - k on the right. Any other new segment takes the
// zone of the cell of a removed segment of the same build order whose ground
// its cell's centre lies on. That is how the pieces of a split, and a road
// an undo brings back, take over the cells that were there.
//
// Shapes use only exact arithmetic (shape.ts), so every machine walks the
// same cells to the same answer (CLAUDE.md rule 6).

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "../chunks";
import { ROAD_TYPES } from "../roads/balance";
import { LEVEL_BRIDGE, LEVEL_GROUND, isNode, isSegment, observeNetwork, segmentIdLimit, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { isWaterAt, mapSize, slopeAt, type Terrain } from "../terrain/terrain";
import { ZONING_BALANCE } from "./balance";
import { cellsPerPlace, fromLocal, zonableFields, type CellRef, type CellState } from "./cells";
import {
  STATION_FLOATS,
  cellCornersInto,
  cellsAlong,
  isConvexQuad,
  quadBoxInto,
  quadCentre,
  quadContains,
  quadsOverlap,
  stationsOf,
  surfaceInto,
} from "./shape";

/** Why a cell can or cannot be zoned. The values are not saved. */
export const CELL_OPEN = 0;
/** A corner is off the map. */
export const CELL_OFF_MAP = 1;
/** The centre or a corner is water. */
export const CELL_WATER = 2;
/** The ground at its centre is steeper than `maxSlope`. */
export const CELL_STEEP = 3;
/** A road, rail or path surface covers it. */
export const CELL_ROAD = 4;
/** It folds over itself, or overlaps an earlier cell of its own segment, on the inside of a bend. */
export const CELL_BEND = 5;
/** It overlaps a cell of an older road, which keeps the ground. */
export const CELL_TAKEN = 6;
/** Not yet walked. Never left behind by a walk. */
const UNSET = 255;

/** Side of a bucket in the grid that finds cells and surfaces near a point, metres. */
const BUCKET = 32;
/**
 * A cell's key is `segment * KEY_STRIDE + its place in the segment's run`,
 * and a surface piece's `segment * KEY_STRIDE + piece`.
 */
const KEY_STRIDE = 2 ** 21;
/** Station gaps per surface piece of a straight segment. A curve has one piece per gap, to follow it. */
const STRAIGHT_PIECE = 4;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const CELL = ZONING_BALANCE.cellSize;

/** One segment as the index last saw it. */
interface SegShape {
  a: number;
  b: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cx: number;
  cz: number;
  type: number;
  network: number;
  levelA: number;
  levelB: number;
  order: number;
  length: number;
  /** Half the road's width, metres. */
  half: number;
  straight: boolean;
  /** Places along, when it has cells; 0 otherwise. */
  places: number;
  /** Stations every cell size from node A, and one at node B. Null when it has neither cells nor a surface. */
  stations: Float64Array | null;
  /**
   * Its surface pieces, eight floats each as `surfaceInto` writes them, when
   * its surface covers cells: ground or bridge at either end. A straight
   * segment's pieces are STRAIGHT_PIECE station gaps long, a curve's one,
   * so each piece's box is small and a long road is not tested whole.
   */
  surface: Float64Array | null;
  /** The box around each surface piece, four floats each. */
  surfaceBoxes: Float64Array | null;
  /** Each cell's CELL_ value, in run order. Null when it has no cells. */
  status: Uint8Array | null;
}

/** The cells of one network. Derived data: not state. */
export interface CellIndex {
  readonly net: RoadNetwork;
  readonly terrain: Terrain;
  /** Buckets along each side. Bucket (i, j) is at `j * perSide + i`. */
  readonly perSide: number;
  /** Keys of the cells whose box touches each bucket, in no particular order. */
  readonly cellBuckets: (number[] | undefined)[];
  /** The same for open cells only, the ones that hold ground. */
  readonly openBuckets: (number[] | undefined)[];
  /** Keys of the surface pieces whose box touches each bucket, in no particular order. */
  readonly surfaceBuckets: (number[] | undefined)[];
  /** Each segment id as last seen, null where none was live. */
  segs: (SegShape | null)[];
  /** Segment ids the network has added or removed since the index last looked. */
  readonly touched: Set<number>;
}

// Scratch space. The sim runs on one thread, and no two users of one of
// these are ever live at once.
const quadA = new Float64Array(8);
const boxA = new Float64Array(4);
const quadB = new Float64Array(8);
const boxB = new Float64Array(4);
const quadW = new Float64Array(8);
const boxW = new Float64Array(4);

const keyOf = (seg: number, local: number): number => seg * KEY_STRIDE + local;
const segOfKey = (key: number): number => Math.floor(key / KEY_STRIDE);

// ---- Segment shapes ----

/** Segment `id` of `net` as the index keeps it, or null if it is not live. */
function shapeOf(net: RoadNetwork, id: number): SegShape | null {
  if (!isSegment(net, id)) return null;
  const a = net.segA[id] ?? 0;
  const b = net.segB[id] ?? 0;
  const ax = net.nodeX[a] ?? 0;
  const az = net.nodeZ[a] ?? 0;
  const bx = net.nodeX[b] ?? 0;
  const bz = net.nodeZ[b] ?? 0;
  const cx = net.segCX[id] ?? 0;
  const cz = net.segCZ[id] ?? 0;
  const type = net.segType[id] ?? 0;
  const network = net.segNetwork[id] ?? 0;
  const levelA = net.segLevelA[id] ?? 0;
  const levelB = net.segLevelB[id] ?? 0;
  const length = net.segLength[id] ?? 0;
  const places = zonableFields(network, type, levelA, levelB) ? cellsAlong(length, CELL) : 0;
  const onSurface = (level: number) => level === LEVEL_GROUND || level === LEVEL_BRIDGE;
  const covers = onSurface(levelA) || onSurface(levelB);
  const stations = places > 0 || covers ? stationsOf(ax, az, cx, cz, bx, bz, length, CELL, cellsAlong(length, CELL)) : null;
  const straight = cx === (ax + bx) / 2 && cz === (az + bz) / 2;
  // Rail and paths have no width table yet, so they read the road type
  // with their index, as their segments do until they get their own.
  const half = (ROAD_TYPES[type]?.width ?? 0) / 2;
  let surface: Float64Array | null = null;
  let surfaceBoxes: Float64Array | null = null;
  if (covers && stations) {
    const last = stations.length / STATION_FLOATS - 1;
    const step = straight ? STRAIGHT_PIECE : 1;
    const pieces = Math.ceil(last / step);
    surface = new Float64Array(pieces * 8);
    surfaceBoxes = new Float64Array(pieces * 4);
    for (let i = 0; i < pieces; i++) {
      const piece = surface.subarray(i * 8, i * 8 + 8);
      surfaceInto(stations, i * step, Math.min(last, (i + 1) * step), half, piece);
      quadBoxInto(piece, surfaceBoxes.subarray(i * 4, i * 4 + 4));
    }
  }
  return {
    a,
    b,
    ax,
    az,
    bx,
    bz,
    cx,
    cz,
    type,
    network,
    levelA,
    levelB,
    order: net.segOrder[id] ?? 0,
    length,
    half,
    straight,
    places,
    stations,
    surface,
    surfaceBoxes,
    status: places > 0 ? new Uint8Array(places * cellsPerPlace()).fill(UNSET) : null,
  };
}

/** Whether segment `id` of `net` is exactly what `s` recorded. */
function sameAsNet(s: SegShape | null, net: RoadNetwork, id: number): boolean {
  if (!isSegment(net, id)) return s === null;
  if (s === null) return false;
  const a = net.segA[id] ?? 0;
  const b = net.segB[id] ?? 0;
  return (
    s.a === a &&
    s.b === b &&
    isNode(net, a) &&
    s.ax === net.nodeX[a] &&
    s.az === net.nodeZ[a] &&
    s.bx === net.nodeX[b] &&
    s.bz === net.nodeZ[b] &&
    s.cx === net.segCX[id] &&
    s.cz === net.segCZ[id] &&
    s.type === net.segType[id] &&
    s.network === net.segNetwork[id] &&
    s.levelA === net.segLevelA[id] &&
    s.levelB === net.segLevelB[id] &&
    s.order === net.segOrder[id] &&
    s.length === net.segLength[id]
  );
}

/** Writes cell `local` of segment shape `s` into `out`. On the hot path, so the name is unpacked inline. */
function cellQuad(s: SegShape, local: number, out: Float64Array): void {
  const depth = local % DEPTH;
  const rest = (local - depth) / DEPTH;
  cellCornersInto(s.stations as Float64Array, rest >> 1, rest & 1, s.half + depth * CELL, s.half + (depth + 1) * CELL, out);
}

/** Whether a cell of order `p` and key `pk` claims ground before one of order `q` and key `qk`. */
function before(p: number, pk: number, q: number, qk: number): boolean {
  return p < q || (p === q && pk < qk);
}

/** Whether cell `key` claims ground before cell `other`. */
function claimsFirst(index: CellIndex, key: number, other: number): boolean {
  return before(index.segs[segOfKey(key)]?.order ?? 0, key, index.segs[segOfKey(other)]?.order ?? 0, other);
}

// ---- Buckets ----

function bucketOf(index: CellIndex, v: number): number {
  const c = Math.floor(v / BUCKET);
  return c < 0 ? 0 : c >= index.perSide ? index.perSide - 1 : c;
}

/** Calls `visit` with every bucket the box in `box` touches. */
function forBuckets(index: CellIndex, box: Float64Array, visit: (bucket: number) => void): void {
  const i0 = bucketOf(index, box[0] ?? 0);
  const i1 = bucketOf(index, box[2] ?? 0);
  const j0 = bucketOf(index, box[1] ?? 0);
  const j1 = bucketOf(index, box[3] ?? 0);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visit(j * index.perSide + i);
}

function boxesTouch(p: Float64Array, q: Float64Array): boolean {
  return (p[0] ?? 0) <= (q[2] ?? 0) && (q[0] ?? 0) <= (p[2] ?? 0) && (p[1] ?? 0) <= (q[3] ?? 0) && (q[1] ?? 0) <= (p[3] ?? 0);
}

function bucketPush(lists: (number[] | undefined)[], bucket: number, value: number): void {
  const list = lists[bucket];
  if (list) list.push(value);
  else lists[bucket] = [value];
}

function bucketDrop(lists: (number[] | undefined)[], bucket: number, value: number): void {
  const list = lists[bucket];
  const at = list ? list.indexOf(value) : -1;
  if (!list || at < 0) throw new Error(`${value} is missing from a cell bucket`);
  list[at] = list[list.length - 1] as number;
  list.pop();
}

/** Files or unfiles cell `local` of `s` in `lists`. */
function fileCell(index: CellIndex, lists: (number[] | undefined)[], seg: number, s: SegShape, local: number, add: boolean): void {
  cellQuad(s, local, quadA);
  quadBoxInto(quadA, boxA);
  const key = keyOf(seg, local);
  forBuckets(index, boxA, (bucket) => (add ? bucketPush : bucketDrop)(lists, bucket, key));
}

/** Files or unfiles every cell of `s`, and its open cells in the open buckets. */
function fileCells(index: CellIndex, seg: number, s: SegShape, add: boolean): void {
  const status = s.status;
  if (!status) return;
  for (let local = 0; local < status.length; local++) {
    fileCell(index, index.cellBuckets, seg, s, local, add);
    if (status[local] === CELL_OPEN) fileCell(index, index.openBuckets, seg, s, local, add);
  }
}

function fileSurface(index: CellIndex, seg: number, s: SegShape, add: boolean): void {
  const boxes = s.surfaceBoxes;
  if (!boxes) return;
  for (let i = 0; i < boxes.length; i += 4) {
    const key = keyOf(seg, i / 4);
    forBuckets(index, boxes.subarray(i, i + 4), (bucket) => (add ? bucketPush : bucketDrop)(index.surfaceBuckets, bucket, key));
  }
}

// ---- Walking one cell ----

/** Whether any surface but segment `seg`'s own covers quad `q`, whose box is `box`. */
function covered(index: CellIndex, seg: number, q: Float64Array, box: Float64Array): boolean {
  const minX = box[0] ?? 0;
  const minZ = box[1] ?? 0;
  const maxX = box[2] ?? 0;
  const maxZ = box[3] ?? 0;
  const i0 = bucketOf(index, minX);
  const i1 = bucketOf(index, maxX);
  const j0 = bucketOf(index, minZ);
  const j1 = bucketOf(index, maxZ);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const list = index.surfaceBuckets[j * index.perSide + i];
      if (!list) continue;
      for (const piece of list) {
        const other = Math.floor(piece / KEY_STRIDE);
        if (other === seg) continue;
        const s = index.segs[other];
        const boxes = s?.surfaceBoxes;
        if (!s || !boxes) continue;
        const k = (piece - other * KEY_STRIDE) * 4;
        if ((boxes[k] ?? 0) > maxX || (boxes[k + 2] ?? 0) < minX || (boxes[k + 1] ?? 0) > maxZ || (boxes[k + 3] ?? 0) < minZ) continue;
        if (quadsOverlap(q, (s.surface as Float64Array).subarray(k * 2, k * 2 + 8))) return true;
      }
    }
  }
  return false;
}

/** The CELL_ value of cell `local` of segment `seg`, given the cells that claim before it. */
function walkCell(index: CellIndex, seg: number, s: SegShape, local: number): number {
  const q = quadW;
  const box = boxW;
  cellQuad(s, local, q);
  quadBoxInto(q, box);
  const minX = box[0] ?? 0;
  const minZ = box[1] ?? 0;
  const maxX = box[2] ?? 0;
  const maxZ = box[3] ?? 0;
  const t = index.terrain;
  const size = mapSize(t);
  if (minX < 0 || minZ < 0 || maxX > size || maxZ > size) return CELL_OFF_MAP;
  const { x, z } = quadCentre(q);
  if (isWaterAt(t, x, z)) return CELL_WATER;
  for (let i = 0; i < 8; i += 2) if (isWaterAt(t, q[i] ?? 0, q[i + 1] ?? 0)) return CELL_WATER;
  if (slopeAt(t, x, z) > ZONING_BALANCE.maxSlope) return CELL_STEEP;
  if (!isConvexQuad(q)) return CELL_BEND;
  if (covered(index, seg, q, box)) return CELL_ROAD;
  // Lost to an open cell that claims first and overlaps it.
  const key = keyOf(seg, local);
  const order = s.order;
  const i0 = bucketOf(index, minX);
  const i1 = bucketOf(index, maxX);
  const j0 = bucketOf(index, minZ);
  const j1 = bucketOf(index, maxZ);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const list = index.openBuckets[j * index.perSide + i];
      if (!list) continue;
      for (const other of list) {
        if (other === key) continue;
        const otherSeg = Math.floor(other / KEY_STRIDE);
        const o = index.segs[otherSeg];
        if (!o || !before(o.order, other, order, key)) continue;
        cellQuad(o, other - otherSeg * KEY_STRIDE, quadB);
        quadBoxInto(quadB, boxB);
        if ((boxB[0] ?? 0) > maxX || (boxB[2] ?? 0) < minX || (boxB[1] ?? 0) > maxZ || (boxB[3] ?? 0) < minZ) continue;
        if (quadsOverlap(q, quadB)) return otherSeg === seg ? CELL_BEND : CELL_TAKEN;
      }
    }
  }
  return CELL_OPEN;
}

/** Sets a cell's status, keeping the open buckets in step. */
function setStatus(index: CellIndex, seg: number, s: SegShape, local: number, now: number): void {
  const status = s.status as Uint8Array;
  const was = status[local];
  status[local] = now;
  if ((was === CELL_OPEN) !== (now === CELL_OPEN)) fileCell(index, index.openBuckets, seg, s, local, now === CELL_OPEN);
}

/** Cell statuses as bits, for picking which cells to look at again. */
const BIT_OPEN = 1 << CELL_OPEN;
/** Cells whose status depends on what covers them or claims first: not off the map, wet or steep. */
const DEPENDS_ON_ROADS = BIT_OPEN | (1 << CELL_ROAD) | (1 << CELL_BEND) | (1 << CELL_TAKEN) | (1 << 7);
/** Cells that lost ground to another cell, or may have. */
const LOST_GROUND = (1 << CELL_BEND) | (1 << CELL_TAKEN);

/**
 * Calls `visit` with the key of every cell in the buckets whose status is
 * one of the bits in `statuses` and that overlaps quad `q` by more than the
 * tolerance, whose box is `box`. A cell in several buckets is visited once
 * per bucket. The status is read first, so most cells cost no geometry.
 */
function forOverlappingCells(index: CellIndex, q: Float64Array, box: Float64Array, statuses: number, visit: (key: number) => void): void {
  forBuckets(index, box, (bucket) => {
    for (const key of index.cellBuckets[bucket] ?? []) {
      const seg = segOfKey(key);
      const s = index.segs[seg];
      const local = key - seg * KEY_STRIDE;
      const status = s?.status?.[local] ?? UNSET;
      // UNSET counts as bit 7, which DEPENDS_ON_ROADS includes.
      if (!s || ((1 << (status === UNSET ? 7 : status)) & statuses) === 0) continue;
      cellQuad(s, local, quadB);
      quadBoxInto(quadB, boxB);
      if (boxesTouch(box, boxB) && quadsOverlap(q, quadB)) visit(key);
    }
  });
}

// ---- Building and keeping current ----

/** Every cell of `net` walked from scratch. */
export function buildCellIndex(net: RoadNetwork, terrain: Terrain): CellIndex {
  const perSide = Math.ceil(mapSize(terrain) / BUCKET);
  const index: CellIndex = {
    net,
    terrain,
    perSide,
    cellBuckets: new Array<number[] | undefined>(perSide * perSide),
    openBuckets: new Array<number[] | undefined>(perSide * perSide),
    surfaceBuckets: new Array<number[] | undefined>(perSide * perSide),
    segs: [],
    touched: new Set<number>(),
  };
  const limit = segmentIdLimit(net);
  const order: number[] = [];
  for (let id = 0; id < limit; id++) {
    const s = shapeOf(net, id);
    index.segs.push(s);
    if (!s) continue;
    fileSurface(index, id, s, true);
    if (s.status) {
      fileCells(index, id, s, true);
      order.push(id);
    }
  }
  order.sort((p, q) => (index.segs[p]?.order ?? 0) - (index.segs[q]?.order ?? 0) || p - q);
  for (const id of order) {
    const s = index.segs[id] as SegShape;
    const status = s.status as Uint8Array;
    for (let local = 0; local < status.length; local++) setStatus(index, id, s, local, walkCell(index, id, s, local));
  }
  return index;
}

/** A queue of cell keys, the one that claims first at the front. */
class ClaimQueue {
  private readonly heap: number[] = [];
  private readonly seen = new Set<number>();
  constructor(private readonly index: CellIndex) {}

  /** Queues `key` unless it has been queued before. */
  push(key: number): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const heap = this.heap;
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!claimsFirst(this.index, key, heap[parent] as number)) break;
      heap[i] = heap[parent] as number;
      i = parent;
    }
    heap[i] = key;
  }

  pop(): number | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length === 0 || last === undefined) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= heap.length) break;
      const r = l + 1;
      const child = r < heap.length && claimsFirst(this.index, heap[r] as number, heap[l] as number) ? r : l;
      if (!claimsFirst(this.index, heap[child] as number, last)) break;
      heap[i] = heap[child] as number;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}

/** A segment the roads changed, as it was before. */
interface Before {
  id: number;
  shape: SegShape | null;
  /** Where its cells were in the zone and density arrays. */
  start: number;
}

/**
 * Brings `index` up to date with its network and returns the new cell state
 * for `cells`, the old one. Returns `cells` itself when no segment changed.
 */
function update(index: CellIndex, cells: CellState): CellState {
  const net = index.net;
  const limit = segmentIdLimit(net);
  const oldLimit = index.segs.length;
  const changed: Before[] = [];
  const look = [...index.touched];
  index.touched.clear();
  for (let id = Math.min(limit, oldLimit); id < Math.max(limit, oldLimit); id++) look.push(id);
  look.sort((p, r) => p - r);
  for (let i = 0; i < look.length; i++) {
    const id = look[i] as number;
    if (i > 0 && look[i - 1] === id) continue;
    const s = index.segs[id] ?? null;
    if (!sameAsNet(s, net, id)) changed.push({ id, shape: s, start: id < oldLimit ? (cells.offset[id] ?? 0) : 0 });
  }
  if (changed.length === 0 && limit === oldLimit) return cells;

  const queue = new ClaimQueue(index);
  const changedIds = new Set(changed.map((c) => c.id));
  const box = new Float64Array(4);
  // Seeds every unchanged cell of those statuses that overlaps `q`; the changed ones are all walked anyway.
  const seedOverlapping = (q: Float64Array, statuses: number) => {
    quadBoxInto(q, box);
    forOverlappingCells(index, q, box, statuses, (key) => {
      if (!changedIds.has(segOfKey(key))) queue.push(key);
    });
  };
  const q = new Float64Array(8);
  const seedUnderSurface = (s: SegShape) => {
    const surface = s.surface;
    if (!surface) return;
    for (let i = 0; i < surface.length; i += 8) seedOverlapping(surface.subarray(i, i + 8), DEPENDS_ON_ROADS);
  };

  // The old shapes leave. Cells they held, and cells under their surfaces,
  // may now have ground.
  for (const { id, shape } of changed) {
    if (!shape) continue;
    fileCells(index, id, shape, false);
    fileSurface(index, id, shape, false);
  }
  for (const { shape } of changed) {
    if (!shape) continue;
    seedUnderSurface(shape);
    const status = shape.status;
    if (!status) continue;
    for (let local = 0; local < status.length; local++) {
      if (status[local] !== CELL_OPEN) continue;
      cellQuad(shape, local, q);
      seedOverlapping(q, LOST_GROUND);
    }
  }

  // The new shapes arrive, and are walked whole.
  index.segs.length = limit;
  for (let id = oldLimit; id < limit; id++) index.segs[id] = null;
  for (const { id } of changed) {
    if (id >= limit) continue;
    const s = shapeOf(net, id);
    index.segs[id] = s;
    if (!s) continue;
    fileSurface(index, id, s, true);
    fileCells(index, id, s, true);
  }
  for (const { id } of changed) {
    const s = index.segs[id];
    if (!s) continue;
    seedUnderSurface(s);
    for (let local = 0; local < (s.status?.length ?? 0); local++) queue.push(keyOf(id, local));
  }

  // Walk in claim order. A cell that gains or loses its claim sends every
  // later cell it overlaps round again.
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    const seg = segOfKey(key);
    const s = index.segs[seg];
    if (!s?.status) continue;
    const local = key - seg * KEY_STRIDE;
    const was = s.status[local];
    const now = walkCell(index, seg, s, local);
    setStatus(index, seg, s, local, now);
    if ((was === CELL_OPEN) === (now === CELL_OPEN)) continue;
    cellQuad(s, local, q);
    quadBoxInto(q, box);
    // A cell that now holds ground can only take it from open cells; one
    // that let it go can only give it to cells that lost ground.
    forOverlappingCells(index, q, box, now === CELL_OPEN ? BIT_OPEN : LOST_GROUND, (other) => {
      if (claimsFirst(index, key, other)) queue.push(other);
    });
  }

  return relayout(index, cells, changed);
}

/** Whether the shapes are one road in one place, the same way round or reversed; null if not. */
function sameGround(p: SegShape, q: SegShape): "same" | "reversed" | null {
  if (p.order !== q.order || p.places !== q.places || p.cx !== q.cx || p.cz !== q.cz) return null;
  if (p.ax === q.ax && p.az === q.az && p.bx === q.bx && p.bz === q.bz) return "same";
  if (p.ax === q.bx && p.az === q.bz && p.bx === q.ax && p.bz === q.az) return "reversed";
  return null;
}

/** The zone and density arrays laid out for the roads `index` now has, carrying zones over as the header says. */
function relayout(index: CellIndex, cells: CellState, changed: readonly Before[]): CellState {
  const limit = index.segs.length;
  const offset = new Int32Array(limit + 1);
  let total = 0;
  for (let id = 0; id < limit; id++) {
    offset[id] = total;
    total += index.segs[id]?.status?.length ?? 0;
  }
  offset[limit] = total;
  const zone = new Uint8Array(total);
  const density = new Uint8Array(total);
  const perPlace = cellsPerPlace();
  const byGround: number[] = [];
  // Unchanged segments between two changed ones have their runs side by
  // side in both layouts, so each stretch is one copy.
  let stretch = 0;
  const copyStretch = (end: number) => {
    if (end > stretch) {
      const from = cells.offset[stretch] ?? 0;
      const upTo = cells.offset[end] ?? 0;
      zone.set(cells.zone.subarray(from, upTo), offset[stretch] ?? 0);
      density.set(cells.density.subarray(from, upTo), offset[stretch] ?? 0);
    }
  };
  for (const { id } of changed) {
    if (id >= limit) break;
    copyStretch(id);
    stretch = id + 1;
  }
  copyStretch(Math.min(limit, cells.offset.length - 1));
  for (const old of changed) {
    const id = old.id;
    const s = index.segs[id];
    const count = s?.status?.length ?? 0;
    if (!s || count === 0) continue;
    const to = offset[id] ?? 0;
    const match = old.shape ? sameGround(old.shape, s) : null;
    if (match === "same") {
      zone.set(cells.zone.subarray(old.start, old.start + count), to);
      density.set(cells.density.subarray(old.start, old.start + count), to);
    } else if (match === "reversed") {
      for (let local = 0; local < count; local++) {
        const { side, place, depth } = fromLocal(local);
        const from = old.start + (s.places - 1 - place) * perPlace + (1 - side) * DEPTH + depth;
        zone[to + local] = cells.zone[from] ?? 0;
        density[to + local] = cells.density[from] ?? 0;
      }
    } else {
      byGround.push(id);
    }
  }
  if (byGround.length > 0) carryByGround(index, cells, changed, byGround, offset, zone, density);
  return { offset, zone, density };
}

/**
 * Gives each cell of the segments in `targets` the zone of the zoned cell of
 * a removed segment of the same build order whose ground holds its centre.
 * Of two such cells, the one that claims first.
 */
function carryByGround(
  index: CellIndex,
  cells: CellState,
  changed: readonly Before[],
  targets: readonly number[],
  offset: Int32Array,
  zone: Uint8Array,
  density: Uint8Array,
): void {
  // The zoned cells of removed shapes, filed by bucket, in claim order.
  const sources = changed
    .filter((c) => c.shape?.status)
    .sort((p, q) => (p.shape?.order ?? 0) - (q.shape?.order ?? 0) || p.id - q.id);
  const filed = new Map<number, { order: number; quad: Float64Array; at: number }[]>();
  for (const { shape, start } of sources) {
    const s = shape as SegShape;
    const count = s.status?.length ?? 0;
    for (let local = 0; local < count; local++) {
      if ((cells.zone[start + local] ?? 0) === 0) continue;
      const quad = new Float64Array(8);
      cellQuad(s, local, quad);
      quadBoxInto(quad, boxA);
      const entry = { order: s.order, quad, at: start + local };
      forBuckets(index, boxA, (bucket) => {
        const list = filed.get(bucket);
        if (list) list.push(entry);
        else filed.set(bucket, [entry]);
      });
    }
  }
  if (filed.size === 0) return;
  const q = new Float64Array(8);
  for (const id of targets) {
    const s = index.segs[id] as SegShape;
    const count = s.status?.length ?? 0;
    const to = offset[id] ?? 0;
    for (let local = 0; local < count; local++) {
      cellQuad(s, local, q);
      const { x, z } = quadCentre(q);
      const bucket = bucketOf(index, z) * index.perSide + bucketOf(index, x);
      const found = filed.get(bucket)?.find((e) => e.order === s.order && quadContains(e.quad, x, z));
      if (!found) continue;
      zone[to + local] = cells.zone[found.at] ?? 0;
      density[to + local] = cells.density[found.at] ?? 0;
    }
  }
}

// Live indexes by network object, like the spatial index and the blocks. A
// network loaded from a save, cloned or replayed is a new object, so it
// gets a fresh index built from its arrays.
const live = new WeakMap<RoadNetwork, CellIndex>();

/**
 * The cell index of `state`'s roads, built on first use, with the cells in
 * state laid out for the roads as they are now. Every query goes through
 * here, so a query never sees cells older than the roads.
 *
 * The step calls this before and after every command (commands.ts), so
 * state always holds the cells of its roads. A state whose roads were
 * changed without a step, as a test may, and whose index was never built,
 * has its cells laid out afresh here: a segment keeps its zones if it has as
 * many cells as it had, and starts unzoned otherwise.
 */
export function syncCells(state: SimState): CellIndex {
  let index = live.get(state.roads);
  if (!index) {
    const built = buildCellIndex(state.roads, terrainOf(state.seed));
    const touch = (id: number) => built.touched.add(id);
    observeNetwork(state.roads, { nodeAdded: () => undefined, nodeRemoving: () => undefined, segmentAdded: touch, segmentRemoving: touch });
    live.set(state.roads, built);
    index = built;
    state.cells = fitCells(index, state.cells);
    return index;
  }
  state.cells = update(index, state.cells);
  return index;
}

/** `cells` as they are when they fit the roads, or laid out afresh as `syncCells` says. */
function fitCells(index: CellIndex, cells: CellState): CellState {
  const limit = index.segs.length;
  let fits = cells.offset.length === limit + 1 && (cells.offset[0] ?? 0) === 0;
  for (let id = 0; fits && id < limit; id++) {
    fits = (cells.offset[id + 1] ?? 0) - (cells.offset[id] ?? 0) === (index.segs[id]?.status?.length ?? 0);
  }
  if (fits && cells.zone.length === (cells.offset[limit] ?? 0)) return cells;
  const offset = new Int32Array(limit + 1);
  let total = 0;
  for (let id = 0; id < limit; id++) {
    offset[id] = total;
    total += index.segs[id]?.status?.length ?? 0;
  }
  offset[limit] = total;
  const zone = new Uint8Array(total);
  const density = new Uint8Array(total);
  for (let id = 0; id < limit && id + 1 < cells.offset.length; id++) {
    const from = cells.offset[id] ?? 0;
    const count = (cells.offset[id + 1] ?? 0) - from;
    if (count !== (offset[id + 1] ?? 0) - (offset[id] ?? 0) || from < 0 || from + count > cells.zone.length) continue;
    zone.set(cells.zone.subarray(from, from + count), offset[id] ?? 0);
    density.set(cells.density.subarray(from, from + count), offset[id] ?? 0);
  }
  return { offset, zone, density };
}

// ---- Queries ----

/** One cell: its name, where it sits in the zone and density arrays, and whether it can be zoned. */
export interface CellInfo extends CellRef {
  /** Index in `state.cells.zone` and `state.cells.density`. */
  index: number;
  /** CELL_OPEN, or why it is blocked. */
  status: number;
}

function infoOf(index: CellIndex, cells: CellState, key: number): CellInfo {
  const segment = segOfKey(key);
  const local = key - segment * KEY_STRIDE;
  const { side, place, depth } = fromLocal(local);
  return {
    segment,
    side,
    place,
    depth,
    index: (cells.offset[segment] ?? 0) + local,
    status: index.segs[segment]?.status?.[local] ?? UNSET,
  };
}

function checkPoint(x: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError(`point (${x}, ${z}) is not finite`);
}

/**
 * The cell whose ground holds point (x, z), edges included, or null. Where
 * cells overlap, an open cell before a blocked one, then the one that claims
 * first.
 */
export function cellAt(state: SimState, x: number, z: number): CellInfo | null {
  checkPoint(x, z);
  const index = syncCells(state);
  const bucket = bucketOf(index, z) * index.perSide + bucketOf(index, x);
  let best = -1;
  let bestOpen = false;
  const q = new Float64Array(8);
  for (const key of index.cellBuckets[bucket] ?? []) {
    const seg = segOfKey(key);
    const s = index.segs[seg];
    if (!s) continue;
    const local = key - seg * KEY_STRIDE;
    cellQuad(s, local, q);
    if (!quadContains(q, x, z)) continue;
    const open = s.status?.[local] === CELL_OPEN;
    if (best < 0 || (open && !bestOpen) || (open === bestOpen && claimsFirst(index, key, best))) {
      best = key;
      bestOpen = open;
    }
  }
  return best < 0 ? null : infoOf(index, state.cells, best);
}

/** Keys of the cells in the buckets over the box whose centres `keep` takes, by segment and then run order. */
function keysInBox(index: CellIndex, minX: number, minZ: number, maxX: number, maxZ: number, keep: (x: number, z: number) => boolean): number[] {
  const box = Float64Array.of(minX, minZ, maxX, maxZ);
  const found = new Set<number>();
  const q = new Float64Array(8);
  forBuckets(index, box, (bucket) => {
    for (const key of index.cellBuckets[bucket] ?? []) {
      if (found.has(key)) continue;
      const seg = segOfKey(key);
      const s = index.segs[seg];
      if (!s) continue;
      cellQuad(s, key - seg * KEY_STRIDE, q);
      const { x, z } = quadCentre(q);
      if (keep(x, z)) found.add(key);
    }
  });
  return [...found].sort((p, r) => p - r);
}

/**
 * Every cell whose centre lies inside the rectangle, edges included, open or
 * blocked, by segment id and then place, side and depth.
 */
export function cellsInBox(state: SimState, minX: number, minZ: number, maxX: number, maxZ: number): CellInfo[] {
  checkPoint(minX, minZ);
  checkPoint(maxX, maxZ);
  if (minX > maxX || minZ > maxZ) throw new RangeError("the box's minimum is past its maximum");
  const index = syncCells(state);
  const keys = keysInBox(index, minX, minZ, maxX, maxZ, (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ);
  return keys.map((key) => infoOf(index, state.cells, key));
}

/** The chunk a point is in, as `cj * CHUNKS_PER_SIDE + ci`, off-map points in the nearest edge chunk. */
function chunkAt(x: number, z: number): number {
  const clamp = (v: number) => {
    const c = Math.floor(v / CHUNK_SIZE);
    return c < 0 ? 0 : c >= CHUNKS_PER_SIDE ? CHUNKS_PER_SIDE - 1 : c;
  };
  return clamp(z) * CHUNKS_PER_SIDE + clamp(x);
}

/**
 * Every cell whose centre is in 500 m chunk `chunk`, numbered as
 * `chunkOfNode` numbers them, open or blocked, in the order `cellsInBox`
 * gives. A cell off the map belongs to the nearest edge chunk, so each cell
 * is in exactly one chunk.
 */
export function cellsInChunk(state: SimState, chunk: number): CellInfo[] {
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= CHUNKS_PER_SIDE * CHUNKS_PER_SIDE) throw new RangeError(`no chunk ${chunk}`);
  const index = syncCells(state);
  const ci = chunk % CHUNKS_PER_SIDE;
  const cj = (chunk - ci) / CHUNKS_PER_SIDE;
  // An edge chunk reaches out over the edge buckets, which hold everything off the map.
  const far = CHUNKS_PER_SIDE * CHUNK_SIZE * 4;
  const minX = ci === 0 ? -far : ci * CHUNK_SIZE;
  const minZ = cj === 0 ? -far : cj * CHUNK_SIZE;
  const maxX = ci === CHUNKS_PER_SIDE - 1 ? far : (ci + 1) * CHUNK_SIZE;
  const maxZ = cj === CHUNKS_PER_SIDE - 1 ? far : (cj + 1) * CHUNK_SIZE;
  const keys = keysInBox(index, minX, minZ, maxX, maxZ, (x, z) => chunkAt(x, z) === chunk);
  return keys.map((key) => infoOf(index, state.cells, key));
}

/** The corners of the cell `ref` names, as x0, z0, ..., x3, z3, or null if there is no such cell. */
export function cellCorners(state: SimState, ref: CellRef): number[] | null {
  const index = syncCells(state);
  const s = index.segs[ref.segment];
  if (!s?.status || !Number.isInteger(ref.place) || ref.place < 0 || ref.place >= s.places) return null;
  if ((ref.side !== 0 && ref.side !== 1) || !Number.isInteger(ref.depth) || ref.depth < 0 || ref.depth >= DEPTH) return null;
  const q = new Float64Array(8);
  cellQuad(s, (ref.place * 2 + ref.side) * DEPTH + ref.depth, q);
  return Array.from(q);
}

/**
 * Every cell's CELL_ value, in the order of `state.cells.zone`. For tests
 * and tools that compare whole cities.
 */
export function cellStatuses(state: SimState): Uint8Array {
  const index = syncCells(state);
  const out = new Uint8Array(state.cells.zone.length);
  for (let id = 0; id < index.segs.length; id++) {
    const status = index.segs[id]?.status;
    if (status) out.set(status, state.cells.offset[id] ?? 0);
  }
  return out;
}
