// The open jobs job matching draws among, by travel zone (M3-09). Derived
// data, never saved or hashed: it lives in a WeakMap keyed by the pops
// object, like the pop index (where.ts), is built from the buildings and the
// pop index on first use, and is kept current after, so a tick's matching
// costs pops times zones and not a pass over every building (issue #178).
//
// A workplace is filed in its travel zone while it is live, on a road that
// reaches an outside connection, and has an open job for some level of
// education (open-jobs.ts). Each zone keeps its workplaces in ascending id
// and the sum of their open jobs for each level.
//
// It keeps current three ways:
// - where.ts notes a building each time a pop joins or leaves its workers,
//   and buildings.ts each time a building comes or goes
//   (opening-changes.ts). Each building noted is filed again from scratch.
// - A change of roads can move any building's zone or reach, so the whole
//   of it is built again. It watches the network's nodes and segments, as
//   the outside reach does (roads/outside.ts), and rebuilds on its next
//   read after any of them comes or goes, paused or not.
// - Job matching files its own takes again as it makes them.
//
// Built afresh or kept current, it gives the same answers: the sums are of
// whole numbers, and each zone's list is in id order whatever order the
// changes came in. For each level of education a Fenwick tree over the
// zones holds the same sums, so a job drawn among all the city's open jobs
// finds its zone in a few steps. `openingsProblem` checks all of it for
// the tests.

import { BUILDING_TYPES } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE } from "../buildings/buildings";
import { NO_BUILDING, buildingChunks } from "../buildings/where";
import { NETWORK_ROAD, observeNetwork, type RoadNetwork } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { TRAVEL_ZONES } from "../travel-times";
import { jobsUpToLevel, openJobsFrom } from "./open-jobs";
import { takeOpeningNotes, watchOpenings } from "./opening-changes";
import { POP_LEVELS, type PopState } from "./pops";
import { popIndexOf } from "./where";

/** By type index: jobs per cell, 0 for a type with none. */
const JOBS_PER_CELL = Float64Array.from(BUILDING_TYPES, (t) => (t.jobsPerCell > 0 ? t.jobsPerCell : 0));

export interface Openings {
  /** The network's count of changes (`roadChanges`) when it was last built whole. */
  roadsSeen: number;
  /** The outside connections it was built for. A load or a test may put a new list on the state. */
  connections: Int32Array;
  /** By zone times POP_LEVELS plus education: the open jobs a pop of that education may take there. */
  open: Float64Array;
  /**
   * For each education: a Fenwick tree over the zones of their open jobs,
   * entry z + 1 for zone z, so a job drawn among all of them finds its zone
   * in a few steps (`zoneOfJob`).
   */
  trees: Int32Array[];
  /** By zone: its workplaces with an open job, ascending by id. */
  members: number[][];
  /** The zones with any workplace filed, ascending, or null until asked for again. */
  zoneList: Int32Array | null;
  /** By building: the zone it is filed in, or -1. */
  zoneOf: Int32Array;
  /** By building times POP_LEVELS plus level: its jobs at that level of education or below, while filed. */
  upTo: Int32Array;
  /** By building times POP_LEVELS plus education: the open jobs it adds to its zone's sums, while filed. */
  given: Int32Array;
}

const live = new WeakMap<PopState, Openings>();

/** By network: how many nodes and segments have come or gone since anything here first watched it. */
const roadCounts = new WeakMap<RoadNetwork, { changes: number }>();

/** A count that moves with every change of `net`'s nodes or segments, from when it is first asked for. */
function roadChanges(net: RoadNetwork): number {
  let count = roadCounts.get(net);
  if (!count) {
    const made = { changes: 0 };
    const bump = () => void (made.changes += 1);
    observeNetwork(net, { nodeAdded: bump, nodeRemoving: bump, segmentAdded: bump, segmentRemoving: bump });
    roadCounts.set(net, made);
    count = made;
  }
  return count.changes;
}

function grownTo(array: Int32Array, length: number, fill: number): Int32Array {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2, 64));
  next.set(array);
  if (fill !== 0) next.fill(fill, array.length);
  return next;
}

/** Room in `o` for every building id `n` covers. */
function fit(o: Openings, n: number): void {
  if (o.zoneOf.length >= n) return;
  o.zoneOf = grownTo(o.zoneOf, n, -1);
  o.upTo = grownTo(o.upTo, o.zoneOf.length * POP_LEVELS, 0);
  o.given = grownTo(o.given, o.zoneOf.length * POP_LEVELS, 0);
}

