// The four demand bars (M3-06, PRD "Four demand bars").
//
// Residential, commercial, office and industrial, each from -100 to 100,
// recomputed by the DEMAND system on the first tick of each game day from
// the running totals (stats/stats.ts) and nothing else, so the cost does not
// grow with the city. The one input that is not a total is whether anything
// the player built has a road out of the map (roads/outside.ts), which the
// industrial bar needs.
//
// Each bar is the sum of signed parts, one per input, so the client can say
// what pushes it up and what holds it down. A part is an input times its
// weight in `balance/demand.json`. Every input is a ratio of totals from 0
// up, each over a total that is at least 1, so an empty city divides by 1
// and reads 0. The one exception is the residents' average satisfaction,
// which is measured from `satisfactionNeutral`, so unhappy residents lower
// the residential bar and happy ones raise it. When the parts add up to more than 100 either way they are
// scaled down together until they add up to 100, so the parts still say
// what pushes the bar and by how much of it.
//
// A bar does not jump to its new value. Each day every part moves
// `dailyShare` of the way from where it is to where the totals put it, and
// the bar is the sum of its parts. A bar that would go from 80 to -80 in a
// day takes a few days, and the city does not flicker.
//
// Two parts are not an input times a weight. `outsidePull` adds
// `outsidePull.bar` to the residential bar's target while the city has
// never had `outsidePull.untilResidents` residents, and again whenever it
// has nobody, so an empty city reads that much and its first houses come.
// It is added to the other parts, not a floor under them (#361): a town
// with no jobs reads its unemployment, falls below zero and empties. Its
// first newcomers are not held back by that, because the unemployment part
// leaves out the workers of pops still in their first `newcomer.graceDays`
// days (pops.json), who are looking for work. It keys on the most residents
// the city has had, so a city that shrinks back under the number does not
// get it back until it is empty. `outsideRoute` takes away whatever the
// industrial bar's other parts add up to above 0 while nothing the city has
// built reaches an outside connection: factories need a route out.
//
// Each bar's last part is what is already waiting (#420): homes still
// filling on residential, open jobs in the zone's workplaces on the others
// (pull.ts, `WAITING_PART`). The grower holds a zone back while too many of
// them wait (grower.ts), and until #420 the bar read +30 the whole time, so
// a player zoned more of what was not being built. The part's target takes
// away a share of what the bar's other targets add above zero: the homes
// still filling over the most the grower allows at once
// (`unfilledHomesMax`), or the zone's open jobs over the most it allows
// (`openJobsMin`, `openJobsShareMax`), at most all of it. So a bar reads 0
// while its zone is held and something in between as it nears the hold. It
// moves `dailyShare` a day like the rest, and then is held between 0 and the
// sum of the other parts, so it never takes a bar below zero and never adds
// to one. The systems that act on demand read the bar without it
// (`demandPull`), so the city grows as it did; only what the bar says
// changes. Counting the homes still filling is one pass over the buildings,
// once a game day; the open jobs are kept by job matching's openings. While
// a change of roads is settling nothing is counted and each waiting part
// stays where it is, as the grower adds nothing then.
//
// Arithmetic is add, subtract, multiply and divide (CLAUDE.md rule 6), so a
// replay on any machine reaches the same bars.

import type { SimState } from "../state";
import type { System } from "../step";
import { segmentsReachingOutside } from "../roads/outside";
import { TIME_BALANCE } from "../calendar";
import type { StatTotals } from "../stats/stats";
import { DEMAND_BALANCE, type DemandBalance } from "./balance";
import { WAITING_PART } from "./pull";
import { reachableRoom } from "../pops/room";
import { zoneJobs } from "../pops/openings";
import { workplacesHeldBy } from "../pops/open-jobs";
import { ZONING_BALANCE } from "../zoning/balance";
import { cellsSettled } from "../zoning/cell-index";

/** The four bars, in the order state, deltas and the debug panel hold them. */
export const DEMAND_BARS = ["residential", "commercial", "office", "industrial"] as const;
export type DemandBar = (typeof DEMAND_BARS)[number];

/**
 * Each bar's parts, in the order state holds them. The weighted inputs come
 * first, named as their weights in `demand.json`; then the two parts that
 * are not weights; last, what is already waiting (`WAITING_PART`, #420).
 */
export const DEMAND_PARTS = {
  residential: ["openJobs", "unemployment", "satisfaction", "outsidePull", "homesFilling"],
  commercial: ["spendingPower", "availableWorkers", "shopSurplus", "jobsOpen"],
  office: ["educatedWorkers", "serviceBuyers", "jobsOpen"],
  industrial: ["unemployedWorkers", "goodsNeeded", "openOfficeJobs", "outsideRoute", "jobsOpen"],
} as const satisfies Record<DemandBar, readonly string[]>;

