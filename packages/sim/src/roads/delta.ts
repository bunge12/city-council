// Road deltas: what changed in a network since a host last looked, as rows a
// client copies into its own read-only copy.
//
// The change list is not state. It lives in a WeakMap keyed by the network
// object, like the spatial index, so it is left out of the hash and the save
// and a city behaves the same whether or not anyone reads it. Recording
// starts the first time a host asks for it. Every change goes through the
// observer hooks in network.ts, and the list holds at most one entry per id,
// so a host that stops draining costs memory bounded by the id count.
//
// A delta carries whole rows: every field of every node and segment that was
// added, changed or removed, read from the network when the delta is built.
// A removed id arrives as a row of zeros, which is what the network itself
// holds for it. An id removed and handed out again before the delta is built
// arrives once, as the new row, so the old one can never reach a client.
//
// Node positions never change once a node exists, so a segment's shape
// changes only when the segment itself does.
//
// Undo can take back the newest ids by shrinking the arrays again, so an id
// limit can go down. A delta then carries the dropped ids as rows of zeros
// and the copy shrinks to the new limit after copying them.

import {
  NODE_ARRAYS,
  NONE,
  SEG_ARRAYS,
  isNode,
  isSegment,
  nextSegmentAt,
  nodeIdLimit,
  observeNetwork,
  resized,
  segmentIdLimit,
  type AnyTypedArray,
  type RoadNetwork,
} from "./network";
import {
  chunkOfNode,
  existingRoadIndex,
  forSegmentChunks,
  indexNode,
  indexSegment,
  unindexNode,
  unindexSegment,
} from "./spatial";
import { addBlockSegment, existingBlockIndex, removeBlockSegment } from "./blocks";
import { NO_EDGE, existingRoutingGraph, refreshRoutingSegment } from "./routing";

type NodeKey = (typeof NODE_ARRAYS)[number];
type SegKey = (typeof SEG_ARRAYS)[number];

/** Node and segment ids touched since the last drain. Not state. */
export interface RoadChanges {
  /** Ascending. */
  nodes: number[];
  /** Ascending. */
  segs: number[];
  /** Whether `nodeFree` changed. */
  nodeFree: boolean;
  /** Whether `segFree` changed. */
  segFree: boolean;
}

/**
 * The rows of a network that changed, as a delta message carries them.
 * Plain fields and typed arrays only, so it crosses a worker or a socket.
 */
export interface RoadDelta {
  /** `nodeIdLimit` after the change. Smaller than before only after an undo. */
  nodeLimit: number;
  /** `segmentIdLimit` after the change. Smaller than before only after an undo. */
  segLimit: number;
  /** Changed node ids, ascending. Row `i` of each node array is node `nodeIds[i]`. */
  nodeIds: Int32Array;
  nodes: Pick<RoadNetwork, NodeKey>;
  /** Changed segment ids, ascending. Row `i` of each segment array is segment `segIds[i]`. */
  segIds: Int32Array;
  segs: Pick<RoadNetwork, SegKey>;
  /** The whole free list, when it changed. */
  nodeFree?: Int32Array;
  segFree?: Int32Array;
}

interface Recorder {
  nodes: Set<number>;
  segs: Set<number>;
  /**
   * The free lists as of the last drain. network.ts gives a free list a new
   * view every time it changes, so a different object means it changed.
   */
  nodeFree: Int32Array;
  segFree: Int32Array;
}

const recorders = new WeakMap<RoadNetwork, Recorder>();

/** Marks `node` and every segment in its list. */
function markNodeAndList(net: RoadNetwork, rec: Recorder, node: number): void {
  rec.nodes.add(node);
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) rec.segs.add(seg);
}

/**
 * Starts recording changes to `net`, if nothing is yet. Changes made before
 * this call are not in any later drain; a host sends a snapshot for those.
 */
export function recordRoadChanges(net: RoadNetwork): void {
  if (recorders.has(net)) return;
  const rec: Recorder = { nodes: new Set(), segs: new Set(), nodeFree: net.nodeFree, segFree: net.segFree };
  observeNetwork(net, {
    nodeAdded: (id) => void rec.nodes.add(id),
    nodeRemoving: (id) => void rec.nodes.add(id),
    // Adding a segment puts it at the head of both nodes' lists, but undo
    // puts one back in the middle, which changes the segment before it.
    segmentAdded: (id) => {
      rec.segs.add(id);
      markNodeAndList(net, rec, net.segA[id] ?? NONE);
      markNodeAndList(net, rec, net.segB[id] ?? NONE);
    },
    // Called once the segment is out of its nodes' lists. Whatever pointed
    // at it now points past it: a node's head or the segment before it in a
    // list, and both are still in the lists, so mark them all.
    segmentRemoving: (id) => {
      rec.segs.add(id);
      markNodeAndList(net, rec, net.segA[id] ?? NONE);
      markNodeAndList(net, rec, net.segB[id] ?? NONE);
    },
  });
  recorders.set(net, rec);
}

