// The road graph: nodes and segments in typed arrays indexed by id
// (CLAUDE.md rule 7). Road, rail and path share it; the network type sets
// which one a segment belongs to.
//
// Each array is a view whose length is the high-water mark of ids handed
// out. Its buffer is bigger and doubles when full, but the spare room is
// outside the view, so the state hash, a save and a clone all see the same
// bytes whatever the capacity. A removed id stays inside the view with every
// field zeroed and goes on a free list. Ids come back off that list last in,
// first out, so the order depends only on the commands applied.
//
// Each node keeps a linked list of the segments that touch it: the head is
// `nodeFirstSeg` and each segment links on through `segNextA` (at its node
// A) or `segNextB` (at its node B). -1 ends a list.
//
// While a journal is open (`startJournal`), every change is also written
// down as plain data, so undo (undo.ts) can reverse it exactly. A node or
// segment the command removed and did not hand out again is held when the
// journal closes: its row stays zeroed but its id comes off the free list,
// so nothing else can take it and undo can put it back under the same id.
// The undo record that removed it holds it, and frees it when the record is
// forgotten. An id a command frees and reuses itself, as a split does, is
// handed out exactly as without a journal.
//
// Only exact arithmetic here (rule 6): two machines must agree on lengths.

import { ROAD_TYPES } from "./balance";

/**
 * A segment's vertical level at each end (issue 22, PRD "Levels and grade
 * separation"). Ground, tunnel and the two elevated levels sit a fixed
 * height above or below the ground under them, from `levels` in
 * `roads.json`. A bridge is its own level: its deck height comes from the
 * water under it (bridge.ts), and it is a bridge at both ends. The values
 * are what saves hold, so never renumber them.
 */
export const LEVEL_GROUND = 0;
export const LEVEL_BRIDGE = 1;
export const LEVEL_TUNNEL = 2;
export const LEVEL_ELEVATED_1 = 3;
export const LEVEL_ELEVATED_2 = 4;
export const LEVEL_COUNT = 5;

/** Whether `level` is one of the level values. */
export function isLevel(level: number): boolean {
  return Number.isInteger(level) && level >= 0 && level < LEVEL_COUNT;
}

/** Whether segment `seg` has the same level `level` at both ends. */
export function segmentAtLevel(net: RoadNetwork, seg: number, level: number): boolean {
  return net.segLevelA[seg] === level && net.segLevelB[seg] === level;
}

/** Which network a segment belongs to. M1 builds only road. */
export const NETWORK_ROAD = 0;
export const NETWORK_RAIL = 1;
export const NETWORK_PATH = 2;
const NETWORK_COUNT = 3;

/** Node flags. */
export const NODE_ALIVE = 1;
/** The player cannot remove this node, as at an outside connection. */
export const NODE_FIXED = 2;

/** Segment flags. */
export const SEG_ALIVE = 1;
/** The player cannot remove or change this segment, as at an outside connection. */
export const SEG_FIXED = 2;

/** Marks the end of a list. */
export const NONE = -1;

/** Capacity of an array's first buffer. */
const INITIAL_CAPACITY = 16;

/** The road graph. Plain fields and typed arrays only. */
export interface RoadNetwork {
  /** Metres east. */
  nodeX: Float64Array;
  /** Metres south, the terrain's z. */
  nodeZ: Float64Array;
  /** Height in metres. */
  nodeHeight: Float64Array;
  /** NODE_ALIVE, NODE_FIXED. */
  nodeFlags: Uint8Array;
  /** First segment touching the node, or NONE. */
  nodeFirstSeg: Int32Array;
  /** Removed node ids, the next one to reuse last. */
  nodeFree: Int32Array;

  segA: Int32Array;
  segB: Int32Array;
  /** Next segment in node A's list, or NONE. */
  segNextA: Int32Array;
  /** Next segment in node B's list, or NONE. */
  segNextB: Int32Array;
  /** Index into ROAD_TYPES for road; rail and path get their own tables later. */
  segType: Uint8Array;
  /** NETWORK_ROAD, NETWORK_RAIL or NETWORK_PATH. */
  segNetwork: Uint8Array;
  /**
   * The level at node A and at node B: LEVEL_GROUND and the rest. They
   * differ only on a ramp, which M5 builds; every M1 segment has one level.
   */
  segLevelA: Uint8Array;
  segLevelB: Uint8Array;
  /** SEG_ALIVE, SEG_FIXED. */
  segFlags: Uint8Array;
  /**
   * The quadratic curve's control point. A straight segment has it exactly
   * at the midpoint of its nodes.
   */
  segCX: Float64Array;
  segCZ: Float64Array;
  /** Length in plan, metres. */
  segLength: Float64Array;
  /**
   * Build order: a lower number is an older segment (M2-01). Each new
   * segment takes `segOrderNext`. The pieces of a split keep their
   * parent's number, and an upgrade or a reverse leaves it alone, so the
   * number says when the road was first built there. Two segments share a
   * number only as pieces of one split road. Where two roads compete for
   * the same ground, the older keeps its cells (PRD, "M2 Zoning and
   * buildings").
   */
  segOrder: Float64Array;
  /** Removed segment ids, the next one to reuse last. */
  segFree: Int32Array;
  /** The build order number the next new segment takes. Above every live segment's. */
  segOrderNext: number;
}