/** One bar: its value and the parts it is the sum of. */
export interface BarState {
  /** From -100 to 100. The sum of `parts`. */
  value: number;
  /** By name in `DEMAND_PARTS`: what each input adds to the bar, signed. */
  parts: Record<string, number>;
}

/** The four bars. Plain numbers (CLAUDE.md rule 7). Part of `SimState`. */
export type DemandState = Record<DemandBar, BarState>;

/** Every bar at 0, as a new city has them until its first day. */
export function createDemand(): DemandState {
  const bars = {} as DemandState;
  for (const bar of DEMAND_BARS) bars[bar] = { value: 0, parts: Object.fromEntries(DEMAND_PARTS[bar].map((p) => [p, 0])) };
  return bars;
}

/** A copy, for a delta or a test. */
export function copyDemand(demand: DemandState): DemandState {
  const out = {} as DemandState;
  for (const bar of DEMAND_BARS) out[bar] = { value: demand[bar].value, parts: { ...demand[bar].parts } };
  return out;
}

// --- Where the totals put the bars ---------------------------------------------

/** What the bars read: the running totals, and whether the city has a road out. */
export interface DemandInputs {
  totals: StatTotals;
  /** Road segments the player built on pieces that reach an outside connection (`segmentsReachingOutside`). */
  segmentsOutside: number;
  /**
   * The most residents the city has had (`stats.highestPopulation`). The
   * pull from outside stops once it reaches `untilResidents`, until the city
   * is empty again. Left out, a test's city is taken to have never had more
   * than it has now.
   */
  highestPopulation?: number;
  /**
   * By bar, from 0 to 1: how near the grower is to holding its zone back
   * for what is already waiting, 1 when it does (`waitingShares`, #420). The
   * bar's waiting part takes this share of what its other parts add above
   * zero. Left out, nothing waits.
   */
  waiting?: Partial<Record<DemandBar, number>>;
}

/** Each bar's parts as the inputs put them today, before the day's share is taken. */
export type DemandTargets = Record<DemandBar, Record<string, number>>;

const at = (t: StatTotals, name: string): number => t[name] ?? 0;
/** `n` over `d`, with `d` at least 1, so nothing divides by 0. */
const per = (n: number, d: number): number => n / Math.max(1, d);
const positive = (v: number): number => (v > 0 ? v : 0);

/**
 * The residents' spending power: each resident counted at their wealth
 * level's weight in `spendingByWealth`, from the running totals. The
 * commercial bar reads it, and so does the sales tax (M4-06), which scales
 * shops' sales down while there are more shop jobs filled than it keeps busy.
 */
export function spendingPower(t: StatTotals, balance: DemandBalance = DEMAND_BALANCE): number {
  const w = balance.spendingByWealth;
  return at(t, "residentsWealthLow") * w.low + at(t, "residentsWealthMedium") * w.medium + at(t, "residentsWealthHigh") * w.high;
}

/**
 * Where the inputs put every part of every bar, scaled so no bar's parts
 * add up to more than 100 either way. For tests, and the system below.
 */
