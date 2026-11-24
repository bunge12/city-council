// The daily sweep over the pops (M3-03). A system that visits every pop,
// such as job matching, satisfaction or turnover, may not walk 150,000 of
// them in one tick. It visits a slice a tick instead, so the whole array is
// covered once a game day.
//
// On a day's first tick the POPS system writes the pop id limit into
// `pops.sweep`. Tick k of the day then takes every id below it that leaves
// k over ticksPerDay: k, k + ticksPerDay, k + 2 ticksPerDay and so on. That
// is a function of the tick and of state, so every machine visits the same
// pops on the same tick (CLAUDE.md rule 3), and a save mid-day carries on
// where it stopped. A pop added during the day past the limit waits for the
// next day.
//
// Strided, not in runs of ids (issue #354). New pops take the highest ids,
// so a day's newcomers and the pops job matching split off were all in the
// last run, and on the 500,000 scale city its tick matched about 700 pops
// looking for work while the ticks before it matched a few. Strided, each
// tick takes its share of them. Redevelopment strides its buildings the same
// way (buildings/redevelop.ts).

import { TIME_BALANCE } from "../calendar";
import type { SimState } from "../state";
import { POP_ALIVE, popIdLimit } from "./pops";

/** The name the timer hook reports for the sweep's start of day. */
export const POPS_SYSTEM = "pops";

/** On a day's first tick, the pop ids the day's sweep covers. */
function startSweep(state: SimState): void {
  if (state.tick % TIME_BALANCE.ticksPerDay === 0) state.pops.sweep = popIdLimit(state.pops);
}

/** The step's system for the sweep. Runs before every system that reads a slice. */
export const POPS = { name: POPS_SYSTEM, run: startSweep };

/** The pop ids this tick's slice covers: `from`, then every `step` after it, below `to`. Free ids among them are for the caller to skip. */
export function popSlice(state: SimState): { from: number; to: number; step: number } {
  const perDay = TIME_BALANCE.ticksPerDay;
  return { from: state.tick % perDay, to: state.pops.sweep, step: perDay };
}

/** Calls `visit` on each live pop in this tick's slice, in id order. */
export function sweepPops(state: SimState, visit: (id: number) => void): void {
  const { from, to, step } = popSlice(state);
  const flags = state.pops.flags;
  for (let id = from; id < to; id += step) if (((flags[id] ?? 0) & POP_ALIVE) !== 0) visit(id);
}
