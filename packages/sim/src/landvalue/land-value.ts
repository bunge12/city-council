// Land value (M3-13, PRD "Land value"). Every zoning cell has a value from 0
// to 100: `base` plus four parts from landvalue.json, each a whole number
// of points.
//   - Road access, from the type of the road the cell fronts.
//   - Distance to water, from the terrain (water.ts).
//   - Distance to the city centre, from the centre in state.
//   - Pollution from industry nearby, which subtracts: a grid of squares the
//     building index keeps as buildings come and go (pollution.ts).
//
// Only the centre is state. Everything else follows from the roads, the
// terrain and the buildings in state, so a value is worked out when it is
// asked for and never saved, like where a cell is. There is no pass over the
// map to save the place of: a factory built on a tick lowers the values
// around it from that tick, on every machine and after a reload. Pollution
// is integer points summed per square, so it is the same however the grid
// was built (pollution.ts).
//
// The centre is the middle of the city's jobs, weighted by the jobs each
// building offers (buildings/jobs.ts), or of its homes, weighted by room,
// while it has no jobs. The building index keeps the sums it needs. The land value system works it out on the first
// settled tick at or after `centre.due`: the first tick of each game month,
// or, while the city has no centre, of each game day, so the first houses
// give it one. It waits while a change of roads settles, since it reads
// where each lot is.

import { TIME_BALANCE, gameDate } from "../calendar";
import { isBuilding } from "../buildings/buildings";
import { jobAndHomeMiddles, lotCentres, pollutionGrid } from "../buildings/where";
import type { Terrain } from "../terrain/terrain";
import { ROAD_TYPES } from "../roads/balance";
import type { SimState } from "../state";
import type { System } from "../step";
import { terrainOf } from "../terrain/cache";
import { cellCorners, cellsSettled } from "../zoning/cell-index";
import type { CellRef } from "../zoning/cells";
import { LAND_VALUE_BALANCE, LAND_VALUE_MAX, falloff } from "./balance";
import { pollutionAt, pollutionSide } from "./pollution";
import { waterDistanceAt } from "./water";

/** Name the timer hook reports for the land value system. */
export const LAND_VALUE_SYSTEM = "landValue";

/** The first tick of the game day after the one `tick` is on. */
function nextDay(tick: number): number {
  const t = TIME_BALANCE.ticksPerDay;
  return (Math.floor(tick / t) + 1) * t;
}

/** The first tick of the game month after the one `tick` is on. */
export function nextMonth(tick: number): number {
  const date = gameDate(tick);
  const days = TIME_BALANCE.monthDays[date.month - 1] ?? 0;
  return (date.dayNumber + days - date.day + 1) * TIME_BALANCE.ticksPerDay;
}

/**
 * The middle of the jobs of the buildings in `state`, or of their homes
 * when none offers a job, and what it weighs. From whole-number sums the
 * building index keeps as buildings come and go, with each lot's centre
 * rounded to an eighth of a metre (buildings/where.ts), so it costs the
 * same on a town as on a village and is the same on every machine.
 */
export function findCentre(state: SimState): { x: number; z: number; weight: number } {
  const m = jobAndHomeMiddles(state);
  if (m.jobs > 0) return { x: m.jobX, z: m.jobZ, weight: m.jobs };
  if (m.room > 0) return { x: m.roomX, z: m.roomZ, weight: m.room };
  return { x: 0, z: 0, weight: 0 };
}

/** Works the centre out again, as the header says, when it is due and the cells have settled. */
export function updateCentre(state: SimState): void {
  if (state.tick < state.centre.due || !cellsSettled(state)) return;
  const found = findCentre(state);
  state.centre = { ...found, due: found.weight > 0 ? nextMonth(state.tick) : nextDay(state.tick) };
}

/** The land value system: keeps the city centre. Values themselves are worked out when asked for. */
export const LAND_VALUE: System = { name: LAND_VALUE_SYSTEM, run: updateCentre };

export { falloff };

/** A cell's value and the parts it is made of, each in whole points. */
export interface LandValue {
  /** `base + road + water + centre - pollution`, held between 0 and 100. */
  value: number;
  base: number;
  /** From the type of road the cell fronts. */
  road: number;
  /** From how near water is. */
  water: number;
  /** From how near the city centre is; 0 for a city with no centre. */
  centre: number;
  /** Taken off by industry nearby, up to `maxPollution`. */
  pollution: number;
}

/**
 * The value of land at (x, z) fronting a road of type `roadType` (its place
 * in `ROAD_TYPES`), and its parts. For a cell, `landValueAt`.
 */
export function landValueAtPoint(state: SimState, x: number, z: number, roadType: number): LandValue {
  return valueWith(state, terrainOf(state.seed), pollutionGrid(state), x, z, roadType);
}