/** Adds `by` to zone `zone`'s entry in Fenwick tree `tree`. */
function addToTree(tree: Int32Array, zone: number, by: number): void {
  if (by === 0) return;
  for (let i = zone + 1; i < tree.length; i += i & -i) tree[i] = (tree[i] as number) + by;
}

/** The open jobs for `education` in every zone together. */
export function openJobsInAll(o: Openings, education: number): number {
  const tree = o.trees[education] as Int32Array;
  let sum = 0;
  for (let i = TRAVEL_ZONES; i > 0; i -= i & -i) sum += tree[i] as number;
  return sum;
}

/** The highest power of two no more than TRAVEL_ZONES, where a search down the tree starts. */
const TREE_TOP = (() => {
  let top = 1;
  while (top * 2 <= TRAVEL_ZONES) top *= 2;
  return top;
})();

/**
 * The zone of open job `k` for `education`, counting every zone's open jobs
 * in zone order from 0, and `k` less the open jobs of the zones before it:
 * the job's place in its zone. `k` must be below `openJobsInAll`.
 */
export function zoneOfJob(o: Openings, education: number, k: number): { zone: number; rest: number } {
  const tree = o.trees[education] as Int32Array;
  let at = 0;
  let rest = k;
  for (let step = TREE_TOP; step > 0; step >>= 1) {
    const next = at + step;
    if (next <= TRAVEL_ZONES && (tree[next] as number) <= rest) {
      at = next;
      rest -= tree[next] as number;
    }
  }
  return { zone: at, rest };
}

