// The tax sweep and property tax (M4-05, PRD "M4 Economy").
//
// Homes pay a yearly property tax on their value, a day at a time. Once a
// game day the TAX system visits each building, a slice a tick, as the
// vacancy check does (buildings/vacancy.ts): tick k of the day visits the
// ids that leave k over `ticksPerDay`, in id order. The visits follow from
// the tick alone, so every machine visits the same buildings on the same
// tick, a save mid-day carries on where it stopped, and no tick pays for
// more than its slice of the city.
//
// On its visit a building pays that day's share of its yearly tax, with the
// exact daily share of M4-02 (`dailyShare`), read from its value and the
// rate as they are that day. Land value is derived and moves when a factory
// goes up or the centre moves, so the visit reads it fresh and no running
// sum of property value has to be rebuilt.
//
// Residential tax is the residential rate, from state (M4-02; the command
// that sets it is M4-07), times the building's value (economy/value.ts), on
// the share of its floor space that is homes: all of a house or a tower,
// part of a mixed building. A building pays only while people live in it,
// read from who lives there on the visit, not from the vacancy check's
// flag: the tax sweep visits each id on the same tick as the vacancy check
// and runs before it, so a home people moved back into still carries
// yesterday's BUILDING_VACANT and would miss a day. A vacant building has
// nobody in it and pays nothing; an abandoned one offers no room and pays
// nothing either, and neither does a workplace.
//
// Business tax (M4-06) is charged on the same visit, so the cost of
// finding each building is paid once. Business tax follows activity, and M4
// has no trips or freight, so jobs filled stand in for it: a shop pays the
// commercial rate on its sales, its shop jobs filled times `salesPerJob`;
// an office pays the office rate on its output, its office jobs filled
// times `outputPerJob.office`; a factory pays the industrial rate on its
// output in the same way, and only while its road reaches an outside
// connection, read on the visit. A workplace nobody works in pays nothing.
// Sales are scaled down, the same share for every shop, while the city's
// shop jobs filled are more than its residents' spending power keeps busy
// (`spendingPower` and `shopJobsPerSpending`, M3-06), both read from the
// running totals, so the scale is never recounted. A mixed building pays
// the residential and commercial rates (M4.md): the commercial rate on all
// its jobs, its office jobs' output included at density 3. M5 swaps in
// trips and freight for jobs filled and keeps the rates.
//
// Each line's yearly figure is charged with its own exact daily share, so a
// year of visits adds up to the yearly figure on every line. Only add,
// multiply, divide and floor, in one fixed order, so every host agrees
// (rule 6).

import { TIME_BALANCE, yearDays } from "../calendar";
import { BUILDING_TYPES, type BuildingType } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_LANDMARK } from "../buildings/buildings";
import { jobsByKind, lotJobs, type JobsByKind } from "../buildings/jobs";
import { DEMAND_BALANCE } from "../demand/balance";
import { spendingPower } from "../demand/demand";
import { buildingValues } from "../landvalue/land-value";
import { roadReaches } from "../pops/room";
import { popIndexOf } from "../pops/where";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { kindsOf, type StatTotals } from "../stats/stats";
import type { System } from "../step";
import { ECONOMY, ECONOMY_SLIDERS } from "./balance";
import { TAX_LINES, dailyShare, moveMoney } from "./budget";
import { homesAndValue, type HomesAndValue } from "./value";

/** Each rate's place in `BudgetState.taxRates`. */
const RESIDENTIAL = ECONOMY_SLIDERS.indexOf("residential");
const COMMERCIAL = ECONOMY_SLIDERS.indexOf("commercial");
const OFFICE = ECONOMY_SLIDERS.indexOf("office");
const INDUSTRIAL = ECONOMY_SLIDERS.indexOf("industrial");

/** A building's yearly tax by line, whole dollars, in `ECONOMY_SLIDERS` order: residential, commercial, office, industrial. */
export type TaxByLine = [number, number, number, number];

/** A building's jobs filled by kind, the base its business tax follows. */
export interface JobsFilled {
  commercial: number;
  office: number;
  industrial: number;
}

/** What the business tax reads beside a building's jobs filled: the rates and the city's shop sales scale. */
export interface BusinessTaxTerms {
  /** The four tax rates, in `ECONOMY_SLIDERS` order (`BudgetState.taxRates`). */
  rates: ArrayLike<number>;
  /** The share of a shop's sales it makes, from 0 to 1 (`shopSalesScale`). */
  salesScale: number;
  /** Whether the building's road reaches an outside connection, which a factory needs to pay. */
  reachesOutside: boolean;
}

/**
 * The yearly residential tax, in whole dollars, of a building of `type`
 * with room for `residents` and `jobs` jobs, on land of value `landValue`,
 * at `rate`: the rate times its value, on the share of its floor space that
 * is homes. 0 for a building with no homes.
 */
