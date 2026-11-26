// Satisfaction and leaving (M3-10, PRD "Satisfaction").
//
// The SATISFACTION system visits the day's slice of the pops (sweep.ts) and
// sets each one's score once a game day. M3 has one input, the job. A pop
// with nobody who works heads for `target.noWorkers` in pops.json, one in a
// job at its own education level for `target.fittingJob`, one in a job
// below its level for `target.otherJob`, and one with workers and no job
// for `target.noJob`. A job fits when the workplace offers jobs at the
// pop's own level (buildings/jobs.ts): a high education pop in a shop has a
// job, and a lower score than one in an office. The score moves
// `dailyShare` of the way to its target each day, rounded to the nearest
// point and at least one, so a pop that has just lost its job does not
// leave the next morning.
//
// A pop whose score has stayed below `leaveBelow` for `leaveAfterDays` game
// days in a row, while its target was below it too, moves out: its home's
// room and its job are freed and its people go on the year's departures. A
// pop that finds work starts its count again, even while its score is
// still climbing back, so a job found late in the wait is kept. That is the only way unemployment
// makes a pop leave, as the PRD asks.
//
// Since M4-07 the residential tax rate is a second input. The target from
// the job loses the rate's pressure (economy/tax-rates.ts: 0 at the default
// rate, 1 at the top of its range) times `taxByWealth` for the pop's wealth,
// so a wealthy pop feels a rise more than a poor one, and a rate below the
// default raises the target as far the other way. The target is rounded to
// a whole point and held from 0 to 100. Every home pays the residential
// rate, a mixed building's flats too, so every pop reads it.
//
// Since M4-10 displacement is a third input (displacement.ts): the
// expropriations near the pop's home in the last game year, and its own
// displacement if it carries a mark, take points off the target from the
// job along with the tax, faded over the year.
//
// The one other rule is the residential bar below zero. A bar of b below
// zero sends ceil(-b / 100 × `departuresPerYearAtFullDemand` / days a year)
// people away a day (demand.json), the least satisfied first. On the day's
// first tick the plan is set from the people at each score as the day
// opens (where.ts): `leaveScore` is the lowest score at which the people
// at or below it reach the day's number, and `leaveAtScore` the people at
// that score still to go once all those below it have. Each pop below
// `leaveScore` then leaves as the sweep reaches it, and pops at it leave
// while `leaveAtScore` is above 0. A pop larger than what is left takes it
// below 0, as a household does in arrivals, and the next day's plan pays
// that back before anyone else is due, so a city of towers still loses
// people at the bar's rate on average. While the bar is at or above zero
// the debt is dropped. Both are state (pops.ts), so a city saved mid-day
// sends the same pops away.
//
// Each pop is judged on its score as the day opened, then given the day's
// step. The plan is close rather than exact: the part of a pop split by job
// matching that lands on a freed id the sweep has passed waits for the next
// day, so its people, counted in the plan with the pop's, do not leave today.
//
// Arithmetic is add, subtract, multiply, divide and floor (CLAUDE.md rule
// 6), and nothing here draws from the generator.

import { yearDays, TIME_BALANCE } from "../calendar";
import { buildingJobs } from "../buildings/jobs";
import { DEMAND_BALANCE } from "../demand/balance";
import { demandPull } from "../demand/pull";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteYear } from "../stats/stats";
import { taxPressure } from "../economy/tax-rates";
import { ECONOMY, ECONOMY_SLIDERS } from "../economy/balance";
import { EDUCATION_LEVELS } from "../buildings/balance";
import { POPS_BALANCE } from "./balance";
import { clearOldMark, displacementLoss, displacementView, type DisplacementView } from "./displacement";
import { jobsUpToLevel } from "./open-jobs";
import { NO_LEAVING, NO_WORK, POP_ALIVE, SATISFACTION_MAX, popWorkers, removePop, setPopDaysLow, setPopGraceDays, setPopSatisfaction } from "./pops";
import { popSlice } from "./sweep";
import { popIndexOf } from "./where";

/** The name the timer hook reports for satisfaction. */
export const SATISFACTION_SYSTEM = "satisfaction";

/** Whether workplace `work` offers jobs at education `education` itself, not only below it. */
export function jobFits(state: SimState, work: number, education: number): boolean {
  const b = state.buildings;
  const upTo = jobsUpToLevel(b.type[work] ?? 0, buildingJobs(b, work));
  const below = education > 0 ? (upTo[education - 1] ?? 0) : 0;
  return (upTo[education] ?? 0) - below > 0;
}

/** Where pop `id`'s score heads from its job alone, as the header says. */
export function jobTarget(state: SimState, id: number): number {
  const target = POPS_BALANCE.satisfaction.target;
  const p = state.pops;
  if (popWorkers(p, id) === 0) return target.noWorkers;
  const work = p.work[id] ?? NO_WORK;
  if (work === NO_WORK) return target.noJob;
  return jobFits(state, work, p.education[id] ?? 0) ? target.fittingJob : target.otherJob;
}

const RESIDENTIAL_RATE = ECONOMY_SLIDERS.indexOf("residential");

/** Today's residential tax rate in `state`. */
const residentialRate = (state: SimState): number => state.budget.taxRates[RESIDENTIAL_RATE] ?? ECONOMY.taxRates.residential.default;

/**
 * The points the residential tax rate at `rate` takes off a target, by
 * wealth, 0 low to 2 high: the rate's pressure times `taxByWealth`. Below 0
 * while the rate is under its default, which adds to the target.
 */
