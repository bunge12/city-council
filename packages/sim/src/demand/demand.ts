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
// and reads 0. When the parts add up to more than 100 either way they are
// scaled down together until they add up to 100, so the parts still say
// what pushes the bar and by how much of it.
//
// A bar does not jump to its new value. Each day every part moves
// `dailyShare` of the way from where it is to where the totals put it, and
// the bar is the sum of its parts. A bar that would go from 80 to -80 in a
// day takes a few days, and the city does not flicker.
//
// Two parts are not an input times a weight. `outsidePull` holds the
// residential bar's target at least at `outsidePull.bar` until the city has
// `outsidePull.untilResidents` residents, so the first houses always come,
// whatever the other inputs say. `outsideRoute` takes away whatever the
// industrial bar's other parts add up to above 0 while nothing the city has
// built reaches an outside connection: factories need a route out.
//
// Arithmetic is add, subtract, multiply and divide (CLAUDE.md rule 6), so a
// replay on any machine reaches the same bars.

import type { SimState } from "../state";
import type { System } from "../step";
import { segmentsReachingOutside } from "../roads/outside";
import { TIME_BALANCE } from "../calendar";
import type { StatTotals } from "../stats/stats";
import { DEMAND_BALANCE, type DemandBalance } from "./balance";

/** The four bars, in the order state, deltas and the debug panel hold them. */
export const DEMAND_BARS = ["residential", "commercial", "office", "industrial"] as const;
export type DemandBar = (typeof DEMAND_BARS)[number];

/**
 * Each bar's parts, in the order state holds them. The weighted inputs come
 * first, named as their weights in `demand.json`; then the two parts that
 * are not weights.
 */
export const DEMAND_PARTS = {
  residential: ["openJobs", "unemployment", "outsidePull"],
  commercial: ["spendingPower", "availableWorkers", "shopSurplus"],
  office: ["educatedWorkers", "serviceBuyers"],
  industrial: ["unemployedWorkers", "goodsNeeded", "openOfficeJobs", "outsideRoute"],
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
}

/** Each bar's parts as the inputs put them today, before the day's share is taken. */
export type DemandTargets = Record<DemandBar, Record<string, number>>;

const at = (t: StatTotals, name: string): number => t[name] ?? 0;
/** `n` over `d`, with `d` at least 1, so nothing divides by 0. */
const per = (n: number, d: number): number => n / Math.max(1, d);
const positive = (v: number): number => (v > 0 ? v : 0);

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

  // Residential: open jobs bring people, unemployment sends them away.
  const r = balance.residential;
  const jobsPart = r.openJobs * per(openJobs, workers);
  const unemploymentPart = r.unemployment * per(unemployed, workers);
  const pull = balance.outsidePull;
  const pulled = residents < pull.untilResidents && jobsPart + unemploymentPart < pull.bar;
  const residential: Record<string, number> = {
    openJobs: jobsPart,
    unemployment: unemploymentPart,
    outsidePull: pulled ? pull.bar - (jobsPart + unemploymentPart) : 0,
  };

  // Commercial: the spending no shop serves yet, and workers to staff new
  // shops, against shop jobs beyond what the spending keeps busy.
  const c = balance.commercial;
  const w = balance.spendingByWealth;
  const spending = at(t, "residentsWealthLow") * w.low + at(t, "residentsWealthMedium") * w.medium + at(t, "residentsWealthHigh") * w.high;
  const servedJobs = spending * balance.shopJobsPerSpending;
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
  for (const bar of DEMAND_BARS) fitInRange(targets[bar], DEMAND_PARTS[bar]);
  return targets;
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
 * the sum of its parts, held within -100 to 100 against rounding.
 */
export function moveDemand(demand: DemandState, targets: DemandTargets, share: number): void {
  for (const bar of DEMAND_BARS) {
    const state = demand[bar];
    let sum = 0;
    for (const name of DEMAND_PARTS[bar]) {
      const from = state.parts[name] ?? 0;
      const to = targets[bar][name] ?? 0;
      const part = from + (to - from) * share;
      state.parts[name] = part;
      sum += part;
    }
    state.value = sum > 100 ? 100 : sum < -100 ? -100 : sum;
  }
}

/** On a game day's first tick, the bars take the day's step toward where the totals put them. */
export function updateDemand(state: SimState): void {
  if (state.tick % TIME_BALANCE.ticksPerDay !== 0) return;
  const targets = demandTargets({ totals: state.stats.totals, segmentsOutside: segmentsReachingOutside(state) });
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
  }
  return null;
}
