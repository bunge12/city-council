// City statistics (M3-04, PRD "City statistics").
//
// Running totals of the counts the game leans on, kept in state and saved
// with the city. They are adjusted where pops and buildings change, never
// recounted in a tick: pops.ts calls `countPop` and `countFilled` around
// every change of a pop, and buildings.ts calls `countBuilding` as a
// building is added or removed. `recountTotals` works every total out
// afresh from the pop and building rows, for tests to check the running
// ones against.
//
// Once per game month, on the month's first tick, the STATS system writes
// one sample of each total into a history of at most `HISTORY_LENGTH`
// samples: one Int32Array per total, with one write position shared by
// all. The arrays grow by a sample a month until they are full, so a young
// city's save does not carry a hundred years of zeros. From then on each
// sample is written over the oldest.
//
// The yearly counts of births, deaths, arrivals and departures are added to
// by the systems that move people (M3-08, M3-10, M3-11) through `noteYear`.
// On 1 January the running year becomes the last one and starts again at 0.
//
// Each sample also holds the money (M4-02): the treasury, and the income,
// expenses and tax income of the month the budget system has just closed
// (economy/budget.ts). Money is whole dollars that pass the 2.1 billion an
// Int32Array holds, so those series are Float64Arrays, kept apart from the
// counts but written at the same position.

import { BUILDINGS_BALANCE, BUILDING_TYPES, JOB_KINDS, type JobKind } from "../buildings/balance";
import { BUILDING_ALIVE, OFFERS_JOBS, type BuildingState } from "../buildings/buildings";
import { buildingJobs, jobsByKind, type JobsByKind } from "../buildings/jobs";
import { isMonthStart, isYearStart } from "../calendar";
import { expensesOf, incomeOf, taxIncomeOf, type BudgetState } from "../economy/budget";
import { NO_HOME, NO_WORK, POP_ALIVE, POP_LEVELS, workersFor, type PopState } from "../pops/pops";
import { popIndexOf } from "../pops/where";
import type { SimState } from "../state";
import type { System } from "../step";
import { ZONING_BALANCE } from "../zoning/balance";

/**
 * Samples the history holds: one a game month for a hundred game years
 * (PRD, "City statistics"). The length of arrays in state, not a balance
 * number: a change is a change of the save's shape and needs a migration.
 */
export const HISTORY_LENGTH = 1200;

const LEVELS = ["Low", "Medium", "High"] as const;
const KIND_NAMES: Readonly<Record<JobKind, string>> = { commercial: "Commercial", office: "Office", industrial: "Industrial" };
const DENSITIES = ZONING_BALANCE.densities.length;

/** People living in homes of density 1, 2 and 3. */
const RESIDENTS_BY_DENSITY = ZONING_BALANCE.densities.map((d) => `residentsDensity${d.level}`);
/** People by education level, lowest first. */
const RESIDENTS_BY_EDUCATION = LEVELS.map((l) => `residentsEducation${l}`);
/** People by wealth level, lowest first. */
const RESIDENTS_BY_WEALTH = LEVELS.map((l) => `residentsWealth${l}`);
/** Jobs offered, in `JOB_KINDS` order. */
const JOBS_BY_KIND = JOB_KINDS.map((k) => `jobs${KIND_NAMES[k]}`);
/** Jobs filled, in `JOB_KINDS` order. */
const FILLED_BY_KIND = JOB_KINDS.map((k) => `filled${KIND_NAMES[k]}`);
/** Buildings by zone number less 1, then density less 1: `buildingsR1` to `buildingsM3`. */
const BUILDINGS_BY_ZONE = ZONING_BALANCE.zones.map((zone) => ZONING_BALANCE.densities.map((d) => `buildings${zone.letter}${d.level}`));

/**
 * Every running total, in the order state holds them. Population and the
 * residents' breakdowns count people; `pops` and `popsWithChildren` count
 * pops. `residentSatisfaction` is the sum over the pops of their people
 * times their satisfaction, so over the population it is the residents'
 * average satisfaction weighted by pop size (M3-10). Workers are the people of a pop who work (`workersFor`), employed
 * if the pop has a job. `workersUnemployedNew` are the unemployed workers
 * of pops with days of grace left, newcomers the residential bar does not
 * count as unemployed yet (#361). Jobs are split by kind with `jobsByKind`, offered
 * from a building's jobs and filled from its jobs filled, so a mixed
 * building counts commercial jobs, and office jobs too at density 3.
 */
