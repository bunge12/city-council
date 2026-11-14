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
// Cells claim ground in a fixed order (`claimsBefore`): the older segment
// first, by build order. Between roads of one age, the pieces of a split and
// the streets of a grid, the anchor that starts further west, then further
// north, then by its other end and control point. On one anchor, the cell
// nearer its start, then its left side, then nearer the road, so where the
// cells of one strip close up on the inside of a bend the earlier one stays.
// None of that changes when a road is cut. A cell that is blocked for any
// reason claims nothing, so the next cell in the order can have that ground.
//
// The result is the same as walking every cell in that order once and
// giving each the ground no earlier cell holds. `buildCellIndex` does that.
// After the roads change, `update` finds the segments that changed, from the
// ones the network reported adding or removing, each compared with the copy
// the index took last time. A new cell on the same anchor cell as a removed
// one, with the same road width, has the same corners and the same place in
// the claim order, so it starts from that cell's status. The rest are
// walked again: new cells with nothing to start from, the cells a surface
// that went used to block, the cells a removed cell held ground against,
// and then, in claim order, any cell whose overlapping neighbour gained or
// lost its claim. Cells a new surface covers are blocked without a walk.
// Each cell is looked at only after every cell that claims before it is
// settled, so the answer is the one a full walk gives, whatever order the
// changes came in. A change too big for one tick is walked a slice a step
// (`stepCells`, `settleCells`).
//
// `update` also lays out the zone and density arrays in state for the new
// roads (cells.ts). An unchanged segment keeps its run. A changed one takes,
// cell by cell, the zone of the removed cell on the same anchor cell,
// whatever the road's width: so a split, an upgrade, a reverse and an undo
// that joins pieces again all keep each zone on its ground.
//
// Shapes use only exact arithmetic (shape.ts), so every machine walks the
// same cells to the same answer (CLAUDE.md rule 6).

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "../chunks";
import { ROAD_TYPES } from "../roads/balance";
import {
  LEVEL_BRIDGE,
  LEVEL_GROUND,
  NONE,
  isNode,
  isSegment,
  nextSegmentAt,
  observeNetwork,
  readAnchor,
  segmentIdLimit,
  type RoadNetwork,
} from "../roads/network";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { isWaterAt, mapSize, slopeAt, type Terrain } from "../terrain/terrain";
import { ZONING_BALANCE } from "./balance";
import { CELL_KEY_STRIDE, noteCellsRelaid } from "./cell-changes";
import { cellsPerPlace, fromLocal, zonableFields, type CellRef, type CellState } from "./cells";
import {
  STATION_FLOATS,
  anchorSpan,
  anchorStations,
  ceilOf,
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
/** It folds over itself on the inside of a bend too tight for it. */
export const CELL_BEND = 5;
/** It overlaps an open cell that claims the ground first: an older road's, or an earlier one of its own road on the inside of a bend. */
export const CELL_TAKEN = 6;
/** Not yet walked. Never left behind by a walk. */
const UNSET = 255;

/** Side of a bucket in the grid that finds cells and surfaces near a point, metres. */
const BUCKET = 32;
/**
 * A cell's key is `segment * KEY_STRIDE + its place in the segment's run`,
 * and a surface piece's `segment * KEY_STRIDE + piece`.
 */
const KEY_STRIDE = CELL_KEY_STRIDE;
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
  /** Its cell anchor, as the network holds it, field by field: a big city has tens of thousands of shapes, and every object costs the garbage collector. */
  anchorAX: number;
  anchorAZ: number;
  anchorCX: number;
  anchorCZ: number;
  anchorBX: number;
  anchorBZ: number;
  anchorTA: number;
  anchorTB: number;
  /** The first anchor cell this segment has, counted from the anchor's start. */
  from: number;
  /** Whether node A is at the anchor's far end, so places count down the anchor. */
  reversed: boolean;
  /**
   * The shape's numbers, in one array over one buffer that `status` shares:
   * first the anchor stations `from` to `from + places`, which the cells
   * span; then, from `surfaceAt`, its surface pieces, eight floats each as
   * `surfaceInto` writes them; then, from `boxesAt`, the box around each
   * piece, four floats each. Null when it has neither cells nor a surface.
   */
  data: Float64Array | null;
  /**
   * Surface pieces, when its surface covers cells: ground or bridge at
   * either end. A straight segment's pieces are STRAIGHT_PIECE station gaps
   * long, a curve's one, so each piece's box is small and a long road is
   * not tested whole.
   */
  pieces: number;
  surfaceAt: number;
  boxesAt: number;
  /** Each cell's CELL_ value, in run order. Null when it has no cells. */
  status: Uint8Array | null;
}

/** Surface piece `k` of `s`, as a view on its data. */
function surfacePiece(s: SegShape, k: number): Float64Array {
  const at = s.surfaceAt + k * 8;
  return (s.data as Float64Array).subarray(at, at + 8);
}

/** The anchor's road and build order as text: two shapes with the same key measure cells on the same road. */
function anchorKeyOf(s: SegShape): string {
  return `${s.order},${s.anchorAX},${s.anchorAZ},${s.anchorCX},${s.anchorCZ},${s.anchorBX},${s.anchorBZ}`;
}

/**
 * Lists by bucket, only for buckets that hold something. A map rather than
 * an array of every bucket, so a city with few roads costs little to index.
 */
type Buckets = BucketLists;

/**
 * Lists of numbers by bucket, kept in a few typed arrays as linked lists:
 * `heads[bucket]` is the first entry, `next[entry]` the one after it, -1 at
 * the end, and `keys[entry]` the number. A big city files millions of
 * cells, and kept outside the garbage collector's heap they cost it nothing
 * to scan or move. Order within a list means nothing.
 */
