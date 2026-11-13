// The routing graph and the pathfinder: how to get from here to there on
// the network.
//
// The graph has one directed edge per direction per segment. Edge `2 * seg`
// runs from the segment's node A to node B and edge `2 * seg + 1` from B to
// A. A one-way runs from A to B (network.ts), so its B to A edge is missing.
// Each edge holds its travel time in seconds, or NO_EDGE. The time comes
// from an edge cost function kept apart from the search: M1 prices an edge
// at free-flow time, its length over its type's speed, and M5 swaps in
// congested time without touching the search.
//
// The graph is derived data (PRD, "Derived data"), cached by network object
// like the spatial index. It is built from the arrays on first use, kept
// current through the observer hooks in network.ts and by `applyRoadDelta`
// on a client's copy, and holds only per-edge numbers that depend on the
// segment alone, so a graph kept current equals one built from scratch.
// Which edges leave a node is read from the network's own lists.
//
// The search is Dijkstra over a binary heap. Every tie breaks by id: the heap
// pops the lower node id of two at the same time, and of two ways into a node
// at the same time the one over the lower segment id wins. So the route never
// depends on the order segments were built in, the order of a node's list, or
// the machine.
//
// Routes feed later sim modules (M3 commutes), so only exact arithmetic
// (CLAUDE.md rule 6).

import routingBalance from "../../balance/routing.json" with { type: "json" };
import { ROAD_TYPES } from "./balance";
import { quadPoint, segmentQuad, subControl } from "./curve";
import {
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  NONE,
  curveLength,
  isNode,
  isSegment,
  nextSegmentAt,
  nodeIdLimit,
  observeNetwork,
  segmentIdLimit,
  type RoadNetwork,
} from "./network";
import { NETWORKS_ALL, NETWORKS_ROAD, nearestPointOnSegment, roadIndexOf } from "./spatial";

/** An edge that does not exist: a dead segment, or the wrong way along a one-way. */
export const NO_EDGE = -1;

/**
 * Seconds to travel the whole of segment `seg`, forward from node A to node
 * B or back from B to A. Only called for a live segment and a direction it
 * allows. Must be positive and depend only on the segment's own fields.
 */
export type EdgeCost = (net: RoadNetwork, seg: number, forward: boolean) => number;

/** Speeds for the networks that have no types yet, from `balance/routing.json`. */
export interface RoutingBalance {
  networkSpeedKmh: Record<"rail" | "path", { speedKmh: number; source: string; placeholder?: boolean }>;
}

/** Every problem with a routing balance file, or none. */
export function checkRoutingBalance(data: unknown): string[] {
  const errors: string[] = [];
  const speeds = (data as { networkSpeedKmh?: unknown } | null)?.networkSpeedKmh;
  if (typeof speeds !== "object" || speeds === null) return ["networkSpeedKmh is missing"];
  for (const network of ["rail", "path"]) {
    const entry = (speeds as Record<string, unknown>)[network] as Record<string, unknown> | undefined;
    const speed = entry?.["speedKmh"];
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
      errors.push(`networkSpeedKmh.${network}.speedKmh must be a positive number`);
    }
    if (typeof entry?.["source"] !== "string" || entry["source"] === "") errors.push(`networkSpeedKmh.${network}.source is missing`);
  }
  return errors;
}

const routingProblems = checkRoutingBalance(routingBalance);
if (routingProblems.length > 0) throw new TypeError(`balance/routing.json: ${routingProblems.join("; ")}`);

/** The routing balance file as written. */
export const ROUTING_BALANCE: RoutingBalance = routingBalance;

/** Metres per second in a km/h. Seconds are metres times 3.6 over km/h. */
const KMH_TO_MS = 3.6;