/**
 * What changed in `net` since the last drain, or since recording started,
 * and clears the list. Null if nothing changed or nothing is recording.
 */
export function drainRoadChanges(net: RoadNetwork): RoadChanges | null {
  const rec = recorders.get(net);
  if (!rec) return null;
  const nodeFree = rec.nodeFree !== net.nodeFree;
  const segFree = rec.segFree !== net.segFree;
  if (rec.nodes.size === 0 && rec.segs.size === 0 && !nodeFree && !segFree) return null;
  const changes: RoadChanges = {
    nodes: [...rec.nodes].sort((a, b) => a - b),
    segs: [...rec.segs].sort((a, b) => a - b),
    nodeFree,
    segFree,
  };
  rec.nodes.clear();
  rec.segs.clear();
  rec.nodeFree = net.nodeFree;
  rec.segFree = net.segFree;
  return changes;
}

/** Adds `more` into `into`, keeping id lists ascending and without repeats. */
export function mergeRoadChanges(into: RoadChanges | null, more: RoadChanges | null): RoadChanges | null {
  if (!into) return more;
  if (!more) return into;
  const union = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
  return {
    nodes: union(into.nodes, more.nodes),
    segs: union(into.segs, more.segs),
    nodeFree: into.nodeFree || more.nodeFree,
    segFree: into.segFree || more.segFree,
  };
}

function gather<K extends string>(net: RoadNetwork, keys: readonly K[], ids: Int32Array): Record<K, AnyTypedArray> {
  const out = {} as Record<K, AnyTypedArray>;
  for (const key of keys) {
    const source = (net as unknown as Record<K, AnyTypedArray>)[key];
    const Type = source.constructor as new (n: number) => AnyTypedArray;
    const rows = new Type(ids.length);
    for (let i = 0; i < ids.length; i++) rows[i] = source[ids[i] ?? 0] ?? 0;
    out[key] = rows;
  }
  return out;
}

/** The rows `changes` names, read from `net` as it is now. */
export function encodeRoadDelta(net: RoadNetwork, changes: RoadChanges): RoadDelta {
  const nodeIds = Int32Array.from(changes.nodes);
  const segIds = Int32Array.from(changes.segs);
  const delta: RoadDelta = {
    nodeLimit: nodeIdLimit(net),
    segLimit: segmentIdLimit(net),
    nodeIds,
    nodes: gather(net, NODE_ARRAYS, nodeIds) as Pick<RoadNetwork, NodeKey>,
    segIds,
    segs: gather(net, SEG_ARRAYS, segIds) as Pick<RoadNetwork, SegKey>,
  };
  if (changes.nodeFree) delta.nodeFree = net.nodeFree.slice();
  if (changes.segFree) delta.segFree = net.segFree.slice();
  return delta;
}

/** Why `delta` cannot apply to `net`, or null if it can. */
function deltaProblem(net: RoadNetwork, delta: RoadDelta): string | null {
  if (!Number.isSafeInteger(delta.nodeLimit) || delta.nodeLimit < 0 || !Number.isSafeInteger(delta.segLimit) || delta.segLimit < 0) {
    return "id limits are not whole numbers";
  }
  // A row past both the copy's limit and the new one is for an id handed
  // out and taken back by undo between two deltas. The copy never had it,
  // and copying it changes nothing.
  const ids = (list: Int32Array) => list.every((id, i) => id >= 0 && (i === 0 || id > (list[i - 1] ?? 0)));
  if (!ids(delta.nodeIds) || !ids(delta.segIds)) return "row ids are out of range or order";
  if (NODE_ARRAYS.some((key) => delta.nodes[key].length !== delta.nodeIds.length)) return "node rows differ in length";
  if (SEG_ARRAYS.some((key) => delta.segs[key].length !== delta.segIds.length)) return "segment rows differ in length";
  // Every id past the old limit was handed out since, so it has a row.
  const covered = (list: Int32Array, from: number, to: number) => {
    let at = 0;
    for (let id = from; id < to; id++) {
      while (at < list.length && (list[at] ?? 0) < id) at++;
      if (list[at] !== id) return false;
    }
    return true;
  };
  if (!covered(delta.nodeIds, nodeIdLimit(net), delta.nodeLimit) || !covered(delta.segIds, segmentIdLimit(net), delta.segLimit)) {
    return "new ids have no rows";
  }
  // Every id an undo dropped was removed, so it has a row too.
  if (!covered(delta.nodeIds, delta.nodeLimit, nodeIdLimit(net)) || !covered(delta.segIds, delta.segLimit, segmentIdLimit(net))) {
    return "dropped ids have no rows";
  }
  return null;
}

