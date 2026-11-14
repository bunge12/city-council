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
import {
  LEVEL_BRIDGE,
  LEVEL_GROUND,
  isNode,
  isSegment,
  observeNetwork,
  readAnchor,
  segmentIdLimit,
  type RoadNetwork,
  type SegmentAnchor,
} from "../roads/network";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { isWaterAt, mapSize, slopeAt, type Terrain } from "../terrain/terrain";
import { ZONING_BALANCE } from "./balance";
import { cellsPerPlace, fromLocal, zonableFields, type CellRef, type CellState } from "./cells";
import {
  STATION_FLOATS,
  anchorSpan,
  anchorStations,
  cellCornersInto,
  measureCurve,
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
  /** Its cell anchor, as the network holds it. */
  anchor: SegmentAnchor;
  /** The anchor's road and build order as text: two shapes with the same key measure cells on the same road. */
  anchorKey: string;
  /** The first anchor cell this segment has, counted from the anchor's start. */
  from: number;
  /** Whether node A is at the anchor's far end, so places count down the anchor. */
  reversed: boolean;
  /** Anchor stations `from` to `from + places`, which the cells span. Null when it has no cells. */
  cellStations: Float64Array | null;
  /** Its own stations every cell size from node A, and one at node B, for its surface. Null when it has no surface. */
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

/**
 * Lists by bucket, only for buckets that hold something. A map rather than
 * an array of every bucket, so a city with few roads costs little to index.
 */
type Buckets = Map<number, number[]>;

/** The cells of one network. Derived data: not state. */
export interface CellIndex {
  readonly net: RoadNetwork;
  readonly terrain: Terrain;
  /** Buckets along each side. Bucket (i, j) is at `j * perSide + i`. */
  readonly perSide: number;
  /** Keys of the cells whose box touches each bucket, in no particular order. */
  readonly cellBuckets: Buckets;
  /** The same for open cells only, the ones that hold ground. */
  readonly openBuckets: Buckets;
  /** Keys of the surface pieces whose box touches each bucket, in no particular order. */
  readonly surfaceBuckets: Buckets;
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
  const anchor = readAnchor(net, id);
  let places = 0;
  let from = 0;
  let reversed = false;
  let cellStations: Float64Array | null = null;
  if (zonableFields(network, type, levelA, levelB)) {
    const road = measureCurve(anchor.ax, anchor.az, anchor.cx, anchor.cz, anchor.bx, anchor.bz);
    const span = anchorSpan(road, anchor.tA, anchor.tB, CELL);
    places = span.to - span.from;
    from = span.from;
    reversed = span.reversed;
    if (places > 0) cellStations = anchorStations(road, span.from, span.to, CELL);
  }
  const onSurface = (level: number) => level === LEVEL_GROUND || level === LEVEL_BRIDGE;
  const covers = onSurface(levelA) || onSurface(levelB);
  const stations = covers ? stationsOf(measureCurve(ax, az, cx, cz, bx, bz), CELL) : null;
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
    anchor,
    anchorKey: [net.segOrder[id] ?? 0, anchor.ax, anchor.az, anchor.cx, anchor.cz, anchor.bx, anchor.bz].join(","),
    from,
    reversed,
    cellStations,
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
    s.length === net.segLength[id] &&
    s.anchor.ax === net.segAnchorAX[id] &&
    s.anchor.az === net.segAnchorAZ[id] &&
    s.anchor.cx === net.segAnchorCX[id] &&
    s.anchor.cz === net.segAnchorCZ[id] &&
    s.anchor.bx === net.segAnchorBX[id] &&
    s.anchor.bz === net.segAnchorBZ[id] &&
    s.anchor.tA === net.segAnchorTA[id] &&
    s.anchor.tB === net.segAnchorTB[id]
  );
}

/**
 * Writes cell `local` of segment shape `s` into `out`. The corners are the
 * anchor cell's, so they are the same bits as the cell of any other piece
 * of the anchor on that ground. On the hot path, so the name is unpacked
 * inline.
 */
function cellQuad(s: SegShape, local: number, out: Float64Array): void {
  const depth = local % DEPTH;
  const rest = (local - depth) / DEPTH;
  const place = rest >> 1;
  const side = rest & 1;
  const j = s.reversed ? s.places - 1 - place : place;
  cellCornersInto(s.cellStations as Float64Array, j, s.reversed ? 1 - side : side, s.half + depth * CELL, s.half + (depth + 1) * CELL, out);
}

