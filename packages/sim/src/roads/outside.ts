// Which pieces of the road network reach an outside connection (M3-06).
//
// A piece is a set of road nodes joined by road segments, rail and paths
// left out, in either direction: a one-way joins its two ends like any
// other road. A piece reaches outside when it holds the edge node of an
// outside connection. The answer is kept per node, so a segment, and from
// M3-08 a home on it, reads its piece through either end.
//
// Derived data, never saved or hashed: built from the roads on first use,
// cached by network object, and worked out again after a change of roads.
// Any segment added or removed marks it stale. The step brings a stale one
// up to date once, after the commands (derived.ts, `catchUpDerived`), so the
// systems that read it never pay for the rebuild. A rebuild is one pass of
// union and find over the segments, linear in the size of the network.
//
// `pieceSegment` uses the routing graph's notion of what joins two nodes, a
// live road segment. `nearestOutside` in connections.ts answers the harder
// question of the quickest route and which connection it ends at, with one
// search per connection; this answers only whether there is one, for every
// node at once.

import {
  NETWORK_ROAD,
  NODE_ALIVE,
  SEG_ALIVE,
  SEG_FIXED,
  isNode,
  isSegment,
  nodeIdLimit,
  observeNetwork,
  segmentIdLimit,
  type RoadNetwork,
} from "./network";

/** The answer for one network. Derived data: not state. */
interface OutsideIndex {
  readonly net: RoadNetwork;
  connections: Int32Array;
  /** Set by any change of segments; cleared by a rebuild. */
  stale: boolean;
  /** By node: 1 if its piece reaches outside. 0 for a node with no road, or a removed one. */
  reaches: Uint8Array;
  /** By node: its piece, named by the lowest node id in it. NO_PIECE for a removed node. */
  pieces: Int32Array;
  /** Road segments that are not a connection's fixed stub, on pieces that reach outside. */
  outsideSegments: number;
  // Scratch for the union and find, grown as needed.
  parent: Int32Array;
}

const live = new WeakMap<RoadNetwork, OutsideIndex>();

/** `roadPieceByNode` for a removed node. */
export const NO_PIECE = -1;

function find(parent: Int32Array, node: number): number {
  let root = node;
  while (parent[root] !== root) root = parent[root] as number;
  // Point every node on the way straight at the root.
  while (parent[node] !== root) {
    const next = parent[node] as number;
    parent[node] = root;
    node = next;
  }
  return root;
}

/** Whether segment `seg` joins its two nodes into one piece: a live road. */
function pieceSegment(net: RoadNetwork, seg: number): boolean {
  return isSegment(net, seg) && net.segNetwork[seg] === NETWORK_ROAD;
}

function rebuild(index: OutsideIndex): void {
  const { net, connections } = index;
  const nodes = nodeIdLimit(net);
  const segs = segmentIdLimit(net);
  if (index.parent.length < nodes) index.parent = new Int32Array(Math.max(16, nodes * 2));
  if (index.reaches.length !== nodes) index.reaches = new Uint8Array(nodes);
  if (index.pieces.length !== nodes) index.pieces = new Int32Array(nodes);
  const parent = index.parent;
  const { segA, segB, segFlags, segNetwork, nodeFlags } = net;
  // Imported constants as locals: under the test runner each import is a
  // property read on a module object, which in these loops costs more than
  // the work.
  const road = NETWORK_ROAD;
  const aliveSeg = SEG_ALIVE;
  const fixedSeg = SEG_FIXED;
  const aliveNode = NODE_ALIVE;
  for (let n = 0; n < nodes; n++) parent[n] = n;
  for (let s = 0; s < segs; s++) {
    if (((segFlags[s] as number) & aliveSeg) === 0 || segNetwork[s] !== road) continue;
    const a = find(parent, segA[s] as number);
    const b = find(parent, segB[s] as number);
    // The lower root wins, so the result does not depend on segment order.
    if (a < b) parent[b] = a;
    else if (b < a) parent[a] = b;
  }
  // A root's mark, kept at the root's own entry until every node is read.
  const reaches = index.reaches;
  reaches.fill(0);
  for (const edge of connections) if (isNode(net, edge)) reaches[find(parent, edge)] = 1;
  // A root is the lowest id in its piece, so walking up the ids reaches it
  // before any other member, and its own entry, the piece's mark, is never
  // written over before the members read it.
  const pieces = index.pieces;
  for (let n = 0; n < nodes; n++) {
    const dead = ((nodeFlags[n] as number) & aliveNode) === 0;
    const root = find(parent, n);
    pieces[n] = dead ? NO_PIECE : root;
    reaches[n] = dead ? 0 : (reaches[root] as number);
  }
  let outside = 0;
  for (let s = 0; s < segs; s++) {
    const flags = segFlags[s] as number;
    if ((flags & aliveSeg) === 0 || (flags & fixedSeg) !== 0 || segNetwork[s] !== road) continue;
    outside += reaches[segA[s] as number] as number;
  }
  index.outsideSegments = outside;
  index.stale = false;
}