function scatter<K extends string>(net: RoadNetwork, keys: readonly K[], limit: number, ids: Int32Array, rows: Record<K, AnyTypedArray>): void {
  const arrays = net as unknown as Record<K, AnyTypedArray>;
  for (const key of keys) {
    // Rows past a smaller limit are copied too, then cut off, so nothing
    // is left behind in the buffer to come back if the arrays grow again.
    const target = resized(arrays[key], Math.max(limit, arrays[key].length));
    const source = rows[key];
    for (let i = 0; i < ids.length; i++) target[ids[i] ?? 0] = source[i] ?? 0;
    arrays[key] = resized(target, limit);
  }
}

/**
 * Chunks a network copy touches through the rows a delta names: where each
 * live node is and every chunk each live segment crosses.
 */
function touchedChunks(net: RoadNetwork, nodeIds: Int32Array, segIds: Int32Array, into: Set<number>): void {
  for (const node of nodeIds) if (isNode(net, node)) into.add(chunkOfNode(net, node));
  for (const seg of segIds) if (isSegment(net, seg)) forSegmentChunks(net, seg, (chunk) => into.add(chunk));
}

/**
 * Copies a delta's rows into `net`, a client's copy of the network the
 * delta was built from. Returns the 500 m chunks whose roads changed, as
 * `cj * CHUNKS_PER_SIDE + ci` ascending: each changed row's chunks before the
 * change and after. Returns a reason instead, changing nothing, if the delta
 * cannot belong to this copy; the client then asks for a snapshot.
 */
export function applyRoadDelta(net: RoadNetwork, delta: RoadDelta): number[] | string {
  const problem = deltaProblem(net, delta);
  if (problem) return problem;
  const chunks = new Set<number>();
  touchedChunks(net, delta.nodeIds.filter((id) => id < nodeIdLimit(net)), delta.segIds.filter((id) => id < segmentIdLimit(net)), chunks);
  // Rows are copied in place, past the observer hooks, so a spatial index
  // the client already has is brought up to date here: changed rows come
  // out as they were and go back in as they are.
  const index = existingRoadIndex(net);
  if (index) {
    for (const seg of delta.segIds) if (isSegment(net, seg)) unindexSegment(index, seg);
    for (const node of delta.nodeIds) if (isNode(net, node)) unindexNode(index, node);
  }
  // Blocks the same way: each changed row lets go while the lists are as
  // they were, and comes back once they are as they are.
  const blocks = existingBlockIndex(net);
  if (blocks) for (const seg of delta.segIds) if (isSegment(net, seg)) removeBlockSegment(blocks, seg);
  scatter(net, NODE_ARRAYS, delta.nodeLimit, delta.nodeIds, delta.nodes);
  scatter(net, SEG_ARRAYS, delta.segLimit, delta.segIds, delta.segs);
  if (delta.nodeFree) net.nodeFree = delta.nodeFree.slice();
  if (delta.segFree) net.segFree = delta.segFree.slice();
  if (index) {
    for (const node of delta.nodeIds) if (isNode(net, node)) indexNode(index, node);
    for (const seg of delta.segIds) if (isSegment(net, seg)) indexSegment(index, seg);
  }
  if (blocks) for (const seg of delta.segIds) if (isSegment(net, seg)) addBlockSegment(blocks, seg);
  // The routing graph keeps per-segment numbers only, so each changed row is
  // worked out again, and ids past a smaller limit lose their edges.
  const graph = existingRoutingGraph(net);
  if (graph) {
    for (const seg of delta.segIds) refreshRoutingSegment(graph, seg);
    for (let e = 2 * segmentIdLimit(net); e < graph.edgeTime.length; e++) graph.edgeTime[e] = NO_EDGE;
  }
  touchedChunks(net, delta.nodeIds, delta.segIds, chunks);
  return [...chunks].sort((a, b) => a - b);
}
