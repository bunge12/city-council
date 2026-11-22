// Pops move in (M3-08, PRD "M3 Demand" and "Turnover").
//
// While the residential bar is above zero, people arrive each game day and
// take free room in homes newcomers can reach (room.ts). A bar of b brings
// ceil(b / 100 x `arrivalsPerYearAtFullDemand` / days a year) people a day
// (demand.json), so a bar barely above zero still brings one. The day's
// people are spread over its ticks the way the grower spreads its buildings
// (`growthOnTick`).
//
// `pops.owed` is the day's plan: people due who have not yet found a home.
// A tick adds its share, then newcomers move in while any are owed. Each
// is one household, a pop: a home drawn among those with room from the
// generator in state, then its size, education, wealth and children drawn
// with the mix in pops.json. Its size is drawn between the least and most
// for the home's density and cut to the room the home has left, so a large
// household can take more than is owed and `owed` goes below 0. The next
// arrivals wait until the ticks have paid that back, and the people a day
// still average out to the bar. People due when no home has room do not
// wait: they go elsewhere, and the plan goes back to 0. So between ticks
// the plan is 0 or below.
//
// The plan is state, so a city saved mid-day lands the same pops as one
// that never stopped. It sits in the pops with the sweep's limit, and
// travels to a client only in a snapshot, as the pop table does (M3-05).
//
// Newcomers arrive without a job (M3-09 finds them one), and each adds its
// people to the year's arrivals (stats.ts).

import { growthOnTick } from "../buildings/grower";
import { yearDays } from "../calendar";
import { DEMAND_BALANCE } from "../demand/balance";
import { nextFloat, nextInt } from "../rng";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteYear } from "../stats/stats";
import { POPS_BALANCE } from "./balance";
import { addPop, popSizeCap, type PopProfile } from "./pops";
import { homeRoomLeft, homesWithRoom, newcomerRoomLeft } from "./room";
import type { EducationShares } from "../buildings/balance";

/** The name the timer hook reports for arrivals. */
export const ARRIVALS_SYSTEM = "arrivals";

/** People due a game day with the residential bar at `bar`: none at or below zero, else the full rate times the bar over 100, rounded up. */
export function dayArrivals(bar: number): number {
  if (!(bar > 0)) return 0;
  // ceil(x) as -floor(-x), so it uses only floor (CLAUDE.md rule 6).
  return -Math.floor(-(DEMAND_BALANCE.arrivalsPerYearAtFullDemand * bar) / (100 * yearDays()));
}

/** A level, 0 low to 2 high, drawn with `shares`. One draw. */
function drawLevel(rng: Uint32Array, shares: EducationShares): number {
  const u = nextFloat(rng);
  if (u < shares.low) return 0;
  return u < shares.low + shares.medium ? 1 : 2;
}

/** A newcomer's profile, drawn with the mix in pops.json: education, then wealth, then children. */
export function drawProfile(rng: Uint32Array): PopProfile {
  const mix = POPS_BALANCE.newcomer;
  const education = drawLevel(rng, mix.education);
  const wealth = drawLevel(rng, mix.wealth);
  const children = nextFloat(rng) < mix.childrenShare ? 1 : 0;
  return { education, wealth, children };
}

/** A newcomer household's size for a home of `density` with `room` left: drawn between the density's least and most, cut to the size cap and the room. */
export function drawSize(rng: Uint32Array, density: number, room: number): number {
  const sizes = POPS_BALANCE.newcomer.size;
  const [least, most] = sizes[Math.min(sizes.length, Math.max(1, density)) - 1] ?? [1, 1];
  const drawn = least + nextInt(rng, most - least + 1);
  return Math.max(1, Math.min(drawn, popSizeCap(density), room));
}

/** Moves one household into a home drawn from `homes`, which are those with room, and returns its people. Takes the home off the list once it has no room left for another household (room.ts). */
function moveIn(state: SimState, homes: number[]): number {
  const rng = state.rng;
  const at = nextInt(rng, homes.length);
  const home = homes[at] as number;
  const size = drawSize(rng, state.buildings.density[home] ?? 1, homeRoomLeft(state, home));
  const profile = drawProfile(rng);
  addPop(state, { home, size, ...profile, satisfaction: POPS_BALANCE.newcomer.satisfaction });
  noteYear(state, "arrivals", size);
  if (newcomerRoomLeft(state, home) === 0) {
    homes[at] = homes[homes.length - 1] as number;
    homes.pop();
  }
  return size;
}

/** The arrivals system's work for one tick, as the header says. */
export function arrive(state: SimState): void {
  const p = state.pops;
  p.owed += growthOnTick(state.tick, dayArrivals(state.demand.residential.value));
  if (p.owed <= 0) return;
  const homes = homesWithRoom(state);
  while (p.owed > 0 && homes.length > 0) p.owed -= moveIn(state, homes);
  if (p.owed > 0) p.owed = 0;
}

/**
 * The step's system for arrivals. It runs after the pops' sweep starts its
 * day, and before the grower, which holds new homes back while there is
 * room in standing ones. A newcomer on a new id past the day's limit waits
 * for the next day's sweep; one that reuses a freed id below the limit is
 * visited today if the slices have not yet passed it, the same on every
 * machine.
 */
export const ARRIVALS: System = { name: ARRIVALS_SYSTEM, run: arrive };