export function taxLosses(rate: number): [number, number, number] {
  const pressure = taxPressure("residential", rate);
  const by = POPS_BALANCE.satisfaction.taxByWealth;
  const loss = (level: (typeof EDUCATION_LEVELS)[number]) => (pressure === 0 ? 0 : by[level] * pressure);
  return [loss("low"), loss("medium"), loss("high")];
}

/** `jobTarget` less `loss`, rounded to a whole point and held from 0 to 100. */
export function targetAfterTax(job: number, loss: number): number {
  if (loss === 0) return job;
  const target = Math.floor(job - loss + 0.5);
  return target < 0 ? 0 : target > SATISFACTION_MAX ? SATISFACTION_MAX : target;
}

/**
 * Where pop `id`'s score heads today: its job's target, less what the
 * residential tax rate takes off for its wealth (M4-07) and what
 * displacement takes off (M4-10). `losses` is `taxLosses` of today's rate
 * and `view` the tick's `displacementView`, each worked out once a tick;
 * left out, they are. Reads state only.
 */
export function satisfactionTarget(state: SimState, id: number, losses: readonly number[] = taxLosses(residentialRate(state)), view: DisplacementView = displacementView(state)): number {
  return targetAfterTax(jobTarget(state, id), (losses[state.pops.wealth[id] ?? 0] ?? 0) + displacementLoss(state, id, view));
}

/** A score one day on from `score` toward `target`: `dailyShare` of the way, rounded to the nearest point, at least one and never past the target. */
export function stepScore(score: number, target: number): number {
  const gap = target - score;
  if (gap === 0) return score;
  const size = gap < 0 ? -gap : gap;
  const move = Math.max(1, Math.min(size, Math.floor(size * POPS_BALANCE.satisfaction.dailyShare + 0.5)));
  return gap < 0 ? score - move : score + move;
}

/** People sent away a game day with the residential bar at `bar`: none at or above zero, else the full rate times the bar over -100, rounded up. */
export function dayDepartures(bar: number): number {
  if (!(bar < 0)) return 0;
  // ceil(x) as -floor(-x), so it uses only floor (CLAUDE.md rule 6).
  return -Math.floor((DEMAND_BALANCE.departuresPerYearAtFullDemand * bar) / (100 * yearDays()));
}

/** On a game day's first tick, the day's plan of departures from the residential bar and the people at each score, as the header says. */
function planDepartures(state: SimState): void {
  const p = state.pops;
  const today = dayDepartures(demandPull(state.demand, "residential"));
  // What earlier days sent away past their plan, 0 or below, paid back first.
  const debt = today > 0 && p.leaveAtScore < 0 ? p.leaveAtScore : 0;
  const due = today + debt;
  p.leaveScore = NO_LEAVING;
  p.leaveAtScore = due < 0 ? due : 0;
  if (due <= 0) return;
  const byScore = popIndexOf(state).peopleBySatisfaction;
  let below = 0;
  for (let score = 0; score <= SATISFACTION_MAX; score++) {
    const at = byScore[score] ?? 0;
    if (below + at >= due || score === SATISFACTION_MAX) {
      p.leaveScore = score;
      p.leaveAtScore = Math.min(at, due - below);
      return;
    }
    below += at;
  }
}

/** Moves pop `id` out of the city, onto the year's departures. */
function leave(state: SimState, id: number): void {
  noteYear(state, "departures", state.pops.size[id] ?? 0);
  removePop(state, id);
}

/** Whether pop `id`, with `score` as the day opened, is one the residential bar sends away today. Takes its people off the plan when it is at `leaveScore`. */
function sentAway(state: SimState, id: number, score: number): boolean {
  const p = state.pops;
  if (score < p.leaveScore) return true;
  if (score !== p.leaveScore || p.leaveAtScore <= 0) return false;
  p.leaveAtScore -= p.size[id] ?? 0;
  return true;
}

/** The satisfaction system's work for one tick, as the header says. */
export function updateSatisfaction(state: SimState): void {
  if (state.tick % TIME_BALANCE.ticksPerDay === 0) planDepartures(state);
  const { leaveBelow, leaveAfterDays } = POPS_BALANCE.satisfaction;
  const { from, to, step } = popSlice(state);
  const p = state.pops;
  const losses = taxLosses(residentialRate(state));
  const view = displacementView(state);
  for (let id = from; id < to; id += step) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    const score = p.satisfaction[id] ?? 0;
    if (p.leaveScore !== NO_LEAVING && sentAway(state, id, score)) {
      leave(state, id);
      continue;
    }
    const grace = p.graceDays[id] ?? 0;
    if (grace > 0) setPopGraceDays(state, id, grace - 1);
    clearOldMark(state, id);
    const target = satisfactionTarget(state, id, losses, view);
    const next = stepScore(score, target);
    setPopSatisfaction(state, id, next);
    const days = next < leaveBelow && target < leaveBelow ? Math.min(leaveAfterDays, (p.daysLow[id] ?? 0) + 1) : 0;
    if (days >= leaveAfterDays) leave(state, id);
    else if (days !== p.daysLow[id]) setPopDaysLow(state, id, days);
  }
}

/**
 * The step's system for satisfaction. It runs after job matching, so a pop
 * that finds work today is scored with its job, and before the grower,
 * which then sees the room the day's departures freed.
 */
export const SATISFACTION: System = { name: SATISFACTION_SYSTEM, run: updateSatisfaction };