export const STAT_TOTALS: readonly string[] = [
  "population",
  "pops",
  ...RESIDENTS_BY_DENSITY,
  ...RESIDENTS_BY_EDUCATION,
  ...RESIDENTS_BY_WEALTH,
  "residentSatisfaction",
  "workersEmployed",
  "workersUnemployed",
  "workersUnemployedNew",
  ...JOBS_BY_KIND,
  ...FILLED_BY_KIND,
  "popsWithChildren",
  ...BUILDINGS_BY_ZONE.flat(),
];

/**
 * The money series of the history, in the order state holds them: the
 * treasury as the month opened, and the closed month's income, expenses
 * and tax income, whole dollars (M4-02).
 */
export const MONEY_SERIES = ["treasury", "income", "expenses", "taxIncome"] as const;
export type MoneySeries = (typeof MONEY_SERIES)[number];
export type MoneySample = Record<MoneySeries, number>;

/** A number for each name in `STAT_TOTALS`. */
export type StatTotals = Record<string, number>;

/** What the yearly counts count, in the order state holds them. */
export const YEAR_COUNTS = ["births", "deaths", "arrivals", "departures"] as const;
export type YearCount = (typeof YEAR_COUNTS)[number];
export type YearCounts = Record<YearCount, number>;

/** The city's statistics. Plain numbers and typed arrays (CLAUDE.md rule 7). Part of `SimState`. */
export interface StatsState {
  /** The running totals. */
  totals: StatTotals;
  /** The highest population the city has reached. M4's milestones read it. */
  highestPopulation: number;
  /** People born, died, arrived and departed so far this game year. */
  year: YearCounts;
  /** The same for the game year that last ended. All 0 in a city's first year. */
  lastYear: YearCounts;
  /**
   * By total: its monthly samples, all the same length, up to
   * `HISTORY_LENGTH`. Oldest first until they are full, then a ring that
   * `next` writes into.
   */
  history: Record<string, Int32Array>;
  /** Where the next sample goes in every history array: their length until they are full. The newest sample is just before it. */
  next: number;
  /** By money series: its monthly samples, as long as `history`'s and written at the same position. */
  money: Record<MoneySeries, Float64Array>;
}

/** Every total at 0. */
export function zeroTotals(): StatTotals {
  return Object.fromEntries(STAT_TOTALS.map((name) => [name, 0]));
}

/** Every money series as `length` samples of 0. */
export function emptyMoney(length: number): Record<MoneySeries, Float64Array> {
  return Object.fromEntries(MONEY_SERIES.map((name) => [name, new Float64Array(length)])) as Record<MoneySeries, Float64Array>;
}

/**
 * The money sample of `budget`: its treasury as the month opened, and its
 * last closed month. The opening balance, not the treasury now: the sample
 * runs after the commands of the month's first tick, and a road built on
 * that tick is the new month's spending (M4-03).
 */
export function moneySample(budget: BudgetState): MoneySample {
  return { treasury: budget.opening, income: incomeOf(budget.lastMonth), expenses: expensesOf(budget.lastMonth), taxIncome: taxIncomeOf(budget.lastMonth) };
}

const NO_MONEY: MoneySample = { treasury: 0, income: 0, expenses: 0, taxIncome: 0 };

function zeroYear(): YearCounts {
  return { births: 0, deaths: 0, arrivals: 0, departures: 0 };
}

/** A city with nothing in it, and no history. */
export function createStats(): StatsState {
  return {
    totals: zeroTotals(),
    highestPopulation: 0,
    year: zeroYear(),
    lastYear: zeroYear(),
    history: Object.fromEntries(STAT_TOTALS.map((name) => [name, new Int32Array(0)])),
    next: 0,
    money: emptyMoney(0),
  };
}

