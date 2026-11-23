// Free-flow travel times between zones (M3-23, issue #177): how long it
// takes to drive between any two parts of the city, cheap enough to ask
// many times a game day.
//
// The map is cut into travel zones, one per 500 m chunk. Each zone is
// measured from its source: of the nodes in it with a road segment, the
// one nearest its middle, the lower id on a tie. A zone with no such node
// has no source, and every trip to or from it answers "no route". The
// table holds, for every two zones, the free-flow seconds from one source
// to the other by the quickest road route, rounded to the second: one
// search from each source gives a row. Two buildings in one zone get
// `sameZoneSeconds` from routing.json instead, so a pop can work next door.
//
// The table is derived data (PRD, "Derived data"): never saved or hashed,
// built from the roads alone, so a table kept current equals one built
// afresh. Only `state.travelReadyAt` is state. A command that changes the
// roads gives it the tick by which the table is rebuilt, from the size of
// the work: zones with a source times road nodes, over
// `rebuildSettlesPerTick`. Small cities rebuild at once. A big one
// compacts the road graph on the next step, then settles up to
// `rebuildSettlesPerTick` nodes a step over that many ticks, stopping a
// row's search part way when the share runs out and carrying it on in the
// next step, and the step whose tick is last before the ready tick
// finishes it, so the table is whole on that tick on every machine
// (CLAUDE.md rule 5). A change while one rebuilds starts it again.
//
// Nothing in the sim may read the table before the ready tick
// (`travelTimesReady`). The table it would read is the one from before the
// change, and a city loaded from a save made in between has only the
// roads as they are now, so it could not give the same answers. A reader
// that cannot wait does without the table until then.
//
// Exact arithmetic only (CLAUDE.md rule 6): sums of edge times, squared
// distances and `Math.floor`.

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "./chunks";
import { NO_BUILDING, buildingChunk } from "./buildings/where";
import { NETWORK_ROAD, NONE, SEG_ALIVE, nodeIdLimit, observeNetwork, type RoadNetwork } from "./roads/network";
import { NO_EDGE, ROUTING_BALANCE, routingGraphOf } from "./roads/routing";
import type { SimState } from "./state";

/** Travel zones on the map: one per 500 m chunk, numbered as chunks are. */
export const TRAVEL_ZONES = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;

/** A table entry for a pair of zones with no route between them. */
const UNREACHED = 0xffff;
/** The longest time a table entry holds, in seconds: about 18 hours. */
const LONGEST = 0xfffe;

/** The road graph of a rebuild, compacted to the nodes with a road segment, as it was when the rebuild started. */
interface CompactGraph {
  /** Compact nodes, in ascending node id. */
  readonly size: number;
  /** Edges out of compact node `i` are `first[i]` up to `first[i + 1]`. */
  readonly first: Int32Array;
  /** Where each edge goes, as a compact node. */
  readonly to: Int32Array;
  /** Seconds along each edge. */
  readonly time: Float64Array;
  /** For each compact node, the zone it is the source of, or -1. */
  readonly zoneOf: Int32Array;
}

/**
 * A rebuild of the table, a row at a time. A row's search may stop part way
 * at the end of a step and carry on in the next, so a step settles no more
 * nodes than its share whatever the size of a row (#326).
 */
interface Rebuild {
  readonly graph: CompactGraph;
  /** Each zone's source node, or NONE. */
  readonly sources: Int32Array;
  /** Each zone's source as a compact node, or -1. */
  readonly compactSources: Int32Array;
  /** The zones with a source, ascending: the rows to build. */
  readonly rows: Int32Array;
  /** How many of `rows` are built. */
  done: number;
  /** Row `done` has its search under way: its start pushed and its part of the table cleared. */
  open: boolean;
  /** Entries in the open row's heap (`heapTime`, `heapNode`). */
  heapSize: number;
  /** Sources the open row's search has still to settle. */
  left: number;
  readonly table: Uint16Array;
}

