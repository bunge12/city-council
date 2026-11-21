// Land value numbers from `balance/landvalue.json`, checked when the module
// loads (M3-13, PRD "Land value"). land-value.ts reads them.

import balance from "../../balance/landvalue.json" with { type: "json" };
import { isRecord, numberProblem, numberProblems, unknownKeys, type NumberRule } from "../balance-fields";
import { ROAD_TYPES } from "../roads/balance";

/** Points within `near` metres, none from `far` on, a straight line between. */
export interface Falloff {
  points: number;
  near: number;
  far: number;
}

/** What one industrial building takes off the ground around it. */
export interface IndustrySource {
  /** Points taken at the lot's centre. */
  strength: number;
  /** Metres from the lot's centre at which it takes none. */
  radius: number;
}

/** The land value balance file. */
export interface LandValueBalance {
  /** Points every cell starts from. */
  base: number;
  /** Points by the id of the road type a cell fronts. */
  roadAccess: Record<string, number>;
  water: Falloff;
  centre: Falloff;
  /** By industrial density, 1 to 3, in that order. */
  industry: IndustrySource[];
  /** The most points pollution takes off one cell. */
  maxPollution: number;
  /** Side of the squares pollution is counted on, metres. */
  squareSize: number;
}

/** A value is held between 0 and this. */
export const LAND_VALUE_MAX = 100;

/** The farthest the water distance map searches, metres (`water.far`). */
export const WATER_REACH_MAX = 1000;

const POINTS: NumberRule = { min: 0, max: LAND_VALUE_MAX, whole: true };

const TOP: Readonly<Record<string, NumberRule>> = {
  base: POINTS,
  maxPollution: POINTS,
  squareSize: { min: 8, max: 500, whole: true },
};

function falloffProblems(value: unknown, where: string, farMax: number): string[] {
  const errors = numberProblems(value, { points: POINTS, near: { min: 0 }, far: { min: 0, max: farMax } }, where);
  if (errors.length === 0 && isRecord(value) && (value["far"] as number) <= (value["near"] as number)) errors.push(`${where}.far must be more than ${where}.near`);
  return errors;
}

/** Every problem with a land value balance file, or none. A missing field is a problem. */
export function checkLandValueBalance(data: unknown): string[] {
  if (!isRecord(data)) return ["the land value balance is not an object"];
  const errors: string[] = [];
  const others = ["roadAccess", "water", "centre", "industry"];
  for (const key of others) if (!(key in data)) errors.push(`${key} is missing`);
  for (const [key, rule] of Object.entries(TOP)) {
    const problem = numberProblem(data, key, rule, "");
    if (problem) errors.push(problem);
  }
  errors.push(...unknownKeys(data, [...others, ...Object.keys(TOP)], "the file"));
  if ("roadAccess" in data) {
    const zonable = ROAD_TYPES.filter((t) => t.zonable === true).map((t) => t.id);
    errors.push(...numberProblems(data["roadAccess"], Object.fromEntries(zonable.map((id) => [id, POINTS])), "roadAccess"));
  }
  if ("water" in data) errors.push(...falloffProblems(data["water"], "water", WATER_REACH_MAX));
  if ("centre" in data) errors.push(...falloffProblems(data["centre"], "centre", Number.POSITIVE_INFINITY));
  if ("industry" in data) {
    const industry = data["industry"];
    if (!Array.isArray(industry) || industry.length !== 3) errors.push("industry must list one entry for each density, 1 to 3");
    else {
      industry.forEach((entry, i) => {
        errors.push(...numberProblems(entry, { strength: POINTS, radius: { min: 0, max: 2000, aboveMin: true } }, `industry[${i}]`));
      });
    }
  }
  return errors;
}

/** Checks a land value balance and returns it. Throws listing every problem. */
export function resolveLandValueBalance(data: unknown): LandValueBalance {
  const errors = checkLandValueBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/landvalue.json: ${errors.join("; ")}`);
  return data as LandValueBalance;
}

/** The land value balance, checked. */
export const LAND_VALUE_BALANCE: LandValueBalance = resolveLandValueBalance(balance);