export type AnyTypedArray = Float64Array | Int32Array | Uint8Array;

/**
 * Derived data that follows a network: the spatial index, later the routing
 * graph. Told after a node or segment is added and before one is removed,
 * while its fields still hold their values. A segment changed in place
 * (`restyleSegment`) is reported as removed before the change and added
 * after it.
 */
export interface NetworkObserver {
  nodeAdded(id: number): void;
  nodeRemoving(id: number): void;
  segmentAdded(id: number): void;
  segmentRemoving(id: number): void;
}

// Observers by network object. Not state: a network loaded, cloned or
// replayed is a new object with none, and its derived data is rebuilt from
// the arrays. A WeakMap, so a network nobody holds takes its observers with it.
const observers = new WeakMap<RoadNetwork, NetworkObserver[]>();

/** Tells `observer` about every later change to `net` made through this module. */
export function observeNetwork(net: RoadNetwork, observer: NetworkObserver): void {
  const list = observers.get(net);
  if (list) list.push(observer);
  else observers.set(net, [observer]);
}

/** A network with no nodes or segments. */
export function createRoadNetwork(): RoadNetwork {
  return {
    nodeX: new Float64Array(0),
    nodeZ: new Float64Array(0),
    nodeHeight: new Float64Array(0),
    nodeFlags: new Uint8Array(0),
    nodeFirstSeg: new Int32Array(0),
    nodeFree: new Int32Array(0),
    segA: new Int32Array(0),
    segB: new Int32Array(0),
    segNextA: new Int32Array(0),
    segNextB: new Int32Array(0),
    segType: new Uint8Array(0),
    segNetwork: new Uint8Array(0),
    segLevelA: new Uint8Array(0),
    segLevelB: new Uint8Array(0),
    segFlags: new Uint8Array(0),
    segCX: new Float64Array(0),
    segCZ: new Float64Array(0),
    segLength: new Float64Array(0),
    segOrder: new Float64Array(0),
    segFree: new Int32Array(0),
    segOrderNext: 0,
  };
}

/** Elements the buffer behind `array` can hold from the view's start. */
export function capacityOf(array: AnyTypedArray): number {
  return (array.buffer.byteLength - array.byteOffset) / array.BYTES_PER_ELEMENT;
}

/**
 * A view of `array`'s data with `length` elements. Reuses the buffer when it
 * has room and otherwise copies into one of double the capacity. Elements
 * past the old length are whatever the buffer holds; callers write them.
 */
export function resized<T extends AnyTypedArray>(array: T, length: number): T {
  const Type = array.constructor as new (bufferOrLength: ArrayBufferLike | number, offset?: number, length?: number) => T;
  const capacity = capacityOf(array);
  if (length <= capacity) return new Type(array.buffer, array.byteOffset, length);
  let next = Math.max(INITIAL_CAPACITY, capacity);
  while (next < length) next *= 2;
  const grown = new Type(next);
  grown.set(array);
  return new Type(grown.buffer, 0, length);
}

/** Number of node ids handed out, removed ones included. */
export function nodeIdLimit(net: RoadNetwork): number {
  return net.nodeFlags.length;
}

/** Number of segment ids handed out, removed ones included. */
export function segmentIdLimit(net: RoadNetwork): number {
  return net.segFlags.length;
}

export function isNode(net: RoadNetwork, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < net.nodeFlags.length && ((net.nodeFlags[id] ?? 0) & NODE_ALIVE) !== 0;
}

export function isSegment(net: RoadNetwork, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < net.segFlags.length && ((net.segFlags[id] ?? 0) & SEG_ALIVE) !== 0;
}

function countAlive(flags: Uint8Array, alive: number): number {
  let n = 0;
  for (const f of flags) if ((f & alive) !== 0) n++;
  return n;
}

/** Live nodes. Counts the flags, since held ids are on no free list. */
export function nodeCount(net: RoadNetwork): number {
  return countAlive(net.nodeFlags, NODE_ALIVE);
}

/** Live segments. Counts the flags, since held ids are on no free list. */
export function segmentCount(net: RoadNetwork): number {
  return countAlive(net.segFlags, SEG_ALIVE);
}