/** A table and the rebuild under way, for one network. Derived data: not state. */
interface TravelTimes {
  readonly net: RoadNetwork;
  /**
   * A segment came or went since the command being applied started
   * (`startTravelWatch`). Read only around commands: a check that builds
   * and takes back, as `submit` does for a BuildRoadGrid, sets it too.
   */
  touched: boolean;
  /** A command applied this step changed the roads, or a host said so (`markRoadsChanged`). */
  changed: boolean;
  /** Seconds from zone `a` to zone `b` at `a * TRAVEL_ZONES + b`, once built. */
  table: Uint16Array | null;
  /** Each zone's source node in `table`, or NONE. Null while the table is being rebuilt in place. */
  sources: Int32Array | null;
  rebuild: Rebuild | null;
  /**
   * A rebuild due to start on the next step: the step that applied the
   * change spent its time on it. The roads stay as they were: a change
   * before then starts it again.
   */
  waiting: boolean;
  /**
   * How many live road segments end at each node, kept from the network's
   * events, so the step that applies a change of roads knows the size of
   * the rebuild without a pass over the network. A node's place never
   * changes while it has segments.
   */
  roadDegree: Int32Array;
  /** How many nodes in each zone a road reaches. */
  zoneRoadNodes: Int32Array;
  /** Nodes a road reaches, and zones with at least one: the rebuild's size. */
  roadNodes: number;
  roadZones: number;
  // Buffers kept between rebuilds, so a rebuild makes no garbage: the road
  // node marks, the compacted graph and the searches' scratch.
  mark: Uint8Array;
  index: Int32Array;
  first: Int32Array;
  cursor: Int32Array;
  to: Int32Array;
  time: Float64Array;
  zoneOf: Int32Array;
  dist: Float64Array;
  heapTime: Float64Array;
  heapNode: Int32Array;
}

const live = new WeakMap<RoadNetwork, TravelTimes>();

/** The travel times of `net`, watching it for changes from now on, with no table built yet if it has none. */
function watched(net: RoadNetwork): TravelTimes {
  let tt = live.get(net);
  if (!tt) {
    const made: TravelTimes = {
      net,
      touched: false,
      changed: false,
      table: null,
      sources: null,
      rebuild: null,
      waiting: false,
      roadDegree: new Int32Array(0),
      zoneRoadNodes: new Int32Array(TRAVEL_ZONES),
      roadNodes: 0,
      roadZones: 0,
      mark: new Uint8Array(0),
      index: new Int32Array(0),
      first: new Int32Array(0),
      cursor: new Int32Array(0),
      to: new Int32Array(0),
      time: new Float64Array(0),
      zoneOf: new Int32Array(0),
      dist: new Float64Array(0),
      heapTime: new Float64Array(64),
      heapNode: new Int32Array(64),
    };
    observeNetwork(net, {
      nodeAdded: () => undefined,
      nodeRemoving: () => undefined,
      segmentAdded: (seg) => {
        made.touched = true;
        countSegment(made, seg, 1);
      },
      segmentRemoving: (seg) => {
        made.touched = true;
        countSegment(made, seg, -1);
      },
    });
    const { segFlags } = net;
    for (let seg = 0; seg < segFlags.length; seg++) if (((segFlags[seg] ?? 0) & SEG_ALIVE) !== 0) countSegment(made, seg, 1);
    live.set(net, made);
    tt = made;
  }
  return tt;
}

/**
 * Counts live segment `seg` in or out of the rebuild's size: each end a
 * road reaches, and each zone that has one.
 */
function countSegment(tt: TravelTimes, seg: number, by: 1 | -1): void {
  const net = tt.net;
  if (net.segNetwork[seg] !== NETWORK_ROAD) return;
  for (const node of [net.segA[seg] ?? 0, net.segB[seg] ?? 0]) {
    if (node >= tt.roadDegree.length) {
      const grown = new Int32Array(Math.max(64, 2 * node + 2));
      grown.set(tt.roadDegree);
      tt.roadDegree = grown;
    }
    const before = tt.roadDegree[node] ?? 0;
    tt.roadDegree[node] = before + by;
    // A node joins the count with its first road segment and leaves it with its last.
    if (by === 1 ? before !== 0 : before !== 1) continue;
    tt.roadNodes += by;
    const zone = zoneAt(net.nodeX[node] ?? 0, net.nodeZ[node] ?? 0);
    const inZone = tt.zoneRoadNodes[zone] ?? 0;
    tt.zoneRoadNodes[zone] = inZone + by;
    if (by === 1 ? inZone === 0 : inZone === 1) tt.roadZones += by;
  }
}