/** Statistics for a city with `state`'s pops and buildings and no history: the totals counted, the highest population today's. */
export function statsFor(state: Pick<SimState, "pops" | "buildings">): StatsState {
  const stats = createStats();
  stats.totals = recountTotals(state);
  stats.highestPopulation = stats.totals["population"] ?? 0;
  return stats;
}

// --- What one pop or building adds -----------------------------------------------

/** Adds `sign` times live pop `id`'s people, workers and children to `t`. */
function addPop(t: StatTotals, p: PopState, b: BuildingState, id: number, sign: number): void {
  const size = p.size[id] ?? 0;
  const children = p.children[id] ?? 0;
  const home = p.home[id] ?? 0;
  const workers = workersFor(size, children);
  const people = sign * size;
  bump(t, "population", people);
  bump(t, "pops", sign);
  // A displaced pop waiting for a home (M3-12) is in the population but in no density's residents.
  if (home !== NO_HOME) bump(t, RESIDENTS_BY_DENSITY[Math.min(DENSITIES, Math.max(1, b.density[home] ?? 1)) - 1], people);
  bump(t, RESIDENTS_BY_EDUCATION[Math.min(POP_LEVELS - 1, p.education[id] ?? 0)], people);
  bump(t, RESIDENTS_BY_WEALTH[Math.min(POP_LEVELS - 1, p.wealth[id] ?? 0)], people);
  bump(t, "residentSatisfaction", people * (p.satisfaction[id] ?? 0));
  const jobless = (p.work[id] ?? NO_WORK) === NO_WORK;
  bump(t, jobless ? "workersUnemployed" : "workersEmployed", sign * workers);
  // Pops from a save before version 29 have no days of grace: the migrations before it count them as settled.
  const grace = p.graceDays as Uint8Array | undefined;
  if (jobless && (grace?.[id] ?? 0) > 0) bump(t, "workersUnemployedNew", sign * workers);
  if (children) bump(t, "popsWithChildren", sign);
}

/**
 * By type, then by jobs: `jobsByKind`, which job matching asks for on every
 * take (M3-09). A function of the balance alone, made again when the job
 * mix it was made from is replaced whole, as `withValue(BUILDINGS_BALANCE,
 * "jobMix", ...)` in a test does (M3 review, #365). A change inside the
 * mix is not seen. Read only.
 */
let kindCache: (JobsByKind | undefined)[][] = BUILDING_TYPES.map(() => []);
let kindCacheMix: unknown = BUILDINGS_BALANCE.jobMix;

/** `jobs` of a building of type index `type` split by kind, or null for no such type. */
export function kindsOf(type: number, jobs: number): JobsByKind | null {
  if (kindCacheMix !== BUILDINGS_BALANCE.jobMix) {
    kindCache = BUILDING_TYPES.map(() => []);
    kindCacheMix = BUILDINGS_BALANCE.jobMix;
  }
  const kind = BUILDING_TYPES[type];
  const cache = kindCache[type];
  if (!kind || !cache) return null;
  let out = cache[jobs];
  if (!out) {
    out = jobsByKind(kind, jobs);
    cache[jobs] = out;
  }
  return out;
}

/** Adds `sign` times `filled` jobs filled at building `id`, split by kind, to `t`. */
function addFilled(t: StatTotals, b: BuildingState, id: number, filled: number, sign: number): void {
  if (filled === 0) return;
  const byKind = kindsOf(b.type[id] ?? 0, filled);
  if (!byKind) return;
  JOB_KINDS.forEach((kind, i) => bump(t, FILLED_BY_KIND[i], sign * byKind[kind]));
}

/** Adds `sign` times live building `id` and the jobs it offers to `t`. */
function addBuilding(t: StatTotals, b: BuildingState, id: number, sign: number): void {
  const zone = b.zone[id] ?? 0;
  const density = b.density[id] ?? 0;
  bump(t, BUILDINGS_BY_ZONE[zone - 1]?.[density - 1], sign);
  addJobs(t, b, id, sign);
}

