// What a building is worth in dollars (M4-01, PRD "M4 Economy"). Property tax
// and the eminent domain price both read it.
//
// A building's floor space follows the room and the jobs it has, not its lot:
// `floorSpace.perResident` square metres for each resident it holds room for,
// and `floorSpace.perJob` for each job by kind, so a tower on 4 × 6 cells is
// worth what its hundreds of homes are and a house what its four are. Each
// use's floor space is priced at its own dollars per square metre, homes at
// the residential price and jobs at their kind's, so a mixed building adds
// its flats and its shops. The sum is scaled by the land value at the lot's
// centre: at `landValueReference` a square metre is worth its price, and
// `landValueWeight` of the price rises and falls with the land.
//
// Every input is in the building's row, its type or the derived land value,
// so the value needs no state column, like jobs (buildings/jobs.ts). Only
// add, multiply, divide and floor, so every host agrees (rule 6).

import { BUILDING_TYPES, JOB_KINDS, type BuildingType, type JobKind } from "../buildings/balance";
import { BUILDING_ALIVE, type BuildingState } from "../buildings/buildings";
import { jobsByKind, lotJobs } from "../buildings/jobs";
import { buildingValues } from "../landvalue/land-value";
import type { SimState } from "../state";
import { ECONOMY, type EconomySlider } from "./balance";

/** The price key each kind of job's floor space is valued at. */
const JOB_PRICE: Record<JobKind, EconomySlider> = { commercial: "commercial", office: "office", industrial: "industrial" };

/** A building's floor space, square metres: for its homes and for each kind of job. */
export interface FloorSpace {
  homes: number;
  jobs: Record<JobKind, number>;
  total: number;
}

/** The floor space of a building of `type` with room for `residents` and `jobs` jobs. */
export function floorSpaceOf(type: Pick<BuildingType, "zone" | "density">, residents: number, jobs: number): FloorSpace {
  const per = ECONOMY.floorSpace;
  const byKind = jobsByKind(type, jobs);
  const homes = residents * per.perResident;
  const out: Record<JobKind, number> = { commercial: 0, office: 0, industrial: 0 };
  let total = homes;
  for (const kind of JOB_KINDS) {
    out[kind] = byKind[kind] * per.perJob[kind];
    total += out[kind];
  }
  return { homes, jobs: out, total };
}

/**
 * The value in whole dollars of a building of `type` with room for
 * `residents` and `jobs` jobs, on land of value `landValue` (0 to 100).
 */
export function propertyValueOf(type: Pick<BuildingType, "zone" | "density">, residents: number, jobs: number, landValue: number): number {
  return valueOfSpace(floorSpaceOf(type, residents, jobs), landValue);
}

/** The value in whole dollars of floor space `space` on land of value `landValue`: `propertyValueOf` for a caller that has the floor space already. */
export function valueOfSpace(space: FloorSpace, landValue: number): number {
  const v = ECONOMY.value;
  let dollars = space.homes * v.perSquareMetre.residential;
  for (const kind of JOB_KINDS) dollars += space.jobs[kind] * v.perSquareMetre[JOB_PRICE[kind]];
  const ref = v.landValueReference;
  const factor = ref - v.landValueWeight * ref + v.landValueWeight * landValue;
  return Math.max(0, Math.floor((dollars * factor) / ref));
}

/**
 * The value of building `id` in whole dollars, from its row's type, room
 * and lot and the land value at its lot's centre. 0 for a free id.
 *
 * An abandoned or vacant building keeps the value of the floor space it was
 * built with. A reader that should treat it differently checks the flags
 * itself: eminent domain charges demolition only for one (M4-09), and the
 * property tax sweep (M4-05) must decide whether an abandoned building pays.
 */
export function propertyValue(state: SimState, id: number): number {
  return propertyValues(state, [id])[0] ?? 0;
}

/** `propertyValue` for each of `ids`, with land values looked up together. */
export function propertyValues(state: SimState, ids: readonly number[]): Float64Array {
  const b = state.buildings;
  const land = buildingValues(state, ids);
  const out = new Float64Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    out[i] = valueOfRow(b, id, land[i] ?? 0);
  }
  return out;
}

function valueOfRow(b: BuildingState, id: number, landValue: number): number {
  if (((b.flags[id] ?? 0) & BUILDING_ALIVE) === 0) return 0;
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  if (!type) return 0;
  return propertyValueOf(type, b.residents[id] ?? 0, lotJobs(b, id), landValue);
}
