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
// value). It builds at an end of the free frontage that cell lies on, not
// at the cell (issue 194): it asks the lot finder what fits at the nearer
// end (`freeFrontage`, lots.ts), then at the farther, and only if neither
// fits, at the cell drawn. A lot holding an end cell runs from it, so the
// building stands against whatever ends the run, a junction, a neighbour
// or other zoning, and the free ground it leaves stays in one piece. Built
// around the cell drawn, a 3-wide building on a strip 7 wide left 2 cells
// either side, too narrow for anything of its zone. At an end, each lot is
// also narrowed, within its type's widths, until the frontage it leaves is
// empty or as wide as the narrowest type of its zone and density, so a
// 6-wide tower does not take a 7-wide O3 strip and leave one cell. A lot
// that no width of its type leaves room beside drops out of the draw, unless
// every one does. Through-lots keep their place: when the end has none but
// one fits at the cell drawn, the grower builds that one there, as before,
// and a through-lot is never narrowed. The draw then picks the type among
// those left: the ones
// whose lot reaches the back of the free ground at the cell, or every one
// if none does, each as likely, on its largest lot, narrowed as above. So a deep R2 strip grows apartments and a
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
import type { CellRef } from "../zoning/cells";
import type { System } from "../step";
import { cellSlotIn, cellsSettled, nextColumn, syncCells, type Column } from "../zoning/cell-index";
import { BUILDINGS_BALANCE, BUILDING_TYPES, typesFor, type BuildingType } from "./balance";
import { addBuilding } from "./buildings";
import type { GrowthState } from "./growth";
import { candidateAt, candidateCount } from "./candidates";
import { freeFrontage, lotOptions, type Lot, type LotOptions } from "./lots";
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

/**
 * The lot the draw picks among the types that fit at a cell, as the header
 * says. `leaving` gives each lot as it would stand to leave room on its
 * frontage, or null when it cannot; the draw is among those that can, if
 * any. One draw either way.
 */
function chooseLot(rng: Uint32Array, lots: readonly Lot[], free: number, leaving: (lot: Lot) => Lot | null): Lot {
  const through = lots.filter((lot) => lot.backDepth > 0);
  if (through.length > 0) return through[nextInt(rng, through.length)] as Lot;
  const room = lots.map(leaving).filter((lot): lot is Lot => lot !== null);
  const fitting = room.length > 0 ? room : lots;
  const reaching = fitting.filter((lot) => lot.depth === free);
  const pool = reaching.length > 0 ? reaching : fitting;
  return pool[nextInt(rng, pool.length)] as Lot;
}

/** The narrowest lot any type on one strip of `type`'s zone and density takes. */
function narrowestBeside(type: BuildingType): number {
  return NARROWEST_BESIDE[type.index] ?? Infinity;
}

/** `narrowestBeside` by type index, found once rather than on every draw (issue 166). */
const NARROWEST_BESIDE = BUILDING_TYPES.map((type) =>
  Math.min(...typesFor(type.zoneNumber, type.density).filter((t) => !t.throughLot).map((t) => t.width[0])),
);

/**
 * `lot`, standing at the end `end` of a free frontage `run` columns wide,
 * at the widest its type takes up to its own width that leaves the rest of
 * the frontage empty or at least as wide as the narrowest type of its zone
 * and density; or null when no width does. Narrower, it keeps the end
 * column, so when the lot runs toward the end its first column moves on.
 */
function leavingRoom(state: SimState, lot: Lot, end: CellRef, run: number): Lot | null {
  const type = BUILDING_TYPES[lot.type] as BuildingType;
  const narrowest = narrowestBeside(type);
  let width = lot.width;
  while (width >= type.width[0] && run - width !== 0 && run - width < narrowest) width--;
  if (width < type.width[0]) return null;
  if (width === lot.width) return lot;
  const first: Column = { seg: lot.firstSeg, side: lot.firstSide, place: lot.firstPlace, dir: lot.dir };
  if (first.seg === end.segment && first.side === end.side && first.place === end.place) return { ...lot, width };
  const index = syncCells(state);
  let col: Column | null = first;
  for (let i = 0; i < lot.width - width && col; i++) col = nextColumn(index, col);
  return col ? { ...lot, firstSeg: col.seg, firstSide: col.side, firstPlace: col.place, width } : null;
}

/** Whether any through-lot type grows on the zone and density of the cell `ref` names. */
function hasThroughLots(state: SimState, ref: CellRef): boolean {
  const slot = cellSlotIn(syncCells(state), state.cells, ref.segment, ref.side, ref.place, ref.depth);
  if (slot < 0) return false;
  return typesFor(state.cells.zone[slot] ?? 0, state.cells.density[slot] ?? 0).some((t) => t.throughLot);
}

/**
 * What fits at the nearer end of the free frontage `ref` lies on, else at
 * the farther end, else at `ref` itself, as the header says; and how each
 * lot would stand to leave room on the frontage. Away from an end every
 * lot stands as it is.
 */
function optionsFromEnd(state: SimState, ref: CellRef): { options: LotOptions; leaving: (lot: Lot) => Lot | null } {
  const { ends, width } = freeFrontage(state, ref);
  const asIs = (lot: Lot) => lot;
  let last: LotOptions | null = null;
  const isEnd = ends.some((e) => e.segment === ref.segment && e.side === ref.side && e.place === ref.place);
  for (const at of ends) {
    last = lotOptions(state, at, false);
    if (!last.ok) continue;
    // A through-lot at the cell drawn still comes first, as before issue 194.
    if (!isEnd && !last.lots.some((lot) => lot.backDepth > 0) && hasThroughLots(state, ref)) {
      const drawn = lotOptions(state, ref, false);
      if (drawn.ok && drawn.lots.some((lot) => lot.backDepth > 0)) return { options: drawn, leaving: asIs };
    }
    return { options: last, leaving: (lot) => leavingRoom(state, lot, at, width) };
  }
  return { options: isEnd && last ? last : lotOptions(state, ref, false), leaving: asIs };
}

/** Adds one building where the draw lands, or none after `growthTries` cells with no lot. Returns the id or -1. */
export function growOne(state: SimState): number {
  for (let tries = 0; tries < BUILDINGS_BALANCE.growthTries; tries++) {
    const index = syncCells(state);
    const onCell = () => segmentBuildings(state);
    const count = candidateCount(state, index, onCell);
    if (count === 0) return -1;
    const ref = candidateAt(state, index, onCell, nextInt(state.rng, count));
    const { options, leaving } = optionsFromEnd(state, ref);
    if (!options.ok) continue;
    const lot = chooseLot(state.rng, options.lots, options.free, leaving);
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