/** The per-node arrays, every one indexed by node id. */
export const NODE_ARRAYS = ["nodeX", "nodeZ", "nodeHeight", "nodeFlags", "nodeFirstSeg"] as const;
/** The per-segment arrays, every one indexed by segment id. */
export const SEG_ARRAYS = [
  "segA",
  "segB",
  "segNextA",
  "segNextB",
  "segType",
  "segNetwork",
  "segLevelA",
  "segLevelB",
  "segFlags",
  "segCX",
  "segCZ",
  "segLength",
  "segOrder",
] as const;

/** Every field of one segment, as plain data. */
export interface SegmentRow {
  a: number;
  b: number;
  type: number;
  network: number;
  levelA: number;
  levelB: number;
  flags: number;
  cx: number;
  cz: number;
  length: number;
  /** Build order, `segOrder`. */
  order: number;
}

/**
 * One change a journal wrote down. `grown` is true when the id came from
 * growing the arrays rather than off the free list. `fresh` is true when a
 * new segment took its build order from `segOrderNext` rather than from the
 * segment it was split from. `atA` and `atB` are
 * where a removed segment stood in its nodes' lists, counted from the head.
 *
 * Ids are reused, so an id written here may later name something else. A
 * removed segment therefore carries where its end nodes stood (`ax` to
 * `bz`), and a restyle the ends the segment had before it (`a`, `b`). Undo
 * refuses when they no longer match (M1 review, issue 80).
 */
export type NetworkOp =
  | { op: "addNode"; id: number; grown: boolean }
  | { op: "removeNode"; id: number; x: number; z: number; height: number; flags: number }
  | { op: "addSeg"; id: number; grown: boolean; fresh: boolean; row: SegmentRow }
  | { op: "removeSeg"; id: number; row: SegmentRow; atA: number; atB: number; ax: number; az: number; bx: number; bz: number }
  | { op: "restyle"; id: number; from: number; to: number; reverse: boolean; a: number; b: number };

// Open journals by network object. Only open while one command applies, so
// never part of state.
const journals = new WeakMap<RoadNetwork, NetworkOp[]>();

/** Starts writing down every change to `net`, and holding removed ids. */
export function startJournal(net: RoadNetwork): void {
  journals.set(net, []);
}

/**
 * Stops the journal `startJournal` opened and returns what it wrote, oldest
 * first. Ids the command removed and left removed come off the free list,
 * held for undo (see `heldByOps`).
 */
export function endJournal(net: RoadNetwork): NetworkOp[] {
  const ops = journals.get(net) ?? [];
  journals.delete(net);
  const held = heldByOps(ops);
  claimAll(net, "nodeFree", held.nodes);
  claimAll(net, "segFree", held.segs);
  return ops;
}

/**
 * The ids a journal's command removed and did not hand out again, in the
 * order they were removed. They are held for its undo record.
 */
export function heldByOps(ops: readonly NetworkOp[]): HeldIds {
  const nodes = new Map<number, boolean>();
  const segs = new Map<number, boolean>();
  for (const op of ops) {
    if (op.op === "addNode" || op.op === "removeNode") {
      nodes.delete(op.id);
      nodes.set(op.id, op.op === "removeNode");
    } else if (op.op === "addSeg" || op.op === "removeSeg") {
      segs.delete(op.id);
      segs.set(op.id, op.op === "removeSeg");
    }
  }
  const removed = (m: Map<number, boolean>) => [...m].filter(([, gone]) => gone).map(([id]) => id);
  return { nodes: removed(nodes), segs: removed(segs) };
}

function journal(net: RoadNetwork, op: NetworkOp): void {
  journals.get(net)?.push(op);
}

/** Every field of segment `id`. */
export function readSegment(net: RoadNetwork, id: number): SegmentRow {
  return {
    a: net.segA[id] ?? NONE,
    b: net.segB[id] ?? NONE,
    type: net.segType[id] ?? 0,
    network: net.segNetwork[id] ?? 0,
    levelA: net.segLevelA[id] ?? 0,
    levelB: net.segLevelB[id] ?? 0,
    flags: net.segFlags[id] ?? 0,
    cx: net.segCX[id] ?? 0,
    cz: net.segCZ[id] ?? 0,
    length: net.segLength[id] ?? 0,
    order: net.segOrder[id] ?? 0,
  };
}

/** Whether two rows hold the same values. */
export function sameRow(p: SegmentRow, q: SegmentRow): boolean {
  return (
    p.a === q.a &&
    p.b === q.b &&
    p.type === q.type &&
    p.network === q.network &&
    p.levelA === q.levelA &&
    p.levelB === q.levelB &&
    p.flags === q.flags &&
    Object.is(p.cx, q.cx) &&
    Object.is(p.cz, q.cz) &&
    Object.is(p.length, q.length) &&
    p.order === q.order
  );
}