/** `a` if it holds `n`, or a bigger one of the same kind. What it held is not kept. */
function room<T extends Int32Array | Float64Array | Uint8Array>(a: T, n: number, make: (n: number) => T): T {
  return a.length >= n ? a : make(Math.max(n, 2 * a.length));
}

/**
 * Marks in `tt.mark` every node a live road segment ends at, the nodes a
 * road reaches, and returns how many there are. One pass over the
 * segments, into a buffer kept between rebuilds.
 */
function markRoadNodes(tt: TravelTimes): number {
  const net = tt.net;
  const limit = nodeIdLimit(net);
  tt.mark = room(tt.mark, limit, (n) => new Uint8Array(n));
  const mark = tt.mark;
  mark.fill(0, 0, limit);
  const { segFlags, segNetwork, segA, segB } = net;
  // Imported constants as locals: under the test runner, which the bench
  // and the soak time, each read of an import is a property read (#306).
  const alive = SEG_ALIVE;
  const road = NETWORK_ROAD;
  for (let seg = 0; seg < segFlags.length; seg++) {
    if (((segFlags[seg] ?? 0) & alive) === 0 || segNetwork[seg] !== road) continue;
    mark[segA[seg] ?? 0] = 1;
    mark[segB[seg] ?? 0] = 1;
  }
  let nodes = 0;
  for (let node = 0; node < limit; node++) nodes += mark[node] ?? 0;
  return nodes;
}

/** The zone a point is in, as `chunkAt` gives it: off-map points in the nearest edge zone. */
function zoneAt(x: number, z: number): number {
  const side = CHUNKS_PER_SIDE;
  const size = CHUNK_SIZE;
  let i = Math.floor(x / size);
  let j = Math.floor(z / size);
  if (i < 0) i = 0;
  else if (i >= side) i = side - 1;
  if (j < 0) j = 0;
  else if (j >= side) j = side - 1;
  return j * side + i;
}

/** Each zone's source node, or NONE, and how many nodes have a road segment. From the roads alone. */
function findSources(tt: TravelTimes): { sources: Int32Array; nodes: number } {
  const net = tt.net;
  const nodes = markRoadNodes(tt);
  const mark = tt.mark;
  const none = NONE;
  const side = CHUNKS_PER_SIDE;
  const size = CHUNK_SIZE;
  const sources = new Int32Array(TRAVEL_ZONES).fill(none);
  const best = new Float64Array(TRAVEL_ZONES);
  const limit = nodeIdLimit(net);
  const { nodeX, nodeZ } = net;
  for (let node = 0; node < limit; node++) {
    if (mark[node] === 0) continue;
    const x = nodeX[node] ?? 0;
    const z = nodeZ[node] ?? 0;
    const zone = zoneAt(x, z);
    const dx = x - ((zone % side) + 0.5) * size;
    const dz = z - (Math.floor(zone / side) + 0.5) * size;
    const d = dx * dx + dz * dz;
    // Ascending ids, so a tie keeps the lower.
    if (sources[zone] === none || d < (best[zone] ?? 0)) {
      sources[zone] = node;
      best[zone] = d;
    }
  }
  return { sources, nodes };
}

/**
 * How many ticks of rows rebuilding the table for the roads as they are is
 * given, at least 1: zones a road reaches times nodes it reaches, over the
 * settles a tick. From the roads alone, so every machine agrees.
 */
function rebuildTicks(tt: TravelTimes): number {
  const per = ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick;
  const ticks = Math.floor((tt.roadZones * tt.roadNodes + per - 1) / per);
  return ticks < 1 ? 1 : ticks;
}

/**
 * The road graph of `net` as it is now, compacted to the nodes a road
 * reaches, in ascending id, with each zone's source marked. Reads the
 * nodes `findSources` has just marked, so the caller runs it first. Two
 * passes over the segments: one counts each node's edges, one files them.
 * Into buffers kept between rebuilds, so a rebuild makes no garbage.
 */
