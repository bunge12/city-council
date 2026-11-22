// The grower (M2-10, PRD "M2 Zoning and buildings"; M3-07, PRD "Four
// demand bars"): buildings appear on zoned cells where demand asks for
// them and nowhere else.
//
// Each zone builds only while its demand bar is above zero, and mixed only
// while the residential and commercial bars both are. Its pace follows the
// bar: a zone whose bar reads b builds ceil(b / 100 x its
// `buildingsPerDayAtFullDemand`) buildings a game day (demand.json), so a
// bar barely above zero still builds one a day. Mixed reads the lower of
// its two bars. The zones take their quotas in zone order, and together
// they are held to `growthPerDayMax` (buildings.json), which keeps a tick
// inside its share of the budget. The bars move only on a day's first tick
// (demand.ts), and the grower runs after them, so the day's quotas follow
// from state alone and need no plan of their own: a city loaded mid-day
// lands the same buildings as one that never stopped. Tick t of the day
// adds floor((t + 1) r / T) - floor(t r / T) buildings of a zone, for r its
// quota and T ticks a day. A tick that falls while a change of roads is
// still settling (`cellsSettled`) adds none, and those buildings are not
// made up later. Density is whatever the cell is zoned for: an R3 cell
// gets an R3 building as soon as residential demand is above zero.
//
// Free room in standing homes fills before more is built (M3-08, PRD
// "Turnover"): the grower adds no building to a zone people live in,
// residential or mixed, while the room empty in homes newcomers can reach
// is more than `emptyRoomShareMax` of those homes' room (demand.json,
// pops/room.ts). It works the room out once on a tick it adds such a
// building, after the tick's arrivals, and adds each home it builds to it,
// so it asks again before each and a home that fills mid-day lets the next
// one come. Homes newcomers cannot reach, on a street
// joined to nothing, are left out of both: their room never fills, and
// should not hold the rest of the city back.
//
// Open jobs in standing workplaces fill the same way (M3-09): the grower
// adds no building to a zone that offers jobs, commercial, office,
// industrial or mixed, while the open jobs in that zone's workplaces are
// more than `openJobsShareMax` of their jobs (pops/open-jobs.ts). Mixed is
// held by either rule. As for homes, it works the jobs out once on a tick
// it adds such a building, adds each one it builds, and leaves out
// workplaces on a street joined to nothing.
//
// For each building the grower draws a free zoned cell by the road of the
// building's zone from the generator in state (candidates.ts; M3-25
// replaces the draw with land value). It builds at an end of the free frontage that cell lies on, not
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
// rounded half up. The variant number, which the client
// reads to pick a model and a tint, is drawn from 0 to 255.

import { TIME_BALANCE } from "../calendar";
import { DEMAND_BALANCE } from "../demand/balance";
import type { DemandState } from "../demand/demand";
import { nextInt } from "../rng";
import type { SimState } from "../state";
import type { CellRef } from "../zoning/cells";
import type { System } from "../step";
import { ZONING_BALANCE } from "../zoning/balance";
import { cellSlotIn, cellsSettled, nextColumn, syncCells, type Column } from "../zoning/cell-index";
import { BUILDINGS_BALANCE, BUILDING_TYPES, typesFor, type BuildingType } from "./balance";
import { addBuilding } from "./buildings";
import { candidateAt, candidateCount } from "./candidates";
import { freeFrontage, lotOptions, type Lot, type LotOptions } from "./lots";
import { segmentBuildings } from "./where";
import { buildingReachesOutside, reachableRoom, type ReachableRoom } from "../pops/room";
import { workplacesHeldBy, zoneJobs, type ZoneJobs } from "../pops/open-jobs";
import { buildingJobs } from "./jobs";

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

/** Which bar each zone reads, by zone id. Mixed has no bar: it reads the lower of residential and commercial. */
const ZONE_BARS: Readonly<Record<string, readonly (keyof DemandState)[]>> = {
  residential: ["residential"],
  commercial: ["commercial"],
  office: ["office"],
  industrial: ["industrial"],
  mixed: ["residential", "commercial"],
};

/** The bar zone `id` grows by: its own, or for mixed the lower of its two. */
export function zoneBar(demand: DemandState, id: string): number {
  const bars = ZONE_BARS[id] ?? [];
  let least = bars.length > 0 ? Infinity : 0;
  for (const bar of bars) least = Math.min(least, demand[bar].value);
  return least;
}

/**
 * The buildings each zone adds today, by zone number, with index 0 unused,
 * as the header says: none while its bar is at or below zero, else its
 * full-demand rate times the bar over 100, rounded up, the zones together
 * held to `growthPerDayMax` in zone order.
 */
