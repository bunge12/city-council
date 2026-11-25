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
// - A change of roads can change whether a workplace's road reaches
//   outside. It watches the network's nodes and segments, as the outside
//   reach does (roads/outside.ts), and on its next read after any of them
//   comes or goes, paused or not, refiles only the workplaces whose road
//   now reaches outside where it did not, or the other way (#313). A
//   building's zone is its lot's chunk, which no road moves, and a road
//   that removes a building notes it. A change of the outside connections
//   builds it again whole.
// - Job matching files its own takes again as it makes them.
//
// Each filing also counts the workplace's jobs, and how many are open, in
// its zone of the zoning (commercial, office, industrial or mixed), for the
// grower, which holds a zone back while too many of its jobs stand open
// (open-jobs.ts, `workplacesHeldBy`). Counted are the live workplaces that
// are not abandoned and whose road reaches outside, full or not, whatever
// their travel zone, as `countZoneJobs` counts them in one pass. Until
// #366 the grower made that pass itself, once on a tick it added a
// workplace: about once a game day on a big city, so the engine often had
// its compiled code thrown away between calls, and on the 500,000 scale
// city a cold pass took 3 to 7 ms of the grower's 5 ms share.
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
import { ZONING_BALANCE } from "../zoning/balance";
import { countZoneJobs, jobsUpToLevel, openJobsFrom, type ZoneJobs } from "./open-jobs";
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
  /**
   * By building: 1 if its road reached outside when it was last filed, for
   * a live workplace that is not abandoned. What a change of roads compares
   * (`catchUpRoads`).
   */
  roadOk: Uint8Array;
  /** By zone number of the zoning: the jobs of its workplaces counted, as `countZoneJobs` gives them. */
  zoneJobs: Float64Array;
  /** By zone number of the zoning: how many of those jobs are open. */
  zoneOpen: Float64Array;
  /** By building: the jobs it adds to `zoneJobs`, 0 while it is not counted. */
  counted: Int32Array;
  /** By building: the open jobs it adds to `zoneOpen`. */
  countedOpen: Int32Array;
  /** By building: the zone number it is counted in, 0 while it is not counted. */
  countedZone: Uint8Array;
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

function grownBytes(array: Uint8Array, length: number): Uint8Array {
  if (array.length >= length) return array;
  const next = new Uint8Array(length);
  next.set(array);
  return next;
}

/** Room in `o` for every building id `n` covers. */
function fit(o: Openings, n: number): void {
  if (o.zoneOf.length >= n) return;
  o.zoneOf = grownTo(o.zoneOf, n, -1);
  const length = o.zoneOf.length;
  o.upTo = grownTo(o.upTo, length * POP_LEVELS, 0);
  o.given = grownTo(o.given, length * POP_LEVELS, 0);
  o.roadOk = grownBytes(o.roadOk, length);
  o.counted = grownTo(o.counted, length, 0);
  o.countedOpen = grownTo(o.countedOpen, length, 0);
  o.countedZone = grownBytes(o.countedZone, length);
}

/** Building `id`'s jobs filled, every level together, from `filled` by building times POP_LEVELS plus education. */
function filledAt(filled: Int32Array, id: number): number {
  const u = id * POP_LEVELS;
  let sum = 0;
  for (let e = 0; e < POP_LEVELS; e++) sum += filled[u + e] ?? 0;
  return sum;
}

/** Counts building `id` as adding `jobs`, `open` of them open, to zone number `zone`, in place of what it added before. */
function setCount(o: Openings, id: number, zone: number, jobs: number, open: number): void {
  const was = o.countedZone[id] as number;
  const wasJobs = o.counted[id] as number;
  const wasOpen = o.countedOpen[id] as number;
  if (was === zone && wasJobs === jobs && wasOpen === open) return;
  o.zoneJobs[was] = (o.zoneJobs[was] as number) - wasJobs;
  o.zoneOpen[was] = (o.zoneOpen[was] as number) - wasOpen;
  o.zoneJobs[zone] = (o.zoneJobs[zone] as number) + jobs;
  o.zoneOpen[zone] = (o.zoneOpen[zone] as number) + open;
  o.countedZone[id] = zone;
  o.counted[id] = jobs;
  o.countedOpen[id] = open;
}

