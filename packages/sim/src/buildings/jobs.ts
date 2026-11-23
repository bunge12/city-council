// Jobs per building (M3-01, PRD "Jobs per building"). A building's jobs are
// a function of its type and its lot, both already in its row, so they need
// no state column: `max(1, round(jobsPerCell × width × depth))` for a type
// that offers any, and 0 otherwise. The split between kinds and education
// levels is from `jobMix` and `jobKinds` in buildings.json.

import { BUILDINGS_BALANCE, BUILDING_TYPES, EDUCATION_LEVELS, JOB_KINDS, type BuildingType, type EducationLevel, type JobKind } from "./balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, type BuildingState } from "./buildings";

/** Whole jobs for each kind. */
export type JobsByKind = Record<JobKind, number>;

/** Whole jobs for each education level. */
export type JobsByEducation = Record<EducationLevel, number>;

/**
 * `x` rounded to the nearest whole number, halves up. Math.round is not on
 * rule 6's list, and for numbers of at least 0 this is the same.
 */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** The jobs a building of `type` offers on a `width` × `depth` lot. A through-lot's depth is both strips. */
export function jobsForLot(type: Pick<BuildingType, "jobsPerCell">, width: number, depth: number): number {
  if (type.jobsPerCell <= 0) return 0;
  return Math.max(1, roundHalfUp(type.jobsPerCell * (width * depth)));
}

/**
 * The jobs building `id` offers, from its row's type and lot. 0 for a free
 * id, a type with none, or an abandoned building (M3-24): job matching, the
 * running totals and the bars read a dead district as no jobs, not open ones.
 */
export function buildingJobs(b: Pick<BuildingState, "flags" | "type" | "width" | "depth">, id: number): number {
  if (((b.flags[id] ?? 0) & BUILDING_ABANDONED) !== 0) return 0;
  return lotJobs(b, id);
}

/**
 * The jobs building `id`'s type and lot hold, abandoned or not. 0 for a
 * free id or a type with none. For what does not change as a building is
 * abandoned, such as the middle of the city's jobs (where.ts).
 */
export function lotJobs(b: Pick<BuildingState, "flags" | "type" | "width" | "depth">, id: number): number {
  if (((b.flags[id] ?? 0) & BUILDING_ALIVE) === 0) return 0;
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  return type ? jobsForLot(type, b.width[id] ?? 0, b.depth[id] ?? 0) : 0;
}

/**
 * `total` split by `shares` in `keys` order into whole numbers that add to
 * `total`. Each key gets the rounded running total less the one before it,
 * so no key is more than one off its exact share and nothing is lost to
 * rounding.
 */
function splitWhole<K extends string>(total: number, keys: readonly K[], shares: Partial<Record<K, number>>): Record<K, number> {
  const out = {} as Record<K, number>;
  let running = 0;
  let given = 0;
  keys.forEach((key, i) => {
    running += shares[key] ?? 0;
    const upTo = i === keys.length - 1 ? total : Math.min(total, roundHalfUp(total * running));
    out[key] = upTo - given;
    given = upTo;
  });
  return out;
}

/** `jobs` of a building of `type` split by kind with `jobMix`. All zero for a type with no jobs. */
export function jobsByKind(type: Pick<BuildingType, "zone" | "density">, jobs: number): JobsByKind {
  const mix = BUILDINGS_BALANCE.jobMix[type.zone]?.[type.density - 1] ?? {};
  if (jobs === 0 || !JOB_KINDS.some((k) => (mix[k] ?? 0) > 0)) return { commercial: 0, office: 0, industrial: 0 };
  return splitWhole(jobs, JOB_KINDS, mix);
}

/** Jobs split by kind, then each kind by education level with `jobKinds`, summed by level. */
export function jobsByEducation(byKind: JobsByKind): JobsByEducation {
  const out: JobsByEducation = { low: 0, medium: 0, high: 0 };
  for (const kind of JOB_KINDS) {
    const part = splitWhole(byKind[kind], EDUCATION_LEVELS, BUILDINGS_BALANCE.jobKinds[kind]);
    for (const level of EDUCATION_LEVELS) out[level] += part[level];
  }
  return out;
}
