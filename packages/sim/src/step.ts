import { GROWER } from "./buildings/grower";
import { POPS } from "./pops/sweep";
import { ARRIVALS } from "./pops/arrivals";
import { JOBS } from "./pops/matching";
import { STATS } from "./stats/stats";
import { DEMAND } from "./demand/demand";
import { keepBuildings } from "./buildings/upkeep";
import { LAND_VALUE } from "./landvalue/land-value";
import { applyPending, type DroppedCommand } from "./commands";
import { catchUpDerived } from "./derived";
import type { SimState } from "./state";
import { stepTravel } from "./travel-times";
import { settleCells } from "./zoning/cell-index";

/** One part of the per-tick update. Systems run in array order. */
export interface System {
  name: string;
  run(state: SimState): void;
}

/**
 * The systems `step` runs each tick, in this fixed order. The statistics
 * come first, so the yearly counts roll over before anything adds to the
 * new year, and a month's sample is the city as the month opens. Demand
 * comes next, so every system that acts on the bars reads the day's. The pops'
 * sweep comes after it, so every system after it reads the day's slice.
 * Arrivals come after the sweep, so a pop that arrives waits for the next
 * day's, and before the grower, which holds new homes back while there is
 * room in standing ones. Job matching comes after arrivals and before the
 * grower, which holds new workplaces back while open jobs stand. Land value
 * keeps the city centre before the grower builds, so a building grown on
 * the first tick of a month sees the month's centre.
 */
export const SYSTEMS: readonly System[] = [STATS, DEMAND, POPS, ARRIVALS, JOBS, LAND_VALUE, GROWER];

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
 * system and advances exactly one tick.
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
  state.tick += 1;
  state.cellReads = 0;
  return dropped;
}