/** Counts building `id` as adding nothing to the zones' jobs. */
function uncount(o: Openings, id: number): void {
  if ((o.counted[id] as number) !== 0) setCount(o, id, 0, 0, 0);
}

/** Counts the open jobs of building `id` again after a take, which changes only its jobs filled. */
function countOpen(o: Openings, id: number, filled: Int32Array): void {
  const jobs = o.counted[id] as number;
  if (jobs > 0) setCount(o, id, o.countedZone[id] as number, jobs, Math.max(0, jobs - filledAt(filled, id)));
}

/** Whether segment `seg` is a road whose first end reaches an outside connection. */
function reachesOutside(net: RoadNetwork, seg: number, reach: Uint8Array): boolean {
  return net.segNetwork[seg] === NETWORK_ROAD && reach[net.segA[seg] as number] === 1;
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

/** Moves the open jobs building `id`, filed in `zone` with its jobs in `upTo`, gives its zone to what `filled` leaves open now. */
function moveGiven(o: Openings, id: number, zone: number, filled: Int32Array): void {
  const u = id * POP_LEVELS;
  const at = zone * POP_LEVELS;
  for (let e = 0; e < POP_LEVELS; e++) {
    const open = openJobsFrom(o.upTo, u, filled, u, e);
    const by = open - (o.given[u + e] as number);
    if (by === 0) continue;
    o.given[u + e] = open;
    o.open[at + e] = (o.open[at + e] as number) + by;
    addToTree(o.trees[e] as Int32Array, zone, by);
  }
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
  if (id >= b.flags.length || ((b.flags[id] as number) & BUILDING_ALIVE) === 0 || ((b.flags[id] as number) & BUILDING_ABANDONED) !== 0) {
    uncount(o, id);
    return unfile(o, id);
  }
  const t = b.type[id] as number;
  const rate = JOBS_PER_CELL[t] ?? 0;
  if (rate <= 0) {
    uncount(o, id);
    return unfile(o, id);
  }
  const roadOk = reachesOutside(state.roads, b.firstSeg[id] as number, reach);
  o.roadOk[id] = roadOk ? 1 : 0;
  if (!roadOk) {
    uncount(o, id);
    return unfile(o, id);
  }
  // jobsForLot, written out, as `countZoneJobs` has it.
  const jobs = Math.max(1, Math.floor(rate * ((b.width[id] as number) * (b.depth[id] as number)) + 0.5));
  // Counted whatever its travel zone, full or not, as `countZoneJobs` counts it.
  setCount(o, id, b.zone[id] as number, jobs, Math.max(0, jobs - filledAt(filled, id)));
  const zone = chunks[id] ?? NO_BUILDING;
  if (zone === NO_BUILDING) return unfile(o, id);
  const levels = jobsUpToLevel(t, jobs);
  const u = id * POP_LEVELS;
  // The open jobs for the highest level are the most any level has.
  if (openJobsFrom(levels, 0, filled, u, 2) === 0) return unfile(o, id);
  if (o.zoneOf[id] === zone) {
    // Filed in this zone already and staying, as after most takes: its
    // place in the zone's list holds, so only the sums move (issue #293).
    o.upTo.set(levels, u);
    return moveGiven(o, id, zone, filled);
  }
  unfile(o, id);
  const at = zone * POP_LEVELS;
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
    roadOk: new Uint8Array(0),
    zoneJobs: new Float64Array(ZONING_BALANCE.zones.length + 1),
    zoneOpen: new Float64Array(ZONING_BALANCE.zones.length + 1),
    counted: new Int32Array(0),
    countedOpen: new Int32Array(0),
    countedZone: new Uint8Array(0),
  };
  const n = state.buildings.flags.length;
  fit(o, n);
  const reach = outsideReachByNode(state);
  const chunks = buildingChunks(state);
  const filled = popIndexOf(state).filledByEducation;
  for (let id = 0; id < n; id++) refile(state, o, id, reach, chunks, filled);
  return o;
}