/** Free-flow speed of segment `seg` in km/h: its road type's, or its network's. */
export function freeFlowSpeedKmh(net: RoadNetwork, seg: number): number {
  const network = net.segNetwork[seg] ?? NETWORK_ROAD;
  if (network === NETWORK_RAIL) return ROUTING_BALANCE.networkSpeedKmh.rail.speedKmh;
  if (network === NETWORK_PATH) return ROUTING_BALANCE.networkSpeedKmh.path.speedKmh;
  const type = ROAD_TYPES[net.segType[seg] ?? 0];
  if (!type) throw new RangeError(`segment ${seg} has unknown road type ${net.segType[seg]}`);
  return type.speedKmh;
}

/** The M1 edge cost: free-flow time, the segment's length over its speed. The same both ways. */
export const freeFlowTime: EdgeCost = (net, seg) => ((net.segLength[seg] ?? 0) * KMH_TO_MS) / freeFlowSpeedKmh(net, seg);

/** Whether segment `seg` can be travelled from B back to A. A one-way cannot. */
function allowsBackward(net: RoadNetwork, seg: number): boolean {
  if (net.segNetwork[seg] !== NETWORK_ROAD) return true;
  return !(ROAD_TYPES[net.segType[seg] ?? 0]?.oneWay ?? false);
}

/** The routing graph of one network. Derived data: not state. */
export interface RoutingGraph {
  readonly net: RoadNetwork;
  readonly cost: EdgeCost;
  /**
   * Seconds along each edge, or NO_EDGE. Edge `2 * seg` is A to B, `2 * seg + 1`
   * is B to A. Entries past twice the segment id limit are NO_EDGE.
   */
  edgeTime: Float64Array;
  // Scratch for the search, grown as needed. Not part of the graph's answer.
  scratch: SearchScratch;
}

interface SearchScratch {
  /** Best time to each node found by the search stamped `stamp[node]`. */
  time: Float64Array;
  /** The segment that best time arrived over, or NONE for a start. */
  via: Int32Array;
  /** The search a node's entries belong to. Older ones read as unvisited. */
  stamp: Uint32Array;
  done: Uint8Array;
  search: number;
  heapTime: Float64Array;
  heapNode: Int32Array;
}

function newScratch(): SearchScratch {
  return {
    time: new Float64Array(0),
    via: new Int32Array(0),
    stamp: new Uint32Array(0),
    done: new Uint8Array(0),
    search: 0,
    heapTime: new Float64Array(16),
    heapNode: new Int32Array(16),
  };
}

function ensureEdges(graph: RoutingGraph, seg: number): void {
  const need = 2 * (seg + 1);
  if (graph.edgeTime.length >= need) return;
  let size = Math.max(16, graph.edgeTime.length);
  while (size < need) size *= 2;
  const grown = new Float64Array(size).fill(NO_EDGE);
  grown.set(graph.edgeTime);
  graph.edgeTime = grown;
}

/** Works out both edges of segment `seg` from its fields as they are now. */
export function refreshRoutingSegment(graph: RoutingGraph, seg: number): void {
  const { net } = graph;
  ensureEdges(graph, seg);
  if (!isSegment(net, seg)) {
    graph.edgeTime[2 * seg] = NO_EDGE;
    graph.edgeTime[2 * seg + 1] = NO_EDGE;
    return;
  }
  graph.edgeTime[2 * seg] = graph.cost(net, seg, true);
  graph.edgeTime[2 * seg + 1] = allowsBackward(net, seg) ? graph.cost(net, seg, false) : NO_EDGE;
}

/** Marks both edges of segment `seg` missing. */
function dropRoutingSegment(graph: RoutingGraph, seg: number): void {
  if (2 * seg + 1 >= graph.edgeTime.length) return;
  graph.edgeTime[2 * seg] = NO_EDGE;
  graph.edgeTime[2 * seg + 1] = NO_EDGE;
}

/**
 * A new routing graph over `net` as it is now, priced with `cost`. It does
 * not follow later changes; for that, use `routingGraphOf`.
 */