export function demandTargets(inputs: DemandInputs, balance: DemandBalance = DEMAND_BALANCE): DemandTargets {
  const t = inputs.totals;
  const residents = at(t, "population");
  const unemployed = at(t, "workersUnemployed");
  const workers = at(t, "workersEmployed") + unemployed;
  const shopJobs = at(t, "jobsCommercial");
  const officeJobs = at(t, "jobsOffice");
  const factoryJobs = at(t, "jobsIndustrial");
  const openOffice = positive(officeJobs - at(t, "filledOffice"));
  const openJobs = positive(shopJobs - at(t, "filledCommercial")) + openOffice + positive(factoryJobs - at(t, "filledIndustrial"));
  const low = at(t, "residentsEducationLow");
  const medium = at(t, "residentsEducationMedium");
  const high = at(t, "residentsEducationHigh");

  // Residential: open jobs bring people, unemployment sends them away, and
  // residents happier than `satisfactionNeutral` on average bring more
  // (M3-10). The average is weighted by pop size, and a city with nobody
  // in it reads 0 rather than the neutral score's distance from 0.
  const r = balance.residential;
  const jobsPart = r.openJobs * per(openJobs, workers);
  // Newcomers still in their grace are looking for work, not out of it (#361).
  const unemploymentPart = r.unemployment * per(positive(unemployed - at(t, "workersUnemployedNew")), workers);
  const satisfactionPart = residents > 0 ? (r.satisfaction * (at(t, "residentSatisfaction") / residents - balance.satisfactionNeutral)) / 100 : 0;
  const pull = balance.outsidePull;
  const highest = Math.max(residents, inputs.highestPopulation ?? 0);
  const residential: Record<string, number> = {
    openJobs: jobsPart,
    unemployment: unemploymentPart,
    satisfaction: satisfactionPart,
    outsidePull: residents === 0 || highest < pull.untilResidents ? pull.bar : 0,
  };

  // Commercial: the spending no shop serves yet, and workers to staff new
  // shops, against shop jobs beyond what the spending keeps busy. The
  // spending keeps at most one shop job busy per worker, so a city with
  // more shop jobs than workers does not want shops.
  const c = balance.commercial;
  const spending = spendingPower(t, balance);
  // Shops cannot staff more jobs than the city has workers.
  const servedJobs = Math.min(spending * balance.shopJobsPerSpending, workers);
  const commercial: Record<string, number> = {
    spendingPower: c.spendingPower * per(positive(servedJobs - shopJobs), servedJobs),
    availableWorkers: c.availableWorkers * per(unemployed, workers),
    shopSurplus: c.shopSurplus * per(positive(shopJobs - servedJobs), shopJobs),
  };

  // Office: medium and high education workers who have no office job, and
  // residents and businesses whose services no office provides yet. The
  // totals count residents by education, not workers, so a city's workers
  // are taken to share its residents' education.
  const o = balance.office;
  const educatedWorkers = workers * per(medium + high, residents);
  const buyers = (residents + shopJobs + factoryJobs) * balance.officeJobsPerBuyer;
  const office: Record<string, number> = {
    educatedWorkers: o.educatedWorkers * per(positive(educatedWorkers - at(t, "filledOffice")), workers),
    serviceBuyers: o.serviceBuyers * per(positive(buyers - officeJobs), buyers),
  };

  // Industrial: low and medium education workers with no job of any kind,
  // and shops whose goods no factory makes yet, against open office jobs,
  // so a dense city leans on offices. Nothing at all without a road out.
  const i = balance.industrial;
  const goodsJobs = shopJobs * balance.factoryJobsPerShopJob;
  const unemployedPart = i.unemployedWorkers * per(unemployed * per(low + medium, residents), workers);
  const goodsPart = i.goodsNeeded * per(positive(goodsJobs - factoryJobs), goodsJobs);
  const officePart = i.openOfficeJobs * per(openOffice, workers);
  const industrySum = unemployedPart + goodsPart + officePart;
  const industrial: Record<string, number> = {
    unemployedWorkers: unemployedPart,
    goodsNeeded: goodsPart,
    openOfficeJobs: officePart,
    outsideRoute: inputs.segmentsOutside === 0 && industrySum > 0 ? -industrySum : 0,
  };

  const targets: DemandTargets = { residential, commercial, office, industrial };
  for (const bar of DEMAND_BARS) {
    fitInRange(targets[bar], DEMAND_PARTS[bar]);
    // Then what is already waiting takes its share of what the rest add above zero.
    const share = inputs.waiting?.[bar] ?? 0;
    const above = othersSum(targets[bar], bar);
    targets[bar][WAITING_PART[bar]] = share > 0 && above > 0 ? -(above * (share < 1 ? share : 1)) : 0;
  }
  return targets;
}

/** The sum of every part of `bar` in `parts` but its waiting part. */
function othersSum(parts: Readonly<Record<string, number>>, bar: DemandBar): number {
  const waiting = WAITING_PART[bar];
  let sum = 0;
  for (const name of DEMAND_PARTS[bar]) if (name !== waiting) sum += parts[name] ?? 0;
  return sum;
}

/** `n` over `most`, from 0 to 1: 1 once `n` reaches `most`. */
const shareOf = (n: number, most: number): number => (n <= 0 ? 0 : n >= most ? 1 : n / most);

/** Zone number of each workplace bar's zone. */
const BAR_ZONES = Object.fromEntries(
  (["commercial", "office", "industrial"] as const).map((bar) => [bar, ZONING_BALANCE.zones.findIndex((z) => z.id === bar) + 1]),
) as Record<Exclude<DemandBar, "residential">, number>;

/**
 * How near the grower is to holding each zone back for what is already
 * waiting, from 0 to 1, as the header says: the homes newcomers can reach
 * still filling over `unfilledHomesMax`, and for each workplace zone its
 * open jobs over the most it may have, 1 while the grower holds it
 * (`workplacesHeldBy`). One pass over the buildings for the homes.
 */
export function waitingShares(state: SimState): Record<DemandBar, number> {
  const room = reachableRoom(state);
  const jobs = zoneJobs(state);
  const shares = { residential: shareOf(room.unfilled, DEMAND_BALANCE.unfilledHomesMax) } as Record<DemandBar, number>;
  for (const [bar, zone] of Object.entries(BAR_ZONES) as [Exclude<DemandBar, "residential">, number][]) {
    const most = Math.max(DEMAND_BALANCE.openJobsMin, DEMAND_BALANCE.openJobsShareMax * (jobs.jobs[zone] ?? 0));
    shares[bar] = workplacesHeldBy(jobs, zone) ? 1 : shareOf(jobs.open[zone] ?? 0, most);
  }
  return shares;
}

