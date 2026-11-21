// The daily sweep over the pops (M3-03). A system that visits every pop,
// such as job matching, satisfaction or turnover, may not walk 150,000 of
// them in one tick. It visits a slice a tick instead, so the whole array is
// covered once a game day, in id order.
//
// On a day's first tick the POPS system writes the pop id limit into
// `pops.sweep`. Each tick of the day then takes the ids from
// `sweep × k / ticksPerDay` up to `sweep × (k + 1) / ticksPerDay`, rounded
// down, where k is the tick's place in the day. That is a function of the
// tick and of state, so every machine visits the same pops on the same tick
// (CLAUDE.md rule 3), and a save mid-day carries on where it stopped. A pop
// added during the day past the limit waits for the next day.

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

/** The pop ids this tick's slice covers, from `from` up to but not including `to`. Free ids among them are for the caller to skip. */
export function popSlice(state: SimState): { from: number; to: number } {
  const perDay = TIME_BALANCE.ticksPerDay;
  const k = state.tick % perDay;
  const limit = state.pops.sweep;
  return { from: Math.floor((limit * k) / perDay), to: Math.floor((limit * (k + 1)) / perDay) };
}

/** Calls `visit` on each live pop in this tick's slice, in id order. */
export function sweepPops(state: SimState, visit: (id: number) => void): void {
  const { from, to } = popSlice(state);
  const flags = state.pops.flags;
  for (let id = from; id < to; id++) if (((flags[id] ?? 0) & POP_ALIVE) !== 0) visit(id);
}