export function dayQuotas(demand: DemandState): number[] {
  const quotas = [0];
  let left = BUILDINGS_BALANCE.growthPerDayMax;
  for (const zone of ZONING_BALANCE.zones) {
    const bar = zoneBar(demand, zone.id);
    const rate = DEMAND_BALANCE.buildingsPerDayAtFullDemand[zone.id] ?? 0;
    // ceil(rate x bar / 100) as -floor(-x), so it uses only floor (CLAUDE.md rule 6).
    const want = bar > 0 ? -Math.floor(-(rate * bar) / 100) : 0;
    const quota = Math.min(want, left);
    quotas.push(quota);
    left -= quota;
  }
  return quotas;
}

/** Residents for a `type` building on a `width` x `depth` lot. */
export function residentsFor(type: BuildingType, width: number, depth: number): number {
  const [low, high] = type.residents;
  if (high === low) return low;
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

/**
 * Adds one building where the draw lands among the free cells of zone
 * number `zone`, or of every zone for 0, the default; or none after
 * `growthTries` cells with no lot. Returns the id or -1.
 */
export function growOne(state: SimState, zone = 0): number {
  for (let tries = 0; tries < BUILDINGS_BALANCE.growthTries; tries++) {
    const index = syncCells(state);
    const onCell = () => segmentBuildings(state);
    const count = candidateCount(state, index, onCell, zone);
    if (count === 0) return -1;
    const ref = candidateAt(state, index, onCell, nextInt(state.rng, count), zone);
    const { options, leaving } = optionsFromEnd(state, ref);
    if (!options.ok) continue;
    const lot = chooseLot(state.rng, options.lots, options.free, leaving);
    const type = BUILDING_TYPES[lot.type] as BuildingType;
    const residents = residentsFor(type, lot.width, lot.depth);
    const variant = nextInt(state.rng, VARIANTS);
    return addBuilding(state, { ...lot, residents, variant });
  }
  return -1;
}

/** The free zoned front cells of zone number `zone`, or of every zone for 0, the default: the grower's candidates. */
export function freeFrontCells(state: SimState, zone = 0): number {
  return candidateCount(state, syncCells(state), () => segmentBuildings(state), zone);
}

/** Zone numbers with a type people live in: residential and mixed. */
const HOME_ZONES: ReadonlySet<number> = new Set(BUILDING_TYPES.filter((t) => t.residents[1] > 0).map((t) => t.zoneNumber));

/** Zone numbers with a type that offers jobs: commercial, office, industrial and mixed. */
const WORK_ZONES: ReadonlySet<number> = new Set(BUILDING_TYPES.filter((t) => t.jobsPerCell > 0).map((t) => t.zoneNumber));

/** Whether `room` holds new homes back: its empty room is more than `emptyRoomShareMax` of its capacity. */
function holds(room: ReachableRoom): boolean {
  return room.empty > DEMAND_BALANCE.emptyRoomShareMax * room.capacity;
}

/** Whether the grower holds new homes back: the room empty in homes newcomers can reach is more than `emptyRoomShareMax` of their room. */
export function homesHeld(state: SimState): boolean {
  return holds(reachableRoom(state));
}

/** The grower's work for one tick. */
export function grow(state: SimState): void {
  if (!cellsSettled(state)) return;
  const quotas = dayQuotas(state.demand);
  // Each worked out on the first building of its kind the tick may add, then kept as it adds them.
  let room: ReachableRoom | null = null;
  let jobs: ZoneJobs | null = null;
  for (let zone = 1; zone < quotas.length; zone++) {
    const due = growthOnTick(state.tick, quotas[zone] ?? 0);
    const homes = HOME_ZONES.has(zone);
    const work = WORK_ZONES.has(zone);
    for (let i = 0; i < due; i++) {
      if (homes) {
        room ??= reachableRoom(state);
        if (holds(room)) break;
      }
      if (work) {
        jobs ??= zoneJobs(state);
        if (workplacesHeldBy(jobs, zone)) break;
      }
      const id = growOne(state, zone);
      if (id < 0) break;
      // A new home is empty: all its room is room left.
      const reaches = buildingReachesOutside(state, id);
      if (room && reaches && (state.buildings.residents[id] ?? 0) > 0) {
        const residents = state.buildings.residents[id] ?? 0;
        room.capacity += residents;
        room.empty += residents;
      }
      // And a new workplace's jobs are all open.
      const offered = buildingJobs(state.buildings, id);
      if (jobs && reaches && offered > 0) {
        jobs.jobs[zone] = (jobs.jobs[zone] ?? 0) + offered;
        jobs.open[zone] = (jobs.open[zone] ?? 0) + offered;
      }
    }
  }
}

export const GROWER: System = { name: GROWER_SYSTEM, run: grow };