/** Scales `parts` together so they add up to no more than 100 either way. */
function fitInRange(parts: Record<string, number>, names: readonly string[]): void {
  let sum = 0;
  for (const name of names) sum += parts[name] ?? 0;
  const size = sum < 0 ? -sum : sum;
  if (size <= 100) return;
  const scale = 100 / size;
  for (const name of names) parts[name] = (parts[name] ?? 0) * scale;
}

/**
 * Moves every part `share` of the way to its target and sets each bar to
 * the sum of its parts, held within -100 to 100 against rounding. The
 * waiting part is then held between minus what the others add above zero
 * and 0, so it never takes the bar below zero or adds to it.
 */
export function moveDemand(demand: DemandState, targets: DemandTargets, share: number): void {
  for (const bar of DEMAND_BARS) {
    const state = demand[bar];
    const waiting = WAITING_PART[bar];
    let sum = 0;
    for (const name of DEMAND_PARTS[bar]) {
      if (name === waiting) continue;
      const from = state.parts[name] ?? 0;
      const to = targets[bar][name] ?? 0;
      const part = from + (to - from) * share;
      state.parts[name] = part;
      sum += part;
    }
    const from = state.parts[waiting] ?? 0;
    const moved = from + ((targets[bar][waiting] ?? 0) - from) * share;
    const least = sum > 0 ? -sum : 0;
    const part = moved < least ? least : moved < 0 ? moved : 0;
    state.parts[waiting] = part;
    sum += part;
    // A sum that is not a number, from a save that loaded parts near the
    // largest double, reads as 0 rather than poisoning every later day.
    state.value = sum > 100 ? 100 : sum < -100 ? -100 : Number.isNaN(sum) ? 0 : sum;
  }
}

/** On a game day's first tick, the bars take the day's step toward where the totals put them. */
export function updateDemand(state: SimState): void {
  if (state.tick % TIME_BALANCE.ticksPerDay !== 0) return;
  // While a change of roads is still settling, what waits is not counted:
  // the open jobs come from the building index, which would settle the
  // cells at once, and the grower adds nothing then anyway. Each waiting
  // part stays where it is for the day.
  const settled = cellsSettled(state);
  const targets = demandTargets({
    totals: state.stats.totals,
    segmentsOutside: segmentsReachingOutside(state),
    highestPopulation: state.stats.highestPopulation,
    ...(settled ? { waiting: waitingShares(state) } : {}),
  });
  if (!settled) for (const bar of DEMAND_BARS) targets[bar][WAITING_PART[bar]] = state.demand[bar].parts[WAITING_PART[bar]] ?? 0;
  moveDemand(state.demand, targets, DEMAND_BALANCE.dailyShare);
}

/** The name the timer hook reports for the demand system. */
export const DEMAND_SYSTEM = "demand";

/**
 * The step's system for the bars. It runs after the statistics, so it reads
 * the totals as the day opens, and before every system that acts on them.
 */
export const DEMAND: System = { name: DEMAND_SYSTEM, run: updateDemand };

// --- Loading ----------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Why `value` is not a well-formed `DemandState`, or null if it is. For
 * loading a save and applying a delta: the four bars in order, each with
 * exactly its parts in order, every number finite and each bar from -100 to
 * 100. Whether a bar is the sum of its parts is not checked: rounding in the
 * sum is the sim's, and a load should take what the sim wrote.
 */
export function checkDemand(value: unknown): string | null {
  if (!isRecord(value)) return "it is not an object";
  const keys = Object.keys(value);
  if (keys.length !== DEMAND_BARS.length || DEMAND_BARS.some((bar, i) => keys[i] !== bar)) return "it does not hold the four bars";
  for (const bar of DEMAND_BARS) {
    const state = value[bar];
    if (!isRecord(state) || Object.keys(state).length !== 2) return `the ${bar} bar is malformed`;
    const { value: v, parts } = state;
    if (!finite(v) || v < -100 || v > 100) return `the ${bar} bar is not a number from -100 to 100`;
    if (!isRecord(parts)) return `the ${bar} bar's parts are not an object`;
    const names = DEMAND_PARTS[bar];
    const have = Object.keys(parts);
    if (have.length !== names.length || names.some((name, i) => have[i] !== name || !finite(parts[name]))) {
      return `the ${bar} bar's parts are not the parts this build keeps`;
    }
    // Parts can be large and cancel out, but four near the largest double
    // would add up to no number at all. The sim never writes one this large.
    if (names.some((name) => Math.abs(parts[name] as number) > 1e300)) return `the ${bar} bar has a part far off the bar`;
  }
  return null;
}
