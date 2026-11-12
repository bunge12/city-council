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
// Only exact arithmetic here (rule 6): two machines must agree on lengths.

import { ROAD_TYPES } from "./balance";

/** Ground, bridge, tunnel or elevated. M1 writes only ground and bridge. */
export const LEVEL_GROUND = 0;
export const LEVEL_BRIDGE = 1;
export const LEVEL_TUNNEL = 2;
export const LEVEL_ELEVATED = 3;
const LEVEL_COUNT = 4;

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
  /** LEVEL_GROUND and the rest. */
  segLevel: Uint8Array;
  /** SEG_ALIVE. */
  segFlags: Uint8Array;
  /**
   * The quadratic curve's control point. A straight segment has it exactly
   * at the midpoint of its nodes.
   */
  segCX: Float64Array;
  segCZ: Float64Array;
  /** Length in plan, metres. */
  segLength: Float64Array;
  /** Removed segment ids, the next one to reuse last. */
  segFree: Int32Array;
}

type AnyTypedArray = Float64Array | Int32Array | Uint8Array;

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
    segLevel: new Uint8Array(0),
    segFlags: new Uint8Array(0),
    segCX: new Float64Array(0),
    segCZ: new Float64Array(0),
    segLength: new Float64Array(0),
    segFree: new Int32Array(0),
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
function resized<T extends AnyTypedArray>(array: T, length: number): T {
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

/** Live nodes. */
export function nodeCount(net: RoadNetwork): number {
  return net.nodeFlags.length - net.nodeFree.length;
}

/** Live segments. */
export function segmentCount(net: RoadNetwork): number {
  return net.segFlags.length - net.segFree.length;
}

const NODE_ARRAYS = ["nodeX", "nodeZ", "nodeHeight", "nodeFlags", "nodeFirstSeg"] as const;
const SEG_ARRAYS = [
  "segA",
  "segB",
  "segNextA",
  "segNextB",
  "segType",
  "segNetwork",
  "segLevel",
  "segFlags",
  "segCX",
  "segCZ",
  "segLength",
] as const;

/** Takes an id off the free list, or grows every array by one. */
function allocate(net: RoadNetwork, freeKey: "nodeFree" | "segFree", keys: readonly (keyof RoadNetwork)[]): number {
  const free = net[freeKey];
  if (free.length > 0) {
    const id = free[free.length - 1] ?? 0;
    net[freeKey] = resized(free, free.length - 1);
    return id;
  }
  const id = (net[keys[0] as keyof RoadNetwork] as AnyTypedArray).length;
  for (const key of keys) {
    (net as unknown as Record<string, AnyTypedArray>)[key] = resized(net[key] as AnyTypedArray, id + 1);
  }
  return id;
}

function release(net: RoadNetwork, freeKey: "nodeFree" | "segFree", keys: readonly (keyof RoadNetwork)[], id: number): void {
  for (const key of keys) (net[key] as AnyTypedArray)[id] = 0;
  const free = resized(net[freeKey], net[freeKey].length + 1);
  free[free.length - 1] = id;
  net[freeKey] = free;
}

function checkFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`);
}

/** Adds a node and returns its id. */
export function addNode(net: RoadNetwork, x: number, z: number, height: number, fixed = false): number {
  checkFinite("x", x);
  checkFinite("z", z);
  checkFinite("height", height);
  const id = allocate(net, "nodeFree", NODE_ARRAYS);
  net.nodeX[id] = x;
  net.nodeZ[id] = z;
  net.nodeHeight[id] = height;
  net.nodeFlags[id] = NODE_ALIVE | (fixed ? NODE_FIXED : 0);
  net.nodeFirstSeg[id] = NONE;
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
  release(net, "nodeFree", NODE_ARRAYS, id);
}

/** What a new segment is, besides its two nodes. */
export interface SegmentSpec {
  /** Index into ROAD_TYPES. */
  type: number;
  network?: number;
  level?: number;
  /** Control point. Leave out both for a straight segment. */
  cx?: number;
  cz?: number;
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
  if (!Number.isInteger(spec.type) || spec.type < 0 || spec.type > 255) throw new RangeError(`bad segment type ${spec.type}`);
  if (!Number.isInteger(network) || network < 0 || network >= NETWORK_COUNT) throw new RangeError(`bad network ${network}`);
  if (!Number.isInteger(level) || level < 0 || level >= LEVEL_COUNT) throw new RangeError(`bad level ${level}`);
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

  const id = allocate(net, "segFree", SEG_ARRAYS);
  net.segA[id] = a;
  net.segB[id] = b;
  net.segType[id] = spec.type;
  net.segNetwork[id] = network;
  net.segLevel[id] = level;
  net.segFlags[id] = SEG_ALIVE;
  net.segCX[id] = cx;
  net.segCZ[id] = cz;
  net.segLength[id] = curveLength(ax, az, cx, cz, bx, bz);
  // Newest first in each node's list.
  net.segNextA[id] = net.nodeFirstSeg[a] ?? NONE;
  net.nodeFirstSeg[a] = id;
  net.segNextB[id] = net.nodeFirstSeg[b] ?? NONE;
  net.nodeFirstSeg[b] = id;
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

function unlink(net: RoadNetwork, seg: number, node: number): void {
  let prev = NONE;
  let at = net.nodeFirstSeg[node] ?? NONE;
  while (at !== NONE && at !== seg) {
    prev = at;
    at = nextSegmentAt(net, at, node);
  }
  if (at === NONE) throw new Error(`segment ${seg} is missing from node ${node}'s list`);
  const next = nextSegmentAt(net, seg, node);
  if (prev === NONE) net.nodeFirstSeg[node] = next;
  else setNextAt(net, prev, node, next);
}