export function buildRoutingGraph(net: RoadNetwork, cost: EdgeCost = freeFlowTime): RoutingGraph {
  const limit = segmentIdLimit(net);
  const graph: RoutingGraph = { net, cost, edgeTime: new Float64Array(Math.max(16, 2 * limit)).fill(NO_EDGE), scratch: newScratch() };
  for (let seg = 0; seg < limit; seg++) if (isSegment(net, seg)) refreshRoutingSegment(graph, seg);
  return graph;
}

// Live graphs by network object, as with the spatial index.
const live = new WeakMap<RoadNetwork, RoutingGraph>();

/**
 * The free-flow routing graph of `net`, kept current through every change
 * made with the functions in network.ts. Built on first use.
 */
export function routingGraphOf(net: RoadNetwork): RoutingGraph {
  let graph = live.get(net);
  if (!graph) {
    const built = buildRoutingGraph(net);
    observeNetwork(net, {
      nodeAdded: () => undefined,
      nodeRemoving: () => undefined,
      segmentAdded: (id) => refreshRoutingSegment(built, id),
      segmentRemoving: (id) => dropRoutingSegment(built, id),
    });
    live.set(net, built);
    graph = built;
  }
  return graph;
}

/** The routing graph of `net` if one has been built, or null. For `applyRoadDelta`. */
export function existingRoutingGraph(net: RoadNetwork): RoutingGraph | null {
  return live.get(net) ?? null;
}

/**
 * Whether two graphs over the same network give every edge the same time.
 * Spare room past twice the segment id limit is ignored.
 */
export function sameRoutingGraph(p: RoutingGraph, q: RoutingGraph): boolean {
  const limit = 2 * Math.max(segmentIdLimit(p.net), segmentIdLimit(q.net));
  for (let e = 0; e < Math.max(p.edgeTime.length, q.edgeTime.length, limit); e++) {
    const a = p.edgeTime[e] ?? NO_EDGE;
    const b = q.edgeTime[e] ?? NO_EDGE;
    if (!(a === b)) return false;
  }
  return true;
}

// ---- The search ----

/** A route along the network. */
export interface Route {
  /** Segments in the order travelled. */
  segments: number[];
  /** For each segment, whether it is travelled from its node A to node B. */
  forward: boolean[];
  /**
   * Nodes passed, in order. A route between nodes starts and ends with them,
   * so it has one more node than segments. A route between points has only
   * the nodes between its first and last segment.
   */
  nodes: number[];
  /** Plan length in metres. */
  distance: number;
  /** Travel time in seconds. */
  time: number;
}

/** Where a route between points meets the network. */
export interface RouteEnd {
  segment: number;
  /** Curve parameter from the segment's node A to node B, 0 to 1. */
  t: number;
  x: number;
  z: number;
  /** How far the point given was from the network, in metres. */
  offset: number;
}

/** A route between two points, with where each end joins the network. */
export interface PointRoute extends Route {
  start: RouteEnd;
  end: RouteEnd;
}

export type RouteResult<R extends Route = Route> = { ok: true; route: R } | { ok: false; reason: string };

/** The reason given when the network does not join the two ends. */
export const NO_ROUTE = "no route";

function checkNetworks(networks: number): void {
  if (!Number.isInteger(networks) || networks < 0 || networks > NETWORKS_ALL) throw new RangeError(`bad network filter ${networks}`);
}

function onNetworks(net: RoadNetwork, seg: number, networks: number): boolean {
  return ((1 << (net.segNetwork[seg] ?? 0)) & networks) !== 0;
}

/** Whether (t1, n1) comes before (t2, n2): earlier time, then lower node id. */
function before(t1: number, n1: number, t2: number, n2: number): boolean {
  return t1 < t2 || (t1 === t2 && n1 < n2);
}