/** Takes an id off the free list, or grows every array by one. */
function allocate(net: RoadNetwork, freeKey: "nodeFree" | "segFree", keys: readonly (keyof RoadNetwork)[]): { id: number; grown: boolean } {
  const free = net[freeKey];
  if (free.length > 0) {
    const id = free[free.length - 1] ?? 0;
    net[freeKey] = resized(free, free.length - 1);
    return { id, grown: false };
  }
  const id = (net[keys[0] as keyof RoadNetwork] as AnyTypedArray).length;
  for (const key of keys) {
    (net as unknown as Record<string, AnyTypedArray>)[key] = resized(net[key] as AnyTypedArray, id + 1);
  }
  return { id, grown: true };
}

function pushFree(net: RoadNetwork, freeKey: "nodeFree" | "segFree", id: number): void {
  const free = resized(net[freeKey], net[freeKey].length + 1);
  free[free.length - 1] = id;
  net[freeKey] = free;
}

function release(net: RoadNetwork, freeKey: "nodeFree" | "segFree", keys: readonly (keyof RoadNetwork)[], id: number): void {
  for (const key of keys) (net[key] as AnyTypedArray)[id] = 0;
  pushFree(net, freeKey, id);
}

/**
 * The exact reverse of `allocate`, for undo. The row must be zeroed. An id
 * that came from growing the arrays shrinks them again while it is still the
 * last; otherwise it goes back on the free list.
 */
function unallocate(net: RoadNetwork, freeKey: "nodeFree" | "segFree", keys: readonly (keyof RoadNetwork)[], id: number, grown: boolean): void {
  const length = (net[keys[0] as keyof RoadNetwork] as AnyTypedArray).length;
  if (grown && id === length - 1) {
    for (const key of keys) {
      (net as unknown as Record<string, AnyTypedArray>)[key] = resized(net[key] as AnyTypedArray, id);
    }
  } else {
    pushFree(net, freeKey, id);
  }
}

/** Takes `id` off the free list if it is there. A held id is on no list. */
function claim(net: RoadNetwork, freeKey: "nodeFree" | "segFree", id: number): void {
  const free = net[freeKey];
  const at = free.lastIndexOf(id);
  if (at < 0) return;
  const next = new Int32Array(free.length - 1);
  next.set(free.subarray(0, at));
  next.set(free.subarray(at + 1), at);
  net[freeKey] = next;
}

/**
 * Takes every id in `ids` off the free list in one pass, keeping the order
 * of the rest. An id is on the list at most once. One pass, because a
 * command can remove thousands of segments and `claim` copies the list for
 * each.
 */
