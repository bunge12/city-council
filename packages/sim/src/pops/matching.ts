// Job matching (M3-09, PRD "Job matching"): pops find work, nearer jobs
// first.
//
// The JOBS system visits the day's slice of the pops (sweep.ts) and gives
// each one without work, and with someone in it who works, one draw. It
// picks among the open jobs its education allows (open-jobs.ts), each
// weighted by the free-flow travel time from its home, 1 / (1 + (t / h)^k)
// with h and k from `jobMatching` in demand.json. A pop that finds nothing
// looks again the next day. A pop keeps its job until it loses it: when its
// workplace goes, or by the systems after M3 that move people.
//
// A zone's chance is its open jobs times the weight of the time to it from
// the pop's home zone (travel-times.ts), and a workplace's within the zone
// its open jobs, so the cost is not times buildings (issue #178). The open
// jobs at each travel zone's workplaces, for each level of education, are
// kept current between ticks (openings.ts). A pop draws a job among all the
// open jobs its education allows and keeps it with a chance of its weight,
// else draws again (`drawWorkplace`), which gives those chances in a few
// draws rather than a pass over the zones for every pop.
// The draws come from the
// generator in state. A pop whose home zone has no route to any zone with
// open jobs it may take stays without work, and so does every pop while
// the travel times are still being rebuilt after a change of roads.
//
// Only workplaces on a road that reaches an outside connection are
// offered, as only homes on one take newcomers (room.ts): a shop on a
// street joined to nothing stays empty.
//
// A pop with more workers than the building it drew has open jobs is split
// (PRD "Job matching"): the largest part whose workers fit takes the jobs,
// and the rest becomes a pop of its own, in the same home with the same
// profile, which looks again when the sweep next reaches it. A household
// home, the single family home, holds one household and is not split: its
// pop waits for the next day's draw. A part with nobody who works is never
// made the one that takes the jobs.
//
// Nothing here is state beyond the pops themselves and the generator, and
// the openings give the same answers built afresh, so a city saved mid-day
// matches the same pops to the same jobs as one that never stopped.

import { BUILDING_TYPES } from "../buildings/balance";
import { NO_BUILDING, buildingChunks } from "../buildings/where";
import { DEMAND_BALANCE } from "../demand/balance";
import { nextFloat, nextInt } from "../rng";
import { NONE } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import { ROUTING_BALANCE } from "../roads/routing";
import type { SimState } from "../state";
import type { System } from "../step";
import { NO_ROUTE_SECONDS, TRAVEL_ZONES, travelTimeTable, travelTimesReady } from "../travel-times";
import { dropOpeningNote } from "./opening-changes";
import { openJobsFrom } from "./open-jobs";
import { openJobsInAll, openingZones, openingsOf, refileOpening, zoneOfJob, type Openings } from "./openings";
import { NO_WORK, POP_ALIVE, POP_LEVELS, addPop, setPopSize, setPopWork, workersFor } from "./pops";
import { popSlice } from "./sweep";
import { popIndexOf } from "./where";

/** The name the timer hook reports for job matching. */
export const JOBS_SYSTEM = "jobs";

/** By type index: 1 for a type one household lives in, whose pop is never split. */
const ONE_HOUSEHOLD = Uint8Array.from(BUILDING_TYPES, (t) => (t.oneHousehold ? 1 : 0));

/** The weight of an open job `seconds` from home: 1 / (1 + (t / h)^k), with `jobMatching` from demand.json. Multiplies only (CLAUDE.md rule 6). */
export function jobWeight(seconds: number): number {
  const { halfWeightSeconds, falloffPower } = DEMAND_BALANCE.jobMatching;
  const r = seconds / halfWeightSeconds;
  let p = r;
  for (let i = 1; i < falloffPower; i++) p *= r;
  return 1 / (1 + p);
}

/** By whole second: `jobWeight` of that many seconds, for every time the travel table holds, and the balance it was made from. */
let weightTable: { half: number; power: number; bySecond: Float64Array } | null = null;

