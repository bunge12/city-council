// Redevelopment (M3-14, PRD "Rezoning"): built ground that was rezoned
// rebuilds on its own, sooner where the land is worth more.
//
// Once a game day the REDEVELOP system visits each building, a slice a
// tick, as the vacancy check does (vacancy.ts): tick k of day d visits the
// ids that leave (k + d) mod `ticksPerDay` over `ticksPerDay`, so the visits
// follow from the tick alone and a save mid-day carries on where it
// stopped. The slices turn a place each day so that, when the cap below
// runs out before the day does, the ids it leaves out are not the same ids
// every day. It runs after the vacancy check and before the grower.
//
// - A building on ground zoned up, every cell of its lot of its own zone at
//   one density higher than its own (`zonedUpTo`, where.ts), is considered while its
//   zone's bar is above zero, the grower's bar for it (`zoneBar`). Its
//   owner draws from the generator in state, with a chance a day of
//   `chancePerDay` times (land value - `valueFrom`) / (100 - `valueFrom`)
//   times the bar over 100 (demand.json), so owners on better ground and in
//   hotter demand rebuild sooner. One who draws asks the lot finder for the
//   lots of the new zoning holding its ground, counting as free ground both
//   its own building and every neighbour of its zone whose ground is zoned
//   up too (`lotOptions` with `free`): a house lot is too small for any R3
//   type, so a tower takes in the houses beside it. Of the lots that cover
//   every cell of its own lot, it takes the largest, then the deeper, then
//   the first found. Every building with a cell on that lot is replaced
//   together, when the new building is worth at least 1 + `margin` times
//   what they are worth together (landvalue.json): land value at the lot's
//   centre times the lot's cells times the density's worth. A building on
//   ground zoned up that no lot of the new zoning fits, as on a strip too
//   shallow, stays.
// - An abandoned building the vacancy check marked BUILDING_UNZONED, on
//   ground zoned down or for another use, is cleared, and the grower builds
//   on the ground under its zoning. One on ground zoned up is cleared only
//   where a lot of the new zoning fits, or it would leave the ground bare. One still in use, or vacant, stays as a
//   permitted existing use. An abandoned building on ground still zoned for
//   it stays too, to come back into use (vacancy.ts).
//
// At most `perDayMax` buildings a game day are replaced or cleared, every
// building a tower takes in counted (`redevelopedToday` in state, reset on
// the day's first tick), so a rezoned district changes over months and not
// in a day. The cap is spread over the day's ticks as the grower spreads
// its quota: no new redevelopment starts on tick k once the day's count is
// floor((k + 1) x perDayMax / ticksPerDay). The replaced buildings go
// through `removeBuildings`, which displaces the pops of a home (M3-12) and
// frees the jobs of a workplace. The new building is the type of the lot
// it takes, with residents for its lot and a variant drawn, as the grower
// makes one. The city pays nothing for it. From M4-08 the developer pays a
// development charge on the floor space the new building adds over the
// ones it replaces (economy/charges.ts). Nothing runs while a change of
// roads is settling, since the cells cannot be read.
//
// A home is not replaced while the grower holds new homes back (M3-21,
// grower.ts, `holdsHomes`): with `unfilledHomesAllowed` homes newcomers can
// reach still filling, an owner who draws to rebuild waits and counts
// nothing, as a new home on open ground would wait. The owner draws first,
// so the homes are counted only on a tick an owner would rebuild. Without the hold a district
// zoned R3 rebuilt in a game year, and stood empty for years after. The
// homes are counted on a tick that considers one, and again after each
// home it replaces.

import { buildingFloorSpace, payDevelopmentCharge } from "../economy/charges";
import { TIME_BALANCE } from "../calendar";
import { DEMAND_BALANCE } from "../demand/balance";
import { LAND_VALUE_BALANCE, LAND_VALUE_MAX } from "../landvalue/balance";
import { buildingValue, landValueAtPoint } from "../landvalue/land-value";
import { nextInt } from "../rng";
import type { SimState } from "../state";
import type { System } from "../step";
import { ZONING_BALANCE } from "../zoning/balance";
import { cellsSettled, syncCells } from "../zoning/cell-index";
import { segmentOfSlot } from "../zoning/cells";
import { BUILDING_TYPES, type BuildingType } from "./balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_LANDMARK, BUILDING_UNZONED, addBuilding, removeBuildings } from "./buildings";
import { cityPopulation, holdsHomes, residentsFor, zoneBar } from "./grower";
import { reachableRoom, type ReachableRoom } from "../pops/room";
import { lotOptions, type Lot } from "./lots";
import { NO_BUILDING, buildingSlots, lotColumns, lotShapeCorners, lotShapeOf, lotSlots, segmentBuildings, zonedUpTo } from "./where";