function claimAll(net: RoadNetwork, freeKey: "nodeFree" | "segFree", ids: readonly number[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  const free = net[freeKey];
  const next = new Int32Array(free.length);
  let n = 0;
  for (let i = 0; i < free.length; i++) {
    const id = free[i] as number;
    if (!gone.has(id)) next[n++] = id;
  }
  net[freeKey] = next.slice(0, n);
}

/** Puts held ids on the free list, nodes then segments, each in the order given. */
export function releaseHeld(net: RoadNetwork, nodes: readonly number[], segs: readonly number[]): void {
  for (const id of nodes) pushFree(net, "nodeFree", id);
  for (const id of segs) pushFree(net, "segFree", id);
}

function checkFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`);
}

/** Adds a node and returns its id. */
export function addNode(net: RoadNetwork, x: number, z: number, height: number, fixed = false): number {
  checkFinite("x", x);
  checkFinite("z", z);
  checkFinite("height", height);
  const { id, grown } = allocate(net, "nodeFree", NODE_ARRAYS);
  net.nodeX[id] = x;
  net.nodeZ[id] = z;
  net.nodeHeight[id] = height;
  net.nodeFlags[id] = NODE_ALIVE | (fixed ? NODE_FIXED : 0);
  net.nodeFirstSeg[id] = NONE;
  journal(net, { op: "addNode", id, grown });
  for (const observer of observers.get(net) ?? []) observer.nodeAdded(id);
  return id;
}

/**
 * Removes a node. It must have no segments and must not be fixed: remove
 * its segments first, and fixed nodes never go.
 */
export function removeNode(net: RoadNetwork, id: number): void {
  if (!isNode(net, id)) throw new RangeError(`node ${id} does not exist`);
  if (((net.nodeFlags[id] ?? 0) & NODE_FIXED) !== 0) throw new RangeError(`node ${id} is fixed`);
  if (net.nodeFirstSeg[id] !== NONE) throw new RangeError(`node ${id} still has segments`);
  journal(net, {
    op: "removeNode",
    id,
    x: net.nodeX[id] ?? 0,
    z: net.nodeZ[id] ?? 0,
    height: net.nodeHeight[id] ?? 0,
    flags: net.nodeFlags[id] ?? 0,
  });
  for (const observer of observers.get(net) ?? []) observer.nodeRemoving(id);
  release(net, "nodeFree", NODE_ARRAYS, id);
}

/** What a new segment is, besides its two nodes. */
export interface SegmentSpec {
  /** Index into ROAD_TYPES. */
  type: number;
  network?: number;
  /** The level at both ends, or at node A when `levelB` is given. Ground if left out. */
  level?: number;
  /** The level at node B, for a ramp. Defaults to `level`. */
  levelB?: number;
  /** Control point. Leave out both for a straight segment. */
  cx?: number;
  cz?: number;
  /** Sets SEG_FIXED. */
  fixed?: boolean;
  /**
   * Build order to keep, for a piece of a split segment: its parent's
   * number. Left out, the segment is new and takes `segOrderNext`.
   */
  order?: number;
}

/** Steps in the polyline that measures a curve. */
const CURVE_STEPS = 16;

/**
 * Plan length of the quadratic curve from (ax, az) through control point
 * (cx, cz) to (bx, bz). A control point exactly at the midpoint is a
 * straight line. A curve is measured as a polyline of CURVE_STEPS pieces,
 * with only exact operations, so every engine gets the same number.
 */
export function curveLength(ax: number, az: number, cx: number, cz: number, bx: number, bz: number): number {
  if (cx === (ax + bx) / 2 && cz === (az + bz) / 2) {
    const dx = bx - ax;
    const dz = bz - az;
    return Math.sqrt(dx * dx + dz * dz);
  }
  let length = 0;
  let px = ax;
  let pz = az;
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * cx + t * t * bx;
    const z = u * u * az + 2 * u * t * cz + t * t * bz;
    const dx = x - px;
    const dz = z - pz;
    length += Math.sqrt(dx * dx + dz * dz);
    px = x;
    pz = z;
  }
  return length;
}

/** Adds a segment from node `a` to node `b` and returns its id. */
export function addSegment(net: RoadNetwork, a: number, b: number, spec: SegmentSpec): number {
  if (!isNode(net, a)) throw new RangeError(`node ${a} does not exist`);
  if (!isNode(net, b)) throw new RangeError(`node ${b} does not exist`);
  if (a === b) throw new RangeError(`a segment cannot start and end at node ${a}`);
  const network = spec.network ?? NETWORK_ROAD;
  const level = spec.level ?? LEVEL_GROUND;
  const levelB = spec.levelB ?? level;
  if (!Number.isInteger(spec.type) || spec.type < 0 || spec.type > 255) throw new RangeError(`bad segment type ${spec.type}`);
  if (!Number.isInteger(network) || network < 0 || network >= NETWORK_COUNT) throw new RangeError(`bad network ${network}`);
  if (!isLevel(level)) throw new RangeError(`bad level ${level}`);
  if (!isLevel(levelB)) throw new RangeError(`bad level ${levelB}`);
  if ((level === LEVEL_BRIDGE) !== (levelB === LEVEL_BRIDGE)) throw new RangeError("a bridge is a bridge at both ends");
  if (network === NETWORK_ROAD && spec.type >= ROAD_TYPES.length) throw new RangeError(`no road type ${spec.type}`);
  if ((spec.cx === undefined) !== (spec.cz === undefined)) throw new RangeError("give both cx and cz, or neither");
  const ax = net.nodeX[a] ?? 0;
  const az = net.nodeZ[a] ?? 0;
  const bx = net.nodeX[b] ?? 0;
  const bz = net.nodeZ[b] ?? 0;
  const cx = spec.cx ?? (ax + bx) / 2;
  const cz = spec.cz ?? (az + bz) / 2;
  checkFinite("cx", cx);
  checkFinite("cz", cz);
  const fresh = spec.order === undefined;
  const order = spec.order ?? net.segOrderNext;
  if (!fresh && !(Number.isSafeInteger(order) && order >= 0 && order < net.segOrderNext)) {
    throw new RangeError(`segment order ${order} was never handed out`);
  }

  const { id, grown } = allocate(net, "segFree", SEG_ARRAYS);
  net.segA[id] = a;
  net.segB[id] = b;
  net.segType[id] = spec.type;
  net.segNetwork[id] = network;
  net.segLevelA[id] = level;
  net.segLevelB[id] = levelB;
  net.segFlags[id] = SEG_ALIVE | (spec.fixed ? SEG_FIXED : 0);
  net.segCX[id] = cx;
  net.segCZ[id] = cz;
  net.segLength[id] = curveLength(ax, az, cx, cz, bx, bz);
  net.segOrder[id] = order;
  if (fresh) net.segOrderNext = order + 1;
  // Newest first in each node's list.
  net.segNextA[id] = net.nodeFirstSeg[a] ?? NONE;
  net.nodeFirstSeg[a] = id;
  net.segNextB[id] = net.nodeFirstSeg[b] ?? NONE;
  net.nodeFirstSeg[b] = id;
  if (journals.has(net)) journal(net, { op: "addSeg", id, grown, fresh, row: readSegment(net, id) });
  for (const observer of observers.get(net) ?? []) observer.segmentAdded(id);
  return id;
}

/** The segment after `seg` in `node`'s list, or NONE. */
export function nextSegmentAt(net: RoadNetwork, seg: number, node: number): number {
  return (net.segA[seg] === node ? net.segNextA[seg] : net.segNextB[seg]) ?? NONE;
}

/** Points whichever link of `seg` belongs to `node` at `next`. */
function setNextAt(net: RoadNetwork, seg: number, node: number, next: number): void {
  if (net.segA[seg] === node) net.segNextA[seg] = next;
  else net.segNextB[seg] = next;
}

/** Takes `seg` out of `node`'s list and returns where it stood, counted from the head. */
function unlink(net: RoadNetwork, seg: number, node: number): number {
  let prev = NONE;
  let at = net.nodeFirstSeg[node] ?? NONE;
  let place = 0;
  while (at !== NONE && at !== seg) {
    prev = at;
    at = nextSegmentAt(net, at, node);
    place++;
  }
  if (at === NONE) throw new Error(`segment ${seg} is missing from node ${node}'s list`);
  const next = nextSegmentAt(net, seg, node);
  if (prev === NONE) net.nodeFirstSeg[node] = next;
  else setNextAt(net, prev, node, next);
  return place;
}