/** Adds `sign` times the jobs live building `id` offers to `t`, by kind. */
function addJobs(t: StatTotals, b: BuildingState, id: number, sign: number): void {
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  const jobs = buildingJobs(b, id);
  if (!type || jobs === 0) return;
  const byKind = jobsByKind(type, jobs);
  JOB_KINDS.forEach((kind, i) => bump(t, JOBS_BY_KIND[i], sign * byKind[kind]));
}

function bump(t: StatTotals, name: string | undefined, by: number): void {
  if (name !== undefined && by !== 0) t[name] = (t[name] ?? 0) + by;
}

// --- Keeping the running totals ------------------------------------------------

/**
 * Adds live pop `id` to the running totals, or takes it out with `sign` -1.
 * pops.ts takes a pop out before it changes and puts it back after.
 */
export function countPop(state: SimState, id: number, sign: 1 | -1): void {
  const stats = state.stats;
  addPop(stats.totals, state.pops, state.buildings, id, sign);
  if (sign > 0) keepHighest(stats);
}

/**
 * Adds building `id`'s jobs filled, as the pop index has them now, to the
 * running totals, or takes them out with `sign` -1. pops.ts takes a
 * workplace's out before a change and puts them back after.
 */
export function countFilled(state: SimState, id: number, sign: 1 | -1): void {
  addFilled(state.stats.totals, state.buildings, id, popIndexOf(state).filled[id] ?? 0, sign);
}

/**
 * Adds `people` to the residents of building `home`'s density, or takes
 * them away when negative: all a move of pops between a home and none
 * changes in the totals (M3-12).
 */
export function countHomeDensity(state: SimState, home: number, people: number): void {
  const density = state.buildings.density[home] ?? 1;
  bump(state.stats.totals, RESIDENTS_BY_DENSITY[Math.min(DENSITIES, Math.max(1, density)) - 1], people);
}

/**
 * Moves `workers` from unemployed to employed in the running totals, or
 * back with `sign` -1, as a pop takes a job or loses one. `newcomer` says
 * the pop has days of grace left, so its workers are among the unemployed
 * newcomers too while they have no job (#361).
 */
export function countEmployment(state: SimState, workers: number, sign: 1 | -1, newcomer: boolean): void {
  const t = state.stats.totals;
  bump(t, "workersEmployed", sign * workers);
  bump(t, "workersUnemployed", -sign * workers);
  if (newcomer) bump(t, "workersUnemployedNew", -sign * workers);
}

/** Adds `workers` to the unemployed newcomers, or takes them away with `sign` -1, as a pop with no job comes to the end of its grace (#361). */
export function countNewcomersUnemployed(state: SimState, workers: number, sign: 1 | -1): void {
  bump(state.stats.totals, "workersUnemployedNew", sign * workers);
}

/** Adds live building `id` and the jobs it offers to the running totals, or takes it out with `sign` -1, while its row still says what it is. */
export function countBuilding(state: SimState, id: number, sign: 1 | -1): void {
  addBuilding(state.stats.totals, state.buildings, id, sign);
}

/**
 * `countBuilding` for each of `ids`, with the buildings by zone and density
 * added up first and each total moved once: a bulldoze of thousands would
 * look each name up thousands of times (issue #306). Every count is a
 * whole number, so the totals come out the same.
 */
export function countBuildings(state: SimState, ids: readonly number[], sign: 1 | -1): void {
  const t = state.stats.totals;
  const b = state.buildings;
  const zones = BUILDINGS_BY_ZONE.length;
  const densities = DENSITIES;
  const byZone = new Int32Array(zones * densities);
  for (const id of ids) {
    const zone = (b.zone[id] ?? 0) - 1;
    const density = (b.density[id] ?? 0) - 1;
    if (zone >= 0 && zone < zones && density >= 0 && density < densities) byZone[zone * densities + density] = (byZone[zone * densities + density] as number) + 1;
    if (OFFERS_JOBS[b.type[id] ?? 0] === 1) addJobs(t, b, id, sign);
  }
  for (let zone = 0; zone < zones; zone++) {
    for (let density = 0; density < densities; density++) bump(t, BUILDINGS_BY_ZONE[zone]?.[density], sign * (byZone[zone * densities + density] as number));
  }
}

