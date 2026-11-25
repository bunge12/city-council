// Pops move in (M3-08, PRD "M3 Demand" and "Turnover").
//
// While the residential bar is above zero, people arrive each game day and
// take free room in homes newcomers can reach (room.ts). A bar of b brings
// ceil(b / 100 x `arrivalsPerYearAtFullDemand` / days a year) people a day
// (demand.json), so a bar barely above zero still brings one, or, where
// more room stands empty, ceil(b / 100 x empty room / `fillDays`) (M3-21),
// so a few new towers fill in about `fillDays` days while a street of
// houses fills at the first rate. The empty room is read afresh on each
// tick, from state, so a tick takes its share of that tick's figure and the
// day's people follow the room as it fills, roughly and not exactly the
// figure the day started with: deterministic, since every tick reads state.
// They are spread over its ticks the way the grower spreads its buildings
// (`growthOnTick`).
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
import { homeRoomLeft, homesAndEmptyRoom, newcomerRoomLeft } from "./room";
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
 * follows from state alone. Since M3-21 a tick can bring hundreds of
 * households where much room stands empty, so the weights are kept in a
 * Fenwick tree as well: a draw descends it in log steps and lands on the
 * home a walk along the weights in id order would, so nothing a draw picks
 * changed with it. The weights are whole numbers (`homeWeight`), so the
 * sums are exact.
 */
interface HomeDraw {
  homes: number[];
  values: Float64Array;
  weights: Float64Array;
  /** The Fenwick tree over `weights`, 1-based: `tree[i]` sums the weights of the places from i - (i & -i) to i - 1. */
  tree: Float64Array;
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
let scratchTree = new Float64Array(0);

function homeDraw(state: SimState, homes: number[]): HomeDraw {
  if (scratchValues.length < homes.length) {
    const size = Math.max(homes.length, 2 * scratchValues.length);
    scratchValues = new Float64Array(size);
    scratchWeights = new Float64Array(size);
    scratchTree = new Float64Array(size + 1);
  }
  const values = buildingValues(state, homes, scratchValues);
  const weights = scratchWeights;
  const tree = scratchTree;
  const n = homes.length;
  let total = 0;
  // `homeWeight`, inline, its balance number read once a draw rather than once a home (issue #347).
  const from = LAND_VALUE_BALANCE.newcomers.homeWeightFrom;
  for (let i = 0; i < n; i++) {
    const v = (values[i] as number) - from;
    const w = v > 1 ? v : 1;
    weights[i] = w;
    tree[i + 1] = w;
    total += w;
  }
  // Built in place in one pass: each node adds itself to its parent.
  for (let i = 1; i <= n; i++) {
    const parent = i + (i & -i);
    if (parent <= n) tree[parent] = (tree[parent] as number) + (tree[i] as number);
  }
  return { homes, values, weights, tree, total, left: n };
}

/** The place in `d.homes` of the home a whole number `u` from 0 to under `d.total` lands on, the weights laid end to end in id order. */
export function drawnAt(d: Pick<HomeDraw, "homes" | "tree">, u: number): number {
  const n = d.homes.length;
  let step = 1;
  while (step * 2 <= n) step *= 2;
  // The last place whose weights before it sum to u or less, among those with a weight: descend from the top.
  let at = 0;
  let rest = u;
  for (; step > 0; step = Math.floor(step / 2)) {
    const next = at + step;
    if (next <= n && (d.tree[next] as number) <= rest) {
      at = next;
      rest -= d.tree[next] as number;
    }
  }
  return at;
}

/** Takes the home at place `at` out of the draw. */
function fill(d: HomeDraw, at: number): void {
  const w = d.weights[at] as number;
  d.total -= w;
  d.weights[at] = 0;
  for (let i = at + 1; i <= d.homes.length; i += i & -i) d.tree[i] = (d.tree[i] as number) - w;
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
  addPop(state, { home, size, ...profile, satisfaction: POPS_BALANCE.newcomer.satisfaction, graceDays: POPS_BALANCE.newcomer.graceDays });
  noteYear(state, "arrivals", size);
  if (newcomerRoomLeft(state, home) === 0) fill(d, at);
  return size;
}

/**
 * Works out the land value of every home newcomers can draw now, and sizes
 * the draw's scratch for them, for a host to call at load
 * (`prepareDerived`). A city loaded from a save keeps no values, so the
 * first tick people were due worked out every one inside the arrivals'
 * share: up to 1.4 ms on the scale city of 500,000, where the ticks after
 * read them kept (issue #372). The values are derived and the same either
 * way, so state reads and hashes the same.
 */
export function prepareArrivals(state: SimState): void {
  homeDraw(state, homesAndEmptyRoom(state).homes);
}

/** The arrivals system's work for one tick, as the header says. */
export function arrive(state: SimState): void {
  const p = state.pops;
  const bar = state.demand.residential.value;
  if (!(bar > 0) && p.owed <= 0) return;
  // One pass over the buildings gives both the empty room the day's people follow and the homes they draw among.
  const { homes, empty } = homesAndEmptyRoom(state);
  p.owed += growthOnTick(state.tick, dayArrivals(bar, empty));
  if (p.owed <= 0) return;
  const d = homeDraw(state, homes);
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
