// Pop numbers from `balance/pops.json`, checked when the module loads
// (M3-01, PRD "M3 Demand" and "Turnover"). Pops in state (M3-03) read the
// size cap and the worker shares; newcomers read the newcomer mix in M3-08,
// satisfaction reads `satisfaction` in M3-10, turnover reads `turnover`
// in M3-11 and displacement reads `displacedPerTick` in M3-12.

import balance from "../../balance/pops.json" with { type: "json" };
import { EDUCATION_LEVELS, type EducationShares } from "../buildings/balance";
import { isRecord, isShare, numberProblem, numberProblems, shareProblems, unknownKeys } from "../balance-fields";
import { ZONING_BALANCE } from "../zoning/balance";

/** The pops balance file. */
export interface PopsBalance {
  /** The most people in one pop, for a home of density 1, 2 and 3 in order. */
  popSizeCap: number[];
  /** The most displaced pops placed in new homes in one tick; the rest wait in the queue (M3-12). */
  displacedPerTick: number;
  /** Who moves to the city. */
  newcomer: {
    /** The share of newcomers at each education level. */
    education: EducationShares;
    /** The share of newcomers with children. */
    childrenShare: number;
    /** For a home of density 1, 2 and 3 in order: the least and most people in a newcomer household (M3-08). */
    size: [number, number][];
    /** The satisfaction a newcomer starts at, from 0 to 100 (M3-08). */
    satisfaction: number;
    /** Game days a newcomer's workers are left out of the residential bar's unemployment, from 0 to `GRACE_DAYS_LIMIT` (#361). */
    graceDays: number;
  };
  /** The share of a pop's people who work. */
  workerShare: { withoutChildren: number; withChildren: number };
  /** How each pop's score is set once a game day, and when a pop moves out (M3-10). */
  satisfaction: {
    /** Where the score heads, from 0 to 100: with nobody who works, in a job at its own education, in a job below it, and with workers and no job. */
    target: { noWorkers: number; fittingJob: number; otherJob: number; noJob: number };
    /** How far the score moves toward its target a game day, from 0 to 1. */
    dailyShare: number;
    /** A score below this counts toward leaving. */
    leaveBelow: number;
    /** Game days in a row below `leaveBelow` before a pop moves out, from 1 to `DAYS_LOW_LIMIT`. */
    leaveAfterDays: number;
    /** What displacement takes off a target, fading over a game year (M4-10, pops/displacement.ts). */
    displacement: {
      /** Metres from a pop's home within which an expropriation counts. Above 0. */
      radius: number;
      /** Points per person an expropriation near the home displaced, and the most all of them take together. */
      neighbours: { perPerson: number; most: number };
      /** Points a pop the city displaced takes: `base` plus `perPerson` for each person its old home held, at most `most`; `byOwnerShare` of that when its owner redeveloped it. */
      own: { base: number; perPerson: number; most: number; byOwnerShare: number };
    };
  };
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

/** The most a size cap may be: a pop's size is a byte in state (pops.ts). */
export const POP_SIZE_LIMIT = 255;

/** The most `satisfaction.leaveAfterDays` may be: a pop's days below the threshold are a byte in state (pops.ts). */
export const DAYS_LOW_LIMIT = 255;

/** The most `newcomer.graceDays` may be: a pop's days of grace left are a byte in state (pops.ts). */
export const GRACE_DAYS_LIMIT = 255;

const TOP = ["popSizeCap", "displacedPerTick", "newcomer", "workerShare", "satisfaction", "turnover"];

/** Every problem with a pops balance file, or none. A missing field is a problem, and so is a share out of 0 to 1. */
export function checkPopsBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the pops balance is not an object"];
  const errors: string[] = [];
  for (const key of TOP) if (!(key in data)) errors.push(`${key} is missing`);
  errors.push(...unknownKeys(data, TOP, "the file"));

  let capsOk = false;
  if ("popSizeCap" in data) {
    const caps = data["popSizeCap"];
    const levels = ZONING_BALANCE.densities.length;
    if (!Array.isArray(caps) || caps.length !== levels || !caps.every((c) => Number.isSafeInteger(c) && (c as number) >= 1 && (c as number) <= POP_SIZE_LIMIT)) {
      errors.push(`popSizeCap must list ${levels} whole numbers from 1 to ${POP_SIZE_LIMIT}, one per density`);
    } else if (caps.some((c, i) => i > 0 && (c as number) < (caps[i - 1] as number))) {
      errors.push("popSizeCap must not fall as density rises");
    } else capsOk = true;
  }

  if ("displacedPerTick" in data) {
    const problem = numberProblem(data, "displacedPerTick", { min: 1, whole: true }, "");
    if (problem) errors.push(problem);
  }

