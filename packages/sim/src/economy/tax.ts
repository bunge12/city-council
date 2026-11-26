// The tax sweep and property tax (M4-05, PRD "M4 Economy").
//
// Homes pay a yearly property tax on their value, a day at a time. Once a
// game day the TAX system visits each building, a slice a tick, as the
// vacancy check does (buildings/vacancy.ts): tick k of the day visits the
// ids that leave k over `ticksPerDay`, in id order. The visits follow from
// the tick alone, so every machine visits the same buildings on the same
// tick, a save mid-day carries on where it stopped, and no tick pays for
// more than its slice of the city.
//
// On its visit a building pays that day's share of its yearly tax, with the
// exact daily share of M4-02 (`dailyShare`), read from its value and the
// rate as they are that day. Land value is derived and moves when a factory
// goes up or the centre moves, so the visit reads it fresh and no running
// sum of property value has to be rebuilt.
//
// Residential tax is the residential rate, from state (M4-02; the command
// that sets it is M4-07), times the building's value (economy/value.ts), on
// the share of its floor space that is homes: all of a house or a tower,
// part of a mixed building. A building pays only while people live in it.
// A vacant or abandoned building pays nothing, and neither does a workplace.
//
// The sweep is shared: business tax (M4-06) is charged on the same visit,
// so the cost of finding each building is paid once. Only add, multiply,
// divide and floor, in one fixed order, so every host agrees (rule 6).

import { TIME_BALANCE, yearDays } from "../calendar";
import { BUILDING_TYPES, type BuildingType } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_VACANT } from "../buildings/buildings";
import { lotJobs } from "../buildings/jobs";
import { buildingValues } from "../landvalue/land-value";
import { popIndexOf } from "../pops/where";
import type { SimState } from "../state";
import type { System } from "../step";
import { ECONOMY_SLIDERS } from "./balance";
import { dailyShare, moveMoney } from "./budget";
import { floorSpaceOf, propertyValueOf } from "./value";

/** The residential rate's place in `BudgetState.taxRates`. */
const RESIDENTIAL = ECONOMY_SLIDERS.indexOf("residential");

/**
 * The yearly residential tax, in whole dollars, of a building of `type`
 * with room for `residents` and `jobs` jobs, on land of value `landValue`,
 * at `rate`: the rate times its value, on the share of its floor space that
 * is homes. 0 for a building with no homes.
 */
export function residentialTaxOf(type: Pick<BuildingType, "zone" | "density">, residents: number, jobs: number, landValue: number, rate: number): number {
  const space = floorSpaceOf(type, residents, jobs);
  if (space.homes <= 0 || space.total <= 0) return 0;
  const value = propertyValueOf(type, residents, jobs, landValue);
  return Math.max(0, Math.floor(((value * space.homes) / space.total) * rate));
}

/** Whether live building `flags` is in a state to pay: neither vacant nor abandoned. */
function standsInUse(flags: number): boolean {
  return (flags & BUILDING_ALIVE) !== 0 && (flags & (BUILDING_VACANT | BUILDING_ABANDONED)) === 0;
}

/**
 * What building `id` pays a year in residential tax while people live in
 * it, in whole dollars, at the city's rate and the land value at its lot
 * today. 0 for a free id, a vacant or abandoned building, or one with no
 * homes. For the hover readout and the budget overlay (M4-18). It does not
 * ask whether anyone lives there today: the sweep does.
 */
export function buildingTaxPerYear(state: SimState, id: number): number {
  const b = state.buildings;
  if (!standsInUse(b.flags[id] ?? 0)) return 0;
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  if (!type || (b.residents[id] ?? 0) <= 0) return 0;
  const land = buildingValues(state, [id])[0] ?? 0;
  return residentialTaxOf(type, b.residents[id] ?? 0, lotJobs(b, id), land, state.budget.taxRates[RESIDENTIAL] ?? 0);
}

/** The ids of the slice a tick pays, and their land values: reused across ticks. Derived scratch, never state. */
const slice: number[] = [];
let landValues = new Float64Array(0);

/**
 * The tax system's work for one tick: each building of the day's slice that
 * people live in pays the day's share of its yearly residential tax, onto
 * the residential tax line.
 */
export function collectTax(state: SimState): void {
  const perDay = TIME_BALANCE.ticksPerDay;
  const b = state.buildings;
  const { flags, residents } = b;
  const people = popIndexOf(state).people;
  slice.length = 0;
  for (let id = state.tick % perDay; id < flags.length; id += perDay) {
    if (!standsInUse(flags[id] ?? 0) || (residents[id] ?? 0) <= 0 || (people[id] ?? 0) <= 0) continue;
    slice.push(id);
  }
  if (slice.length === 0) return;
  if (landValues.length < slice.length) landValues = new Float64Array(Math.max(slice.length, landValues.length * 2));
  const land = buildingValues(state, slice, landValues);
  const rate = state.budget.taxRates[RESIDENTIAL] ?? 0;
  const day = Math.floor(state.tick / perDay) % yearDays();
  let due = 0;
  for (let i = 0; i < slice.length; i++) {
    const id = slice[i] as number;
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    if (!type) continue;
    due += dailyShare(residentialTaxOf(type, residents[id] ?? 0, lotJobs(b, id), land[i] ?? 0, rate), day);
  }
  if (due !== 0) moveMoney(state, "taxResidential", due);
}

/** The name the timer hook reports for the tax sweep, as the debug panel shows it. */
export const TAX_SYSTEM = "tax";

export const TAX: System = { name: TAX_SYSTEM, run: collectTax };
