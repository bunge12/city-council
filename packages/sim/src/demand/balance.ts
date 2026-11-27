// Demand numbers from `balance/demand.json`, checked when the module loads
// (M3-01, PRD "Four demand bars" and "Pacing"). The bars (demand.ts, M3-06)
// read all but `arrivalsPerYearAtFullDemand`, which arrivals read, and
// `unfilledHomesMax`, `residentsPerUnfilledHome` and `homeFullShare`, which
// the grower reads for homes (M3-08, a count since M3-21, scaled with the
// city since #420), `fillDays`, which arrivals read (M3-21),
// `openJobsShareMax`, which it reads for workplaces, and `jobMatching`,
// which job matching reads (M3-09), `departuresPerYearAtFullDemand`, which
// satisfaction reads to send people away while the residential bar is below
// zero (M3-10), `vacancy`, which the vacancy check reads (M3-24),
// `redevelopment`, which redevelopment reads (M3-14),
// and `buildingsPerDayAtFullDemand` and `buildingsPerDayPer100kResidents`,
// which the grower reads (M3-07, scaled with the city since #442).

import balance from "../../balance/demand.json" with { type: "json" };
import { EDUCATION_LEVELS, type EducationLevel } from "../buildings/balance";
import { ZONING_BALANCE } from "../zoning/balance";
import { isRecord, numberProblem, numberProblems, unknownKeys, type NumberRule } from "../balance-fields";

/** The demand balance file. Bar weights are bar points per whole unit of their input. */
export interface DemandBalance {
  /** How far each bar moves toward its new value a game day, from 0 to 1. */
  dailyShare: number;
  /** Each bar's `tax` is the bar points its zone's tax rate is worth at the top of its range, 0 at the default rate (M4-07). */
  residential: { openJobs: number; unemployment: number; satisfaction: number; tax: number };
  commercial: { spendingPower: number; availableWorkers: number; shopSurplus: number; tax: number };
  office: { educatedWorkers: number; serviceBuyers: number; tax: number };
  industrial: { unemployedWorkers: number; goodsNeeded: number; openOfficeJobs: number; tax: number };
  /** What one resident at each wealth level counts for in spending power. Weights of 0 or more, not shares: they need not add to 1. */
  spendingByWealth: Record<EducationLevel, number>;
  /** Shop jobs one unit of spending power keeps busy. */
  shopJobsPerSpending: number;
  /** Office jobs each resident, and each shop or factory job, buys the services of. */
  officeJobsPerBuyer: number;
  /** Factory jobs each shop job needs the goods of. */
  factoryJobsPerShopJob: number;
  /** The least the residential bar reads while the city is small. */
  outsidePull: { bar: number; untilResidents: number };
  /** Residents a game year with the residential bar at 100 (M3-08). */
  arrivalsPerYearAtFullDemand: number;
  /** Residents a game year who leave with the residential bar at -100, the least satisfied first (M3-10). */
  departuresPerYearAtFullDemand: number;
  /** The average satisfaction at which residents neither raise nor lower the residential bar (M3-10). */
  satisfactionNeutral: number;
  /** New homes wait while this many homes newcomers can reach, or more, are still filling (M3-21, replacing M3-08's share of empty room). */
  unfilledHomesMax: number;
  /** One more home may fill at once for every this many residents, above `unfilledHomesMax` (#420). */
  residentsPerUnfilledHome: number;
  /** A home with fewer people than this share of its room, and room left for a household, is still filling (M3-21). */
  homeFullShare: number;
  /** With the residential bar at b, at least ceil(b / 100 x empty room / `fillDays`) people arrive a day, the empty room in homes newcomers can reach (M3-21). */
  fillDays: number;
  /** The grower adds no workplace to a zone while the open jobs in its buildings newcomers can reach are above this share of their jobs (M3-09). */
  openJobsShareMax: number;
  /** Open jobs a zone may have whatever their share, so a zone starting from nothing is not held by its first workplace (M3-21). */
  openJobsMin: number;
  /** How a pop looking for work weights an open job t seconds from home: 1 / (1 + (t / halfWeightSeconds)^falloffPower) (M3-09). */
  jobMatching: { halfWeightSeconds: number; falloffPower: number };
  /**
   * When an empty building is vacant, and a vacant one abandoned (M3-24): game days since it was built or came back into
   * use before it can be vacant, and game days vacant before it is abandoned.
   */
  vacancy: { newDays: number; abandonDays: number };
  /**
   * How soon a building on ground zoned up redevelops (M3-14): its owner's chance a game day is `chancePerDay` times
   * (land value - `valueFrom`) / (100 - `valueFrom`), at least 0, times the zone's bar over 100. At most `perDayMax`
   * buildings a game day are replaced or cleared.
   */
  redevelopment: { chancePerDay: number; valueFrom: number; perDayMax: number };
  /** By zone id: buildings the grower adds a game day with the zone's bar at 100 (M3-07). */
  buildingsPerDayAtFullDemand: Record<string, number>;
  /**
   * By zone id: buildings the grower adds a game day with the zone's bar at 100, per 100,000 residents (#442). A
   * zone's rate at full demand is the larger of this times the city's residents over 100,000 and its
   * `buildingsPerDayAtFullDemand`. 0 keeps the zone at its flat rate.
   */
  buildingsPerDayPer100kResidents: Record<string, number>;
}

