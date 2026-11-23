// Pops move in (M3-08, PRD "M3 Demand" and "Turnover").
//
// While the residential bar is above zero, people arrive each game day and
// take free room in homes newcomers can reach (room.ts). A bar of b brings
// ceil(b / 100 x `arrivalsPerYearAtFullDemand` / days a year) people a day
// (demand.json), so a bar barely above zero still brings one, or, where
// more room stands empty, ceil(b / 100 x empty room / `fillDays`) (M3-21),
// so a few new towers fill in about `fillDays` days while a street of
// houses fills at the first rate. The empty room is read afresh on each
// tick, from state, so the day's people are a little fewer than either
// figure as the homes fill through the day. They are spread over its ticks
// the way the grower spreads its buildings (`growthOnTick`).
//
// `pops.owed` is the day's plan: people due who have not yet found a home.
// A tick adds its share, then newcomers move in while any are owed. Each
// is one household, a pop: a home drawn among those with room from the
// generator in state, each weighted by its land value (M3-25, `homeWeight`),
// then its size, education, wealth and children drawn with the mix in
// pops.json, its wealth with the mix landvalue.json gives for the home's
// value. Its size is drawn between the least and most
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
import { homeRoomLeft, homesWithRoom, newcomerRoomLeft, reachableRoom } from "./room";
import type { EducationShares } from "../buildings/balance";
import { LAND_VALUE_BALANCE, wealthMixAt } from "../landvalue/balance";
import { buildingValues } from "../landvalue/land-value";

/** The name the timer hook reports for arrivals. */
export const ARRIVALS_SYSTEM = "arrivals";

/**
 * People due a game day with the residential bar at `bar` and `emptyRoom`
 * places empty in homes newcomers can reach: none at or below zero, else
 * the more of the full rate and the empty room over `fillDays`, each times
 * the bar over 100, rounded up.
 */
export function dayArrivals(bar: number, emptyRoom = 0): number {
  if (!(bar > 0)) return 0;
  const { arrivalsPerYearAtFullDemand, fillDays } = DEMAND_BALANCE;
  // ceil(x) as -floor(-x), so it uses only floor (CLAUDE.md rule 6).
  const floor = -Math.floor(-(arrivalsPerYearAtFullDemand * bar) / (100 * yearDays()));
  const room = -Math.floor(-(emptyRoom * bar) / (100 * fillDays));
  return Math.max(floor, room);
}

/** A level, 0 low to 2 high, drawn with `shares`. One draw. */
function drawLevel(rng: Uint32Array, shares: EducationShares): number {
  const u = nextFloat(rng);
  if (u < shares.low) return 0;
  return u < shares.low + shares.medium ? 1 : 2;
}

/**
 * A newcomer's profile: education with the mix in pops.json, then wealth
 * with the mix for a home worth `value` points (landvalue.json, M3-25),
 * then children.
 */
export function drawProfile(rng: Uint32Array, value: number): PopProfile {
  const mix = POPS_BALANCE.newcomer;
  const education = drawLevel(rng, mix.education);
  const wealth = drawLevel(rng, wealthMixAt(value));
  const children = nextFloat(rng) < mix.childrenShare ? 1 : 0;
  return { education, wealth, children };
}

/** A home's weight in the draw of newcomers' homes: its land value less `homeWeightFrom`, at least 1 (M3-25). */
export function homeWeight(value: number): number {
  return Math.max(1, value - LAND_VALUE_BALANCE.newcomers.homeWeightFrom);
}

/** A newcomer household's size for a home of `density` with `room` left: drawn between the density's least and most, cut to the size cap and the room. */
export function drawSize(rng: Uint32Array, density: number, room: number): number {
  const sizes = POPS_BALANCE.newcomer.size;
  const [least, most] = sizes[Math.min(sizes.length, Math.max(1, density)) - 1] ?? [1, 1];
  const drawn = least + nextInt(rng, most - least + 1);
  return Math.max(1, Math.min(drawn, popSizeCap(density), room));
}

/**
 * The homes with room (room.ts), in id order, each with its land value and
 * its weight in the draw, and the weights' sum. A home that fills keeps its
 * place with a weight of 0, so the order of the rest, and so the draw,
 * follows from state alone. A tick brings a household or a few, so each
 * draw walks the weights rather than keeping a tree of them.
 */
interface HomeDraw {
  homes: number[];
  values: Float64Array;
  weights: Float64Array;
  /** The weights' sum, and the homes with a weight left. */
  total: number;
  left: number;
}

/**
 * Scratch for `homeDraw`, kept between ticks and grown as needed: two arrays
 * the length of the homes with room, made on every tick people are due,
 * were garbage the size of the town. Never state: each tick fills it afresh.
 */
let scratchValues = new Float64Array(0);
let scratchWeights = new Float64Array(0);

function homeDraw(state: SimState): HomeDraw {
  const homes = homesWithRoom(state);
  if (scratchValues.length < homes.length) {
    const size = Math.max(homes.length, 2 * scratchValues.length);
    scratchValues = new Float64Array(size);
    scratchWeights = new Float64Array(size);
  }
  const values = buildingValues(state, homes, scratchValues);
  const weights = scratchWeights;
  let total = 0;
  for (let i = 0; i < homes.length; i++) {
    const w = homeWeight(values[i] as number);
    weights[i] = w;
    total += w;
  }
  return { homes, values, weights, total, left: homes.length };
}

/** The place in `d.homes` of the home a whole number `u` from 0 to under `d.total` lands on, the weights laid end to end in id order. */
function drawnAt(d: HomeDraw, u: number): number {
  const w = d.weights;
  let at = 0;
  for (let edge = w[0] as number; u >= edge; edge += w[at] as number) at++;
  return at;
}

/** Takes the home at place `at` out of the draw. */
function fill(d: HomeDraw, at: number): void {
  d.total -= d.weights[at] as number;
  d.weights[at] = 0;
  d.left--;
}

/**
 * Moves one household into a home drawn among `d`'s, each as likely as its
 * weight, and returns its people. Its wealth follows the home's land value.
 * Takes the home out of the draw once it has no room left for another
 * household (room.ts).
 */
function moveIn(state: SimState, d: HomeDraw): number {
  const rng = state.rng;
  const at = drawnAt(d, nextInt(rng, d.total));
  const home = d.homes[at] as number;
  const size = drawSize(rng, state.buildings.density[home] ?? 1, homeRoomLeft(state, home));
  const profile = drawProfile(rng, d.values[at] as number);
  addPop(state, { home, size, ...profile, satisfaction: POPS_BALANCE.newcomer.satisfaction });
  noteYear(state, "arrivals", size);
  if (newcomerRoomLeft(state, home) === 0) fill(d, at);
  return size;
}

/** The arrivals system's work for one tick, as the header says. */
export function arrive(state: SimState): void {
  const p = state.pops;
  const bar = state.demand.residential.value;
  if (!(bar > 0) && p.owed <= 0) return;
  p.owed += growthOnTick(state.tick, dayArrivals(bar, reachableRoom(state).empty));
  if (p.owed <= 0) return;
  const d = homeDraw(state);
  while (p.owed > 0 && d.left > 0) p.owed -= moveIn(state, d);
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