/** Puts `seg` into `node`'s list at `place` from the head, or at the tail if the list is shorter. */
function linkAt(net: RoadNetwork, seg: number, node: number, place: number): void {
  let prev = NONE;
  let at = net.nodeFirstSeg[node] ?? NONE;
  for (let i = 0; i < place && at !== NONE; i++) {
    prev = at;
    at = nextSegmentAt(net, at, node);
  }
  setNextAt(net, seg, node, at);
  if (prev === NONE) net.nodeFirstSeg[node] = seg;
  else setNextAt(net, prev, node, seg);
}

/** Removes a segment. Its nodes stay. */
export function removeSegment(net: RoadNetwork, id: number): void {
  if (!isSegment(net, id)) throw new RangeError(`segment ${id} does not exist`);
  const row = readSegment(net, id);
  const atA = unlink(net, id, row.a);
  const atB = unlink(net, id, row.b);
  journal(net, {
    op: "removeSeg",
    id,
    row,
    atA,
    atB,
    ax: net.nodeX[row.a] ?? 0,
    az: net.nodeZ[row.a] ?? 0,
    bx: net.nodeX[row.b] ?? 0,
    bz: net.nodeZ[row.b] ?? 0,
  });
  for (const observer of observers.get(net) ?? []) observer.segmentRemoving(id);
  release(net, "segFree", SEG_ARRAYS, id);
}

// ---- The reverse of each change, for undo ----
//
// Each one undoes exactly what its forward change did, so a change and its
// reverse in turn leave the arrays, the free lists and every node's list as
// they were. Callers check first that the reverse makes sense: undo.ts
// does. None of them is written to a journal.

/** Reverses `addNode`. The node must have no segments. */
export function unaddNode(net: RoadNetwork, id: number, grown: boolean): void {
  if (!isNode(net, id)) throw new RangeError(`node ${id} does not exist`);
  if (net.nodeFirstSeg[id] !== NONE) throw new RangeError(`node ${id} still has segments`);
  for (const observer of observers.get(net) ?? []) observer.nodeRemoving(id);
  for (const key of NODE_ARRAYS) net[key][id] = 0;
  unallocate(net, "nodeFree", NODE_ARRAYS, id, grown);
}

/** Reverses `removeNode`: brings back a held or free node id with the fields it had. */
export function restoreNode(net: RoadNetwork, id: number, x: number, z: number, height: number, flags: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= net.nodeFlags.length || isNode(net, id)) throw new RangeError(`node ${id} cannot be restored`);
  claim(net, "nodeFree", id);
  net.nodeX[id] = x;
  net.nodeZ[id] = z;
  net.nodeHeight[id] = height;
  net.nodeFlags[id] = flags;
  net.nodeFirstSeg[id] = NONE;
  for (const observer of observers.get(net) ?? []) observer.nodeAdded(id);
}

/**
 * Reverses `addSegment`. A `fresh` segment that took the newest build order
 * number gives it back, so the next new segment takes it again. One with an
 * older number leaves the counter alone: a newer segment holds a higher one.
 */
export function unaddSegment(net: RoadNetwork, id: number, grown: boolean, fresh: boolean): void {
  if (!isSegment(net, id)) throw new RangeError(`segment ${id} does not exist`);
  if (fresh && net.segOrder[id] === net.segOrderNext - 1) net.segOrderNext--;
  unlink(net, id, net.segA[id] ?? NONE);
  unlink(net, id, net.segB[id] ?? NONE);
  for (const observer of observers.get(net) ?? []) observer.segmentRemoving(id);
  for (const key of SEG_ARRAYS) net[key][id] = 0;
  unallocate(net, "segFree", SEG_ARRAYS, id, grown);
}