function compact(tt: TravelTimes, sources: Int32Array): { graph: CompactGraph; compactSources: Int32Array } {
  const net = tt.net;
  const { edgeTime } = routingGraphOf(net);
  const mark = tt.mark;
  const limit = nodeIdLimit(net);
  tt.index = room(tt.index, limit, (n) => new Int32Array(n));
  const index = tt.index;
  let n = 0;
  for (let node = 0; node < limit; node++) if (mark[node] !== 0) index[node] = n++;
  tt.first = room(tt.first, n + 1, (k) => new Int32Array(k));
  tt.cursor = room(tt.cursor, n, (k) => new Int32Array(k));
  const first = tt.first;
  const cursor = tt.cursor;
  first.fill(0, 0, n + 1);
  const { segFlags, segNetwork, segA, segB } = net;
  // Imported constants as locals, as in `markRoadNodes`.
  const alive = SEG_ALIVE;
  const road = NETWORK_ROAD;
  const noEdge = NO_EDGE;
  for (let seg = 0; seg < segFlags.length; seg++) {
    if (((segFlags[seg] ?? 0) & alive) === 0 || segNetwork[seg] !== road) continue;
    if ((edgeTime[2 * seg] ?? noEdge) !== noEdge) {
      const i = (index[segA[seg] ?? 0] ?? 0) + 1;
      first[i] = (first[i] ?? 0) + 1;
    }
    if ((edgeTime[2 * seg + 1] ?? noEdge) !== noEdge) {
      const i = (index[segB[seg] ?? 0] ?? 0) + 1;
      first[i] = (first[i] ?? 0) + 1;
    }
  }
  for (let i = 0; i < n; i++) {
    first[i + 1] = (first[i + 1] ?? 0) + (first[i] ?? 0);
    cursor[i] = first[i] ?? 0;
  }
  const edges = first[n] ?? 0;
  tt.to = room(tt.to, edges, (k) => new Int32Array(k));
  tt.time = room(tt.time, edges, (k) => new Float64Array(k));
  const to = tt.to;
  const time = tt.time;
  for (let seg = 0; seg < segFlags.length; seg++) {
    if (((segFlags[seg] ?? 0) & alive) === 0 || segNetwork[seg] !== road) continue;
    const a = index[segA[seg] ?? 0] ?? 0;
    const b = index[segB[seg] ?? 0] ?? 0;
    const forward = edgeTime[2 * seg] ?? noEdge;
    if (forward !== noEdge) {
      const e = cursor[a] ?? 0;
      cursor[a] = e + 1;
      to[e] = b;
      time[e] = forward;
    }
    const back = edgeTime[2 * seg + 1] ?? noEdge;
    if (back !== noEdge) {
      const e = cursor[b] ?? 0;
      cursor[b] = e + 1;
      to[e] = a;
      time[e] = back;
    }
  }
  tt.zoneOf = room(tt.zoneOf, n, (k) => new Int32Array(k));
  const zoneOf = tt.zoneOf;
  zoneOf.fill(-1, 0, n);
  const compactSources = new Int32Array(TRAVEL_ZONES).fill(-1);
  for (let zone = 0; zone < TRAVEL_ZONES; zone++) {
    const s = sources[zone] ?? NONE;
    if (s === NONE) continue;
    const c = index[s] ?? -1;
    compactSources[zone] = c;
    zoneOf[c] = zone;
  }
  return { graph: { size: n, first, to, time, zoneOf }, compactSources };
}

/** Finds the sources and compacts the graph for a rebuild from the roads as they are now, and starts it with no rows built. */
function startRebuild(tt: TravelTimes): void {
  const { sources } = findSources(tt);
  const { graph, compactSources } = compact(tt, sources);
  const rows: number[] = [];
  for (let zone = 0; zone < TRAVEL_ZONES; zone++) if ((compactSources[zone] ?? -1) >= 0) rows.push(zone);
  tt.dist = room(tt.dist, graph.size, (k) => new Float64Array(k));
  // Built in place over the table in use: nothing reads it until the rebuild is done (`tableOf`).
  tt.table ??= new Uint16Array(TRAVEL_ZONES * TRAVEL_ZONES);
  tt.sources = null;
  tt.rebuild = { graph, sources, compactSources, rows: Int32Array.from(rows), done: 0, open: false, heapSize: 0, left: 0, table: tt.table };
}