class Search {
  private size = 0;
  constructor(
    private readonly graph: RoutingGraph,
    private readonly s: SearchScratch,
  ) {
    const nodes = nodeIdLimit(graph.net);
    if (s.time.length < nodes) {
      const cap = Math.max(16, nodes * 2);
      s.time = new Float64Array(cap);
      s.via = new Int32Array(cap);
      s.stamp = new Uint32Array(cap);
      s.done = new Uint8Array(cap);
    }
    s.search = (s.search + 1) >>> 0;
    if (s.search === 0) {
      // Wrapped: clear the stamps so no old search reads as this one.
      s.stamp.fill(0);
      s.search = 1;
    }
  }

  private seen(node: number): boolean {
    return this.s.stamp[node] === this.s.search;
  }

  timeTo(node: number): number {
    return this.seen(node) ? (this.s.time[node] ?? Infinity) : Infinity;
  }

  viaOf(node: number): number {
    return this.s.via[node] ?? NONE;
  }

  /** Offers `node` reached at `time` over segment `via` (NONE for a start). Keeps the earlier, then the lower segment id. */
  offer(node: number, time: number, via: number): void {
    const s = this.s;
    if (this.seen(node)) {
      if (s.done[node]) return;
      const old = s.time[node] ?? Infinity;
      if (time > old || (time === old && via >= (s.via[node] ?? NONE))) return;
      s.via[node] = via;
      if (time === old) return;
      s.time[node] = time;
    } else {
      s.stamp[node] = s.search;
      s.done[node] = 0;
      s.time[node] = time;
      s.via[node] = via;
    }
    this.push(time, node);
  }

  private push(time: number, node: number): void {
    const s = this.s;
    if (this.size === s.heapTime.length) {
      const t = new Float64Array(this.size * 2);
      t.set(s.heapTime);
      const n = new Int32Array(this.size * 2);
      n.set(s.heapNode);
      s.heapTime = t;
      s.heapNode = n;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pt = s.heapTime[parent] ?? 0;
      const pn = s.heapNode[parent] ?? 0;
      if (!before(time, node, pt, pn)) break;
      s.heapTime[i] = pt;
      s.heapNode[i] = pn;
      i = parent;
    }
    s.heapTime[i] = time;
    s.heapNode[i] = node;
  }

  /** The next node to settle, or NONE when there is none. Stale heap entries are skipped. */
  pop(): number {
    const s = this.s;
    while (this.size > 0) {
      const time = s.heapTime[0] ?? 0;
      const node = s.heapNode[0] ?? 0;
      const lastTime = s.heapTime[--this.size] ?? 0;
      const lastNode = s.heapNode[this.size] ?? 0;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this.size) break;
        const r = l + 1;
        let c = l;
        if (r < this.size && before(s.heapTime[r] ?? 0, s.heapNode[r] ?? 0, s.heapTime[l] ?? 0, s.heapNode[l] ?? 0)) c = r;
        if (!before(s.heapTime[c] ?? 0, s.heapNode[c] ?? 0, lastTime, lastNode)) break;
        s.heapTime[i] = s.heapTime[c] ?? 0;
        s.heapNode[i] = s.heapNode[c] ?? 0;
        i = c;
      }
      s.heapTime[i] = lastTime;
      s.heapNode[i] = lastNode;
      if (s.done[node] || time !== s.time[node]) continue;
      s.done[node] = 1;
      return node;
    }
    return NONE;
  }

  /** Offers every node one edge on from settled node `node`. */
  relax(node: number, networks: number): void {
    const { net, edgeTime } = this.graph;
    const base = this.s.time[node] ?? 0;
    for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
      if (!onNetworks(net, seg, networks)) continue;
      const forward = net.segA[seg] === node;
      const cost = edgeTime[forward ? 2 * seg : 2 * seg + 1] ?? NO_EDGE;
      if (cost === NO_EDGE) continue;
      this.offer((forward ? net.segB[seg] : net.segA[seg]) ?? NONE, base + cost, seg);
    }
  }

  /** The segments and nodes back from `node` to a start, in travel order. */
  trace(node: number): { segments: number[]; forward: boolean[]; nodes: number[] } {
    const { net } = this.graph;
    const segments: number[] = [];
    const forward: boolean[] = [];
    const nodes: number[] = [node];
    for (let at = node, seg = this.viaOf(at); seg !== NONE; seg = this.viaOf(at)) {
      const fwd = net.segB[seg] === at;
      at = (fwd ? net.segA[seg] : net.segB[seg]) ?? NONE;
      segments.push(seg);
      forward.push(fwd);
      nodes.push(at);
    }
    segments.reverse();
    forward.reverse();
    nodes.reverse();
    return { segments, forward, nodes };
  }
}