/** Adds `by` to the residents' summed satisfaction: a pop's people times the change in its score (M3-10). */
export function countSatisfaction(state: SimState, by: number): void {
  bump(state.stats.totals, "residentSatisfaction", by);
}

function keepHighest(stats: StatsState): void {
  const population = stats.totals["population"] ?? 0;
  if (population > stats.highestPopulation) stats.highestPopulation = population;
}

/** Adds `n` people to this game year's count of `what`. For the systems that move people. */
export function noteYear(state: SimState, what: YearCount, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`a yearly count grows by a whole number of people, not ${n}`);
  state.stats.year[what] += n;
}

// --- Recounting -------------------------------------------------------------------

/**
 * Every total worked out afresh from the pop and building rows, the jobs
 * filled at each building included, without the pop index. For tests: the
 * running totals must always equal this.
 */
export function recountTotals(state: Pick<SimState, "pops" | "buildings">): StatTotals {
  const t = zeroTotals();
  const b = state.buildings;
  const p = state.pops;
  for (let id = 0; id < b.flags.length; id++) {
    if (((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0) addBuilding(t, b, id, 1);
  }
  const filled = new Float64Array(b.flags.length);
  for (let id = 0; id < p.flags.length; id++) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    addPop(t, p, b, id, 1);
    const work = p.work[id] ?? NO_WORK;
    if (work !== NO_WORK) filled[work] = (filled[work] ?? 0) + workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
  }
  for (let id = 0; id < filled.length; id++) addFilled(t, b, id, filled[id] ?? 0, 1);
  return t;
}

// --- The monthly sample and the year ---------------------------------------------

/** How many monthly samples the history holds, up to `HISTORY_LENGTH`. */
export function sampleCount(stats: StatsState): number {
  return stats.history["population"]?.length ?? 0;
}

/**
 * Writes one sample of every total, and of `money`, at the write position
 * and moves it on: onto the end until the history is full, then over the
 * oldest.
 */
export function takeSample(stats: StatsState, money: MoneySample = NO_MONEY): void {
  writeSample(stats, stats.totals, money);
}

function writeSample(stats: StatsState, values: StatTotals, money: MoneySample): void {
  const grow = sampleCount(stats) < HISTORY_LENGTH;
  for (const name of STAT_TOTALS) {
    let series = stats.history[name] ?? new Int32Array(0);
    if (grow) {
      const longer = new Int32Array(series.length + 1);
      longer.set(series);
      series = longer;
      stats.history[name] = series;
    }
    series[stats.next] = values[name] ?? 0;
  }
  for (const name of MONEY_SERIES) {
    let series = stats.money[name];
    if (grow) {
      const longer = new Float64Array(series.length + 1);
      longer.set(series);
      series = longer;
      stats.money[name] = series;
    }
    series[stats.next] = money[name];
  }
  stats.next = (stats.next + 1) % HISTORY_LENGTH;
}

/** The samples of total or money series `name`, oldest first. */
export function historyOf(stats: StatsState, name: string): number[] {
  const series: Int32Array | Float64Array | undefined = stats.history[name] ?? (MONEY_SET.has(name) ? stats.money[name as MoneySeries] : undefined);
  if (!series) throw new RangeError(`no total "${name}"`);
  const count = series.length;
  // Until the history is full `next` is its length, so the oldest is at 0.
  const first = count < HISTORY_LENGTH ? 0 : stats.next;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(series[(first + i) % count] ?? 0);
  return out;
}

/** On 1 January, the year that ended is kept and the running one starts at 0. Then, on a month's first tick, a sample, with the month the budget has just closed. */
function keepStats(state: SimState): void {
  if (isYearStart(state.tick)) {
    state.stats.lastYear = state.stats.year;
    state.stats.year = zeroYear();
  }
  if (isMonthStart(state.tick)) takeSample(state.stats, moneySample(state.budget));
}

/** The name the timer hook reports for the statistics system. */
export const STATS_SYSTEM = "stats";

/**
 * The step's system for the yearly roll and the monthly sample. It runs
 * first but for the budget's close, so the counts the other systems add on
 * 1 January go to the new year, a month's sample is the city as that month
 * opens, and its money is the month just closed.
 */
export const STATS: System = { name: STATS_SYSTEM, run: keepStats };

// --- Deltas ------------------------------------------------------------------------

/**
 * What a client's copy needs to bring its statistics level with the sim's:
 * the totals that changed since the last delta, the highest population and
 * the yearly counts as they stand, copies, and the samples taken since the
 * write position `sentNext` it last saw, oldest first, each a row of
 * `STAT_TOTALS.length` values (M3-05, protocol version 16).
 */
export interface StatsDelta {
  /** Only the totals that changed, by name. Empty when none did. */
  totals: StatTotals;
  highestPopulation: number;
  year: YearCounts;
  lastYear: YearCounts;
  /** `STAT_TOTALS.length` values for each sample taken since the last delta, oldest first. */
  samples: Int32Array;
  /** `MONEY_SERIES.length` values for each of the same samples (M4-02, protocol version 24). */
  moneySamples: Float64Array;
}

/**
 * The statistics delta since the write position was `sentNext` and the
 * totals were `sentTotals`. Without `sentTotals` every total goes. Every
 * sample between `sentNext` and today's write position is new: a host
 * sends deltas far more often than once in a hundred game years, so the
 * ring has not gone all the way round in between.
 */
export function encodeStatsDelta(stats: StatsState, sentNext: number, sentTotals?: Readonly<StatTotals>): StatsDelta {
  const count = (stats.next - sentNext + HISTORY_LENGTH) % HISTORY_LENGTH;
  const samples = new Int32Array(count * STAT_TOTALS.length);
  const moneySamples = new Float64Array(count * MONEY_SERIES.length);
  const length = sampleCount(stats);
  for (let k = 0; k < count; k++) {
    const at = (sentNext + k) % HISTORY_LENGTH;
    STAT_TOTALS.forEach((name, i) => (samples[k * STAT_TOTALS.length + i] = at < length ? (stats.history[name]?.[at] ?? 0) : 0));
    MONEY_SERIES.forEach((name, i) => (moneySamples[k * MONEY_SERIES.length + i] = at < length ? (stats.money[name][at] ?? 0) : 0));
  }
  const totals: StatTotals = {};
  for (const name of STAT_TOTALS) {
    const value = stats.totals[name] ?? 0;
    if (!sentTotals || sentTotals[name] !== value) totals[name] = value;
  }
  return { totals, highestPopulation: stats.highestPopulation, year: { ...stats.year }, lastYear: { ...stats.lastYear }, samples, moneySamples };
}

const TOTAL_NAMES = new Set(STAT_TOTALS);
const MONEY_SET: ReadonlySet<string> = new Set(MONEY_SERIES);

/** Why `delta` cannot apply to any copy's statistics, or null if it can. Changes nothing. */
export function statsDeltaProblem(delta: StatsDelta): string | null {
  if (!(delta.samples instanceof Int32Array) || delta.samples.length % STAT_TOTALS.length !== 0) return "the statistics delta's samples are not whole rows";
  if (!(delta.moneySamples instanceof Float64Array) || delta.moneySamples.length !== (delta.samples.length / STAT_TOTALS.length) * MONEY_SERIES.length) {
    return "the statistics delta's money samples are not a row for each sample";
  }
  for (const value of delta.moneySamples) if (!Number.isSafeInteger(value)) return "the statistics delta's money samples are not whole dollars";
  if (!isRecord(delta.totals)) return "the statistics delta's totals are not an object";
  for (const [name, value] of Object.entries(delta.totals)) {
    if (!TOTAL_NAMES.has(name)) return `the statistics delta names an unknown total "${name}"`;
    if (!Number.isSafeInteger(value)) return `the statistics delta's ${name} is not a whole number`;
  }
  return null;
}

/**
 * Applies `delta` to a copy's statistics and returns the names of the
 * totals it changed, in `STAT_TOTALS` order. Returns why not instead,
 * changing nothing, if `statsDeltaProblem` finds one.
 */
export function applyStatsDelta(stats: StatsState, delta: StatsDelta): string[] | string {
  const problem = statsDeltaProblem(delta);
  if (problem) return problem;
  const changed: string[] = [];
  // A copy written in the order the copy already has, so its keys stay in `STAT_TOTALS` order.
  const totals = { ...stats.totals };
  for (const name of STAT_TOTALS) {
    const value = delta.totals[name];
    if (value === undefined || value === totals[name]) continue;
    totals[name] = value;
    changed.push(name);
  }
  stats.totals = totals;
  stats.highestPopulation = delta.highestPopulation;
  stats.year = { ...delta.year };
  stats.lastYear = { ...delta.lastYear };
  const rows = delta.samples.length / STAT_TOTALS.length;
  const sample = zeroTotals();
  const money: MoneySample = { ...NO_MONEY };
  for (let k = 0; k < rows; k++) {
    STAT_TOTALS.forEach((name, i) => (sample[name] = delta.samples[k * STAT_TOTALS.length + i] ?? 0));
    MONEY_SERIES.forEach((name, i) => (money[name] = delta.moneySamples[k * MONEY_SERIES.length + i] ?? 0));
    writeSample(stats, sample, money);
  }
  return changed;
}

// --- Loading ----------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` holds exactly `names`, each a whole number of at least 0, in that order. */
function wholeCounts(value: unknown, names: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name, i) => keys[i] === name && Number.isSafeInteger(value[name]) && (value[name] as number) >= 0);
}

