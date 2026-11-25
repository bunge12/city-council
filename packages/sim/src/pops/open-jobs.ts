// Which jobs a pop's education allows (M3-09, PRD "Job matching").
//
// A building's jobs are split between the education levels (buildings/
// jobs.ts): shops and factories take low and medium, offices medium and
// high. A pop may fill a job at its own level or below, so a high
// education pop can work in a shop and a low one never in an office.
//
// Jobs filled are not tied to a level, only to the pops filling them, so a
// building fits its workers when, for each level, the workers at that
// level or below are no more than the jobs at that level or below. With
// the levels nested that is enough for every worker to have a job that
// allows them. The open jobs a pop of education e can take are then the
// least spare, over the levels from e up, of jobs at or below the level
// less workers at or below it. A count per level of each building's
// workers is in the pop index (where.ts), so this reads no pop rows.

import { BUILDINGS_BALANCE, BUILDING_TYPES, EDUCATION_LEVELS } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, type BuildingState } from "../buildings/buildings";
import { buildingJobs, jobsByEducation, jobsByKind } from "../buildings/jobs";
import { DEMAND_BALANCE } from "../demand/balance";
import { NETWORK_ROAD } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { POP_LEVELS } from "./pops";
import { popIndexOf } from "./where";

/**
 * By type, then by jobs: the building's jobs at each level and below,
 * lowest first. A function of the balance alone, made again when the job
 * mix or the education split it was made from is replaced, as a test or
 * the balance script may replace them (M3 review, #365); read only.
 */
let upToCache: (Int32Array | undefined)[][] = BUILDING_TYPES.map(() => []);
let upToFrom: readonly unknown[] = [BUILDINGS_BALANCE.jobMix, BUILDINGS_BALANCE.jobKinds];

/** The jobs of a building of type `type` offering `jobs`, at each education level or below, lowest first. */
export function jobsUpToLevel(type: number, jobs: number): Int32Array {
  if (upToFrom[0] !== BUILDINGS_BALANCE.jobMix || upToFrom[1] !== BUILDINGS_BALANCE.jobKinds) {
    upToCache = BUILDING_TYPES.map(() => []);
    upToFrom = [BUILDINGS_BALANCE.jobMix, BUILDINGS_BALANCE.jobKinds];
  }
  const cache = upToCache[type];
  const kind = BUILDING_TYPES[type];
  if (!cache || !kind) return new Int32Array(POP_LEVELS);
  let out = cache[jobs];
  if (!out) {
    const byLevel = jobsByEducation(jobsByKind(kind, jobs));
    const made = new Int32Array(POP_LEVELS);
    let running = 0;
    EDUCATION_LEVELS.forEach((level, i) => {
      running += byLevel[level];
      made[i] = running;
    });
    cache[jobs] = made;
    out = made;
  }
  return out;
}

/**
 * The open jobs a pop of `education` may take at a workplace whose jobs up
 * to each level are `upTo[u]` to `upTo[u + 2]` (`jobsUpToLevel`) and whose
 * jobs filled by each level are `filled[f]` to `filled[f + 2]`: the least
 * spare over the levels from `education` up. Never below 0. Written out
 * for the three levels, as job matching calls it for every workplace.
 */
export function openJobsFrom(upTo: Int32Array, u: number, filled: Int32Array, f: number, education: number): number {
  const w0 = filled[f] as number;
  const w1 = w0 + (filled[f + 1] as number);
  const w2 = w1 + (filled[f + 2] as number);
  let least = (upTo[u + 2] as number) - w2;
  if (education <= 1) {
    const s1 = (upTo[u + 1] as number) - w1;
    if (s1 < least) least = s1;
  }
  if (education === 0) {
    const s0 = (upTo[u] as number) - w0;
    if (s0 < least) least = s0;
  }
  return least > 0 ? least : 0;
}

/** The open jobs at building `id` a pop of `education` may take. 0 for a building with no jobs. */
export function openJobsFor(state: SimState, id: number, education: number): number {
  const b = state.buildings;
  const jobs = buildingJobs(b, id);
  if (jobs <= 0) return 0;
  return openJobsFrom(jobsUpToLevel(b.type[id] ?? 0, jobs), 0, popIndexOf(state).filledByEducation, id * POP_LEVELS, education);
}

/**
 * Why building `work` cannot take `add` more workers of education `addLevel`
 * once `drop` workers of education `dropLevel` leave it, or null if it can.
 * Only the levels the change adds workers to are checked, so a change that
 * takes workers away is never refused, even at a building a retuned
 * balance left over its jobs.
 */