/** `landValueAtPoint` with the terrain and the pollution grid looked up already, for a pass over many points. */
function valueWith(state: SimState, terrain: Terrain, grid: Int32Array, x: number, z: number, roadType: number): LandValue {
  const lv = LAND_VALUE_BALANCE;
  const id = ROAD_TYPES[roadType]?.id;
  const road = id === undefined ? 0 : (lv.roadAccess[id] ?? 0);
  const water = falloff(lv.water, waterDistanceAt(terrain, x, z));
  const c = state.centre;
  const centre = c.weight > 0 ? falloff(lv.centre, Math.sqrt((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z))) : 0;
  const pollution = Math.min(lv.maxPollution, Math.max(0, pollutionAt(grid, x, z)));
  const value = Math.min(LAND_VALUE_MAX, Math.max(0, lv.base + road + water + centre - pollution));
  return { value, base: lv.base, road, water, centre, pollution };
}

/**
 * The land value of each of the buildings `ids` (M3-25): the value at its
 * lot's centre, fronting the road of its lot's first cell, as
 * `landValueAtPoint` gives it. A building whose lot is not there, or no
 * building, is worth 0. For the arrivals system, which asks of every home
 * with room on each tick people are due: the building index keeps each
 * value until its building is filed again, pollution changes within reach
 * of it or the centre moves (buildings/where.ts), so most are read, not
 * worked out. Written into `into` when it is long enough, for a caller that
 * keeps one between ticks rather than make one each.
 */
export function buildingValues(state: SimState, ids: readonly number[], into?: Float64Array): Float64Array {
  const lv = LAND_VALUE_BALANCE;
  const grid = pollutionGrid(state);
  const { x, z, water: waterPoints, value: kept, valueCentre, valueChunk, valueEpoch, chunkEpoch } = lotCentres(state);
  const b = state.buildings;
  const segType = state.roads.segType;
  const road = ROAD_TYPES.map((t) => lv.roadAccess[t.id] ?? 0);
  const c = state.centre;
  // The values kept are for one centre: a move, once a game month, means working each out again.
  if (valueCentre.weight !== c.weight || valueCentre.x !== c.x || valueCentre.z !== c.z) {
    kept.fill(-1);
    valueCentre.x = c.x;
    valueCentre.z = c.z;
    valueCentre.weight = c.weight;
  }
  const q = lv.squareSize;
  const side = pollutionSide();
  const out = into && into.length >= ids.length ? into : new Float64Array(ids.length);
  const n = kept.length;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    // Nearly every home, nearly every tick: a value kept is one for a live building whose lot is there.
    // Good while pollution has not changed within reach of its chunk since.
    const known = id >= 0 && id < n && valueEpoch[id] === chunkEpoch[valueChunk[id] as number] ? (kept[id] as number) : -1;
    if (known >= 0) {
      out[i] = known;
      continue;
    }
    // Kept by the building index as it files the lot, from the same distance `landValueAtPoint` reads; -1 where the lot is not there.
    const water = id >= 0 && id < n ? (waterPoints[id] as number) : -1;
    if (water < 0 || !isBuilding(b, id)) {
      out[i] = 0;
      continue;
    }
    const px = x[id] as number;
    const pz = z[id] as number;
    const centre = c.weight > 0 ? falloff(lv.centre, Math.sqrt((px - c.x) * (px - c.x) + (pz - c.z) * (pz - c.z))) : 0;
    // `pollutionAt`, inline: this runs over every home with room.
    const si = Math.floor(px / q);
    const sj = Math.floor(pz / q);
    const pol = si < 0 || sj < 0 || si >= side || sj >= side ? 0 : (grid[sj * side + si] as number);
    const pollution = Math.min(lv.maxPollution, Math.max(0, pol));
    const points = road[segType[b.firstSeg[id] ?? 0] ?? 0] ?? 0;
    const v = Math.min(LAND_VALUE_MAX, Math.max(0, lv.base + points + water + centre - pollution));
    kept[id] = v;
    valueEpoch[id] = chunkEpoch[valueChunk[id] as number] as number;
    out[i] = v;
  }
  return out;
}

/** The land value of building `id`, as `buildingValues` gives it. */
export function buildingValue(state: SimState, id: number): number {
  return buildingValues(state, [id])[0] ?? 0;
}

/**
 * The value of the zoning cell `ref` names, measured at its centre, and the
 * parts that make it up, or null if there is no such cell. A blocked cell
 * has a value too: what its ground would be worth.
 */
export function landValueAt(state: SimState, ref: CellRef): LandValue | null {
  const q = cellCorners(state, ref);
  if (!q) return null;
  const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
  const z = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
  return landValueAtPoint(state, x, z, state.roads.segType[ref.segment] ?? 0);
}
