// Land value numbers from `balance/landvalue.json`, checked when the module
// loads (M3-13, PRD "Land value"). land-value.ts reads them.

import balance from "../../balance/landvalue.json" with { type: "json" };
import { isRecord, numberProblem, numberProblems, shareProblems, unknownKeys, type NumberRule } from "../balance-fields";
import { EDUCATION_LEVELS, type EducationShares } from "../buildings/balance";
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

/** The wealth mix of newcomers to homes worth `from` points or more, up to the next band's `from` (M3-25). */
export interface WealthBand extends EducationShares {
  from: number;
}

/** How land value shapes who moves in (M3-25). */
export interface NewcomerValue {
  /** A home's weight in the draw of newcomers' homes is its value less this, and at least 1. */
  homeWeightFrom: number;
  /** By value, lowest first, the first from 0: the share of newcomers at each wealth level. */
  wealth: WealthBand[];
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
  /** How land value shapes who moves in (M3-25). */
  newcomers: NewcomerValue;
  /** What a building is worth to its owner, for redevelopment (M3-14). */
  redevelopment: RedevelopmentWorth;
}

/**
 * A building's worth to its owner (M3-14): its land value times its lot's
 * cells times `worthByDensity[density - 1]`. A replacement must be worth at
 * least 1 + `margin` times what it replaces.
 */
export interface RedevelopmentWorth {
  worthByDensity: number[];
  margin: number;
}

/** `f.points` within `f.near` of `distance`, none from `f.far` on, a straight line between, rounded down. */
export function falloff(f: Falloff, distance: number): number {
  if (distance <= f.near) return f.points;
  if (distance >= f.far) return 0;
  return Math.floor((f.points * (f.far - distance)) / (f.far - f.near));
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
  const others = ["roadAccess", "water", "centre", "industry", "newcomers", "redevelopment"];
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
  if ("newcomers" in data) errors.push(...newcomerProblems(data["newcomers"]));
  if ("redevelopment" in data) errors.push(...worthProblems(data["redevelopment"]));
  return errors;
}

function worthProblems(r: unknown): string[] {
  if (!isRecord(r)) return ["redevelopment must be an object"];
  const errors = unknownKeys(r, ["worthByDensity", "margin"], "redevelopment");
  const margin = numberProblem(r, "margin", { min: 0, max: 10 }, "redevelopment");
  if (margin) errors.push(margin);
  const by = r["worthByDensity"];
  if (!Array.isArray(by) || by.length !== 3 || !by.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)) {
    errors.push("redevelopment.worthByDensity must list a worth above 0 for each density, 1 to 3");
  } else if (!(by[0] < by[1] && by[1] < by[2])) errors.push("redevelopment.worthByDensity must rise with density");
  return errors;
}

function newcomerProblems(n: unknown): string[] {
  if (!isRecord(n)) return ["newcomers must be an object"];
  const errors = unknownKeys(n, ["homeWeightFrom", "wealth"], "newcomers");
  const from = numberProblem(n, "homeWeightFrom", POINTS, "newcomers");
  if (from) errors.push(from);
  const bands = n["wealth"];
  if (!Array.isArray(bands) || bands.length === 0) return [...errors, "newcomers.wealth must list at least one band"];
  bands.forEach((band, i) => {
    const where = `newcomers.wealth[${i}]`;
    if (!isRecord(band)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const { from: start, ...shares } = band;
    if (!Number.isSafeInteger(start) || (start as number) < 0 || (start as number) > LAND_VALUE_MAX) errors.push(`${where}.from must be a whole number of points from 0 to ${LAND_VALUE_MAX}`);
    else if (i === 0 && start !== 0) errors.push("newcomers.wealth[0].from must be 0");
    else if (i > 0 && (start as number) <= ((bands[i - 1] as { from?: number })?.from ?? -1)) errors.push(`${where}.from must be above the band before`);
    errors.push(...shareProblems(shares, EDUCATION_LEVELS, where));
  });
  return errors;
}

/** The wealth mix of a newcomer to a home worth `value` points: the last band that starts at or below it. */
export function wealthMixAt(value: number): EducationShares {
  const bands = LAND_VALUE_BALANCE.newcomers.wealth;
  let mix = bands[0] as WealthBand;
  for (const band of bands) if (band.from <= value) mix = band;
  return mix;
}

/** Checks a land value balance and returns it. Throws listing every problem. */
export function resolveLandValueBalance(data: unknown): LandValueBalance {
  const errors = checkLandValueBalance(data);
  if (errors.length > 0) throw new TypeError(`balance/landvalue.json: ${errors.join("; ")}`);
  return data as LandValueBalance;
}

/** The land value balance, checked. */
export const LAND_VALUE_BALANCE: LandValueBalance = resolveLandValueBalance(balance);