/**
 * Why `value` is not a well-formed `StatsState`, or null if it is. For
 * loading a save: every total and yearly count a whole number of at least
 * 0, a highest population no lower than today's, one history array per
 * total, all the same length of at most `HISTORY_LENGTH`, a write
 * position that is the end of the history until it is full, and one
 * Float64Array of whole dollars per money series, as long as the others. Whether the totals match the pops and buildings is not checked: a
 * test recounts them, and a load should not pay for it.
 */
export function checkStats(value: unknown): string | null {
  if (!isRecord(value)) return "it is not an object";
  const { totals, highestPopulation, year, lastYear, history, next, money } = value;
  if (Object.keys(value).length !== 7) return "it has missing or unknown fields";
  if (!wholeCounts(totals, STAT_TOTALS)) return "its totals are not the totals this build keeps";
  if (!Number.isSafeInteger(highestPopulation) || (highestPopulation as number) < ((totals as StatTotals)["population"] ?? 0)) {
    return "its highest population is below today's";
  }
  if (!wholeCounts(year, YEAR_COUNTS) || !wholeCounts(lastYear, YEAR_COUNTS)) return "its yearly counts are malformed";
  if (!isRecord(history)) return "its history is not an object";
  const keys = Object.keys(history);
  if (keys.length !== STAT_TOTALS.length || STAT_TOTALS.some((name, i) => keys[i] !== name)) return "its history does not have one series per total";
  const count = history["population"] instanceof Int32Array ? history["population"].length : -1;
  if (count < 0 || count > HISTORY_LENGTH || STAT_TOTALS.some((name) => !(history[name] instanceof Int32Array) || (history[name] as Int32Array).length !== count)) {
    return `its history is not one Int32Array per total, all the same length of at most ${HISTORY_LENGTH}`;
  }
  if (!Number.isSafeInteger(next) || (next as number) < 0 || (next as number) >= HISTORY_LENGTH) return "its write position is out of range";
  if (count < HISTORY_LENGTH && next !== count) return "its write position is not the end of a history that is not full";
  if (!isRecord(money)) return "its money history is not an object";
  const moneyKeys = Object.keys(money);
  if (moneyKeys.length !== MONEY_SERIES.length || MONEY_SERIES.some((name, i) => moneyKeys[i] !== name)) return "its money history does not have one series per money series";
  for (const name of MONEY_SERIES) {
    const series = money[name];
    if (!(series instanceof Float64Array) || series.length !== count) return "its money history is not one Float64Array per series, as long as the others";
    for (const dollars of series) if (!Number.isSafeInteger(dollars)) return "its money history is not whole dollars";
  }
  return null;
}
