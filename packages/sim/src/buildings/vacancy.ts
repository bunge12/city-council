// Vacancy and abandonment (M3-24, PRD "Four demand bars" and "Vacancy and
// abandonment").
//
// A building is empty when nobody lives in it, if it is a home, and none of
// its jobs is filled while its zone's bar is below zero, if it offers jobs.
// A mixed building is empty only when both hold. A home emptied by turnover
// alone is empty too, but with the residential bar above zero arrivals fill
// it again long before it is abandoned.
//
// Once a game day the VACANCY system visits each building, a slice a tick:
// tick k of the day visits the ids that leave k over `ticksPerDay`, in id
// order. That is a function of the tick, so every machine visits the same
// buildings on the same tick, a save mid-day carries on where it stopped,
// and a building added during the day is visited on its own tick. On a visit:
//
// - A building in use that is empty, and has stood `vacancy.newDays` game
//   days since it was built or came back into use (demand.json), becomes
//   vacant. A building just built is not vacant before anyone could move in.
// - A vacant building that is no longer empty is back in use. One that has
//   stood vacant `vacancy.abandonDays` game days is abandoned: it offers no
//   jobs (jobs.ts) and no room (buildings.ts, `homeRoom`), and its jobs
//   leave the running totals, so the bars do not read a dead district as
//   open jobs and spare room. Nobody lives or works in it as it goes, since
//   it is empty.
// - An abandoned building comes back into use when its zone's bar is above
//   zero, the grower's bar for it (grower.ts, `zoneBar`), if every cell of
//   its lot is still zoned for what it is and no change of roads is
//   settling. One whose ground was rezoned stands abandoned with
//   BUILDING_UNZONED beside it, which the visit sets and clears as it finds
//   the ground; issue 14 clears such buildings.
//
// A vacant building still offers its room and jobs, so people move in and
// the next visit finds it in use. The grower adds no building to a zone
// while it has an abandoned building not marked unzoned
// (`abandonedWaiting`), so the city fills its empty buildings before it
// builds new ones: the grower builds only while the zone's bar is above
// zero, and on those days the visits bring every such building back within
// the day. The grower reads the mark rather than looking at each lot's
// ground, which on a town of abandoned buildings is too slow for a tick, so
// a building rezoned since its last visit holds the grower for up to a day.
//
// Each change of state notes the building for the delta (changes.ts) and
// for job matching's openings (pops/opening-changes.ts). Nothing here draws
// from the generator, and the arithmetic is whole ticks.

import { TIME_BALANCE } from "../calendar";
import { DEMAND_BALANCE } from "../demand/balance";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteOpening } from "../pops/opening-changes";
import { popIndexOf } from "../pops/where";
import { countBuilding } from "../stats/stats";
import { ZONING_BALANCE } from "../zoning/balance";
import { cellsSettled } from "../zoning/cell-index";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_UNZONED, BUILDING_VACANT } from "./buildings";
import { noteBuildingChanged } from "./changes";
import { zoneBar } from "./grower";
import { lotJobs } from "./jobs";
import { lotZonedFor } from "./where";

/** The name the timer hook reports for the vacancy check. */
export const VACANCY_SYSTEM = "vacancy";

/** By zone number, with 0 unused: the zone's id, for `zoneBar`. */
const ZONE_IDS: readonly string[] = ["", ...ZONING_BALANCE.zones.map((z) => z.id)];

/** The bar building `id`'s zone reads, as the grower reads it. */
function barOf(state: SimState, id: number): number {
  return zoneBar(state.demand, ZONE_IDS[state.buildings.zone[id] ?? 0] ?? "");
}

/** Whether live building `id` is empty, as the header says. A building with neither room nor jobs never is. */
export function buildingEmpty(state: SimState, id: number): boolean {
  const b = state.buildings;
  const index = popIndexOf(state);
  const home = (b.residents[id] ?? 0) > 0;
  const work = lotJobs(b, id) > 0;
  if (!home && !work) return false;
  if (home && (index.people[id] ?? 0) > 0) return false;
  if (work && ((index.filled[id] ?? 0) > 0 || !(barOf(state, id) < 0))) return false;
  return true;
}