/**
 * Reverses `removeSegment`: brings back a held or free segment id with the
 * fields it had, at the place it had in each node's list.
 */
export function restoreSegment(net: RoadNetwork, id: number, row: SegmentRow, atA: number, atB: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= net.segFlags.length || isSegment(net, id)) throw new RangeError(`segment ${id} cannot be restored`);
  if (!isNode(net, row.a) || !isNode(net, row.b) || row.a === row.b) throw new RangeError(`segment ${id} has bad nodes`);
  claim(net, "segFree", id);
  net.segA[id] = row.a;
  net.segB[id] = row.b;
  net.segType[id] = row.type;
  net.segNetwork[id] = row.network;
  net.segLevelA[id] = row.levelA;
  net.segLevelB[id] = row.levelB;
  net.segFlags[id] = row.flags;
  net.segCX[id] = row.cx;
  net.segCZ[id] = row.cz;
  net.segLength[id] = row.length;
  net.segOrder[id] = row.order;
  linkAt(net, id, row.a, atA);
  linkAt(net, id, row.b, atB);
  for (const observer of observers.get(net) ?? []) observer.segmentAdded(id);
}

/**
 * Changes a segment in place: gives it road type `type` and, with `reverse`,
 * swaps its two ends so it runs the other way, each keeping its level. A
 * one-way runs from node A to node B. The id, shape, length, levels and place
 * in each node's list stay.
 * Observers see the segment go and come back, so derived data refiles it.
 */
export function restyleSegment(net: RoadNetwork, id: number, type: number, reverse: boolean): void {
  if (!isSegment(net, id)) throw new RangeError(`segment ${id} does not exist`);
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new RangeError(`bad segment type ${type}`);
  if (net.segNetwork[id] === NETWORK_ROAD && type >= ROAD_TYPES.length) throw new RangeError(`no road type ${type}`);
  journal(net, { op: "restyle", id, from: net.segType[id] ?? 0, to: type, reverse, a: net.segA[id] ?? NONE, b: net.segB[id] ?? NONE });
  for (const observer of observers.get(net) ?? []) observer.segmentRemoving(id);
  net.segType[id] = type;
  if (reverse) {
    // Each node's list follows the link on its own end, so swapping the
    // links with the ends keeps both lists as they were.
    const a = net.segA[id] ?? NONE;
    const nextA = net.segNextA[id] ?? NONE;
    net.segA[id] = net.segB[id] ?? NONE;
    net.segNextA[id] = net.segNextB[id] ?? NONE;
    net.segB[id] = a;
    net.segNextB[id] = nextA;
    const levelA = net.segLevelA[id] ?? 0;
    net.segLevelA[id] = net.segLevelB[id] ?? 0;
    net.segLevelB[id] = levelA;
  }
  for (const observer of observers.get(net) ?? []) observer.segmentAdded(id);
}

/**
 * Runs the reverse of each change in `ops`, newest first, as a journal wrote
 * them. Built and then reversed with nothing in between, the network is byte
 * for byte what it was. The caller checks first that the reverse makes sense.
 */
export function reverseOps(net: RoadNetwork, ops: readonly NetworkOp[]): void {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as NetworkOp;
    switch (op.op) {
      case "addNode":
        unaddNode(net, op.id, op.grown);
        break;
      case "removeNode":
        restoreNode(net, op.id, op.x, op.z, op.height, op.flags);
        break;
      case "addSeg":
        unaddSegment(net, op.id, op.grown, op.fresh);
        break;
      case "removeSeg":
        restoreSegment(net, op.id, op.row, op.atA, op.atB);
        break;
      case "restyle":
        restyleSegment(net, op.id, op.from, op.reverse);
        break;
    }
  }
}

/** The segments touching `node`, newest first. */
export function segmentsAt(net: RoadNetwork, node: number): number[] {
  if (!isNode(net, node)) throw new RangeError(`node ${node} does not exist`);
  const out: number[] = [];
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) out.push(seg);
  return out;
}

/** The node at the other end of `seg` from `node`. */
export function otherEnd(net: RoadNetwork, seg: number, node: number): number {
  return (net.segA[seg] === node ? net.segB[seg] : net.segA[seg]) ?? NONE;
}