export function residentialTaxOf(type: Pick<BuildingType, "zone" | "density">, residents: number, jobs: number, landValue: number, rate: number): number {
  return residentialTaxOfKinds(jobsByKind(type, jobs), residents, landValue, rate);
}

const space: HomesAndValue = { homes: 0, total: 0, value: 0 };

/** `residentialTaxOf` with the building's jobs already split by kind, making no object, for the sweep (issue #454). */
function residentialTaxOfKinds(byKind: Readonly<JobsByKind>, residents: number, landValue: number, rate: number): number {
  homesAndValue(byKind, residents, landValue, space);
  if (space.homes <= 0 || space.total <= 0) return 0;
  return Math.max(0, Math.floor(((space.value * space.homes) / space.total) * rate));
}

/**
 * The share of its sales a shop makes, from 0 to 1, from the running
 * totals: 1 while the residents' spending power keeps every shop job filled
 * busy, and spending power's shop jobs over the shop jobs filled once
 * there are more. The same for every shop in the city.
 */
export function shopSalesScale(totals: StatTotals): number {
  const filled = totals["filledCommercial"] ?? 0;
  const supported = spendingPower(totals) * DEMAND_BALANCE.shopJobsPerSpending;
  if (filled <= supported) return 1;
  return supported > 0 ? supported / filled : 0;
}

/**
 * The yearly business tax, in whole dollars, of a building of `type` with
 * `filled` jobs filled, into `out` at the commercial, office and industrial
 * places; the residential place is left alone. A shop pays the commercial
 * rate on its sales, an office the office rate on its output, and a factory
 * the industrial rate on its output while its road reaches outside. A mixed
 * building pays the commercial rate on all its jobs, onto the commercial line.
 */
export function businessTaxOf(type: Pick<BuildingType, "zone">, filled: JobsFilled, terms: BusinessTaxTerms, out: TaxByLine = [0, 0, 0, 0]): TaxByLine {
  const b = ECONOMY.business;
  const sales = filled.commercial * b.salesPerJob * terms.salesScale;
  const officeOutput = filled.office * b.outputPerJob.office;
  const factoryOutput = terms.reachesOutside ? filled.industrial * b.outputPerJob.industrial : 0;
  const rates = terms.rates;
  if (type.zone === "mixed") {
    out[COMMERCIAL] = Math.floor((sales + officeOutput + factoryOutput) * (rates[COMMERCIAL] ?? 0));
    out[OFFICE] = 0;
    out[INDUSTRIAL] = 0;
  } else {
    out[COMMERCIAL] = Math.floor(sales * (rates[COMMERCIAL] ?? 0));
    out[OFFICE] = Math.floor(officeOutput * (rates[OFFICE] ?? 0));
    out[INDUSTRIAL] = Math.floor(factoryOutput * (rates[INDUSTRIAL] ?? 0));
  }
  return out;
}

/** Whether building `flags` may pay: standing, not abandoned and not a landmark, which the city owns (M4-13). Who lives or works in it is the sweep's question. */
export function mayPay(flags: number): boolean {
  return (flags & BUILDING_ALIVE) !== 0 && (flags & (BUILDING_ABANDONED | BUILDING_LANDMARK)) === 0;
}

const NO_JOBS: JobsFilled = { commercial: 0, office: 0, industrial: 0 };

/** The jobs filled in building `id`: the sim's pop index, or the counts a client's copy keeps (M3-05). */
export type JobsFilledIn = (id: number) => number;

/**
 * What building `id` pays a year, by line, in whole dollars, at the city's
 * rates and the land value at its lot today: residential tax while people
 * live in it, and business tax on the jobs filled there today. All zero for
 * a free id or an abandoned building. For the hover readout and the budget
 * overlay (M4-18). The residential place does not ask whether anyone lives
 * there today, so a vacant home shows what it would pay: the sweep asks.
 * `jobsFilled` gives the jobs filled; a client's copy holds no pop rows, so
 * it passes the counts its mirror keeps (M4-16). Given `livedIn`, the people
 * living in each building, a home nobody lives in pays no residential tax,
 * as the sweep charges it: the hover readout passes it, so a vacant home
 * does not read as income the city gets.
 */
export function buildingTaxByLine(state: SimState, id: number, out: TaxByLine = [0, 0, 0, 0], jobsFilled?: JobsFilledIn, livedIn?: JobsFilledIn): TaxByLine {
  out.fill(0);
  const b = state.buildings;
  if (!mayPay(b.flags[id] ?? 0)) return out;
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  if (!type) return out;
  const rates = state.budget.taxRates;
  const filled = jobsFilled ? jobsFilled(id) : (popIndexOf(state).filled[id] ?? 0);
  if (filled > 0) {
    const terms = { rates, salesScale: shopSalesScale(state.stats.totals), reachesOutside: roadReaches(state, outsideReachByNode(state), id) };
    businessTaxOf(type, kindsOf(b.type[id] ?? 0, filled) ?? NO_JOBS, terms, out);
  }
  if ((b.residents[id] ?? 0) > 0 && (livedIn === undefined || livedIn(id) > 0)) {
    const land = buildingValues(state, [id])[0] ?? 0;
    out[RESIDENTIAL] = residentialTaxOf(type, b.residents[id] ?? 0, lotJobs(b, id), land, rates[RESIDENTIAL] ?? 0);
  }
  return out;
}