const RAISES: NumberRule = { min: 0, max: 1000 };
const LOWERS: NumberRule = { min: -1000, max: 0 };

/** Each bar's inputs, and whether each raises the bar or lowers it (PRD, "Four demand bars"). */
const BARS: Readonly<Record<string, Readonly<Record<string, NumberRule>>>> = {
  residential: { openJobs: RAISES, unemployment: LOWERS, satisfaction: RAISES, tax: LOWERS },
  commercial: { spendingPower: RAISES, availableWorkers: RAISES, shopSurplus: LOWERS, tax: LOWERS },
  office: { educatedWorkers: RAISES, serviceBuyers: RAISES, tax: LOWERS },
  industrial: { unemployedWorkers: RAISES, goodsNeeded: RAISES, openOfficeJobs: LOWERS, tax: LOWERS },
};

const TOP: Readonly<Record<string, NumberRule>> = {
  dailyShare: { min: 0, max: 1, aboveMin: true },
  arrivalsPerYearAtFullDemand: { min: 0 },
  departuresPerYearAtFullDemand: { min: 0 },
  satisfactionNeutral: { min: 0, max: 100 },
  unfilledHomesMax: { min: 1, whole: true },
  residentsPerUnfilledHome: { min: 1, whole: true },
  homeFullShare: { min: 0, max: 1, aboveMin: true },
  fillDays: { min: 0, aboveMin: true },
  openJobsShareMax: { min: 0, max: 1 },
  openJobsMin: { min: 0, whole: true },
  shopJobsPerSpending: { min: 0, max: 10 },
  officeJobsPerBuyer: { min: 0, max: 10 },
  factoryJobsPerShopJob: { min: 0, max: 10 },
};

/**
 * Every problem with a demand balance file, or none. A missing field is a
 * problem, and so is a weight with the wrong sign: an input the PRD says
 * raises a bar may not lower it.
 */
export function checkDemandBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the demand balance is not an object"];
  const errors: string[] = [];
  const others = ["spendingByWealth", "outsidePull", "jobMatching", "vacancy", "redevelopment", "buildingsPerDayAtFullDemand", "buildingsPerDayPer100kResidents"];
  for (const key of [...Object.keys(BARS), ...others]) if (!(key in data)) errors.push(`${key} is missing`);
  for (const [key, rule] of Object.entries(TOP)) {
    const problem = numberProblem(data, key, rule, "");
    if (problem) errors.push(problem);
  }
  errors.push(...unknownKeys(data, [...Object.keys(BARS), ...others, ...Object.keys(TOP)], "the file"));
  for (const [bar, inputs] of Object.entries(BARS)) if (bar in data) errors.push(...numberProblems(data[bar], inputs, bar));
  if ("spendingByWealth" in data) {
    const rules = Object.fromEntries(EDUCATION_LEVELS.map((level) => [level, { min: 0 }]));
    errors.push(...numberProblems(data["spendingByWealth"], rules, "spendingByWealth"));
  }
  if ("outsidePull" in data) {
    errors.push(...numberProblems(data["outsidePull"], { bar: { min: 0, max: 100 }, untilResidents: { min: 0, whole: true } }, "outsidePull"));
  }
  if ("jobMatching" in data) {
    const rules = { halfWeightSeconds: { min: 1, max: 36000 }, falloffPower: { min: 1, max: 8, whole: true } };
    errors.push(...numberProblems(data["jobMatching"], rules, "jobMatching"));
  }
  if ("vacancy" in data) {
    const days = { min: 0, max: 3600, whole: true };
    errors.push(...numberProblems(data["vacancy"], { newDays: days, abandonDays: { ...days, min: 1 } }, "vacancy"));
  }
  if ("redevelopment" in data) {
    const rules = { chancePerDay: { min: 0, max: 1 }, valueFrom: { min: 0, max: 99, whole: true }, perDayMax: { min: 0, max: 1000, whole: true } };
    errors.push(...numberProblems(data["redevelopment"], rules, "redevelopment"));
  }
  if ("buildingsPerDayAtFullDemand" in data) {
    const rules = Object.fromEntries(ZONING_BALANCE.zones.map((zone) => [zone.id, { min: 0, whole: true }]));
    errors.push(...numberProblems(data["buildingsPerDayAtFullDemand"], rules, "buildingsPerDayAtFullDemand"));
  }
  if ("buildingsPerDayPer100kResidents" in data) {
    const rules = Object.fromEntries(ZONING_BALANCE.zones.map((zone) => [zone.id, { min: 0, max: 1000 }]));
    errors.push(...numberProblems(data["buildingsPerDayPer100kResidents"], rules, "buildingsPerDayPer100kResidents"));
  }
  return errors;
}

/** Checks a demand balance and returns it. Throws listing every problem. */
export function resolveDemandBalance(data: unknown): DemandBalance {
  const errors = checkDemandBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/demand.json: ${errors.join("; ")}`);
  return data as DemandBalance;
}

/** The demand balance, checked. */
export const DEMAND_BALANCE: DemandBalance = resolveDemandBalance(balance);