/** `jobWeight` of every whole number of seconds up to NO_ROUTE_SECONDS: made on first use, and again if the balance numbers change, as a test may change them. */
function weightsBySecond(): Float64Array {
  const { halfWeightSeconds, falloffPower } = DEMAND_BALANCE.jobMatching;
  if (!weightTable || weightTable.half !== halfWeightSeconds || weightTable.power !== falloffPower) {
    const bySecond = new Float64Array(NO_ROUTE_SECONDS + 1);
    for (let t = 0; t <= NO_ROUTE_SECONDS; t++) bySecond[t] = jobWeight(t);
    weightTable = { half: halfWeightSeconds, power: falloffPower, bySecond };
  }
  return weightTable.bySecond;
}

/** A tick's matching: the openings, the travel times, and scratch kept between pops. */
interface Matcher {
  state: SimState;
  openings: Openings;
  /** The zones with workplaces filed as the tick started (`openingZones`). Takes only fill jobs, so none joins during the tick. */
  zones: Int32Array;
  /** The pop index's jobs filled by education (where.ts), kept current in place by takes. No building comes or goes while a tick matches, so the array is not replaced. */
  filled: Int32Array;
  /** By building: its travel zone (`buildingChunks`). */
  chunks: readonly number[];
  /** By road node: 1 where it reaches an outside connection (`outsideReachByNode`). */
  reach: Uint8Array;
  table: Uint16Array;
  sources: Int32Array;
  /** `jobWeight` by whole second (`weightsBySecond`), and of `sameZoneSeconds`. */
  bySecond: Float64Array;
  sameZone: number;
  /** The draw's running total over `zones`, for a pop drawn by scan. */
  running: Float64Array;
}

/** How many jobs a pop's draw may pass over before it weighs every zone in turn instead. */
const DRAW_TRIES = 64;

/** The weight of a job in zone `zone` for a pop at home zone `home`, 0 for no route. */
function weightBetween(m: Matcher, home: number, zone: number): number {
  if (zone === home) return m.sameZone;
  if (m.sources[zone] === NONE) return 0;
  const seconds = m.table[home * TRAVEL_ZONES + zone] as number;
  return seconds === NO_ROUTE_SECONDS ? 0 : (m.bySecond[seconds] as number);
}

/**
 * The workplace of the `rest`-th open job for `education` in zone `zone`,
 * counting its workplaces in id order. Each one's open jobs are those it
 * gives its zone (openings.ts), current since every take is filed again.
 */
function workplaceAt(m: Matcher, zone: number, education: number, rest: number): number {
  const { given, members } = m.openings;
  const levels = POP_LEVELS;
  let k = rest;
  for (const id of members[zone] as number[]) {
    const have = given[id * levels + education] as number;
    if (k < have) return id;
    k -= have;
  }
  // The zone's open jobs are the sum of its workplaces', so the walk always lands.
  throw new Error(`zone ${zone}'s open jobs do not add up`);
}

/**
 * Draws a workplace for a pop of `education` at home zone `home`: each open
 * job its education allows as likely as its weight, or -1 for none it can
 * reach.
 *
 * A job is drawn among all the city's open jobs for the education, each as
 * likely (`zoneOfJob`), and kept with a chance of its weight, which is at
 * most 1; else another is drawn. That gives each zone a chance of its open
 * jobs times its weight, as the PRD asks, in a few draws, where weighing
 * every zone costs the zones for every pop. A pop that passes over
 * DRAW_TRIES jobs, because few it can reach are open or all are far, weighs
 * every zone in turn instead (`drawByScan`), which gives the same chances.
 */
function drawWorkplace(m: Matcher, home: number, education: number): number {
  if (m.sources[home] === NONE) return -1;
  const total = openJobsInAll(m.openings, education);
  if (total <= 0) return -1;
  const rng = m.state.rng;
  for (let tries = 0; tries < DRAW_TRIES; tries++) {
    const { zone, rest } = zoneOfJob(m.openings, education, nextInt(rng, total));
    const weight = weightBetween(m, home, zone);
    if (weight > 0 && nextFloat(rng) < weight) return workplaceAt(m, zone, education, rest);
  }
  return drawByScan(m, home, education);
}