class BucketLists {
  heads: Int32Array;
  keys = new Float64Array(1024);
  next = new Int32Array(1024);
  private free = -1;
  private used = 0;
  constructor(buckets: number) {
    this.heads = new Int32Array(buckets).fill(-1);
  }

  add(bucket: number, value: number): void {
    let e = this.free;
    if (e >= 0) this.free = this.next[e] ?? -1;
    else {
      if (this.used === this.keys.length) {
        const keys = new Float64Array(this.keys.length * 2);
        keys.set(this.keys);
        const next = new Int32Array(this.next.length * 2);
        next.set(this.next);
        this.keys = keys;
        this.next = next;
      }
      e = this.used++;
    }
    this.keys[e] = value;
    this.next[e] = this.heads[bucket] ?? -1;
    this.heads[bucket] = e;
  }

  remove(bucket: number, value: number): void {
    let prev = -1;
    for (let e = this.heads[bucket] ?? -1; e >= 0; prev = e, e = this.next[e] ?? -1) {
      if (this.keys[e] !== value) continue;
      if (prev < 0) this.heads[bucket] = this.next[e] ?? -1;
      else this.next[prev] = this.next[e] ?? -1;
      this.next[e] = this.free;
      this.free = e;
      return;
    }
    throw new Error(`${value} is missing from a cell bucket`);
  }
}

/**
 * The work a change of roads leaves: tasks that find the cells it reaches,
 * run in order, then the cells to walk in claim order.
 */
interface SettleJob {
  queue: ClaimQueue;
  seeds: Seed[];
  nextSeed: number;
}

/**
 * One task of a settling job, with what it counts for against a slice of
 * `settleCellsPerTick`, in cells walked. The weights are in zoning.json,
 * since they decide `cellsReadyAt`, which is state.
 */
interface Seed {
  run: () => void;
  cost: number;
}

/** What filing or unfiling a shape's cells and surface counts for. */
function fileCost(s: SegShape): number {
  return (s.status?.length ?? 0) * ZONING_BALANCE.settleFiledCellCost + s.pieces * ZONING_BALANCE.settleSurfacePieceCost;
}

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
  /** A change of roads still settling; null when settled. */
  pending: SettleJob | null;
  /**
   * The zone and density buffers state held before the last change, kept to
   * write the next layout into. A layout is about 6 MB on a big city, and a
   * new one for every road would keep the garbage collector busy enough to
   * stall the sim for tens of milliseconds at a time.
   */
  spare: { zone: Uint8Array; density: Uint8Array } | null;
  /**
   * True for a client's copy of a city, whose zone and density arrays are
   * laid out by cell deltas (delta.ts) and not here.
   */
  follows: boolean;
  /**
   * The 500 m chunks holding a cell that came, went or changed status since
   * `followCells` last asked. Null until it first asks: the sim keeps none.
   */
  dirty: Set<number> | null;
}