/**
 * After a change of roads: refiles every live workplace that is not
 * abandoned whose road reaches outside now where it did not when it was
 * filed, or the other way. Nothing else in a filing reads the roads, so
 * the rest stand as they are. One pass over the buildings, reading three
 * arrays each, where building afresh files every workplace (#313).
 */
function catchUpRoads(state: SimState, o: Openings): void {
  const b = state.buildings;
  const n = b.flags.length;
  fit(o, n);
  const net = state.roads;
  const reach = outsideReachByNode(state);
  const chunks = buildingChunks(state);
  const filled = popIndexOf(state).filledByEducation;
  const alive = BUILDING_ALIVE;
  const abandoned = BUILDING_ABANDONED;
  const { flags, type, firstSeg } = b;
  const roadOk = o.roadOk;
  for (let id = 0; id < n; id++) {
    const f = flags[id] as number;
    if ((f & alive) === 0 || (f & abandoned) !== 0 || (JOBS_PER_CELL[type[id] as number] ?? 0) <= 0) continue;
    const now = reachesOutside(net, firstSeg[id] as number, reach) ? 1 : 0;
    if (now !== roadOk[id]) refile(state, o, id, reach, chunks, filled);
  }
  o.roadsSeen = roadChanges(net);
}

/** The openings for `state`, built on first use, caught up after a change of roads, and with every building noted since. */
export function openingsOf(state: SimState): Openings {
  let o = live.get(state.pops);
  if (!o || o.connections !== state.connections) {
    o = build(state);
    live.set(state.pops, o);
    return o;
  }
  // The notes first: a road that removed a building noted it, and its row is gone.
  const changed = o.roadsSeen !== roadChanges(state.roads);
  const noted = takeOpeningNotes(state.pops);
  if (noted) {
    const reach = outsideReachByNode(state);
    const chunks = buildingChunks(state);
    const filled = popIndexOf(state).filledByEducation;
    for (const id of noted) refile(state, o, id, reach, chunks, filled);
  }
  if (changed) catchUpRoads(state, o);
  return o;
}

/**
 * Files workplace `id` again after a take, as `openingsOf` would on its
 * note, with the reach, zones and jobs filled the caller read for the
 * tick: a take changes none of them but the jobs filled, in place.
 */
export function refileOpening(state: SimState, o: Openings, id: number, reach: Uint8Array, chunks: readonly number[], filled: Int32Array): void {
  const zone = o.zoneOf[id] ?? -1;
  if (zone < 0 || zone !== chunks[id]) return refile(state, o, id, reach, chunks, filled);
  // Filed, as every workplace a pop draws is: its row, its road and its
  // jobs are as they were when it was filed, so only what the take left
  // open moves, as `refile` would move it without reading the row again
  // (issue #314).
  countOpen(o, id, filled);
  if (openJobsFrom(o.upTo, id * POP_LEVELS, filled, id * POP_LEVELS, 2) === 0) return unfile(o, id);
  moveGiven(o, id, zone, filled);
}

/**
 * By zone number of the zoning: the jobs offered and open in each zone's
 * workplaces on a road that reaches outside, as `countZoneJobs` counts them,
 * from the counts kept here. Copies, so a caller may add to them, as the
 * grower does for each workplace it builds.
 */
export function zoneJobs(state: SimState): ZoneJobs {
  const o = openingsOf(state);
  return { jobs: o.zoneJobs.slice(), open: o.zoneOpen.slice() };
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
  const counted = countZoneJobs(state);
  for (let z = 0; z < counted.jobs.length; z++) {
    if (kept.zoneJobs[z] !== counted.jobs[z] || kept.zoneOpen[z] !== counted.open[z]) {
      return `zone number ${z} counts ${kept.zoneJobs[z]} jobs, ${kept.zoneOpen[z]} open, not ${counted.jobs[z]}, ${counted.open[z]}`;
    }
  }
  return null;
}