/** The name the timer hook reports for redevelopment. */
export const REDEVELOP_SYSTEM = "redevelop";

/** By zone number, with 0 unused: the zone's id, for `zoneBar`. */
const ZONE_IDS: readonly string[] = ["", ...ZONING_BALANCE.zones.map((z) => z.id)];

/** Variants a building may draw, as the grower draws them. */
const VARIANTS = 256;

/** The draw an owner's chance is read against: parts in a million. */
const DRAW = 1_000_000;

/** What the building on `cells` cells of value `value` and density `density` is worth to its owner. */
function worth(value: number, cells: number, density: number): number {
  return value * cells * (LAND_VALUE_BALANCE.redevelopment.worthByDensity[density - 1] ?? 0);
}

/** The worth of live building `id` as it stands. */
function buildingWorth(state: SimState, id: number): number {
  const b = state.buildings;
  return worth(buildingValue(state, id), (b.width[id] ?? 0) * (b.depth[id] ?? 0), b.density[id] ?? 0);
}

/** The land value at the centre of `lot`, fronting the road of its first cell, as a building's value is read. */
function lotValue(state: SimState, lot: Lot): number {
  const corners = lotShapeCorners(syncCells(state), lotShapeOf(lot));
  if (!corners) return 0;
  const x = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
  const z = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
  return landValueAtPoint(state, x, z, state.roads.segType[lot.firstSeg] ?? 0).value;
}

/** A redevelopment that may go ahead: the lot to build, and the buildings on it, ascending. */
export interface RedevelopmentPlan {
  lot: Lot;
  replaces: number[];
  /** What the new building and the ones it replaces are worth, as the header says. */
  worth: number;
  worthReplaced: number;
}

/**
 * The lot that would replace live building `id`, whose ground is zoned up
 * to `density`, and the buildings it would replace; or null when no lot of
 * the new zoning covers its ground, or the new building would not be worth
 * clearly more than they are. As the header says. Changes nothing.
 */
export function planRedevelopment(state: SimState, id: number, density = zonedUpTo(state, id)): RedevelopmentPlan | null {
  if (density === 0) return null;
  const b = state.buildings;
  const zone = b.zone[id] ?? 0;
  const own = buildingSlots(state, id);
  if (!own) return null;
  // Whether each neighbour asked about counts as free ground: one of the same zone whose ground is zoned up too.
  const known = new Map<number, boolean>([[id, true]]);
  const free = (other: number): boolean => {
    let yes = known.get(other);
    if (yes === undefined) {
      yes = b.zone[other] === zone && ((b.flags[other] ?? 0) & BUILDING_ALIVE) !== 0 && zonedUpTo(state, other) > 0;
      known.set(other, yes);
    }
    return yes;
  };
  const index = syncCells(state);
  const first = { seg: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, dir: b.dir[id] ?? 0 };
  const cols = lotColumns(index, first, b.width[id] ?? 0);
  if (!cols) return null;
  // The lot finder gives each type's largest lot holding one cell, so ask from each of the building's front cells.
  let best: { lot: Lot; slots: number[] } | null = null;
  for (const col of cols) {
    const options = lotOptions(state, { segment: col.seg, side: col.side, place: col.place, depth: 0 }, false, free);
    if (!options.ok) continue;
    for (const lot of options.lots) {
      const area = lot.width * lot.depth;
      if (best && (area < best.lot.width * best.lot.depth || (area === best.lot.width * best.lot.depth && lot.depth <= best.lot.depth))) continue;
      const slots = lotSlots(state, lotShapeOf(lot));
      if (!slots) continue;
      const taken = new Set(slots);
      if (own.every((slot) => taken.has(slot))) best = { lot, slots };
    }
  }
  if (!best) return null;
  const onCell = segmentBuildings(state);
  const offset = state.cells.offset;
  const replaces = new Set<number>();
  // The slots come a segment's run at a time, so the segment found last is tried first.
  let seg = -1;
  for (const slot of best.slots) {
    seg = segmentOfSlot(offset, slot, seg);
    const on = onCell[seg]?.[slot - (offset[seg] ?? 0)] ?? NO_BUILDING;
    if (on !== NO_BUILDING) replaces.add(on);
  }
  const ids = [...replaces].sort((p, q) => p - q);
  let worthReplaced = 0;
  for (const other of ids) worthReplaced += buildingWorth(state, other);
  const type = BUILDING_TYPES[best.lot.type] as BuildingType;
  const value = worth(lotValue(state, best.lot), best.lot.width * best.lot.depth, type.density);
  if (!(value >= worthReplaced * (1 + LAND_VALUE_BALANCE.redevelopment.margin))) return null;
  return { lot: best.lot, replaces: ids, worth: value, worthReplaced };
}