  if ("newcomer" in data) {
    const n = data["newcomer"];
    if (!isRecord(n)) errors.push("newcomer must be an object");
    else {
      for (const key of ["education"]) {
        if (!(key in n)) errors.push(`newcomer.${key} is missing`);
        else errors.push(...shareProblems(n[key], EDUCATION_LEVELS, `newcomer.${key}`));
      }
      if (!("childrenShare" in n)) errors.push("newcomer.childrenShare is missing");
      else if (!isShare(n["childrenShare"])) errors.push("newcomer.childrenShare must be a share from 0 to 1");
      if (!("size" in n)) errors.push("newcomer.size is missing");
      else errors.push(...sizeProblems(n["size"], capsOk ? (data["popSizeCap"] as number[]) : null));
      const s = n["satisfaction"];
      if (!("satisfaction" in n)) errors.push("newcomer.satisfaction is missing");
      else if (!Number.isSafeInteger(s) || (s as number) < 0 || (s as number) > 100) errors.push("newcomer.satisfaction must be a whole number from 0 to 100");
      const g = n["graceDays"];
      if (!("graceDays" in n)) errors.push("newcomer.graceDays is missing");
      else if (!Number.isSafeInteger(g) || (g as number) < 0 || (g as number) > GRACE_DAYS_LIMIT) errors.push(`newcomer.graceDays must be a whole number from 0 to ${GRACE_DAYS_LIMIT}`);
      errors.push(...unknownKeys(n, ["education", "childrenShare", "size", "satisfaction", "graceDays"], "newcomer"));
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

  if ("satisfaction" in data) {
    const sat = data["satisfaction"];
    const score = { min: 0, max: 100, whole: true };
    if (!isRecord(sat)) errors.push("satisfaction must be an object");
    else {
      const rules = { dailyShare: { min: 0, max: 1, aboveMin: true }, leaveBelow: score, leaveAfterDays: { min: 1, max: DAYS_LOW_LIMIT, whole: true } };
      for (const [key, rule] of Object.entries(rules)) {
        const problem = numberProblem(sat, key, rule, "satisfaction");
        if (problem) errors.push(problem);
      }
      if (!("target" in sat)) errors.push("satisfaction.target is missing");
      else errors.push(...numberProblems(sat["target"], { noWorkers: score, fittingJob: score, otherJob: score, noJob: score }, "satisfaction.target"));
      if (!("displacement" in sat)) errors.push("satisfaction.displacement is missing");
      else errors.push(...displacementProblems(sat["displacement"]));
      errors.push(...unknownKeys(sat, [...Object.keys(rules), "target", "displacement"], "satisfaction"));
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

/** Problems with `satisfaction.displacement` (M4-10): a radius above 0, and points from 0 to 100, with a share from 0 to 1. */
function displacementProblems(d: unknown): string[] {
  const where = "satisfaction.displacement";
  if (!isRecord(d)) return [`${where} must be an object`];
  const errors: string[] = [];
  const radius = numberProblem(d, "radius", { min: 0, aboveMin: true }, where);
  if (radius) errors.push(radius);
  const points = { min: 0, max: 100 };
  if (!("neighbours" in d)) errors.push(`${where}.neighbours is missing`);
  else errors.push(...numberProblems(d["neighbours"], { perPerson: points, most: points }, `${where}.neighbours`));
  if (!("own" in d)) errors.push(`${where}.own is missing`);
  else errors.push(...numberProblems(d["own"], { base: points, perPerson: points, most: points, byOwnerShare: { min: 0, max: 1 } }, `${where}.own`));
  errors.push(...unknownKeys(d, ["radius", "neighbours", "own"], where));
  return errors;
}

/** Problems with `newcomer.size`: one [least, most] per density, whole numbers from 1, the most within that density's size cap when the caps are sound. */
function sizeProblems(sizes: unknown, caps: readonly number[] | null): string[] {
  const levels = ZONING_BALANCE.densities.length;
  const where = "newcomer.size";
  if (!Array.isArray(sizes) || sizes.length !== levels) return [`${where} must list ${levels} ranges, one per density`];
  const errors: string[] = [];
  sizes.forEach((range: unknown, i) => {
    const [least, most] = Array.isArray(range) && range.length === 2 ? (range as unknown[]) : [];
    if (!Number.isSafeInteger(least) || !Number.isSafeInteger(most) || (least as number) < 1 || (most as number) < (least as number)) {
      errors.push(`${where}[${i}] must be [least, most], whole numbers from 1 with the least no more than the most`);
      return;
    }
    const cap = caps?.[i];
    if (cap !== undefined && (most as number) > cap) errors.push(`${where}[${i}] must not hold more than popSizeCap[${i}], ${cap}`);
  });
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