/** Starts the search for row `done` of the rebuild: its source pushed, every other node unreached, its part of the table cleared. */
function openRow(tt: TravelTimes, r: Rebuild): void {
  const zone = r.rows[r.done] ?? 0;
  const dist = tt.dist;
  dist.fill(Infinity, 0, r.graph.size);
  const start = r.compactSources[zone] ?? -1;
  dist[start] = 0;
  tt.heapTime[0] = 0;
  tt.heapNode[0] = start;
  r.heapSize = 1;
  r.left = r.rows.length;
  const row = zone * TRAVEL_ZONES;
  r.table.fill(UNREACHED, row, row + TRAVEL_ZONES);
  r.open = true;
}

/**
 * Carries on the search for the open row, one search from its source over
 * the compacted graph, until every source is settled, nothing more can be
 * reached or `budget` nodes are settled. Returns the nodes it settled.
 * Closes the row when its search is done. Ties need no rule: only times are
 * kept, and the quickest time to a node is the same whichever way reaches
 * it first, so where a step stops changes nothing in the table.
 */
function searchRow(tt: TravelTimes, r: Rebuild, budget: number): number {
  const { first, to, time, zoneOf } = r.graph;
  const dist = tt.dist;
  let heapTime = tt.heapTime;
  let heapNode = tt.heapNode;
  let heapSize = r.heapSize;
  let left = r.left;
  const row = (r.rows[r.done] ?? 0) * TRAVEL_ZONES;
  const table = r.table;
  let settled = 0;
  while (heapSize > 0 && left > 0 && settled < budget) {
    const t = heapTime[0] ?? 0;
    const u = heapNode[0] ?? 0;
    // Pop: move the last entry down from the top.
    heapSize--;
    const lt = heapTime[heapSize] ?? 0;
    const ln = heapNode[heapSize] ?? 0;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapSize) break;
      if (c + 1 < heapSize && (heapTime[c + 1] ?? 0) < (heapTime[c] ?? 0)) c++;
      if ((heapTime[c] ?? 0) >= lt) break;
      heapTime[i] = heapTime[c] ?? 0;
      heapNode[i] = heapNode[c] ?? 0;
      i = c;
    }
    heapTime[i] = lt;
    heapNode[i] = ln;
    // A stale entry: the node was reached sooner since it was pushed, or settled.
    if (t !== dist[u]) continue;
    dist[u] = -1 - t;
    settled++;
    const target = zoneOf[u] ?? -1;
    if (target >= 0) {
      const seconds = Math.floor(t + 0.5);
      table[row + target] = seconds > LONGEST ? LONGEST : seconds;
      if (--left === 0) break;
    }
    const end = first[u + 1] ?? 0;
    for (let e = first[u] ?? 0; e < end; e++) {
      const v = to[e] ?? 0;
      const nt = t + (time[e] ?? 0);
      // A settled node holds -1 minus its time, below any time.
      if (!(nt < (dist[v] ?? 0))) continue;
      dist[v] = nt;
      if (heapSize === heapTime.length) {
        const grownTime = new Float64Array(heapSize * 2);
        grownTime.set(heapTime);
        const grownNode = new Int32Array(heapSize * 2);
        grownNode.set(heapNode);
        heapTime = tt.heapTime = grownTime;
        heapNode = tt.heapNode = grownNode;
      }
      let j = heapSize++;
      while (j > 0) {
        const p = (j - 1) >> 1;
        if ((heapTime[p] ?? 0) <= nt) break;
        heapTime[j] = heapTime[p] ?? 0;
        heapNode[j] = heapNode[p] ?? 0;
        j = p;
      }
      heapTime[j] = nt;
      heapNode[j] = v;
    }
  }
  r.heapSize = heapSize;
  r.left = left;
  if (heapSize === 0 || left === 0) {
    r.open = false;
    r.done++;
  }
  return settled;
}

/**
 * Builds more of the rebuild, row after row, until `budget` nodes are
 * settled, and puts the table in place once every row is built.
 */
