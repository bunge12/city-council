import { GROWER } from "./buildings/grower";
import { POPS } from "./pops/sweep";
import { ARRIVALS } from "./pops/arrivals";
import { DISPLACED } from "./pops/displaced";
import { JOBS } from "./pops/matching";
import { SATISFACTION } from "./pops/satisfaction";
import { TURNOVER } from "./pops/turnover";
import { STATS } from "./stats/stats";
import { BUDGET_SYSTEM, closeMonthOn } from "./economy/budget";
import { dropOldExpropriations } from "./economy/compensation";
import { UPKEEP } from "./economy/upkeep";
import { TAX } from "./economy/tax";
import { DEMAND } from "./demand/demand";
import { keepBuildings } from "./buildings/upkeep";
import { VACANCY } from "./buildings/vacancy";
import { REDEVELOP } from "./buildings/redevelop";
import { LAND_VALUE } from "./landvalue/land-value";
import { PROGRESSION } from "./progression/milestones";
import { applyPending, type DroppedCommand } from "./commands";
import { catchUpDerived } from "./derived";
import type { SimState } from "./state";
import { endTravelStep, stepTravel } from "./travel-times";
import { settleCells } from "./zoning/cell-index";

/** One part of the per-tick update. Systems run in array order. */
export interface System {
  name: string;
  run(state: SimState): void;
}

/**
 * The systems `step` runs each tick, in this fixed order. The statistics
 * come first, so the yearly counts roll over before anything adds to the
 * new year, and a month's sample is the city as the month opens. Upkeep
 * comes next, so the day's first tick charges the day's share of the
 * yearly upkeep for the roads the commands left (M4-04), after the sample
 * and before anything else spends. The tax sweep comes next (M4-05), so
 * the day's slice of homes pays on the people and the land value the tick
 * before left, before any system of this tick moves a pop. Demand comes next, so every system that acts on the bars reads the day's. The pops'
 * sweep comes after it, so every system after it reads the day's slice.
 * Displaced pops find homes next, in the tick that removed theirs and
 * before newcomers take the room (M3-12). Arrivals come after them, so a pop that arrives waits for the next
 * day's, and before the grower, which holds new homes back while there is
 * room in standing ones. Turnover comes after arrivals and before job
 * matching, so a household that replaces another looks for work the same
 * tick. Job matching comes after turnover and before the
 * grower, which holds new workplaces back while open jobs stand.
 * Satisfaction comes after job matching, so a pop that finds work today is
 * scored with it, and before the grower, which then sees the room the
 * day's departures freed. The vacancy check comes after satisfaction, so
 * a home the day's departures emptied is seen empty, and before the
 * grower, which builds nothing in a zone while an abandoned building of it
 * could come back into use. Land value
 * keeps the city centre before the grower builds, so a building grown on
 * the first tick of a month sees the month's centre. Redevelopment comes
 * after both and before the grower (M3-14): it visits the vacancy check's
 * slice, so a building marked unzoned on today's visit is cleared on it,
 * it reads the month's centre, and the grower builds on the ground it
 * clears. The pops of a home it replaces find homes on the next tick.
 * Progression comes last (M4-12), after every system that moves people,
 * so a milestone the day's arrivals pass is reached, and its grant paid,
 * on the tick they arrive.
 */
export const SYSTEMS: readonly System[] = [STATS, UPKEEP, TAX, DEMAND, POPS, DISPLACED, ARRIVALS, TURNOVER, JOBS, SATISFACTION, VACANCY, LAND_VALUE, REDEVELOP, GROWER, PROGRESSION];

/** Name the timer hook reports for applying queued commands. */
export const COMMANDS_SYSTEM = "commands";

/**
 * Name the timer hook reports for walking a slice of zoning cells still
 * settling, and for the blocks and the grower's candidates catching up with
 * the step's changes (derived.ts, `catchUpDerived`).
 */
export const CELLS_SYSTEM = "cells";

/**
 * Lets a host measure tick time per system. The host reads its own clock in
 * these callbacks; the sim never sees a time value (CLAUDE.md rule 3).
 */
export interface SystemTimer {
  start(system: string): void;
  end(system: string): void;
}

function timed(timer: SystemTimer | undefined, name: string, run: () => void): void {
  timer?.start(name);
  run();
  timer?.end(name);
}

/**
 * Name the timer hook reports for rebuilding the travel times between zones
 * after a change of roads (travel-times.ts).
 */
export const TRAVEL_SYSTEM = "travel";

/** Name the timer hook reports for removing buildings whose cells a change of roads blocked. */
export const BUILDINGS_SYSTEM = "buildings";

/**
 * Removes any buildings a settled change of roads left on blocked cells
 * (buildings/upkeep.ts), applies queued commands, walks a slice of any
 * zoning cells still settling and brings derived data up to date with the
 * step's changes, rebuilds a slice of the travel times after a change of
 * roads, then, unless the game is paused, runs every
 * system, advances exactly one tick and, when the new tick is a month's
 * first, closes the month (economy/budget.ts).
 *
 * Returns the queued commands it dropped, with why, for the host to pass
 * on to their senders. Replay has no one to tell and ignores them.
 *
 * The host calls `step` at 10 Hz times the speed. While paused it keeps
 * calling at the 1x rate so commands, including the one that unpauses, still
 * apply. Those calls leave the tick where it is.
 */
export function step(state: SimState, timer?: SystemTimer): DroppedCommand[] {
  let dropped: DroppedCommand[] = [];
  // First, paused or not, so the tick a change of roads settles by is the
  // tick its buildings go, whatever the step before it did.
  timed(timer, BUILDINGS_SYSTEM, () => keepBuildings(state));
  timed(timer, COMMANDS_SYSTEM, () => void (dropped = applyPending(state)));
  // Paused or not, so a change made while paused still settles.
  timed(timer, CELLS_SYSTEM, () => {
    settleCells(state);
    catchUpDerived(state);
  });
  // Paused or not, like the cells: a change made while paused still rebuilds.
  timed(timer, TRAVEL_SYSTEM, () => stepTravel(state));
  if (state.speed === 0) return dropped;
  for (const system of SYSTEMS) {
    timed(timer, system.name, () => system.run(state));
  }
  // After job matching, the last reader of the last whole travel-time table.
  endTravelStep(state);
  state.tick += 1;
  state.cellReads = 0;
  // On the new tick, before anything else happens on it: money a command
  // moves on a month's first tick, paused or not, is the new month's, and
  // the statistics' sample on it holds the month just filed (M4-02).
  timed(timer, BUDGET_SYSTEM, () => {
    closeMonthOn(state);
    // A record a game year old goes on the tick it turns one (M4-09).
    dropOldExpropriations(state);
  });
  return dropped;
}