function distanceOf(net: RoadNetwork, segments: readonly number[]): number {
  let d = 0;
  for (const seg of segments) d += net.segLength[seg] ?? 0;
  return d;
}

/**
 * The quickest route from node `from` to node `to` over segments on a
 * network in the filter, or "no route". Of routes with the same time, the
 * one the id tie-breaks pick. A node to itself is a route of no segments.
 */
export function findRoute(graph: RoutingGraph, from: number, to: number, networks: number = NETWORKS_ROAD): RouteResult {
  const { net } = graph;
  checkNetworks(networks);
  if (!isNode(net, from)) throw new RangeError(`node ${from} does not exist`);
  if (!isNode(net, to)) throw new RangeError(`node ${to} does not exist`);
  const search = new Search(graph, graph.scratch);
  search.offer(from, 0, NONE);
  for (let node = search.pop(); node !== NONE; node = search.pop()) {
    if (node === to) {
      const path = search.trace(to);
      return { ok: true, route: { ...path, distance: distanceOf(net, path.segments), time: search.timeTo(to) } };
    }
    search.relax(node, networks);
  }
  return { ok: false, reason: NO_ROUTE };
}

/** Plan length of segment `seg` from node A to parameter `t`. */
function lengthTo(net: RoadNetwork, seg: number, t: number): number {
  if (t <= 0) return 0;
  const full = net.segLength[seg] ?? 0;
  if (t >= 1) return full;
  const q = segmentQuad(net, seg);
  if (q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2) return full * t;
  const c = subControl(q, 0, t);
  const p = quadPoint(q, t);
  const part = curveLength(q.ax, q.az, c.x, c.z, p.x, p.z);
  // Both lengths come from polylines, so keep the part within the whole.
  return part > full ? full : part;
}

/** A point's place on the network, as a length along its segment from node A. */
interface Attach extends RouteEnd {
  /** Metres from node A to the point along the segment. */
  along: number;
}

function attach(graph: RoutingGraph, x: number, z: number, radius: number, networks: number): Attach | null {
  const near = nearestPointOnSegment(roadIndexOf(graph.net), x, z, radius, networks);
  if (!near) return null;
  return { segment: near.segment, t: near.t, x: near.x, z: near.z, offset: near.distance, along: lengthTo(graph.net, near.segment, near.t) };
}

/** Seconds to travel `metres` of segment `seg` in the given direction, at the edge's rate. */
function partTime(graph: RoutingGraph, seg: number, forward: boolean, metres: number): number {
  const full = graph.net.segLength[seg] ?? 0;
  const edge = graph.edgeTime[forward ? 2 * seg : 2 * seg + 1] ?? NO_EDGE;
  if (edge === NO_EDGE || full <= 0) return NO_EDGE;
  return (edge * metres) / full;
}

/** Options for `findRouteBetween`. */
export interface PointRouteOptions {
  /** Networks a route may use. Road only by default. */
  networks?: number;
  /** How far, in metres, a point may be from the network it joins. No limit by default. */
  radius?: number;
}

