// Pop numbers from `balance/pops.json`, checked when the module loads
// (M3-01, PRD "M3 Demand" and "Turnover"). Nothing reads them yet: pops
// arrive in M3-03, newcomers in M3-08 and turnover in M3-11.

import balance from "../../balance/pops.json" with { type: "json" };
import { EDUCATION_LEVELS, type EducationShares } from "../buildings/balance";
import { isRecord, isShare, numberProblems, shareProblems, unknownKeys } from "../balance-fields";
import { ZONING_BALANCE } from "../zoning/balance";

/** The pops balance file. */
export interface PopsBalance {
  /** The most people in one pop, for a home of density 1, 2 and 3 in order. */
  popSizeCap: number[];
  /** Who moves to the city. */
  newcomer: {
    /** The share of newcomers at each education level. */
    education: EducationShares;
    /** The share of newcomers at each wealth level, low, medium and high like education. Adds to 1. */
    wealth: EducationShares;
    /** The share of newcomers with children. */
    childrenShare: number;
  };
  /** The share of a pop's people who work. */
  workerShare: { withoutChildren: number; withChildren: number };
  /** Yearly rates, applied a 365th a game day. */
  turnover: {
    /** Per person: a pop's daily chance is this times its size over 365. */
    birthsPerPersonYear: number;
    /** Per person, like births. */
    deathsPerPersonYear: number;
    /** Game years on average before a child leaves: the pop loses a person and no longer counts as having children. */
    childrenLeaveYears: number;
    /** The share of households replaced by newcomers a year. */
    replacementsPerPopYear: number;
  };
}

const TOP = ["popSizeCap", "newcomer", "workerShare", "turnover"];

/** Every problem with a pops balance file, or none. A missing field is a problem, and so is a share out of 0 to 1. */
export function checkPopsBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the pops balance is not an object"];
  const errors: string[] = [];
  for (const key of TOP) if (!(key in data)) errors.push(`${key} is missing`);
  errors.push(...unknownKeys(data, TOP, "the file"));

  if ("popSizeCap" in data) {
    const caps = data["popSizeCap"];
    const levels = ZONING_BALANCE.densities.length;
    if (!Array.isArray(caps) || caps.length !== levels || !caps.every((c) => Number.isSafeInteger(c) && (c as number) >= 1)) {
      errors.push(`popSizeCap must list ${levels} whole numbers of at least 1, one per density`);
    } else if (caps.some((c, i) => i > 0 && (c as number) < (caps[i - 1] as number))) {
      errors.push("popSizeCap must not fall as density rises");
    }
  }

  if ("newcomer" in data) {
    const n = data["newcomer"];
    if (!isRecord(n)) errors.push("newcomer must be an object");
    else {
      for (const key of ["education", "wealth"]) {
        if (!(key in n)) errors.push(`newcomer.${key} is missing`);
        else errors.push(...shareProblems(n[key], EDUCATION_LEVELS, `newcomer.${key}`));
      }
      if (!("childrenShare" in n)) errors.push("newcomer.childrenShare is missing");
      else if (!isShare(n["childrenShare"])) errors.push("newcomer.childrenShare must be a share from 0 to 1");
      errors.push(...unknownKeys(n, ["education", "wealth", "childrenShare"], "newcomer"));
    }
  }

  if ("workerShare" in data) {
    const share = { min: 0, max: 1 };
    const ws = data["workerShare"];
    const wsErrors = numberProblems(ws, { withoutChildren: share, withChildren: share }, "workerShare");
    errors.push(...wsErrors);
    if (wsErrors.length === 0 && isRecord(ws) && (ws["withChildren"] as number) > (ws["withoutChildren"] as number)) {
      errors.push("workerShare.withChildren must not be above workerShare.withoutChildren");
    }
  }

  if ("turnover" in data) {
    const rate = { min: 0, max: 1 };
    errors.push(
      ...numberProblems(
        data["turnover"],
        { birthsPerPersonYear: rate, deathsPerPersonYear: rate, childrenLeaveYears: { min: 0, aboveMin: true }, replacementsPerPopYear: rate },
        "turnover",
      ),
    );
  }
  return errors;
}

/** Checks a pops balance and returns it. Throws listing every problem. */
export function resolvePopsBalance(data: unknown): PopsBalance {
  const errors = checkPopsBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/pops.json: ${errors.join("; ")}`);
  return data as PopsBalance;
}

/** The pops balance, checked. */
export const POPS_BALANCE: PopsBalance = resolvePopsBalance(balance);
