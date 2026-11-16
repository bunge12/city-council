// The grower (M2-10, PRD "M2 Zoning and buildings"): buildings appear on
// zoned cells at a fixed rate. M2 has no demand, so every zone, mixed
// included, grows as if its demand were positive; M3 puts the demand bars
// in front of this.
//
// The pace scales with the free frontage (issue 135), so any amount of
// zoning fills in about `fillDays` from the last of it. On the first settled tick of each game
// day the grower counts the free zoned front cells, F, and plans the day
// (`planDay`). The plan also keeps `used`, the front cells the grower
// itself built on since the last plan, so the cells that came since are
// F - (the last plan's F - used): new zoning, or a building gone. When some
// came, they get a full `fillDays` and the cells already planned keep
// their deadline: the new deadline is the two weighted by their cells,
// rounded up, so zoning a street every few days does not hold back the
// ones before it. When none came and the deadline has come, it moves to
// tomorrow while the grower built anything since the last plan, so the
// last few cells fill at once rather than at the floor; once it built
// nothing, what is left is cells no lot fits, and it moves `fillDays` on,
// so they cost few draws. The day's quota is then F over `frontCellsPerBuilding`
// times the days left to the deadline, rounded up and held between
// `growthPerDayMin` and `growthPerDayMax`. The plan is in state
// (growth.ts), since F changes during the day. Tick t of the day adds
// floor((t + 1) r / T) - floor(t r / T) buildings, for r the quota and T
// ticks a day, so when they land follows from state and the tick alone. A
// tick that falls while a change of roads is still settling adds none
// (`cellsSettled`), and a day that settles late is planned then; those
// buildings are not made up later.
//
// For each building the grower draws a free zoned cell by the road from
// the generator in state (candidates.ts; M3 replaces the draw with land
// value) and asks the lot finder what fits there. The draw then picks the
// type among those that fit: the ones whose lot reaches the back of the
// free ground at the cell, or every one that fits if none does, each as
// likely, on its largest lot. So a deep R2 strip grows apartments and a
// shallow one townhomes, as the PRD says the lot's shape decides, while a
// long R1 strip zoned six deep, where neither type reaches the back, grows
// houses and plexes both and not plexes alone. Where a through-lot fits
// (lots.ts, M2-14), the draw is among the through-lots alone, so a big
// building takes the block before smaller ones fill both strips. When the
// cell has no lot, as on an R3 strip under 4 x 4, the grower draws again,
// up to `growthTries` cells, then gives that building up.
//
// Residents scale with lot area between the type's low and high figure,
// rounded half up, or for a type with `drawResidents`, the single family
// home, are drawn per building. The variant number, which the client
// reads to pick a model and a tint, is drawn from 0 to 255.

import { TIME_BALANCE } from "../calendar";
import { nextInt } from "../rng";
import type { SimState } from "../state";
import type { System } from "../step";
import { cellsSettled, syncCells } from "../zoning/cell-index";
import { BUILDINGS_BALANCE, BUILDING_TYPES, type BuildingType } from "./balance";
import { addBuilding } from "./buildings";
import type { GrowthState } from "./growth";
import { candidateAt, candidateCount } from "./candidates";
import { lotOptions, type Lot } from "./lots";
import { segmentBuildings } from "./where";

/** Name the timer hook reports for the grower. */
export const GROWER_SYSTEM = "grower";

/** Variants a building may draw: the values a byte holds. */
const VARIANTS = 256;

/** How many of a day's `quota` buildings the grower adds on `tick`. Over a day's ticks they add up to `quota`. */
export function growthOnTick(tick: number, quota: number): number {
  const t = TIME_BALANCE.ticksPerDay;
  const at = tick % t;
  return Math.floor(((at + 1) * quota) / t) - Math.floor((at * quota) / t);
}

/** The game day `tick` falls on. */
export function dayOf(tick: number): number {
  return Math.floor(tick / TIME_BALANCE.ticksPerDay);
}