function advance(tt: TravelTimes, budget: number): void {
  const r = tt.rebuild;
  if (!r) return;
  let settled = 0;
  while (r.done < r.rows.length && settled < budget) {
    if (!r.open) openRow(tt, r);
    settled += searchRow(tt, r, budget - settled);
  }
  if (r.done < r.rows.length) return;
  tt.table = r.table;
  tt.sources = r.sources;
  tt.rebuild = null;
}

/** Rebuilds the whole table now, from the roads as they are. */
function rebuildNow(tt: TravelTimes): void {
  tt.changed = false;
  tt.waiting = false;
  startRebuild(tt);
  advance(tt, Infinity);
}

/**
 * Starts watching the roads for one command (commands.ts, `applyPending`).
 * Only a command the step applies counts as a change of roads, through
 * `endTravelWatch`: a dropped BuildRoadGrid that a street refused built
 * the streets before it and took them back, and a check before a step
 * may build and take back too. Neither leaves the roads changed, and a
 * replay, which sees neither, must give `travelReadyAt` the same ticks.
 */
export function startTravelWatch(state: SimState): void {
  watched(state.roads).touched = false;
}

/** Ends the watch `startTravelWatch` began: a command that applied and touched a segment changed the roads. */
export function endTravelWatch(state: SimState, applied: boolean): void {
  const tt = watched(state.roads);
  if (applied && tt.touched) tt.changed = true;
  tt.touched = false;
}

/**
 * Tells the travel times the roads changed outside a command, which no
 * game does (CLAUDE.md rule 2). For tests that build a network directly.
 * The next step gives the change its ready tick, as it would a command's.
 */
export function markRoadsChanged(state: SimState): void {
  watched(state.roads).changed = true;
}

/**
 * Once a step, paused or not, after the commands. If the roads changed,
 * gives `state.travelReadyAt` the tick the table is rebuilt by: a small
 * rebuild is done at once, and a bigger one compacts the road graph on the
 * next step and builds rows from the one after. Otherwise settles one
 * share of the nodes of a rebuild under way, or all that is left on the
 * step before the ready tick. The table is kept current only once
 * something has built it: a city that never asked has nothing to keep.
 */
export function stepTravel(state: SimState): void {
  const tt = watched(state.roads);
  const kept = tt.table !== null;
  if (tt.changed) {
    tt.changed = false;
    const ticks = rebuildTicks(tt);
    tt.rebuild = null;
    tt.waiting = false;
    if (ticks <= 1) {
      // Rebuilt in this step, so readable now, even while an earlier rebuild
      // was due later. Set outright, from the roads as they end the step
      // alone: a replay applies a tick's commands in one step, where the host
      // may have applied them over several paused steps.
      state.travelReadyAt = state.tick;
      if (kept) {
        startRebuild(tt);
        advance(tt, Infinity);
      }
      return;
    }
    // This step and the next, which compacts the graph, build no rows, so
    // the rows get `ticks` steps of their own after them.
    state.travelReadyAt = state.tick + ticks + 2;
    tt.waiting = kept;
    return;
  }
  const ticksLeft = state.travelReadyAt - state.tick;
  if (tt.waiting) {
    startRebuild(tt);
    tt.waiting = false;
    // Compacting the graph is this step's share, unless it is the last.
    if (ticksLeft > 1) return;
  }
  const r = tt.rebuild;
  if (!r) return;
  if (ticksLeft <= 1) {
    advance(tt, Infinity);
    return;
  }
  // A step's share: no row settles more nodes than a road reaches, and the
  // ticks were given at one share a tick for every row, so the rows are
  // done by the last step and it has at most a share left (#326).
  advance(tt, ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick);
}

/**
 * Whether the sim may read travel times: no change of roads is still being
 * rebuilt. Before then a reader does without them.
 */
export function travelTimesReady(state: SimState): boolean {
  return state.tick >= state.travelReadyAt;
}

/** The table, whole and for the roads as they are now, built on first use. */
function tableOf(state: SimState): { table: Uint16Array; sources: Int32Array } {
  const tt = watched(state.roads);
  // Between a command that changed the roads and `stepTravel` in the same
  // step: a read here would rebuild and swallow the change, and the step
  // would never give it a ready tick.
  if (tt.changed) throw new Error("the roads changed in this step and the travel times have not caught up");
  // A change the step has not seen yet, or a rebuild cut short: only outside the step.
  if (!tt.table || !tt.sources || tt.rebuild || tt.waiting) rebuildNow(tt);
  return { table: tt.table as Uint16Array, sources: tt.sources as Int32Array };
}