export function jobsProblem(state: SimState, b: BuildingState, work: number, addLevel: number, add: number, dropLevel: number, drop: number): string | null {
  const jobs = buildingJobs(b, work);
  const upTo = jobsUpToLevel(b.type[work] ?? 0, jobs);
  const filled = popIndexOf(state).filledByEducation;
  let workers = 0;
  let change = 0;
  let problem: string | null = null;
  for (let level = 0; level < POP_LEVELS; level++) {
    workers += filled[work * POP_LEVELS + level] ?? 0;
    if (level === addLevel) change += add;
    if (level === dropLevel) change -= drop;
    if (change <= 0 || workers + change <= (upTo[level] ?? 0)) continue;
    // Too many in all says so first: it is the plainer reason.
    if (level === POP_LEVELS - 1) return `building ${work} offers ${jobs} jobs, not ${workers + change}`;
    problem ??= `building ${work} has ${upTo[level] ?? 0} jobs up to education ${level}, not ${workers + change}`;
  }
  return problem;
}

/** By zone number: the jobs that zone's workplaces offer, and how many of them are open. */
export interface ZoneJobs {
  jobs: Float64Array;
  open: Float64Array;
}

/** By type index: its `jobsPerCell`, 0 for a type with no jobs. Read by `zoneJobs` in place of the type's row. */
const JOBS_PER_CELL = Float64Array.from(BUILDING_TYPES, (t) => (t.jobsPerCell > 0 ? t.jobsPerCell : 0));

/**
 * The jobs offered and open in each zone's workplaces on a road that
 * reaches an outside connection, by zone number, education aside. One pass
 * over the buildings, for the grower on a tick it adds a workplace (M3-09):
 * a shop on a street joined to nothing never fills, and should not hold
 * the rest of the city's shops back.
 *
 * Kept tight, as `eachReachableHome` is (room.ts): each building's jobs are
 * `buildingJobs` worked out inline from a table by type, and the imported
 * constants are locals. Through `buildingJobs` the pass took 4 to 6 ms on
 * the 500,000 scale city, more than the grower's whole share (issue #324).
 */
export function zoneJobs(state: SimState): ZoneJobs {
  const b = state.buildings;
  const net = state.roads;
  const reach = outsideReachByNode(state);
  const filled = popIndexOf(state).filled;
  const zones = ZONING_BALANCE.zones.length + 1;
  const jobsOut = new Float64Array(zones);
  const openOut = new Float64Array(zones);
  const { flags, firstSeg, zone, type, width, depth } = b;
  const { segNetwork, segA } = net;
  const alive = BUILDING_ALIVE;
  const abandoned = BUILDING_ABANDONED;
  const road = NETWORK_ROAD;
  const perCell = JOBS_PER_CELL;
  const n = flags.length;
  for (let id = 0; id < n; id++) {
    const f = flags[id] as number;
    if ((f & alive) === 0 || (f & abandoned) !== 0) continue;
    const rate = perCell[type[id] as number] ?? 0;
    if (rate <= 0) continue;
    const seg = firstSeg[id] as number;
    if (segNetwork[seg] !== road || reach[segA[seg] as number] !== 1) continue;
    // jobsForLot (buildings/jobs.ts), the same sum in the same order.
    const jobs = Math.max(1, Math.floor(rate * ((width[id] as number) * (depth[id] as number)) + 0.5));
    const z = zone[id] as number;
    const open = jobs - (filled[id] ?? 0);
    jobsOut[z] = (jobsOut[z] as number) + jobs;
    if (open > 0) openOut[z] = (openOut[z] as number) + open;
  }
  return { jobs: jobsOut, open: openOut };
}

/**
 * Whether `jobs` holds new workplaces of zone number `zone` back: its open
 * jobs are more than `openJobsShareMax` of its jobs and more than
 * `openJobsMin` (M3-21). Without the floor a zone starting again from
 * nothing, as industry zoned once more after its factories went, was held
 * by its first workshop, whose jobs were all open, and in a city with
 * nobody out of work they never filled.
 */
export function workplacesHeldBy(jobs: ZoneJobs, zone: number): boolean {
  const open = jobs.open[zone] ?? 0;
  return open > DEMAND_BALANCE.openJobsMin && open > DEMAND_BALANCE.openJobsShareMax * (jobs.jobs[zone] ?? 0);
}

/** Whether the grower holds new workplaces of zone number `zone` back now. One pass over the buildings. */
export function workplacesHeld(state: SimState, zone: number): boolean {
  return workplacesHeldBy(zoneJobs(state), zone);
}