/** `drawWorkplace` by weighing every zone in turn: one draw, or none when nothing it can reach is open. */
function drawByScan(m: Matcher, home: number, education: number): number {
  const { zones, running } = m;
  const open = m.openings.open;
  const levels = POP_LEVELS;
  let total = 0;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i] as number;
    const jobs = open[zone * levels + education] as number;
    if (jobs > 0) total += weightBetween(m, home, zone) * jobs;
    running[i] = total;
  }
  if (!(total > 0)) return -1;
  // The first zone whose running total passes the draw; one with no share
  // never does, since its total equals the one before it.
  const u = nextFloat(m.state.rng) * total;
  let lo = 0;
  let hi = zones.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((running[mid] as number) > u) hi = mid;
    else lo = mid + 1;
  }
  const zone = zones[lo] as number;
  return workplaceAt(m, zone, education, nextInt(m.state.rng, open[zone * levels + education] as number));
}

/**
 * The size of the part of a pop of `size` people, with `children`, that
 * fits `open` jobs: the largest below `size` with at least one worker and
 * no more workers than `open`. 0 if there is none.
 */
export function partThatFits(size: number, children: number, open: number): number {
  for (let part = size - 1; part >= 1; part--) {
    const workers = workersFor(part, children);
    if (workers === 0) return 0;
    if (workers <= open) return part;
  }
  return 0;
}

/** Gives pop `id` a job at `work`, splitting it when its workers do not all fit, as the header says. Keeps the openings current. */
function takeJob(m: Matcher, id: number, work: number): void {
  const { state, openings } = m;
  const p = state.pops;
  const size = p.size[id] ?? 0;
  const children = p.children[id] ?? 0;
  const home = p.home[id] ?? 0;
  const education = p.education[id] ?? 0;
  const open = openJobsFrom(openings.upTo, work * POP_LEVELS, m.filled, work * POP_LEVELS, education);
  if (workersFor(size, children) > open) {
    if (ONE_HOUSEHOLD[state.buildings.type[home] ?? 0] === 1) return;
    const part = partThatFits(size, children, open);
    if (part === 0) return;
    setPopSize(state, id, part);
    addPop(state, { home, size: size - part, education, wealth: p.wealth[id] ?? 0, children, satisfaction: p.satisfaction[id] ?? 0 });
  }
  setPopWork(state, id, work);
  refileOpening(state, openings, work, m.reach, m.chunks, m.filled);
  dropOpeningNote(p, work);
}

/** The job matching system's work for one tick, as the header says. */
export function matchJobs(state: SimState): void {
  if (!travelTimesReady(state)) return;
  const { from, to } = popSlice(state);
  const p = state.pops;
  let m: Matcher | null = null;
  for (let id = from; id < to; id++) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0 || p.work[id] !== NO_WORK) continue;
    if (workersFor(p.size[id] ?? 0, p.children[id] ?? 0) === 0) continue;
    if (!m) {
      const openings = openingsOf(state);
      const zones = openingZones(openings);
      if (zones.length === 0) return;
      const { table, sources } = travelTimeTable(state);
      m = {
        state,
        openings,
        zones,
        filled: popIndexOf(state).filledByEducation,
        chunks: buildingChunks(state),
        reach: outsideReachByNode(state),
        table,
        sources,
        bySecond: weightsBySecond(),
        sameZone: jobWeight(ROUTING_BALANCE.travelTimes.sameZoneSeconds),
        running: new Float64Array(zones.length),
      };
    }
    const home = m.chunks[p.home[id] ?? 0] ?? NO_BUILDING;
    if (home === NO_BUILDING) continue;
    const work = drawWorkplace(m, home, p.education[id] ?? 0);
    if (work >= 0) takeJob(m, id, work);
  }
}

/**
 * The step's system for job matching. It runs after arrivals, so a
 * newcomer on an id the day's sweep has not yet passed may find work the
 * day it comes, and before the grower, which holds new workplaces back
 * while the open jobs already standing are above their share.
 */
export const JOBS: System = { name: JOBS_SYSTEM, run: matchJobs };