/** Removes a segment. Its nodes stay. */
export function removeSegment(net: RoadNetwork, id: number): void {
  if (!isSegment(net, id)) throw new RangeError(`segment ${id} does not exist`);
  unlink(net, id, net.segA[id] ?? NONE);
  unlink(net, id, net.segB[id] ?? NONE);
  release(net, "segFree", SEG_ARRAYS, id);
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

const ARRAY_TYPES: Readonly<Record<keyof RoadNetwork, new (n: number) => AnyTypedArray>> = {
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
  segLevel: Uint8Array,
  segFlags: Uint8Array,
  segCX: Float64Array,
  segCZ: Float64Array,
  segLength: Float64Array,
  segFree: Int32Array,
};

/**
 * Why `value` is not a well-formed network, or null if it is. For loading a
 * save: a network that passes cannot make the graph functions throw or loop.
 */
export function checkRoadNetwork(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not an object";
  const net = value as Record<string, unknown>;
  for (const [key, Type] of Object.entries(ARRAY_TYPES)) {
    if (!(net[key] instanceof Type)) return `${key} is not a ${Type.name}`;
  }
  const extra = Object.keys(net).find((key) => !(key in ARRAY_TYPES));
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  const n = net as unknown as RoadNetwork;
  const nodes = n.nodeFlags.length;
  const segs = n.segFlags.length;
  if (NODE_ARRAYS.some((key) => n[key].length !== nodes)) return "its node arrays differ in length";
  if (SEG_ARRAYS.some((key) => n[key].length !== segs)) return "its segment arrays differ in length";

  const checkFree = (free: Int32Array, limit: number, alive: (id: number) => boolean): string | null => {
    const seen = new Uint8Array(limit);
    for (const id of free) {
      if (id < 0 || id >= limit || seen[id] || alive(id)) return "its free list is malformed";
      seen[id] = 1;
    }
    for (let id = 0; id < limit; id++) if (!seen[id] && !alive(id)) return `id ${id} is neither live nor free`;
    return null;
  };
  const freeProblem =
    checkFree(n.nodeFree, nodes, (id) => isNode(n, id)) ?? checkFree(n.segFree, segs, (id) => isSegment(n, id));
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
    if ((n.segNetwork[seg] ?? 0) >= NETWORK_COUNT || (n.segLevel[seg] ?? 0) >= LEVEL_COUNT) {
      return `segment ${seg} has a bad network or level`;
    }
    if (n.segNetwork[seg] === NETWORK_ROAD && (n.segType[seg] ?? 0) >= ROAD_TYPES.length) {
      return `segment ${seg} has an unknown road type`;
    }
  }
  return null;
}
