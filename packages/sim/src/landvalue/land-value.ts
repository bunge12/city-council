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
import { jobAndHomeMiddles, pollutionGrid } from "../buildings/where";
import { ROAD_TYPES } from "../roads/balance";
import type { SimState } from "../state";
import type { System } from "../step";
import { terrainOf } from "../terrain/cache";
import { cellCorners, cellsSettled } from "../zoning/cell-index";
import type { CellRef } from "../zoning/cells";
import { LAND_VALUE_BALANCE, LAND_VALUE_MAX, type Falloff } from "./balance";
import { pollutionAt } from "./pollution";
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

/** `f.points` within `f.near` of `distance`, none from `f.far` on, a straight line between, rounded down. */
export function falloff(f: Falloff, distance: number): number {
  if (distance <= f.near) return f.points;
  if (distance >= f.far) return 0;
  return Math.floor((f.points * (f.far - distance)) / (f.far - f.near));
}

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
  const lv = LAND_VALUE_BALANCE;
  const id = ROAD_TYPES[roadType]?.id;
  const road = id === undefined ? 0 : (lv.roadAccess[id] ?? 0);
  const water = falloff(lv.water, waterDistanceAt(terrainOf(state.seed), x, z));
  const c = state.centre;
  const centre = c.weight > 0 ? falloff(lv.centre, Math.sqrt((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z))) : 0;
  const pollution = Math.min(lv.maxPollution, Math.max(0, pollutionAt(pollutionGrid(state), x, z)));
  const value = Math.min(LAND_VALUE_MAX, Math.max(0, lv.base + road + water + centre - pollution));
  return { value, base: lv.base, road, water, centre, pollution };
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