const ARRAY_TYPES: Readonly<Record<Exclude<keyof RoadNetwork, "segOrderNext">, new (n: number) => AnyTypedArray>> = {
  nodeX: Float64Array,
  nodeZ: Float64Array,
  nodeHeight: Float64Array,
  nodeFlags: Uint8Array,
  nodeFirstSeg: Int32Array,
  nodeFree: Int32Array,
  segA: Int32Array,
  segB: Int32Array,
  segNextA: Int32Array,
  segNextB: Int32Array,
  segType: Uint8Array,
  segNetwork: Uint8Array,
  segLevelA: Uint8Array,
  segLevelB: Uint8Array,
  segFlags: Uint8Array,
  segCX: Float64Array,
  segCZ: Float64Array,
  segLength: Float64Array,
  segOrder: Float64Array,
  segFree: Int32Array,
};

/** Ids an undo record holds: removed, on no free list, waiting to come back. */
export interface HeldIds {
  nodes: readonly number[];
  segs: readonly number[];
}

/**
 * Why `value` is not a well-formed network, or null if it is. For loading a
 * save: a network that passes cannot make the graph functions throw or loop.
 * `held` lists the ids undo records hold, which are neither live nor free.
 */
export function checkRoadNetwork(value: unknown, held: HeldIds = { nodes: [], segs: [] }): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not an object";
  const net = value as Record<string, unknown>;
  for (const [key, Type] of Object.entries(ARRAY_TYPES)) {
    if (!(net[key] instanceof Type)) return `${key} is not a ${Type.name}`;
  }
  const extra = Object.keys(net).find((key) => !(key in ARRAY_TYPES) && key !== "segOrderNext");
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  const orderNext = net["segOrderNext"];
  if (!Number.isSafeInteger(orderNext) || (orderNext as number) < 0) return "segOrderNext is not a whole number";
  const n = net as unknown as RoadNetwork;
  const nodes = n.nodeFlags.length;
  const segs = n.segFlags.length;
  if (NODE_ARRAYS.some((key) => n[key].length !== nodes)) return "its node arrays differ in length";
  if (SEG_ARRAYS.some((key) => n[key].length !== segs)) return "its segment arrays differ in length";

  const checkFree = (free: Int32Array, kept: readonly number[], limit: number, alive: (id: number) => boolean): string | null => {
    const seen = new Uint8Array(limit);
    for (const id of free) {
      if (id < 0 || id >= limit || seen[id] || alive(id)) return "its free list is malformed";
      seen[id] = 1;
    }
    for (const id of kept) {
      if (!Number.isInteger(id) || id < 0 || id >= limit || seen[id] || alive(id)) return `held id ${id} is live, free or held twice`;
      seen[id] = 1;
    }
    for (let id = 0; id < limit; id++) if (!seen[id] && !alive(id)) return `id ${id} is neither live, free nor held`;
    return null;
  };
  const freeProblem =
    checkFree(n.nodeFree, held.nodes, nodes, (id) => isNode(n, id)) ??
    checkFree(n.segFree, held.segs, segs, (id) => isSegment(n, id));
  if (freeProblem) return freeProblem;

  // Each live segment must be in both of its nodes' lists exactly once, and
  // the lists must hold nothing else. Walking with a step budget means a
  // cycle cannot hang the check.
  const inList = new Uint8Array(segs);
  for (let node = 0; node < nodes; node++) {
    if (!isNode(n, node)) continue;
    let steps = 0;
    for (let seg = n.nodeFirstSeg[node] ?? NONE; seg !== NONE; ) {
      if (!isSegment(n, seg) || (n.segA[seg] !== node && n.segB[seg] !== node)) return `node ${node}'s list is malformed`;
      if (++steps > segs * 2) return `node ${node}'s list has a cycle`;
      inList[seg] = (inList[seg] ?? 0) + 1;
      seg = nextSegmentAt(n, seg, node);
    }
  }
  for (let seg = 0; seg < segs; seg++) {
    if (!isSegment(n, seg)) continue;
    const a = n.segA[seg] ?? NONE;
    const b = n.segB[seg] ?? NONE;
    if (!isNode(n, a) || !isNode(n, b) || a === b) return `segment ${seg} has bad nodes`;
    if (inList[seg] !== 2) return `segment ${seg} is not in its nodes' lists`;
    const levelA = n.segLevelA[seg] ?? 0;
    const levelB = n.segLevelB[seg] ?? 0;
    if ((n.segNetwork[seg] ?? 0) >= NETWORK_COUNT || levelA >= LEVEL_COUNT || levelB >= LEVEL_COUNT) {
      return `segment ${seg} has a bad network or level`;
    }
    if ((levelA === LEVEL_BRIDGE) !== (levelB === LEVEL_BRIDGE)) return `segment ${seg} is a bridge at one end only`;
    if (n.segNetwork[seg] === NETWORK_ROAD && (n.segType[seg] ?? 0) >= ROAD_TYPES.length) {
      return `segment ${seg} has an unknown road type`;
    }
    const order = n.segOrder[seg] ?? 0;
    if (!Number.isSafeInteger(order) || order < 0 || order >= n.segOrderNext) return `segment ${seg} has a bad build order`;
  }
  return null;
}
