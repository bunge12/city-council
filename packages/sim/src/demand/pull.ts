// What a demand bar pulls before what is already waiting (#420).
//
// Each bar's last part takes away what is already waiting for people or
// workers: homes still filling on the residential bar, open jobs on the
// others (demand.ts, `WAITING_PART`). The bar the player sees includes it,
// so a bar reads 0 while the grower waits for room or jobs to fill. The
// systems that act on demand read the bar without it, its pull: arrivals,
// the grower's daily quota, redevelopment, vacancy and departures. People
// still come to fill the room that stands empty, and the city grows at the
// pace it did, while the bar says nothing more needs zoning.
//
// The waiting part never takes a bar below zero and never adds to one, so
// the pull is the bar less that part, and a bar below zero pulls what it
// reads. A file of its own so the pops modules can read it without
// importing the demand system, which reads them.

import type { DemandBar, DemandState } from "./demand";

/** Each bar's part for what is already waiting, the last of its parts. */
export const WAITING_PART = {
  residential: "homesFilling",
  commercial: "jobsOpen",
  office: "jobsOpen",
  industrial: "jobsOpen",
} as const satisfies Record<DemandBar, string>;

/** Bar `bar` without its waiting part: what the systems that act on demand read. */
export function demandPull(demand: DemandState, bar: DemandBar): number {
  const state = demand[bar];
  return state.value - (state.parts[WAITING_PART[bar]] ?? 0);
}