/** Builds the whole table again now, as a load does. For the bench. */
export function rebuildTravelTimesNow(state: SimState): void {
  rebuildNow(watched(state.roads));
}

/** Builds the table now if there is none, so a host's load pays for it and not a tick. */
export function prepareTravelTimes(state: SimState): void {
  tableOf(state);
}

function checkZone(zone: number): void {
  if (!Number.isInteger(zone) || zone < 0 || zone >= TRAVEL_ZONES) throw new RangeError(`no travel zone ${zone}`);
}

/**
 * Free-flow seconds to drive from zone `from` to zone `to`, or null for no
 * route: a zone with no road, or no way between them. Within one zone, the
 * fixed `sameZoneSeconds`. Throws while the table is still being rebuilt
 * (`travelTimesReady`).
 */
export function zoneTravelTime(state: SimState, from: number, to: number): number | null {
  checkZone(from);
  checkZone(to);
  if (!travelTimesReady(state)) throw new Error("travel times are still being rebuilt after a change of roads");
  const { table, sources } = tableOf(state);
  if (sources[from] === NONE || sources[to] === NONE) return null;
  if (from === to) return ROUTING_BALANCE.travelTimes.sameZoneSeconds;
  const seconds = table[from * TRAVEL_ZONES + to] ?? UNREACHED;
  return seconds === UNREACHED ? null : seconds;
}

/** The travel zone of building `id`: the chunk its lot's centre is in. Throws for no such building. */
export function buildingTravelZone(state: SimState, id: number): number {
  const zone = buildingChunk(state, id);
  if (zone === NO_BUILDING) throw new RangeError(`building ${id} does not exist`);
  return zone;
}

/** The entry `travelTimeTable` holds for a pair of zones with no route between them. */
export const NO_ROUTE_SECONDS = UNREACHED;

/**
 * The whole table and each zone's source, for a reader that asks many
 * times a tick (job matching, M3-09): seconds from zone `a` to zone `b` at
 * `a * TRAVEL_ZONES + b`, NO_ROUTE_SECONDS for no route, and a zone with
 * no source (NONE) answers no route to or from anywhere. Within one zone
 * a reader gives `sameZoneSeconds`, as `zoneTravelTime` does, whatever
 * the table holds there. Read only: the arrays are the table's own. Throws
 * while the table is still being rebuilt (`travelTimesReady`).
 */
export function travelTimeTable(state: SimState): { table: Uint16Array; sources: Int32Array } {
  if (!travelTimesReady(state)) throw new Error("travel times are still being rebuilt after a change of roads");
  return tableOf(state);
}

/** Free-flow seconds to drive from building `from` to building `to`, read from their zones, or null for no route. */
export function buildingTravelTime(state: SimState, from: number, to: number): number | null {
  return zoneTravelTime(state, buildingTravelZone(state, from), buildingTravelZone(state, to));
}

/** Each zone's source node, NONE for a zone with none. For tests and the debug view. */
export function travelZoneSources(state: SimState): Int32Array {
  return tableOf(state).sources.slice();
}

/** The rebuild's size as kept from the network's events: nodes and zones a road reaches. For tests. */
export function travelRebuildSize(state: SimState): { nodes: number; zones: number } {
  const tt = watched(state.roads);
  return { nodes: tt.roadNodes, zones: tt.roadZones };
}

/** Bytes the table holds, and the buffers kept for rebuilding it. For the bench. */
export function travelTimesBytes(state: SimState): { table: number; buffers: number } {
  const tt = live.get(state.roads);
  if (!tt) return { table: 0, buffers: 0 };
  const buffers = [tt.mark, tt.index, tt.first, tt.cursor, tt.to, tt.time, tt.zoneOf, tt.dist, tt.heapTime, tt.heapNode];
  return { table: (tt.table?.byteLength ?? 0) + (tt.sources?.byteLength ?? 0), buffers: buffers.reduce((sum, a) => sum + a.byteLength, 0) };
}
