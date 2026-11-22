// Demand numbers from `balance/demand.json`, checked when the module loads
// (M3-01, PRD "Four demand bars" and "Pacing"). The bars (demand.ts, M3-06)
// read all but `arrivalsPerYearAtFullDemand`, which arrivals read (M3-08).

import balance from "../../balance/demand.json" with { type: "json" };
import { EDUCATION_LEVELS, type EducationLevel } from "../buildings/balance";
import { isRecord, numberProblem, numberProblems, unknownKeys, type NumberRule } from "../balance-fields";

/** The demand balance file. Bar weights are bar points per whole unit of their input. */
export interface DemandBalance {
  /** How far each bar moves toward its new value a game day, from 0 to 1. */
  dailyShare: number;
  residential: { openJobs: number; unemployment: number };
  commercial: { spendingPower: number; availableWorkers: number; shopSurplus: number };
  office: { educatedWorkers: number; serviceBuyers: number };
  industrial: { unemployedWorkers: number; goodsNeeded: number; openOfficeJobs: number };
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
  /** Residents a game year with the residential bar at 100. */
  arrivalsPerYearAtFullDemand: number;
}

const RAISES: NumberRule = { min: 0, max: 1000 };
const LOWERS: NumberRule = { min: -1000, max: 0 };

/** Each bar's inputs, and whether each raises the bar or lowers it (PRD, "Four demand bars"). */
const BARS: Readonly<Record<string, Readonly<Record<string, NumberRule>>>> = {
  residential: { openJobs: RAISES, unemployment: LOWERS },
  commercial: { spendingPower: RAISES, availableWorkers: RAISES, shopSurplus: LOWERS },
  office: { educatedWorkers: RAISES, serviceBuyers: RAISES },
  industrial: { unemployedWorkers: RAISES, goodsNeeded: RAISES, openOfficeJobs: LOWERS },
};

const TOP: Readonly<Record<string, NumberRule>> = {
  dailyShare: { min: 0, max: 1, aboveMin: true },
  arrivalsPerYearAtFullDemand: { min: 0 },
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
  const others = ["spendingByWealth", "outsidePull"];
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