/** Plans day `day` from `free`, the free zoned front cells counted at its start, as the header says. */
export function planDay(growth: GrowthState, day: number, free: number): void {
  const b = BUILDINGS_BALANCE;
  const planned = Math.max(0, growth.free - growth.used);
  const came = free - planned;
  if (came > 0) {
    const left = Math.max(1, growth.deadline - day);
    const days = planned * left + came * b.fillDays;
    growth.deadline = day + Math.floor((days + free - 1) / free);
  } else if (day >= growth.deadline) {
    growth.deadline = growth.used > 0 ? day + 1 : day + b.fillDays;
  }
  const per = b.frontCellsPerBuilding * (growth.deadline - day);
  const want = Math.floor((free + per - 1) / per);
  growth.quota = Math.min(b.growthPerDayMax, Math.max(b.growthPerDayMin, want));
  growth.day = day;
  growth.free = free;
  growth.used = 0;
}

/** Residents for a `type` building on a `width` x `depth` lot. Draws from `rng` only for a type with `drawResidents`. */
export function residentsFor(rng: Uint32Array, type: BuildingType, width: number, depth: number): number {
  const [low, high] = type.residents;
  if (high === low) return low;
  if (type.drawResidents) return low + nextInt(rng, high - low + 1);
  const least = type.width[0] * type.depth[0];
  const span = type.width[1] * type.depth[1] - least;
  if (span === 0) return low + Math.floor((high - low) / 2);
  // low + (high - low) (area - least) / span, rounded half up, in whole numbers.
  return low + Math.floor(((high - low) * (width * depth - least) * 2 + span) / (2 * span));
}

/** The lot the draw picks among the types that fit at a cell, as the header says. */
function chooseLot(rng: Uint32Array, lots: readonly Lot[], free: number): Lot {
  const through = lots.filter((lot) => lot.backDepth > 0);
  if (through.length > 0) return through[nextInt(rng, through.length)] as Lot;
  const reaching = lots.filter((lot) => lot.depth === free);
  const pool = reaching.length > 0 ? reaching : lots;
  return pool[nextInt(rng, pool.length)] as Lot;
}

/** Adds one building where the draw lands, or none after `growthTries` cells with no lot. Returns the id or -1. */
export function growOne(state: SimState): number {
  for (let tries = 0; tries < BUILDINGS_BALANCE.growthTries; tries++) {
    const index = syncCells(state);
    const onCell = () => segmentBuildings(state);
    const count = candidateCount(state, index, onCell);
    if (count === 0) return -1;
    const ref = candidateAt(state, index, onCell, nextInt(state.rng, count));
    const options = lotOptions(state, ref);
    if (!options.ok) continue;
    const lot = chooseLot(state.rng, options.lots, options.free);
    const type = BUILDING_TYPES[lot.type] as BuildingType;
    const residents = residentsFor(state.rng, type, lot.width, lot.depth);
    const variant = nextInt(state.rng, VARIANTS);
    return addBuilding(state, { ...lot, residents, variant });
  }
  return -1;
}

/** The free zoned front cells: the grower's candidates. */
export function freeFrontCells(state: SimState): number {
  return candidateCount(state, syncCells(state), () => segmentBuildings(state));
}

/** The grower's work for one tick. */
export function grow(state: SimState): void {
  if (!cellsSettled(state)) return;
  const day = dayOf(state.tick);
  if (state.growth.day !== day) planDay(state.growth, day, freeFrontCells(state));
  // Held to the cap here too, so a save that says more cannot stall a tick.
  const due = growthOnTick(state.tick, Math.min(state.growth.quota, BUILDINGS_BALANCE.growthPerDayMax));
  if (due === 0) return;
  const before = freeFrontCells(state);
  for (let i = 0; i < due; i++) if (growOne(state) < 0) break;
  state.growth.used += before - freeFrontCells(state);
}

export const GROWER: System = { name: GROWER_SYSTEM, run: grow };