function indexOf(net: RoadNetwork, connections: Int32Array): OutsideIndex {
  let index = live.get(net);
  if (!index) {
    const made: OutsideIndex = { net, connections, stale: true, reaches: new Uint8Array(0), pieces: new Int32Array(0), outsideSegments: 0, parent: new Int32Array(0) };
    const mark = () => void (made.stale = true);
    observeNetwork(net, { nodeAdded: mark, nodeRemoving: mark, segmentAdded: mark, segmentRemoving: mark });
    live.set(net, made);
    index = made;
  }
  // A city's connections never change in play, but a test or a load may
  // put a new list on the state the answer was built for.
  if (index.connections !== connections) {
    index.connections = connections;
    index.stale = true;
  }
  if (index.stale) rebuild(index);
  return index;
}

/**
 * Marks the answer for `net` stale, for a change made past the network's
 * observers: `applyRoadDelta` copies a client's rows in place.
 */
export function markOutsideStale(net: RoadNetwork): void {
  const index = live.get(net);
  if (index) index.stale = true;
}

/** Builds the answer for `state`'s roads if it is not built, or brings it up to date. */
export function prepareOutside(state: { roads: RoadNetwork; connections: Int32Array }): void {
  indexOf(state.roads, state.connections);
}

/**
 * Brings an answer already built up to date with the roads, once a step
 * after the commands. A city that has never asked builds it on first use.
 */
export function catchUpOutside(net: RoadNetwork): void {
  const index = live.get(net);
  if (index?.stale) rebuild(index);
}

/** Whether road node `node` is on a piece of road that reaches an outside connection. False for a node that does not exist. */
export function nodeReachesOutside(state: { roads: RoadNetwork; connections: Int32Array }, node: number): boolean {
  const index = indexOf(state.roads, state.connections);
  return Number.isInteger(node) && node >= 0 && index.reaches[node] === 1;
}

/** Whether segment `seg` is a road on a piece that reaches an outside connection. False for a rail, a path or a segment that does not exist. */
export function segmentReachesOutside(state: { roads: RoadNetwork; connections: Int32Array }, seg: number): boolean {
  if (!pieceSegment(state.roads, seg)) return false;
  return nodeReachesOutside(state, state.roads.segA[seg] ?? -1);
}

/**
 * How many road segments the player built reach an outside connection: the
 * segments on pieces that reach one, less the connections' fixed stubs. 0
 * means nothing the city has built has a route out. The industrial bar
 * reads it (demand/demand.ts).
 */
export function segmentsReachingOutside(state: { roads: RoadNetwork; connections: Int32Array }): number {
  return indexOf(state.roads, state.connections).outsideSegments;
}

/**
 * By road node: 1 if its piece reaches an outside connection. For a loop
 * over many segments, such as the homes newcomers can reach (M3-08), which
 * would otherwise look the answer up once a segment. Read it at once: a
 * change of roads may replace it.
 */
export function outsideReachByNode(state: { roads: RoadNetwork; connections: Int32Array }): Uint8Array {
  return indexOf(state.roads, state.connections).reaches;
}

/**
 * By road node: its piece of road, named by the lowest node id in it, or
 * NO_PIECE for a removed node. Two nodes on the same piece have a route
 * between them by road. Displaced pops read it to keep a job they can
 * still reach (M3-12). Read it at once: a change of roads may replace it.
 */
export function roadPieceByNode(state: { roads: RoadNetwork; connections: Int32Array }): Int32Array {
  return indexOf(state.roads, state.connections).pieces;
}
