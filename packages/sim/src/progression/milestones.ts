// Population milestones in play (M4-12, PRD "Progression").
//
// A milestone is reached the first time the population reaches it, and is
// never lost when the population falls. The highest population the city
// has had is kept in the statistics (M3-04), so a milestone is reached when
// that passes it. Milestones rise in population, so the ones reached are
// always the first few: state keeps one entry per milestone reached, in
// order, the tick it was reached on. Reaching one pays its grant on the
// grants line, once.
//
// What a milestone opens is derived from how many are reached, so nothing
// else is stored. A lock stops new painting at a density; it never stops
// growth on cells zoned at it already (zoning/zone.ts).

import { moveMoney } from "../economy/budget";
import type { SimState } from "../state";
import { MILESTONES, unlockMilestone, type Unlock } from "./balance";

/**
 * The tick an entry of `SimState.milestones` holds for a milestone credited
 * rather than reached in play: by the migration of a city saved before the
 * milestones (M4-12), or by `creditMilestones`. No grant was paid for it.
 */
export const CREDITED = -1;

/** A new city's milestones: none reached. */
export function createMilestones(): Int32Array {
  return new Int32Array(0);
}

/** How many milestones `state` has reached. */
export function milestonesReached(state: Pick<SimState, "milestones">): number {
  return state.milestones.length;
}

/** Whether `state` has opened `unlock`. */
export function isUnlocked(state: Pick<SimState, "milestones">, unlock: Unlock): boolean {
  return unlockMilestone(unlock) < state.milestones.length;
}

/** How many of the milestones a population of `population` reaches. */
export function milestonesAt(population: number): number {
  let n = 0;
  while (n < MILESTONES.length && (MILESTONES[n] as (typeof MILESTONES)[number]).population <= population) n++;
  return n;
}

/** `milestones` with `count` more entries of `tick` on the end. */
function withReached(milestones: Int32Array, count: number, tick: number): Int32Array {
  const out = new Int32Array(milestones.length + count);
  out.set(milestones);
  out.fill(tick, milestones.length);
  return out;
}

/**
 * Reaches every milestone the highest population has passed and `state` has
 * not reached yet, paying each grant on the grants line. The step runs it
 * each tick after the systems that move people. Nothing happens on most
 * ticks: one comparison, and an array only on the tick a milestone falls.
 */
export function reachMilestones(state: SimState): void {
  const had = state.milestones.length;
  const now = milestonesAt(state.stats.highestPopulation);
  if (now <= had) return;
  for (let i = had; i < now; i++) moveMoney(state, "grants", (MILESTONES[i] as (typeof MILESTONES)[number]).grant);
  state.milestones = withReached(state.milestones, now - had, state.tick);
}

/** The progression system, run each tick (step.ts). */
export const PROGRESSION = { name: "progression", run: reachMilestones };

/**
 * Credits `state` with the first `count` milestones, every one unless
 * given, without paying their grants. For the generators, tests and
 * walkthroughs that zone densities 2 and 3 on a new city (M4-12): the scale
 * cities, the balance check's standard cities and the test builders. Not a
 * command and not in the log, so a replay of a credited city starts from
 * one credited the same way, as with `fundCity`. A milestone reached
 * already stays as it is.
 */
export function creditMilestones(state: SimState, count = MILESTONES.length): void {
  const want = Math.min(count, MILESTONES.length);
  if (want > state.milestones.length) state.milestones = withReached(state.milestones, want - state.milestones.length, CREDITED);
}

/**
 * The milestones the migration credits a city saved before them with
 * (M4-12): every one its highest population passed, each marked credited,
 * with no grant.
 */
export function creditedFor(highestPopulation: number): Int32Array {
  return withReached(createMilestones(), milestonesAt(highestPopulation), CREDITED);
}

/** The milestone `unlock` waits for, as a player reads it: "the Village milestone, at 1,000 residents". */
export function milestoneLabel(unlock: Unlock): string {
  const m = MILESTONES[unlockMilestone(unlock)] as (typeof MILESTONES)[number];
  return `the ${m.name} milestone, at ${groupThousands(m.population)} residents`;
}

/** `n` with commas between each three digits, the same on every host (no locale). */
function groupThousands(n: number): string {
  const digits = String(n);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** Whether `a` and `b` hold the same milestones reached. For a host deciding whether they go in a delta. */
export function sameMilestones(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Why `value` is not a well-formed list of milestones reached for a city at
 * `tick`, or null if it is: an Int32Array of at most as many entries as
 * there are milestones, each a tick no later than `tick`, or `CREDITED`. For loading a save and checking a delta.
 */
export function checkMilestones(value: unknown, tick: number): string | null {
  if (!(value instanceof Int32Array)) return "they are not an Int32Array";
  if (value.length > MILESTONES.length) return `there are ${value.length}, and this build has ${MILESTONES.length} milestones`;
  for (const at of value) if (!(at === CREDITED || (at >= 0 && at <= tick))) return `${at} is neither a tick of the city's past nor ${CREDITED}`;
  return null;
}