/** What building `id` pays a year in tax on every line together, in whole dollars (`buildingTaxByLine`). */
export function buildingTaxPerYear(state: SimState, id: number, jobsFilled?: JobsFilledIn, livedIn?: JobsFilledIn): number {
  const by = buildingTaxByLine(state, id, [0, 0, 0, 0], jobsFilled, livedIn);
  return by[0] + by[1] + by[2] + by[3];
}

/**
 * What live building `id` of `type` is charged a year, by line, into
 * `out`, as the sweep charges it on a visit: business tax on its `workers`
 * jobs filled, and residential tax at land value `land` when people live
 * in it, or none when `land` is null. `terms.rates` and `terms.salesScale`
 * are read as given; `terms.reachesOutside` is set from `reach`. For the
 * sweep and the budget overlay (M4-18), so the two never disagree.
 */
export function yearlyTaxDue(
  state: SimState,
  id: number,
  type: BuildingType,
  workers: number,
  land: number | null,
  terms: BusinessTaxTerms,
  reach: Uint8Array,
  out: TaxByLine,
): TaxByLine {
  const b = state.buildings;
  out.fill(0);
  if (workers > 0) {
    terms.reachesOutside = roadReaches(state, reach, id);
    businessTaxOf(type, kindsOf(b.type[id] ?? 0, workers) ?? NO_JOBS, terms, out);
  }
  // The split of its jobs by kind from the cache stats keeps, so the visit makes no object (issue #454).
  if (land !== null) out[RESIDENTIAL] = residentialTaxOfKinds(kindsOf(b.type[id] ?? 0, lotJobs(b, id)) ?? NO_JOBS, b.residents[id] ?? 0, land, terms.rates[RESIDENTIAL] ?? 0);
  return out;
}

/** The ids of the slice a tick pays, and their land values: reused across ticks. Derived scratch, never state. */
const slice: number[] = [];
const homes: number[] = [];
let landValues = new Float64Array(0);
const yearly: TaxByLine = [0, 0, 0, 0];
const due: TaxByLine = [0, 0, 0, 0];
const sweepTerms: BusinessTaxTerms = { rates: [], salesScale: 1, reachesOutside: false };

/**
 * The tax system's work for one tick: each building of the day's slice
 * pays the day's share of its yearly tax, line by line: residential tax if
 * people live in it, business tax if people work in it. A visit makes no
 * object: a young-generation collection starts on an allocation, and one set
 * off inside the sweep's tick took 2 ms, twice the sweep's share (issue #454).
 */
export function collectTax(state: SimState): void {
  const perDay = TIME_BALANCE.ticksPerDay;
  const b = state.buildings;
  const { flags, residents } = b;
  const index = popIndexOf(state);
  const { people, filled } = index;
  slice.length = 0;
  homes.length = 0;
  for (let id = state.tick % perDay; id < flags.length; id += perDay) {
    if (!mayPay(flags[id] ?? 0)) continue;
    const home = (residents[id] ?? 0) > 0 && (people[id] ?? 0) > 0;
    if (!home && (filled[id] ?? 0) <= 0) continue;
    slice.push(id);
    if (home) homes.push(id);
  }
  if (slice.length === 0) return;
  if (landValues.length < homes.length) landValues = new Float64Array(Math.max(homes.length, landValues.length * 2));
  const land = homes.length > 0 ? buildingValues(state, homes, landValues) : landValues;
  const rates = state.budget.taxRates;
  const day = Math.floor(state.tick / perDay) % yearDays();
  const reach = outsideReachByNode(state);
  sweepTerms.rates = rates;
  sweepTerms.salesScale = shopSalesScale(state.stats.totals);
  const terms = sweepTerms;
  due.fill(0);
  let h = 0;
  for (let i = 0; i < slice.length; i++) {
    const id = slice[i] as number;
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    const isHome = homes[h] === id;
    if (!type) {
      if (isHome) h++;
      continue;
    }
    yearlyTaxDue(state, id, type, filled[id] ?? 0, isHome ? (land[h++] ?? 0) : null, terms, reach, yearly);
    for (let line = 0; line < 4; line++) if (yearly[line] !== 0) due[line] = (due[line] as number) + dailyShare(yearly[line] as number, day);
  }
  for (let line = 0; line < 4; line++) if (due[line] !== 0) moveMoney(state, TAX_LINES[line] as (typeof TAX_LINES)[number], due[line] as number);
}

/** The name the timer hook reports for the tax sweep, as the debug panel shows it. */
export const TAX_SYSTEM = "tax";

export const TAX: System = { name: TAX_SYSTEM, run: collectTax };