/** Where `id` goes in ascending `list`. */
function placeIn(list: number[], id: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Takes building `id` out of the zone it is filed in, if any. */
function unfile(o: Openings, id: number): void {
  const zone = o.zoneOf[id] ?? -1;
  if (zone < 0) return;
  const at = zone * POP_LEVELS;
  const g = id * POP_LEVELS;
  for (let e = 0; e < POP_LEVELS; e++) {
    const given = o.given[g + e] as number;
    o.open[at + e] = (o.open[at + e] as number) - given;
    addToTree(o.trees[e] as Int32Array, zone, -given);
    o.given[g + e] = 0;
  }
  const list = o.members[zone] as number[];
  list.splice(placeIn(list, id), 1);
  if (list.length === 0) o.zoneList = null;
  o.zoneOf[id] = -1;
}

/**
 * Files building `id` again from its row, the roads and its jobs filled as
 * they are now: out of where it was, and into its zone if it is a live
 * workplace on a road that reaches outside with an open job.
 */
function refile(state: SimState, o: Openings, id: number, reach: Uint8Array, chunks: readonly number[], filled: Int32Array): void {
  fit(o, id + 1);
  const b = state.buildings;
  // An abandoned workplace offers no jobs (M3-24).
  if (id >= b.flags.length || ((b.flags[id] as number) & BUILDING_ALIVE) === 0 || ((b.flags[id] as number) & BUILDING_ABANDONED) !== 0) return unfile(o, id);
  const t = b.type[id] as number;
  const rate = JOBS_PER_CELL[t] ?? 0;
  if (rate <= 0) return unfile(o, id);
  const seg = b.firstSeg[id] as number;
  if (state.roads.segNetwork[seg] !== NETWORK_ROAD || reach[state.roads.segA[seg] as number] !== 1) return unfile(o, id);
  const zone = chunks[id] ?? NO_BUILDING;
  if (zone === NO_BUILDING) return unfile(o, id);
  // jobsForLot, written out.
  const jobs = Math.max(1, Math.floor(rate * ((b.width[id] as number) * (b.depth[id] as number)) + 0.5));
  const levels = jobsUpToLevel(t, jobs);
  const u = id * POP_LEVELS;
  // The open jobs for the highest level are the most any level has.
  if (openJobsFrom(levels, 0, filled, u, 2) === 0) return unfile(o, id);
  const at = zone * POP_LEVELS;
  if (o.zoneOf[id] === zone) {
    // Filed in this zone already and staying, as after most takes: its
    // place in the zone's list holds, so only the sums move (issue #293).
    o.upTo.set(levels, u);
    for (let e = 0; e < POP_LEVELS; e++) {
      const open = openJobsFrom(o.upTo, u, filled, u, e);
      const by = open - (o.given[u + e] as number);
      if (by === 0) continue;
      o.given[u + e] = open;
      o.open[at + e] = (o.open[at + e] as number) + by;
      addToTree(o.trees[e] as Int32Array, zone, by);
    }
    return;
  }
  unfile(o, id);
  o.upTo.set(levels, u);
  for (let e = 0; e < POP_LEVELS; e++) {
    const open = openJobsFrom(o.upTo, u, filled, u, e);
    o.given[u + e] = open;
    o.open[at + e] = (o.open[at + e] as number) + open;
    addToTree(o.trees[e] as Int32Array, zone, open);
  }
  const list = o.members[zone] as number[];
  if (list.length === 0) o.zoneList = null;
  list.splice(placeIn(list, id), 0, id);
  o.zoneOf[id] = zone;
}

/** Every building filed from scratch, in id order. */
function build(state: SimState): Openings {
  watchOpenings(state.pops);
  const o: Openings = {
    roadsSeen: roadChanges(state.roads),
    connections: state.connections,
    open: new Float64Array(TRAVEL_ZONES * POP_LEVELS),
    trees: Array.from({ length: POP_LEVELS }, () => new Int32Array(TRAVEL_ZONES + 1)),
    members: Array.from({ length: TRAVEL_ZONES }, () => []),
    zoneList: null,
    zoneOf: new Int32Array(0),
    upTo: new Int32Array(0),
    given: new Int32Array(0),
  };
  const n = state.buildings.flags.length;
  fit(o, n);
  const reach = outsideReachByNode(state);
  const chunks = buildingChunks(state);
  const filled = popIndexOf(state).filledByEducation;
  for (let id = 0; id < n; id++) refile(state, o, id, reach, chunks, filled);
  return o;
}

/** The openings for `state`, built on first use or after a change of roads, and caught up with every building noted since. */
export function openingsOf(state: SimState): Openings {
  let o = live.get(state.pops);
  if (!o || o.roadsSeen !== roadChanges(state.roads) || o.connections !== state.connections) {
    o = build(state);
    live.set(state.pops, o);
    return o;
  }
  const noted = takeOpeningNotes(state.pops);
  if (noted) {
    const reach = outsideReachByNode(state);
    const chunks = buildingChunks(state);
    const filled = popIndexOf(state).filledByEducation;
    for (const id of noted) refile(state, o, id, reach, chunks, filled);
  }
  return o;
}

/**
 * Files workplace `id` again after a take, as `openingsOf` would on its
 * note, with the reach, zones and jobs filled the caller read for the
 * tick: a take changes none of them but the jobs filled, in place.
 */
export function refileOpening(state: SimState, o: Openings, id: number, reach: Uint8Array, chunks: readonly number[], filled: Int32Array): void {
  refile(state, o, id, reach, chunks, filled);
}

/** The zones with any workplace filed, ascending. */
export function openingZones(o: Openings): Int32Array {
  if (!o.zoneList) {
    const zones: number[] = [];
    for (let z = 0; z < TRAVEL_ZONES; z++) if ((o.members[z] as number[]).length > 0) zones.push(z);
    o.zoneList = Int32Array.from(zones);
  }
  return o.zoneList;
}

/**
 * Why the openings kept for `state` differ from ones built afresh, or null
 * if they do not. For tests: a change that reached them by no note shows
 * here.
 */
export function openingsProblem(state: SimState): string | null {
  const kept = openingsOf(state);
  const fresh = build(state);
  // build() starts the notes again; the kept openings are current, so nothing is lost.
  for (let i = 0; i < fresh.open.length; i++) {
    if (kept.open[i] !== fresh.open[i]) return `zone ${Math.floor(i / POP_LEVELS)} has ${kept.open[i]} open jobs at level ${i % POP_LEVELS}, not ${fresh.open[i]}`;
  }
  for (let e = 0; e < POP_LEVELS; e++) {
    if ((kept.trees[e] as Int32Array).join(",") !== (fresh.trees[e] as Int32Array).join(",")) return `the tree of open jobs for education ${e} differs`;
  }
  for (let z = 0; z < TRAVEL_ZONES; z++) {
    const a = (kept.members[z] as number[]).join(",");
    const b = (fresh.members[z] as number[]).join(",");
    if (a !== b) return `zone ${z} holds workplaces ${a}, not ${b}`;
  }
  return null;
}