/**
 * The quickest route from point (fromX, fromZ) to point (toX, toZ). Each
 * point joins the network at the nearest point on a segment on a network in
 * the filter, and may leave it in either direction the segment allows. A
 * start and end on the same segment may go straight along it, or around if
 * that is quicker or the segment is a one-way pointing the other way.
 */
export function findRouteBetween(
  graph: RoutingGraph,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  options: PointRouteOptions = {},
): RouteResult<PointRoute> {
  const { net } = graph;
  const networks = options.networks ?? NETWORKS_ROAD;
  const radius = options.radius ?? Infinity;
  checkNetworks(networks);
  const start = attach(graph, fromX, fromZ, radius, networks);
  if (!start) return { ok: false, reason: "no road near the start" };
  const end = attach(graph, toX, toZ, radius, networks);
  if (!end) return { ok: false, reason: "no road near the end" };
  const sLen = net.segLength[start.segment] ?? 0;
  const eLen = net.segLength[end.segment] ?? 0;
  const sA = net.segA[start.segment] ?? NONE;
  const sB = net.segB[start.segment] ?? NONE;
  const eA = net.segA[end.segment] ?? NONE;
  const eB = net.segB[end.segment] ?? NONE;
  const ends = { start: strip(start), end: strip(end) };

  // Straight along one segment, when the direction is allowed.
  let best: PointRoute | null = null;
  let bestTime = Infinity;
  if (start.segment === end.segment) {
    const forward = end.along >= start.along;
    const metres = forward ? end.along - start.along : start.along - end.along;
    const time = partTime(graph, start.segment, forward, metres);
    if (time !== NO_EDGE) {
      best = { segments: [start.segment], forward: [forward], nodes: [], distance: metres, time, ...ends };
      bestTime = time;
    }
  }

  // Otherwise leave the start's segment at one end, cross the network, and
  // come onto the end's segment at one of its ends.
  const search = new Search(graph, graph.scratch);
  const toB = partTime(graph, start.segment, true, sLen - start.along);
  const toA = partTime(graph, start.segment, false, start.along);
  if (toB !== NO_EDGE) search.offer(sB, toB, NONE);
  if (toA !== NO_EDGE) search.offer(sA, toA, NONE);
  // Seconds from each end of the end's segment to the end point.
  const fromA = partTime(graph, end.segment, true, end.along);
  const fromB = partTime(graph, end.segment, false, eLen - end.along);
  let bestNode = NONE;
  for (let node = search.pop(); node !== NONE; node = search.pop()) {
    const reached = search.timeTo(node);
    if (reached > bestTime) break;
    for (const [at, last] of [
      [eA, fromA],
      [eB, fromB],
    ] as const) {
      if (node !== at || last === NO_EDGE) continue;
      const total = reached + last;
      // A tie keeps what was found first: the straight run, then the node settled first.
      if (total < bestTime) {
        bestTime = total;
        bestNode = node;
        best = null;
      }
    }
    search.relax(node, networks);
  }
  if (bestNode !== NONE) {
    const path = search.trace(bestNode);
    const first = path.nodes[0] ?? NONE;
    const leaveForward = first === sB;
    const arriveForward = bestNode === eA;
    // The search starts at the ends of the start's segment and stops at the
    // ends of the end's segment, so the two partial segments go on either
    // side of the path. When both points share a segment and the route goes
    // around, that segment is first and last.
    const segments = [start.segment, ...path.segments, end.segment];
    const forward = [leaveForward, ...path.forward, arriveForward];
    const distance =
      (leaveForward ? sLen - start.along : start.along) + distanceOf(net, path.segments) + (arriveForward ? end.along : eLen - end.along);
    best = { segments, forward, nodes: path.nodes, distance, time: bestTime, ...ends };
  }
  return best ? { ok: true, route: best } : { ok: false, reason: NO_ROUTE };
}

function strip(a: Attach): RouteEnd {
  return { segment: a.segment, t: a.t, x: a.x, z: a.z, offset: a.offset };
}