// Scratch space. The sim runs on one thread, and no two users of one of
// these are ever live at once.
const quadA = new Float64Array(8);
const boxA = new Float64Array(4);
const quadB = new Float64Array(8);
const boxB = new Float64Array(4);
const quadW = new Float64Array(8);
const boxW = new Float64Array(4);
const quadD = new Float64Array(8);

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
  // Everything the shape keeps in one buffer, with a view for each part: a
  // big city has tens of thousands of shapes, and the garbage collector
  // pays for every buffer it tracks.
  const last = stations ? stations.length / STATION_FLOATS - 1 : 0;
  const step = straight ? STRAIGHT_PIECE : 1;
  const pieces = covers && stations ? ceilOf(last / step) : 0;
  const cellFloats = cellStations?.length ?? 0;
  const floats = cellFloats + pieces * 12;
  const statusBytes = places > 0 ? places * cellsPerPlace() : 0;
  const buffer = new ArrayBuffer(floats * 8 + statusBytes);
  const data = floats > 0 ? new Float64Array(buffer, 0, floats) : null;
  if (data && cellStations) data.set(cellStations);
  const surfaceAt = cellFloats;
  const boxesAt = cellFloats + pieces * 8;
  if (data && stations) {
    for (let i = 0; i < pieces; i++) {
      const piece = data.subarray(surfaceAt + i * 8, surfaceAt + i * 8 + 8);
      surfaceInto(stations, i * step, Math.min(last, (i + 1) * step), half, piece);
      quadBoxInto(piece, data.subarray(boxesAt + i * 4, boxesAt + i * 4 + 4));
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
    anchorAX: anchor.ax,
    anchorAZ: anchor.az,
    anchorCX: anchor.cx,
    anchorCZ: anchor.cz,
    anchorBX: anchor.bx,
    anchorBZ: anchor.bz,
    anchorTA: anchor.tA,
    anchorTB: anchor.tB,
    from,
    reversed,
    data,
    pieces,
    surfaceAt,
    boxesAt,
    status: statusBytes > 0 ? new Uint8Array(buffer, floats * 8, statusBytes).fill(UNSET) : null,
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
    s.anchorAX === net.segAnchorAX[id] &&
    s.anchorAZ === net.segAnchorAZ[id] &&
    s.anchorCX === net.segAnchorCX[id] &&
    s.anchorCZ === net.segAnchorCZ[id] &&
    s.anchorBX === net.segAnchorBX[id] &&
    s.anchorBZ === net.segAnchorBZ[id] &&
    s.anchorTA === net.segAnchorTA[id] &&
    s.anchorTB === net.segAnchorTB[id]
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
  cellCornersInto(s.data as Float64Array, j, s.reversed ? 1 - side : side, s.half + depth * CELL, s.half + (depth + 1) * CELL, out);
}

/** Where anchor cell `k`, on anchor side `side` at `depth`, sits in `s`'s run, or -1 if `s` does not have it. */
function localOfAnchorCell(s: SegShape, k: number, side: number, depth: number): number {
  const j = k - s.from;
  if (j < 0 || j >= s.places) return -1;
  const place = s.reversed ? s.places - 1 - j : j;
  return (place * 2 + (s.reversed ? 1 - side : side)) * DEPTH + depth;
}

/**
 * Calls `visit` with the first local index in `s` and in `o` of every run
 * of `DEPTH` cells the two shapes share: one run per anchor cell both own
 * and per side of the anchor. Within a run, depth d is `+ d` in both.
 */
function forSharedRuns(s: SegShape, o: SegShape, visit: (sLocal: number, oLocal: number) => void): void {
  const lo = s.from > o.from ? s.from : o.from;
  const sEnd = s.from + s.places;
  const oEnd = o.from + o.places;
  const hi = sEnd < oEnd ? sEnd : oEnd;
  for (let k = lo; k < hi; k++) {
    for (let side = 0; side < 2; side++) visit(localOfAnchorCell(s, k, side, 0), localOfAnchorCell(o, k, side, 0));
  }
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
  if (p.anchorAX !== q.anchorAX) return p.anchorAX < q.anchorAX;
  if (p.anchorAZ !== q.anchorAZ) return p.anchorAZ < q.anchorAZ;
  if (p.anchorBX !== q.anchorBX) return p.anchorBX < q.anchorBX;
  if (p.anchorBZ !== q.anchorBZ) return p.anchorBZ < q.anchorBZ;
  if (p.anchorCX !== q.anchorCX) return p.anchorCX < q.anchorCX;
  if (p.anchorCZ !== q.anchorCZ) return p.anchorCZ < q.anchorCZ;
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
  lists.add(bucket, value);
}

function bucketDrop(lists: Buckets, bucket: number, value: number): void {
  lists.remove(bucket, value);
}

/** Files or unfiles cell `local` of `s` in `lists`. */
function fileCell(index: CellIndex, lists: Buckets, seg: number, s: SegShape, local: number, add: boolean): void {
  cellQuad(s, local, quadA);
  quadBoxInto(quadA, boxA);
  if (index.dirty) {
    const { x, z } = quadCentre(quadA);
    index.dirty.add(chunkAt(x, z));
  }
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
  const data = s.data;
  if (!data) return;
  for (let k = 0; k < s.pieces; k++) {
    const key = keyOf(seg, k);
    const at = s.boxesAt + k * 4;
    forBuckets(index, data.subarray(at, at + 4), (bucket) => (add ? bucketPush : bucketDrop)(index.surfaceBuckets, bucket, key));
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
      const list = index.surfaceBuckets;
      for (let e = list.heads[j * index.perSide + i] ?? -1; e >= 0; e = list.next[e] ?? -1) {
        const piece = list.keys[e] ?? 0;
        const other = Math.floor(piece / KEY_STRIDE);
        if (other === seg) continue;
        const s = index.segs[other];
        const data = s?.data;
        if (!s || !data) continue;
        const k = piece - other * KEY_STRIDE;
        const b = s.boxesAt + k * 4;
        if ((data[b] ?? 0) > maxX || (data[b + 2] ?? 0) < minX || (data[b + 1] ?? 0) > maxZ || (data[b + 3] ?? 0) < minZ) continue;
        if (quadsOverlap(q, surfacePiece(s, k))) return true;
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
      const list = index.openBuckets;
      for (let e = list.heads[j * index.perSide + i] ?? -1; e >= 0; e = list.next[e] ?? -1) {
        const other = list.keys[e] ?? 0;
        if (other === key) continue;
        const otherSeg = Math.floor(other / KEY_STRIDE);
        const o = index.segs[otherSeg];
        if (!o || !claimsBefore(o, other - otherSeg * KEY_STRIDE, other, s, local, key)) continue;
        cellQuad(o, other - otherSeg * KEY_STRIDE, quadB);
        quadBoxInto(quadB, boxB);
        if ((boxB[0] ?? 0) > maxX || (boxB[2] ?? 0) < minX || (boxB[1] ?? 0) > maxZ || (boxB[3] ?? 0) < minZ) continue;
        // One status whoever the winner is: the buckets are in no order, so
        // a label taken from the first overlap found would depend on it.
        if (quadsOverlap(q, quadB)) return CELL_TAKEN;
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
  if (index.dirty && was !== now) {
    cellQuad(s, local, quadD);
    const { x, z } = quadCentre(quadD);
    index.dirty.add(chunkAt(x, z));
  }
  if ((was === CELL_OPEN) !== (now === CELL_OPEN)) fileCell(index, index.openBuckets, seg, s, local, now === CELL_OPEN);
}

/** Cell statuses as bits, for picking which cells to look at again. */
const BIT_OPEN = 1 << CELL_OPEN;
/** Cells a new surface can block: ones it does not already find blocked by ground, a fold or a road. UNSET counts as bit 7. */
const NOT_UNDER_ROAD = BIT_OPEN | (1 << CELL_TAKEN) | (1 << 7);
/** Cells a removed surface can free: ones blocked by a road. */
const UNDER_ROAD = 1 << CELL_ROAD;
/** Cells that lost ground to another cell. A fold depends on its own shape only. */
const LOST_GROUND = 1 << CELL_TAKEN;

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
  const list = index.cellBuckets;
  forBuckets(index, box, (bucket) => {
    for (let e = list.heads[bucket] ?? -1; e >= 0; e = list.next[e] ?? -1) {
      const key = list.keys[e] ?? 0;
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
  const perSide = ceilOf(mapSize(terrain) / BUCKET);
  const index: CellIndex = {
    net,
    terrain,
    perSide,
    cellBuckets: new BucketLists(perSide * perSide),
    openBuckets: new BucketLists(perSide * perSide),
    surfaceBuckets: new BucketLists(perSide * perSide),
    segs: [],
    touched: new Set<number>(),
    pending: null,
    spare: null,
    follows: false,
    dirty: null,
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

/** A cell waiting to be walked, with the segment shape it was queued under. */
interface Waiting {
  key: number;
  shape: SegShape;
}

/**
 * A queue of cells to walk, the one that claims first at the front. Each
 * entry keeps the shape its segment had when it was queued and is ordered
 * by that, so a change of roads that arrives while a walk is under way
 * leaves the queue in order: the entries of a replaced segment are skipped
 * when they come up, and its new cells are queued afresh.
 */
class ClaimQueue {
  private readonly heap: Waiting[] = [];
  /** For each segment with cells waiting, the shape they were queued under and a mark per cell. */
  private readonly waiting = new Map<number, { shape: SegShape; marks: Uint8Array }>();
  constructor(private readonly index: CellIndex) {}

  private marksOf(seg: number, shape: SegShape): Uint8Array {
    const known = this.waiting.get(seg);
    if (known?.shape === shape) return known.marks;
    const marks = new Uint8Array(shape.status?.length ?? 0);
    this.waiting.set(seg, { shape, marks });
    return marks;
  }

  /** Whether cell `key` of shape `shape` is waiting to be walked. Its segment's current shape when left out. */
  has(key: number, shape?: SegShape): boolean {
    const seg = Math.floor(key / KEY_STRIDE);
    const known = this.waiting.get(seg);
    const s = shape ?? this.index.segs[seg];
    return known !== undefined && known.shape === s && known.marks[key - seg * KEY_STRIDE] === 1;
  }

  /** Queues `key` of its segment's current shape unless it is waiting already. */
  push(key: number): void {
    const seg = Math.floor(key / KEY_STRIDE);
    const shape = this.index.segs[seg];
    if (!shape?.status) return;
    const marks = this.marksOf(seg, shape);
    const local = key - seg * KEY_STRIDE;
    if (marks[local] === 1) return;
    marks[local] = 1;
    const item = { key, shape };
    const heap = this.heap;
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!entryFirst(item, heap[parent] as Waiting)) break;
      heap[i] = heap[parent] as Waiting;
      i = parent;
    }
    heap[i] = item;
  }

  /** Whether nothing is left to walk. */
  empty(): boolean {
    return this.heap.length === 0;
  }

  /** The next cell to walk, still a cell of its segment's current shape, or undefined when none is left. */
  pop(): number | undefined {
    for (;;) {
      const item = this.popEntry();
      if (!item) return undefined;
      const seg = Math.floor(item.key / KEY_STRIDE);
      const known = this.waiting.get(seg);
      if (known?.shape === item.shape) known.marks[item.key - seg * KEY_STRIDE] = 0;
      // A segment replaced since: its new cells are queued on their own.
      if (this.index.segs[seg] === item.shape) return item.key;
    }
  }

  private popEntry(): Waiting | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length === 0 || last === undefined) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= heap.length) break;
      const r = l + 1;
      const child = r < heap.length && entryFirst(heap[r] as Waiting, heap[l] as Waiting) ? r : l;
      if (!entryFirst(heap[child] as Waiting, last)) break;
      heap[i] = heap[child] as Waiting;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}

/** Whether queue entry `p` claims before `q`, each by the shape it was queued under. */
function entryFirst(p: Waiting, q: Waiting): boolean {
  const ps = Math.floor(p.key / KEY_STRIDE);
  const qs = Math.floor(q.key / KEY_STRIDE);
  return claimsBefore(p.shape, p.key - ps * KEY_STRIDE, p.key, q.shape, q.key - qs * KEY_STRIDE, q.key);
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
 * for `cells`, the old one, or null when no segment changed.
 *
 * A new segment's cell that lies on the same anchor cell as a removed
 * segment's, with the same road width, has the same corners to the bit, so
 * it starts from the removed cell's status instead of being walked: that is
 * what keeps a road cut by a long grid cheap. Claim order goes by anchor
 * cell, not by segment id (`claimsBefore`), so such a cell claims in the
 * same place in the order as the cell it replaces.
 */
function update(index: CellIndex, cells: CellState): { cells: CellState; work: number; folded: boolean } | null {
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
  if (changed.length === 0 && limit === oldLimit) return null;
  noteCellsRelaid(net, changed);
  // A change still settling is folded into this one rather than finished
  // here, which could take far longer than a tick. Its tasks run now, so
  // the buckets match the shapes, and its cells still to walk join this
  // walk. The walk is right from any statuses, so long as every cell that
  // may be wrong is in the queue or is sent there by a neighbour that
  // changes, and that holds for both changes' cells.
  const earlier = index.pending;
  const queue = earlier ? finishTasks(earlier) : new ClaimQueue(index);
  const box = new Float64Array(4);
  const q = new Float64Array(8);
  const seedOverlapping = (quad: Float64Array, statuses: number) => {
    quadBoxInto(quad, box);
    forOverlappingCells(index, quad, box, statuses, (key) => queue.push(key), (key) => queue.has(key));
  };
  // A surface that comes can only block a cell, and one that goes can only free one.
  const seedUnderSurface = (s: SegShape, statuses: number) => {
    for (let k = 0; k < s.pieces; k++) seedOverlapping(surfacePiece(s, k), statuses);
  };

  // Removed shapes with cells, by the anchor they measure them on.
  const byAnchor = new Map<string, Before[]>();
  for (const c of changed) {
    if (!c.shape?.status) continue;
    const key = anchorKeyOf(c.shape);
    const list = byAnchor.get(key);
    if (list) list.push(c);
    else byAnchor.set(key, [c]);
  }

  // Finding the cells a change reaches is left to the job, a task at a
  // time, in this order, before its walk starts. Nothing reads the buckets
  // until the job is done: a query, a step's slice and the next change all
  // finish it first.
  const seeds: Seed[] = [];
  // The old shapes leave the buckets.
  for (const { id, shape } of changed) {
    if (!shape) continue;
    seeds.push({
      run: () => {
        fileCells(index, id, shape, false);
        fileSurface(index, id, shape, false);
      },
      cost: fileCost(shape),
    });
  }

  // The new shapes arrive, each cell starting from the removed cell on its
  // ground where there is one.
  index.segs.length = limit;
  for (let id = oldLimit; id < limit; id++) index.segs[id] = null;
  /** For each removed shape, the cells a new cell took over as they were. */
  const kept = new Map<Before, Uint8Array>();
  /** New cells on no removed cell's ground: counted from the shapes alone, whatever has been walked. */
  let fresh = 0;
  for (const { id } of changed) {
    if (id >= limit) continue;
    const s = shapeOf(net, id);
    index.segs[id] = s;
    if (!s) continue;
    const status = s.status;
    const sources = status ? byAnchor.get(anchorKeyOf(s)) : undefined;
    if (status && !sources) fresh += status.length;
    if (status && sources) {
      // The first removed shape, in order, that has a cell's anchor cell
      // gives it its status. A run of depths at a time.
      const got = new Uint8Array(status.length);
      for (const b of sources) {
        const o = b.shape as SegShape;
        if (o.half !== s.half) continue;
        const from = o.status as Uint8Array;
        let marks = kept.get(b);
        forSharedRuns(s, o, (sl, ol) => {
          for (let d = 0; d < DEPTH; d++) {
            const local = sl + d;
            if (got[local] === 1) continue;
            got[local] = 1;
            // A cell an earlier change had still to walk has no settled status to give.
            status[local] = queue.has(keyOf(b.id, ol + d), o) ? UNSET : (from[ol + d] ?? UNSET);
            if (!marks) {
              marks = new Uint8Array(from.length);
              kept.set(b, marks);
            }
            marks[ol + d] = 1;
          }
        });
      }
      for (let local = 0; local < status.length; local++) if (got[local] === 0) fresh++;
    }
    seeds.push({
      run: () => {
        fileSurface(index, id, s, true);
        fileCells(index, id, s, true);
      },
      cost: fileCost(s),
    });
  }

  // Cells with nothing to start from are walked. Queued by the job, ahead
  // of the surface tasks that skip queued cells: a big grid has thousands,
  // and they are counted in `fresh` already, so the task costs nothing more.
  for (const { id } of changed) {
    const status = index.segs[id]?.status;
    if (!status) continue;
    seeds.push({
      run: () => {
        for (let local = 0; local < status.length; local++) if (status[local] === UNSET) queue.push(keyOf(id, local));
      },
      cost: 0,
    });
  }
  // Cells under a surface that went may be free now, and are walked.
  for (const { shape } of changed) {
    if (!shape || shape.pieces === 0) continue;
    seeds.push({ run: () => seedUnderSurface(shape, UNDER_ROAD), cost: shape.pieces * ZONING_BALANCE.settleSurfacePieceCost });
  }
  // Cells under a surface that came are blocked by it, whatever claims
  // first, unless they were already blocked by their own shape: no walk
  // needed. One that held ground lets it go to the cells after it.
  const quadC = new Float64Array(8);
  for (const { id } of changed) {
    const shape = index.segs[id];
    if (!shape) continue;
    for (let k = 0; k < shape.pieces; k++) seeds.push({ cost: ZONING_BALANCE.settleSurfacePieceCost, run: () => {
      const piece = surfacePiece(shape, k);
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
    } });
  }
  // Cells that lost ground to a cell that went and that no cell took over.
  for (const c of changed) {
    const status = c.shape?.status;
    if (!status) continue;
    const marks = kept.get(c);
    // Counted already, as the removed cells nothing took over.
    seeds.push({
      cost: 0,
      run: () => {
        for (let local = 0; local < status.length; local++) {
          if (status[local] !== CELL_OPEN || marks?.[local] === 1) continue;
          cellQuad(c.shape as SegShape, local, q);
          seedOverlapping(q, LOST_GROUND);
        }
      },
    });
  }
  index.pending = { queue, seeds, nextSeed: 0 };
  // The tasks count too: what each counts for follows from the shapes as well.
  let work = 0;
  for (const seed of seeds) work += seed.cost;
  // How big the change is, so every machine that applies it agrees how many
  // ticks it may take to settle: the new cells with nothing to start from,
  // and the removed cells no new cell took over. Both follow from the road
  // shapes alone, not from how far an earlier change has settled.
  work += fresh;
  for (const c of changed) {
    const gone = c.shape?.status;
    if (!gone) continue;
    const marks = kept.get(c);
    for (let local = 0; local < gone.length; local++) if (marks?.[local] !== 1) work++;
  }
  // A copy's cells came laid out in the delta that brought the roads.
  return { cells: index.follows ? cells : relayout(index, cells, changed, byAnchor), work, folded: earlier !== null };
}

/**
 * Runs the tasks still to run of a change still settling, so the buckets
 * match the shapes before the next change replaces any, and returns its
 * queue for the next change to add to.
 */
function finishTasks(job: SettleJob): ClaimQueue {
  while (job.nextSeed < job.seeds.length) (job.seeds[job.nextSeed++] as Seed).run();
  return job.queue;
}

/**
 * Walks up to `limit` of the cells a change left to walk, in claim order.
 * A cell that gains or loses its claim sends every later cell it overlaps
 * round again. Returns whether the change has settled.
 */
function drain(index: CellIndex, limit: number): boolean {
  const job = index.pending;
  if (!job) return true;
  const queue = job.queue;
  let walked = 0;
  // Every seeding task runs before the first cell is walked.
  while (job.nextSeed < job.seeds.length) {
    if (walked >= limit) return false;
    const seed = job.seeds[job.nextSeed++] as Seed;
    seed.run();
    walked += seed.cost;
  }
  const q = new Float64Array(8);
  const box = new Float64Array(4);
  while (walked < limit) {
    const key = queue.pop();
    if (key === undefined) break;
    walked++;
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
  if (!queue.empty()) return false;
  index.pending = null;
  return true;
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
  const zone = layoutBuffer(index.spare?.zone, cells.zone, total);
  const density = layoutBuffer(index.spare?.density, cells.density, total);
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
    if (c.id >= limit) continue;
    const s = index.segs[c.id];
    const status = s?.status;
    if (!s || !status) continue;
    // The buffers are not cleared, so a changed run starts unzoned here.
    const to = offset[c.id] ?? 0;
    zone.fill(0, to, to + status.length);
    density.fill(0, to, to + status.length);
    const sources = byAnchor.get(anchorKeyOf(s));
    if (!sources) continue;
    // The first removed shape, in order, that has a cell's anchor cell gives it its zone.
    const got = new Uint8Array(status.length);
    for (const b of sources) {
      forSharedRuns(s, b.shape as SegShape, (sl, ol) => {
        for (let d = 0; d < DEPTH; d++) {
          if (got[sl + d] === 1) continue;
          got[sl + d] = 1;
          zone[to + sl + d] = cells.zone[b.start + ol + d] ?? 0;
          density[to + sl + d] = cells.density[b.start + ol + d] ?? 0;
        }
      });
    }
  }
  // State lets go of the old arrays, so they become the spare.
  index.spare = { zone: cells.zone, density: cells.density };
  return { offset, zone, density };
}

/**
 * An array of `length` for a new layout: a view on the spare buffer when it
 * is big enough and not the one state holds now, else a new buffer with
 * room to grow. A spare holds an old layout, and `relayout` writes every
 * cell over it rather than clearing 2.9 million first. Like the network's
 * arrays, the view is exactly `length` long, so saves, hashes and copies
 * see only the cells.
 */
function layoutBuffer(spare: Uint8Array | undefined, current: Uint8Array, length: number): Uint8Array {
  if (spare && spare.buffer !== current.buffer && spare.buffer.byteLength >= length) {
    return new Uint8Array(spare.buffer, 0, length);
  }
  return new Uint8Array(new ArrayBuffer(ceilOf(length * 1.25) + 1024), 0, length);
}

// Live indexes by network object, like the spatial index and the blocks. A
// network loaded from a save, cloned or replayed is a new object, so it
// gets a fresh index built from its arrays.
const live = new WeakMap<RoadNetwork, CellIndex>();

/**
 * The cell index of `state`'s roads, built on first use, without walking
 * any change the roads have had since it last looked. A state whose roads
 * were changed without a step, as a test may, and whose index was never
 * built, has its cells laid out afresh here: a segment keeps its zones if it
 * has as many cells as it had, and starts unzoned otherwise.
 */
function indexOf(state: SimState): { index: CellIndex; built: boolean } {
  const known = live.get(state.roads);
  if (known) return { index: known, built: false };
  const index = buildCellIndex(state.roads, terrainOf(state.seed));
  const touch = (id: number) => index.touched.add(id);
  observeNetwork(state.roads, { nodeAdded: () => undefined, nodeRemoving: () => undefined, segmentAdded: touch, segmentRemoving: touch });
  live.set(state.roads, index);
  state.cells = fitCells(index, state.cells);
  return { index, built: true };
}

/**
 * The cell index of `state`'s roads with every cell settled, and the cells
 * in state laid out for the roads as they are now. Every query goes
 * through here, so a query never sees cells older than the roads, nor a
 * change half walked.
 */
export function syncCells(state: SimState): CellIndex {
  const { index, built } = indexOf(state);
  if (!built) state.cells = update(index, state.cells)?.cells ?? state.cells;
  drain(index, Infinity);
  return index;
}

/**
 * Brings the cells up to date after a command that may have changed the
 * roads (commands.ts). The zone and density arrays in state are laid out
 * for the new roads at once. A change that walks no more than
 * `settleCellsPerTick` cells settles at once too. A bigger one is given
 * `state.cellsReadyAt`, the tick by which it must be settled, from its size
 * and the tick an earlier change settles by, so every machine gives it the
 * same tick; until then `settleCells` walks one slice of it a step. A change
 * that arrives while another settles joins its walk. Nothing in the sim may read whether a cell
 * is blocked before that tick (`cellsSettled`).
 */
export function stepCells(state: SimState): void {
  const { index, built } = indexOf(state);
  if (built) return;
  const result = update(index, state.cells);
  // No road changed: any change still settling carries on at its own pace.
  if (!result) return;
  const { cells, work, folded } = result;
  state.cells = cells;
  const ticks = ceilOf(work / ZONING_BALANCE.settleCellsPerTick);
  if (ticks <= 1) {
    // While an earlier change is still settling, by the state's own clock,
    // this one adds its tick to the wait, so its work has a slice of its
    // own. From state alone: a city loaded mid-settle, which settled at
    // load and has nothing pending, extends it just the same.
    if (state.cellsReadyAt > state.tick) state.cellsReadyAt += ticks;
    // Settled at once, unless it joined a walk still under way.
    if (!folded) drain(index, Infinity);
    return;
  }
  // A big change gets ticks of its own after any earlier change's, so the
  // two never have to share a tick's slice. From state alone, so a city
  // loaded mid-settle, which settled everything at load, agrees.
  const from = state.cellsReadyAt > state.tick ? state.cellsReadyAt : state.tick;
  state.cellsReadyAt = from + ticks;
}

/**
 * Walks one slice of a change still settling, once a step, paused or not.
 * The step whose tick is the last before `state.cellsReadyAt` walks
 * whatever is left, however much that is, so the cells are settled on that
 * tick on every machine, whatever its speed (CLAUDE.md rule 5).
 */
export function settleCells(state: SimState): void {
  const index = live.get(state.roads);
  if (!index?.pending) return;
  drain(index, state.tick + 1 >= state.cellsReadyAt ? Infinity : ZONING_BALANCE.settleCellsPerTick);
}

/** Whether the sim may read which cells are blocked: no change of roads is still settling. */
export function cellsSettled(state: SimState): boolean {
  return state.tick >= state.cellsReadyAt;
}

/**
 * Whether the walk of every change so far is done, which can be before
 * `cellsSettled`: paused steps walk too, while the clock stands still. For
 * a view deciding when to show cells, never for the sim, whose rules must
 * not depend on how many paused steps a host ran.
 */
export function cellsWalked(state: SimState): boolean {
  const index = live.get(state.roads);
  return !index?.pending;
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

/**
 * For a client's copy of a city, after a delta's road rows and cells are
 * copied into `state` (delta.ts): brings the copy's cell index up to date,
 * if it has one, and returns the 500 m chunks, as `cj * CHUNKS_PER_SIDE + ci`
 * ascending, holding a cell that came, went, changed status or is one of
 * `painted`. `segs` are the segment ids whose rows the delta carried, and
 * `painted` the keys, `segment * CELL_KEY_STRIDE + place in its run`, of
 * cells whose zone the delta set.
 *
 * A copy nobody has asked about cells yet has no index, and building one
 * costs as much as a whole walk, so none is built here and no chunk is
 * returned: nothing has been drawn that could need drawing again. The first
 * query builds the index from the copy as it then is.
 */
export function followCells(state: SimState, segs: ArrayLike<number>, painted: ArrayLike<number>): number[] {
  const index = live.get(state.roads);
  if (!index) return [];
  index.follows = true;
  index.dirty ??= new Set();
  for (let i = 0; i < segs.length; i++) index.touched.add(segs[i] as number);
  syncCells(state);
  const q = new Float64Array(8);
  for (let i = 0; i < painted.length; i++) {
    const key = painted[i] as number;
    const seg = segOfKey(key);
    const s = index.segs[seg];
    const local = key - seg * KEY_STRIDE;
    if (!s?.status || local >= s.status.length) continue;
    cellQuad(s, local, q);
    const { x, z } = quadCentre(q);
    index.dirty.add(chunkAt(x, z));
  }
  const chunks = [...index.dirty].sort((a, b) => a - b);
  index.dirty.clear();
  return chunks;
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
  const list = index.cellBuckets;
  for (let e = list.heads[bucket] ?? -1; e >= 0; e = list.next[e] ?? -1) {
    const key = list.keys[e] ?? 0;
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
  const list = index.cellBuckets;
  forBuckets(index, box, (bucket) => {
    for (let e = list.heads[bucket] ?? -1; e >= 0; e = list.next[e] ?? -1) {
      const key = list.keys[e] ?? 0;
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

/**
 * Calls `visit` with every open cell whose centre lies inside the box, edges
 * included: where it sits in `cells.zone` and `cells.density`, and its
 * centre. Each cell once, in no order a caller may rely on. Does not bring
 * the index up to date: the caller has called `syncCells`.
 *
 * A cell is filed in every bucket its box touches, and is taken only from
 * the bucket its centre is in, so none needs remembering to be told apart.
 * The centre is the one `cellsInBox` goes by, to the bit.
 */
export function forOpenCellsInBox(
  index: CellIndex,
  cells: CellState,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (slot: number, x: number, z: number) => void,
): void {
  const q = quadW;
  const list = index.openBuckets;
  const i0 = bucketOf(index, minX);
  const i1 = bucketOf(index, maxX);
  const j0 = bucketOf(index, minZ);
  const j1 = bucketOf(index, maxZ);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      for (let e = list.heads[j * index.perSide + i] ?? -1; e >= 0; e = list.next[e] ?? -1) {
        const key = list.keys[e] ?? 0;
        const seg = segOfKey(key);
        const s = index.segs[seg];
        if (!s) continue;
        const local = key - seg * KEY_STRIDE;
        cellQuad(s, local, q);
        const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
        const z = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
        if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
        if (bucketOf(index, x) !== i || bucketOf(index, z) !== j) continue;
        visit((cells.offset[seg] ?? 0) + local, x, z);
      }
    }
  }
}

/** The chunk a point is in, as `cj * CHUNKS_PER_SIDE + ci`, off-map points in the nearest edge chunk. */
export function chunkAt(x: number, z: number): number {
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

// ---- Columns, for lots (M2-09) ----

/**
 * A column of cells: one place on one side of a segment, every depth from
 * the road's edge back. `dir` is the way a walk along the road is going
 * from it: 0 toward node B, where places count up, 1 toward node A.
 */
export interface Column {
  seg: number;
  side: number;
  place: number;
  dir: number;
}

/** Two points closer than this, in metres, are one point: the 1 cm shapes go by. */
const SAME_POINT_SQ = 0.0001;

/**
 * Writes the edge of a column that faces `toward` (0 toward node B, 1
 * toward node A), `depth` cells deep, as inner x, z then outer x, z: the
 * corner at the road's edge and the corner at the back of cell `depth - 1`.
 */
function columnEdge(s: SegShape, side: number, place: number, toward: number, depth: number, out: Float64Array): void {
  // A cell's corners go by its anchor: 0 and 3 at the station nearer the
  // anchor's start, 1 and 2 at the next, inner then outer. Places count
  // down the anchor on a reversed segment.
  const ahead = toward === 0 ? !s.reversed : s.reversed;
  const local = (place * 2 + side) * DEPTH;
  cellQuad(s, local, quadD);
  out[0] = quadD[ahead ? 2 : 0] ?? 0;
  out[1] = quadD[ahead ? 3 : 1] ?? 0;
  cellQuad(s, local + depth - 1, quadD);
  out[2] = quadD[ahead ? 4 : 6] ?? 0;
  out[3] = quadD[ahead ? 5 : 7] ?? 0;
}

const edgeA = new Float64Array(4);
const edgeB = new Float64Array(4);

/** Whether two edges as `columnEdge` writes them are one edge, inner to inner and outer to outer. */
function sameEdge(p: Float64Array, q: Float64Array): boolean {
  const d0 = ((p[0] ?? 0) - (q[0] ?? 0)) ** 2 + ((p[1] ?? 0) - (q[1] ?? 0)) ** 2;
  const d1 = ((p[2] ?? 0) - (q[2] ?? 0)) ** 2 + ((p[3] ?? 0) - (q[3] ?? 0)) ** 2;
  return d0 <= SAME_POINT_SQ && d1 <= SAME_POINT_SQ;
}

/**
 * The column after `col` going its way along the road, or null where the
 * strip ends. Within a segment that is the next place. At a segment's end
 * it is the end column of another segment at that node whose facing edge
 * is this column's far edge, inner corner on inner corner and outer on
 * outer, to 1 cm: a road that runs straight on with the same width, such as
 * the two pieces a T-junction across the street cut a road into. Where
 * roads meet at an angle or change width, the edges part and the strip
 * ends. Where two candidates match, which only overlapping roads could
 * give, the lower segment id.
 */
export function nextColumn(index: CellIndex, col: Column): Column | null {
  const s = index.segs[col.seg];
  if (!s?.status) return null;
  const step = col.dir === 0 ? 1 : -1;
  const place = col.place + step;
  if (place >= 0 && place < s.places) return { seg: col.seg, side: col.side, place, dir: col.dir };
  const node = col.dir === 0 ? s.b : s.a;
  columnEdge(s, col.side, col.place, col.dir, DEPTH, edgeA);
  const net = index.net;
  let best: Column | null = null;
  for (let other = net.nodeFirstSeg[node] ?? NONE; other !== NONE; other = nextSegmentAt(net, other, node)) {
    if (other === col.seg || (best !== null && other > best.seg)) continue;
    const o = index.segs[other];
    if (!o?.status || o.places === 0) continue;
    // Leaving through node A means walking toward node B, and the other way.
    const fromA = o.a === node;
    const oPlace = fromA ? 0 : o.places - 1;
    const oDir = fromA ? 0 : 1;
    for (let side = 0; side < 2; side++) {
      columnEdge(o, side, oPlace, 1 - oDir, DEPTH, edgeB);
      if (sameEdge(edgeA, edgeB)) best = { seg: other, side, place: oPlace, dir: oDir };
    }
  }
  return best;
}

/**
 * Whether `col` names a column a segment has. A building row that has not
 * caught up with a change of roads may not.
 */
export function columnExists(index: CellIndex, col: Column): boolean {
  const s = index.segs[col.seg];
  return !!s?.status && (col.side === 0 || col.side === 1) && Number.isInteger(col.place) && col.place >= 0 && col.place < s.places;
}

/** The CELL_ value of the cell at `depth` in `col`, or -1 if there is none. */
export function columnStatus(index: CellIndex, col: Column, depth: number): number {
  const s = index.segs[col.seg];
  if (!s?.status) return -1;
  return s.status[(col.place * 2 + col.side) * DEPTH + depth] ?? -1;
}

/**
 * The corners of the ground `width` columns from `first` on cover, `depth`
 * cells back, as x0, z0, ..., x3, z3: the near edge of the first column at
 * the road and at the back, then the far edge of the last at the back and
 * at the road. Null if the strip ends before `width` columns. On a curve
 * the four corners are those of the cells, so the shape fans out with
 * them.
 */
export function lotCorners(index: CellIndex, first: Column, width: number, depth: number): number[] | null {
  if (!columnExists(index, first) || depth < 1 || depth > DEPTH) return null;
  const cols: Column[] = [first];
  for (let i = 1; i < width; i++) {
    const next = nextColumn(index, cols[i - 1] as Column);
    if (!next) return null;
    cols.push(next);
  }
  const last = cols[width - 1] as Column;
  const s0 = index.segs[first.seg];
  const s1 = index.segs[last.seg];
  if (!s0?.status || !s1?.status) return null;
  const near = new Float64Array(4);
  const far = new Float64Array(4);
  columnEdge(s0, first.side, first.place, 1 - first.dir, depth, near);
  columnEdge(s1, last.side, last.place, last.dir, depth, far);
  return [near[0] ?? 0, near[1] ?? 0, near[2] ?? 0, near[3] ?? 0, far[2] ?? 0, far[3] ?? 0, far[0] ?? 0, far[1] ?? 0];
}