/**
 * Replaces the buildings `plan` names with the building on its lot, whose
 * developer pays the development charge on the floor space it adds over
 * theirs (M4-08). Returns the new building's id.
 */
export function redevelop(state: SimState, plan: RedevelopmentPlan): number {
  let replaced = 0;
  for (const id of plan.replaces) replaced += buildingFloorSpace(state.buildings, id);
  removeBuildings(state, plan.replaces, true);
  const type = BUILDING_TYPES[plan.lot.type] as BuildingType;
  const residents = residentsFor(type, plan.lot.width, plan.lot.depth);
  const variant = nextInt(state.rng, VARIANTS);
  const id = addBuilding(state, { ...plan.lot, residents, variant });
  payDevelopmentCharge(state, id, replaced);
  return id;
}

/** Whether the owner of building `id`, worth `value` in land, with its zone's bar at `bar`, rebuilds today: one draw from the generator. */
function ownerRebuilds(state: SimState, value: number, bar: number): boolean {
  const { chancePerDay, valueFrom } = DEMAND_BALANCE.redevelopment;
  const share = Math.max(0, value - valueFrom) / (LAND_VALUE_MAX - valueFrom);
  const chance = chancePerDay * share * (Math.min(bar, 100) / 100);
  return nextInt(state.rng, DRAW) < chance * DRAW;
}

/** Redevelopment's work for one tick: the day's slice of the buildings, as the header says. */
export function checkRedevelopment(state: SimState): void {
  const perDay = TIME_BALANCE.ticksPerDay;
  if (state.tick % perDay === 0) state.redevelopedToday = 0;
  if (!cellsSettled(state)) return;
  const most = DEMAND_BALANCE.redevelopment.perDayMax;
  const b = state.buildings;
  const unzoned = BUILDING_ALIVE | BUILDING_ABANDONED | BUILDING_UNZONED;
  const at = state.tick % perDay;
  // The day's allowance so far, spread over its ticks as the grower spreads its quota.
  const allowed = Math.floor(((at + 1) * most) / perDay);
  // The slice turns a place each day, so a slice that comes after the allowance runs out one day comes before it on another.
  const first = (at + Math.floor(state.tick / perDay)) % perDay;
  // Counted for the first owner of a home the tick would let rebuild, then again after each home it replaces.
  let room: ReachableRoom | null = null;
  for (let id = first; id < b.flags.length && state.redevelopedToday < allowed; id += perDay) {
    const flags = b.flags[id] ?? 0;
    // A landmark has no owner but the city, who never redevelops it (M4-13).
    if ((flags & (BUILDING_ALIVE | BUILDING_LANDMARK)) !== BUILDING_ALIVE) continue;
    if (flags === unzoned) {
      // On ground zoned up, only where a lot of the new zoning fits, or the ground would stand bare for good.
      if (zonedUpTo(state, id) > 0 && !planRedevelopment(state, id)) continue;
      removeBuildings(state, [id]);
      state.redevelopedToday++;
      continue;
    }
    if ((flags & BUILDING_ABANDONED) !== 0) continue;
    const density = zonedUpTo(state, id);
    if (density === 0) continue;
    const bar = zoneBar(state.demand, ZONE_IDS[b.zone[id] ?? 0] ?? "");
    if (!(bar > 0)) continue;
    if (!ownerRebuilds(state, buildingValue(state, id), bar)) continue;
    // Asked only of an owner who would rebuild, so the pass over the buildings is not paid on the many days nobody draws.
    if ((b.residents[id] ?? 0) > 0) {
      room ??= reachableRoom(state);
      if (holdsHomes(room, cityPopulation(state))) continue;
    }
    const plan = planRedevelopment(state, id, density);
    // Every building it replaces counts toward the day's cap, so a tower that takes in eight houses counts eight.
    if (!plan || state.redevelopedToday + plan.replaces.length > most) continue;
    redevelop(state, plan);
    state.redevelopedToday += plan.replaces.length;
    // The homes it replaced were counted as they stood, and their pops wait to be placed: count afresh for the next.
    room = null;
  }
}

/**
 * The step's system for redevelopment. It runs after the vacancy check, so
 * a building marked unzoned on today's visit is cleared on it, and before
 * the grower, which builds on the cleared ground.
 */
export const REDEVELOP: System = { name: REDEVELOP_SYSTEM, run: checkRedevelopment };