/** The anchor cell, side on the anchor and depth of cell `local` of `s`. */
function anchorCellOf(s: SegShape, local: number): { k: number; side: number; depth: number } {
  const { side, place, depth } = fromLocal(local);
  return s.reversed ? { k: s.from + s.places - 1 - place, side: 1 - side, depth } : { k: s.from + place, side, depth };
}

/** Where anchor cell `k`, on anchor side `side` at `depth`, sits in `s`'s run, or -1 if `s` does not have it. */
function localOfAnchorCell(s: SegShape, k: number, side: number, depth: number): number {
  const j = k - s.from;
  if (j < 0 || j >= s.places) return -1;
  const place = s.reversed ? s.places - 1 - j : j;
  return (place * 2 + (s.reversed ? 1 - side : side)) * DEPTH + depth;
}

/**
 * A cell's place in its anchor's claim order: anchor cell, then side on the
 * anchor, then depth. Unpacked inline, since every claim comparison needs it.
 */
function anchorOrdinal(s: SegShape, local: number): number {
  const depth = local % DEPTH;
  const rest = (local - depth) / DEPTH;
  const place = rest >> 1;
  const side = rest & 1;
  const k = s.reversed ? s.from + s.places - 1 - place : s.from + place;
  return (k * 2 + (s.reversed ? 1 - side : side)) * DEPTH + depth;
}

/**
 * Whether cell `pl` of `p` (key `pk`) claims ground before cell `ql` of `q`
 * (key `qk`). The older road first. Between roads of one age, the pieces of
 * a split and the streets of a grid, the anchor that starts further west,
 * then further north, then by its other end and control point. On one
 * anchor, the cell nearer its start, then its left side, then nearer the
 * road. None of that changes when a road is cut, so the pieces of a split
 * claim in the order their parent did. Last, the lower key, which only two
 * roads laid exactly on top of each other could need.
 */
function claimsBefore(p: SegShape, pl: number, pk: number, q: SegShape, ql: number, qk: number): boolean {
  if (p.order !== q.order) return p.order < q.order;
  if (p.anchorKey !== q.anchorKey) {
    const a = p.anchor;
    const b = q.anchor;
    if (a.ax !== b.ax) return a.ax < b.ax;
    if (a.az !== b.az) return a.az < b.az;
    if (a.bx !== b.bx) return a.bx < b.bx;
    if (a.bz !== b.bz) return a.bz < b.bz;
    if (a.cx !== b.cx) return a.cx < b.cx;
    if (a.cz !== b.cz) return a.cz < b.cz;
  }
  const po = anchorOrdinal(p, pl);
  const qo = anchorOrdinal(q, ql);
  if (po !== qo) return po < qo;
  return pk < qk;
}