/** Whether abandoned building `id` may come back into use now: its zone's bar above zero, its ground still zoned for it and the cells settled. */
export function mayComeBack(state: SimState, id: number): boolean {
  return barOf(state, id) > 0 && cellsSettled(state) && lotZonedFor(state, id);
}

/**
 * Sets live building `id`'s state to `status`, BUILDING_VACANT,
 * BUILDING_ABANDONED or 0 for in use, as of this tick. Its jobs leave the
 * running totals as it is abandoned and come back with it.
 */
function setStatus(state: SimState, id: number, status: number): void {
  const b = state.buildings;
  // Out of the totals as it was and back as it is, so only its jobs offered move.
  countBuilding(state, id, -1);
  b.flags[id] = BUILDING_ALIVE | status;
  b.statusSince[id] = state.tick;
  countBuilding(state, id, 1);
  noteBuildingChanged(b, id);
  noteOpening(state.pops, id);
}

/** Visits live building `id`, as the header says. */
function visit(state: SimState, id: number, newTicks: number, abandonTicks: number): void {
  const b = state.buildings;
  const flags = b.flags[id] ?? 0;
  const since = state.tick - (b.statusSince[id] ?? 0);
  if ((flags & BUILDING_ABANDONED) !== 0) {
    // While a change of roads settles, the ground cannot be read: wait for the next visit.
    if (!cellsSettled(state)) return;
    const zoned = lotZonedFor(state, id);
    if (zoned && barOf(state, id) > 0) return setStatus(state, id, 0);
    const now = BUILDING_ALIVE | BUILDING_ABANDONED | (zoned ? 0 : BUILDING_UNZONED);
    if (flags !== now) {
      b.flags[id] = now;
      noteBuildingChanged(b, id);
    }
    return;
  }
  const empty = buildingEmpty(state, id);
  if ((flags & BUILDING_VACANT) !== 0) {
    if (!empty) setStatus(state, id, 0);
    else if (since >= abandonTicks) setStatus(state, id, BUILDING_ABANDONED);
    return;
  }
  if (empty && since >= newTicks) setStatus(state, id, BUILDING_VACANT);
}

/** The vacancy check's work for one tick: the day's slice of the buildings, as the header says. */
export function checkVacancy(state: SimState): void {
  const perDay = TIME_BALANCE.ticksPerDay;
  const { newDays, abandonDays } = DEMAND_BALANCE.vacancy;
  const newTicks = newDays * perDay;
  const abandonTicks = abandonDays * perDay;
  const flags = state.buildings.flags;
  const n = flags.length;
  for (let id = state.tick % perDay; id < n; id += perDay) {
    if (((flags[id] ?? 0) & BUILDING_ALIVE) !== 0) visit(state, id, newTicks, abandonTicks);
  }
}

/**
 * By zone number, with 0 unused: the abandoned buildings of that zone not
 * marked BUILDING_UNZONED, which come back on their next visit while the
 * zone's bar is above zero. One pass over the buildings' flags. The grower
 * asks on a tick it would add a building.
 */
export function abandonedWaiting(state: SimState): Int32Array {
  const b = state.buildings;
  const out = new Int32Array(ZONE_IDS.length);
  const { flags, zone } = b;
  const mark = BUILDING_ABANDONED | BUILDING_UNZONED;
  const waiting = BUILDING_ABANDONED;
  for (let id = 0; id < flags.length; id++) {
    if (((flags[id] as number) & mark) !== waiting) continue;
    const z = zone[id] as number;
    out[z] = (out[z] ?? 0) + 1;
  }
  return out;
}

/**
 * The step's system for vacancy and abandonment. It runs after
 * satisfaction, so a home the day's departures emptied is seen empty, and
 * before the grower, which holds a zone back while an abandoned building of
 * it could come back.
 */
export const VACANCY: System = { name: VACANCY_SYSTEM, run: checkVacancy };