/** Whether cell `key` claims ground before cell `other`. */
function claimsFirst(index: CellIndex, key: number, other: number): boolean {
  const ps = segOfKey(key);
  const qs = segOfKey(other);
  const p = index.segs[ps];
  const q = index.segs[qs];
  if (!p || !q) return key < other;
  return claimsBefore(p, key - ps * KEY_STRIDE, key, q, other - qs * KEY_STRIDE, other);
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

function bucketPush(lists: Buckets, bucket: number, value: number): void {
  const list = lists.get(bucket);
  if (list) list.push(value);
  else lists.set(bucket, [value]);
}

function bucketDrop(lists: Buckets, bucket: number, value: number): void {
  const list = lists.get(bucket);
  const at = list ? list.indexOf(value) : -1;
  if (!list || at < 0) throw new Error(`${value} is missing from a cell bucket`);
  list[at] = list[list.length - 1] as number;
  list.pop();
}

/** Files or unfiles cell `local` of `s` in `lists`. */
function fileCell(index: CellIndex, lists: Buckets, seg: number, s: SegShape, local: number, add: boolean): void {
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
      const list = index.surfaceBuckets.get(j * index.perSide + i);
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
  const i0 = bucketOf(index, minX);
  const i1 = bucketOf(index, maxX);
  const j0 = bucketOf(index, minZ);
  const j1 = bucketOf(index, maxZ);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const list = index.openBuckets.get(j * index.perSide + i);
      if (!list) continue;
      for (const other of list) {
        if (other === key) continue;
        const otherSeg = Math.floor(other / KEY_STRIDE);
        const o = index.segs[otherSeg];
        if (!o || !claimsBefore(o, other - otherSeg * KEY_STRIDE, other, s, local, key)) continue;
        cellQuad(o, other - otherSeg * KEY_STRIDE, quadB);
        quadBoxInto(quadB, boxB);
        if ((boxB[0] ?? 0) > maxX || (boxB[2] ?? 0) < minX || (boxB[1] ?? 0) > maxZ || (boxB[3] ?? 0) < minZ) continue;
        // A cell of its own road, or of another piece of the road it was cut from, closes up on a bend.
        if (quadsOverlap(q, quadB)) return o.anchorKey === s.anchorKey ? CELL_BEND : CELL_TAKEN;
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
/** Cells a new surface can block: ones it does not already find blocked by ground or a road. UNSET counts as bit 7. */
const NOT_UNDER_ROAD = BIT_OPEN | (1 << CELL_BEND) | (1 << CELL_TAKEN) | (1 << 7);
/** Cells a removed surface can free: ones blocked by a road. */
const UNDER_ROAD = 1 << CELL_ROAD;
/** Cells that lost ground to another cell, or may have. */
const LOST_GROUND = (1 << CELL_BEND) | (1 << CELL_TAKEN);

/**
 * Calls `visit` with the key of every cell in the buckets whose status is
 * one of the bits in `statuses` and that overlaps quad `q` by more than the
 * tolerance, whose box is `box`, leaving out the cells `skip` picks. A
 * cell in several buckets is visited once per bucket. The status is read
 * first, so most cells cost no geometry.
 */
function forOverlappingCells(
  index: CellIndex,
  q: Float64Array,
  box: Float64Array,
  statuses: number,
  visit: (key: number) => void,
  skip?: (key: number, seg: number) => boolean,
): void {
  forBuckets(index, box, (bucket) => {
    for (const key of index.cellBuckets.get(bucket) ?? []) {
      const seg = segOfKey(key);
      if (skip?.(key, seg)) continue;
      const s = index.segs[seg];
      const local = key - seg * KEY_STRIDE;
      const status = s?.status?.[local] ?? UNSET;
      // UNSET counts as bit 7.
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
    cellBuckets: new Map(),
    openBuckets: new Map(),
    surfaceBuckets: new Map(),
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
  // In claim order: a segment's cells go in their anchor's order, and the
  // pieces of one anchor never share an anchor cell, so sorting segments by
  // their first cell sorts every cell.
  order.sort((p, q) => {
    const a = index.segs[p] as SegShape;
    const b = index.segs[q] as SegShape;
    const first = (s: SegShape) => (s.reversed ? (s.places - 1) * 2 * DEPTH : 0);
    return claimsBefore(a, first(a), keyOf(p, first(a)), b, first(b), keyOf(q, first(b))) ? -1 : 1;
  });
  for (const id of order) {
    const s = index.segs[id] as SegShape;
    for (let j = 0; j < s.places; j++) {
      for (let side = 0; side < 2; side++) {
        for (let depth = 0; depth < DEPTH; depth++) {
          const local = localOfAnchorCell(s, s.from + j, side, depth);
          setStatus(index, id, s, local, walkCell(index, id, s, local));
        }
      }
    }
  }
  return index;
}

/** A queue of cell keys, the one that claims first at the front. */
class ClaimQueue {
  private readonly heap: number[] = [];
  /** A mark per cell of each segment that has had one queued. Faster than a set of keys this large. */
  private readonly seen = new Map<number, Uint8Array>();
  constructor(private readonly index: CellIndex) {}

  /** Whether `key` has been queued, and maybe walked already. */
  has(key: number): boolean {
    const seg = Math.floor(key / KEY_STRIDE);
    return this.seen.get(seg)?.[key - seg * KEY_STRIDE] === 1;
  }

  /** Queues `key` unless it has been queued before. */
  push(key: number): void {
    const seg = Math.floor(key / KEY_STRIDE);
    let marks = this.seen.get(seg);
    if (!marks) {
      marks = new Uint8Array(this.index.segs[seg]?.status?.length ?? 0);
      this.seen.set(seg, marks);
    }
    const local = key - seg * KEY_STRIDE;
    if (marks[local] === 1) return;
    marks[local] = 1;
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
 *
 * A new segment's cell that lies on the same anchor cell as a removed
 * segment's, with the same road width, has the same corners to the bit, so
 * it starts from the removed cell's status instead of being walked: that is
 * what keeps a road cut by a long grid cheap. Claim order goes by anchor
 * cell, not by segment id (`claimsBefore`), so such a cell claims in the
 * same place in the order as the cell it replaces.
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
  const box = new Float64Array(4);
  const q = new Float64Array(8);
  const seedOverlapping = (quad: Float64Array, statuses: number) => {
    quadBoxInto(quad, box);
    forOverlappingCells(index, quad, box, statuses, (key) => queue.push(key), (key) => queue.has(key));
  };
  // A surface that comes can only block a cell, and one that goes can only free one.
  const seedUnderSurface = (s: SegShape, statuses: number) => {
    const surface = s.surface;
    if (!surface) return;
    for (let i = 0; i < surface.length; i += 8) seedOverlapping(surface.subarray(i, i + 8), statuses);
  };

  // Removed shapes with cells, by the anchor they measure them on.
  const byAnchor = new Map<string, Before[]>();
  for (const c of changed) {
    if (!c.shape?.status) continue;
    const list = byAnchor.get(c.shape.anchorKey);
    if (list) list.push(c);
    else byAnchor.set(c.shape.anchorKey, [c]);
  }

  // The old shapes leave.
  for (const { id, shape } of changed) {
    if (!shape) continue;
    fileCells(index, id, shape, false);
    fileSurface(index, id, shape, false);
  }

  // The new shapes arrive, each cell starting from the removed cell on its
  // ground where there is one.
  index.segs.length = limit;
  for (let id = oldLimit; id < limit; id++) index.segs[id] = null;
  /** For each removed shape, the cells a new cell took over as they were. */
  const kept = new Map<Before, Uint8Array>();
  for (const { id } of changed) {
    if (id >= limit) continue;
    const s = shapeOf(net, id);
    index.segs[id] = s;
    if (!s) continue;
    const status = s.status;
    const sources = status ? byAnchor.get(s.anchorKey) : undefined;
    if (status && sources) {
      for (let local = 0; local < status.length; local++) {
        const { k, side, depth } = anchorCellOf(s, local);
        for (const b of sources) {
          const o = b.shape as SegShape;
          if (o.half !== s.half) continue;
          const from = localOfAnchorCell(o, k, side, depth);
          if (from < 0) continue;
          status[local] = (o.status as Uint8Array)[from] ?? UNSET;
          let marks = kept.get(b);
          if (!marks) {
            marks = new Uint8Array((o.status as Uint8Array).length);
            kept.set(b, marks);
          }
          marks[from] = 1;
          break;
        }
      }
    }
    fileSurface(index, id, s, true);
    fileCells(index, id, s, true);
  }

  // Cells with nothing to start from are walked.
  for (const { id } of changed) {
    const status = index.segs[id]?.status;
    if (!status) continue;
    for (let local = 0; local < status.length; local++) if (status[local] === UNSET) queue.push(keyOf(id, local));
  }
  // Cells under a surface that went may be free now, and are walked.
  for (const { shape } of changed) if (shape) seedUnderSurface(shape, UNDER_ROAD);
  // Cells under a surface that came are blocked by it, whatever claims
  // first, unless they were already blocked by their own shape: no walk
  // needed. One that held ground lets it go to the cells after it.
  const quadC = new Float64Array(8);
  for (const { id } of changed) {
    const surface = index.segs[id]?.surface;
    if (!surface) continue;
    for (let i = 0; i < surface.length; i += 8) {
      const piece = surface.subarray(i, i + 8);
      quadBoxInto(piece, box);
      const pieceBox = Float64Array.from(box);
      forOverlappingCells(
        index,
        piece,
        pieceBox,
        NOT_UNDER_ROAD,
        (key) => {
          const seg = segOfKey(key);
          const c = index.segs[seg] as SegShape;
          const local = key - seg * KEY_STRIDE;
          cellQuad(c, local, quadC);
          if (!isConvexQuad(quadC)) return;
          const was = c.status?.[local];
          setStatus(index, seg, c, local, CELL_ROAD);
          if (was !== CELL_OPEN) return;
          quadBoxInto(quadC, box);
          forOverlappingCells(
            index,
            quadC,
            box,
            LOST_GROUND,
            (other) => {
              if (claimsFirst(index, key, other)) queue.push(other);
            },
            (other) => queue.has(other),
          );
        },
        // Its own cells only touch a road's surface, and fresh cells are walked anyway.
        (key, seg) => seg === id || queue.has(key),
      );
    }
  }
  // Cells that lost ground to a cell that went and that no cell took over.
  for (const c of changed) {
    const status = c.shape?.status;
    if (!status) continue;
    const marks = kept.get(c);
    for (let local = 0; local < status.length; local++) {
      if (status[local] !== CELL_OPEN || marks?.[local] === 1) continue;
      cellQuad(c.shape as SegShape, local, q);
      seedOverlapping(q, LOST_GROUND);
    }
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
    forOverlappingCells(
      index,
      q,
      box,
      now === CELL_OPEN ? BIT_OPEN : LOST_GROUND,
      (other) => {
        if (claimsFirst(index, key, other)) queue.push(other);
      },
      (other) => queue.has(other),
    );
  }

  return relayout(index, cells, changed, byAnchor);
}

/**
 * The zone and density arrays laid out for the roads `index` now has. An
 * unchanged segment keeps its run. A changed one takes, cell by cell, the
 * zone of the removed cell on the same anchor cell, whatever the road's
 * width: so a split, an upgrade, a reverse and an undo that joins pieces
 * again all keep each zone on its ground.
 */
function relayout(index: CellIndex, cells: CellState, changed: readonly Before[], byAnchor: ReadonlyMap<string, Before[]>): CellState {
  const limit = index.segs.length;
  const offset = new Int32Array(limit + 1);
  // Up to the first changed id the runs start where they did.
  const first = Math.min(changed[0]?.id ?? limit, limit, cells.offset.length - 1);
  offset.set(cells.offset.subarray(0, first + 1));
  // After it, a stretch of unchanged runs moves by however much the
  // changed runs before it grew or shrank.
  let total = offset[first] ?? 0;
  let id = first;
  const oldLimit = cells.offset.length - 1;
  for (let c = 0; c <= changed.length; c++) {
    const next = Math.min(changed[c]?.id ?? limit, limit);
    // Ids past the old limit that are still unchanged were never live, and have no cells.
    const known = Math.min(next, oldLimit);
    if (id < known) {
      const shift = total - (cells.offset[id] ?? 0);
      for (; id < known; id++) offset[id] = (cells.offset[id] ?? 0) + shift;
      total = (cells.offset[known] ?? 0) + shift;
    }
    for (; id < next; id++) offset[id] = total;
    if (next >= limit) break;
    offset[next] = total;
    total += index.segs[next]?.status?.length ?? 0;
    id = next + 1;
  }
  offset[limit] = total;
  const zone = new Uint8Array(total);
  const density = new Uint8Array(total);
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
  for (const c of changed) {
    if (c.id >= limit) break;
    copyStretch(c.id);
    stretch = c.id + 1;
  }
  copyStretch(Math.min(limit, oldLimit));
  for (const c of changed) {
    const s = index.segs[c.id];
    const status = s?.status;
    const sources = s ? byAnchor.get(s.anchorKey) : undefined;
    if (!s || !status || !sources) continue;
    const to = offset[c.id] ?? 0;
    for (let local = 0; local < status.length; local++) {
      const { k, side, depth } = anchorCellOf(s, local);
      for (const b of sources) {
        const from = localOfAnchorCell(b.shape as SegShape, k, side, depth);
        if (from < 0) continue;
        zone[to + local] = cells.zone[b.start + from] ?? 0;
        density[to + local] = cells.density[b.start + from] ?? 0;
        break;
      }
    }
  }
  return { offset, zone, density };
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
  for (const key of index.cellBuckets.get(bucket) ?? []) {
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
    for (const key of index.cellBuckets.get(bucket) ?? []) {
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
