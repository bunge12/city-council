// The grower (M2-10, PRD "M2 Zoning and buildings"; M3-07, PRD "Four
// demand bars"): buildings appear on zoned cells where demand asks for
// them and nowhere else.
//
// Each zone builds only while its demand bar is above zero, and mixed only
// while the residential and commercial bars both are. Its pace follows the
// bar and its development charge (M4-08): a zone whose bar reads b wants
// b / 100 x its `buildingsPerDayAtFullDemand` (demand.json), at least one,
// x its charge's share (economy/charges.ts, 1 at a charge of 0) buildings a
// game day. So with no charge a bar barely above zero still builds one a
// day, as M3-07 had it, and the charge slows even that zone: at the top of
// the range a want of one becomes 0.4. The whole part is built over the
// day, and the fraction left over is one more building with that chance:
// a want of 0.4 builds on about four days in ten. Until M4-08 the want was
// rounded up instead, which left a charge nothing to slow at one a day. The chance is drawn from the generator on the day's last
// tick, and that tick builds the one more if the draw falls below the
// fraction, so every tick's work still follows from state. A zone with no
// free zoned cell by a road draws nothing, so a city with nothing to build
// never moves the generator. Mixed reads the lower of its two bars. The zones take their quotas in zone order, and together
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
// Homes standing fill before more are built (M3-08, PRD "Turnover"; a
// count since M3-21): the grower adds no building to a zone people live in,
// residential or mixed, while `unfilledHomesMax` or more of the homes
// newcomers can reach are still filling (demand.json, pops/room.ts,
// `homeUnfilled`). A count and not a share of the room, so a few towers
// fill side by side as a street of houses does, and arrivals, which follow
// the empty room (pops/arrivals.ts), tell the densities apart. It counts
// once on a tick it adds such a building, after the tick's arrivals, and
// adds each home it builds, so it asks again before each and a home that
// fills mid-day lets the next one come. Homes newcomers cannot reach, on a
// street joined to nothing, are left out of both: their room never fills,
// and should not hold the rest of the city back.
//
// Open jobs in standing workplaces fill the same way (M3-09): the grower
// adds no building to a zone that offers jobs, commercial, office,
// industrial or mixed, while the open jobs in that zone's workplaces are
// more than `openJobsShareMax` of their jobs (pops/open-jobs.ts). Mixed is
// held by either rule. It reads each zone's jobs and open jobs once on a
// tick it adds such a building, from the counts job matching's openings
// keep (pops/openings.ts, issue #366), adds each one it builds, and leaves
// out workplaces on a street joined to nothing.
//
// Abandoned buildings come back before new ones are built (M3-24): the
// grower adds no building to a zone while it has an abandoned building
// whose ground the vacancy check last found still zoned for it
// (buildings/vacancy.ts, `abandonedWaiting`). With the zone's bar above
// zero the check brings every such building back within the day, and the
// grower carries on once none is left. It asks once on a tick it would add
// a building.
//
// For each building the grower takes the free zoned cell by the road of the
// building's zone with the highest land value, the lower cell of two the
// same (candidates.ts and lot-order.ts, M3-25; until then a draw from the
// generator). It builds at an end of the free frontage that cell lies on,
// not at the cell (issue 194): it asks the lot finder what fits at the
// nearer end (`freeFrontage`, lots.ts), then at the farther, and only if
// neither fits, at the cell. A lot holding an end cell runs from it, so the
// building stands against whatever ends the run, a junction, a neighbour
// or other zoning, and the free ground it leaves stays in one piece. Built
// around the cell, a 3-wide building on a strip 7 wide left 2 cells
// either side, too narrow for anything of its zone. At an end, each lot is
// also narrowed, within its type's widths, until the frontage it leaves is
// empty or as wide as the narrowest type of its zone and density, so a
// 6-wide tower does not take a 7-wide O3 strip and leave one cell. A lot
// that no width of its type leaves room beside drops out of the draw, unless
// every one does. Through-lots keep their place: when the end has none but
// one fits at the cell, the grower builds that one there, as before, and a
// through-lot is never narrowed. A draw from the generator then picks the
// type among those left: the ones
// whose lot reaches the back of the free ground at the cell, or every one
// if none does, each as likely, on its largest lot, narrowed as above. So a deep R2 strip grows apartments and a
// shallow one townhomes, as the PRD says the lot's shape decides, while a
// long R1 strip zoned six deep, where neither type reaches the back, grows
// houses and plexes both and not plexes alone. Where a through-lot fits
// (lots.ts, M2-14), the draw is among the through-lots alone, so a big
// building takes the block before smaller ones fill both strips. When the
// cell has no lot, as on an R3 strip under 4 x 4, the grower sets it aside
// until its ground changes and takes the next (lot-order.ts). A try spends
// nothing from the generator, so a city loaded from a save, with nothing
// set aside, tries such a cell once more and lands the same buildings.
//
// Residents scale with lot area between the type's low and high figure,
// rounded half up. The variant number, which the client
// reads to pick a model and a tint, is drawn from 0 to 255.

import { TIME_BALANCE } from "../calendar";
import { DEMAND_BALANCE } from "../demand/balance";
import type { DemandState } from "../demand/demand";
import { nextFloat, nextInt } from "../rng";
import { chargeShares, payDevelopmentCharge } from "../economy/charges";
import type { SimState } from "../state";
import type { CellRef } from "../zoning/cells";
import type { System } from "../step";
import { ZONING_BALANCE } from "../zoning/balance";
import { cellSlotIn, cellsSettled, nextColumn, syncCells, type Column } from "../zoning/cell-index";
import { BUILDINGS_BALANCE, BUILDING_TYPES, typesFor, type BuildingType } from "./balance";
import { addBuilding } from "./buildings";
import { bestCandidate, candidateCount, setAside } from "./candidates";
import { freeFrontage, lotOptions, type Lot, type LotOptions } from "./lots";
import { pollutionGrid, segmentBuildings } from "./where";
import { buildingReachesOutside, homeUnfilled, newcomerRoomLeft, reachableRoom, type ReachableRoom } from "../pops/room";
import { workplacesHeldBy, type ZoneJobs } from "../pops/open-jobs";
import { zoneJobs } from "../pops/openings";
import { buildingJobs } from "./jobs";
import { abandonedWaiting } from "./vacancy";

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
 * The buildings each zone wants today, by zone number, with index 0 unused,
 * before rounding: none while its bar is at or below zero, else its
 * full-demand rate times the bar over 100, at least 1, times its share in
 * `shares`, by zone number, all 1 when left out.
 */
export function dayWants(demand: DemandState, shares?: Float64Array): number[] {
  const wants = [0];
  for (const [i, zone] of ZONING_BALANCE.zones.entries()) {
    const bar = zoneBar(demand, zone.id);
    const rate = DEMAND_BALANCE.buildingsPerDayAtFullDemand[zone.id] ?? 0;
    // At least one a day while the bar is above zero (M3-07), before the charge's share, so a charge still slows a small zone.
    wants.push(bar > 0 ? Math.max(1, (rate * bar) / 100) * (shares?.[i + 1] ?? 1) : 0);
  }
  return wants;
}

/**
 * The buildings each zone adds over the day for certain, by zone number,
 * with index 0 unused, as the header says: the whole part of its want
 * (`dayWants`), the zones together held to `growthPerDayMax` in zone order.
 */
export function dayQuotas(demand: DemandState, shares?: Float64Array): number[] {
  const quotas = [0];
  const wants = dayWants(demand, shares);
  let left = BUILDINGS_BALANCE.growthPerDayMax;
  for (let zone = 1; zone < wants.length; zone++) {
    const quota = Math.min(Math.floor(wants[zone] ?? 0), left);
    quotas.push(quota);
    left -= quota;
  }
  return quotas;
}

/**
 * The chance, by zone number, with index 0 unused, that each zone builds
 * one more building than its quota on the day's last tick: the fraction
 * its want leaves over, or 0 where `growthPerDayMax` has no room left for
 * it once the zones before it took their quotas and their extra ones.
 */
export function extraChances(demand: DemandState, shares?: Float64Array): number[] {
  const wants = dayWants(demand, shares);
  const out = [0];
  let left = BUILDINGS_BALANCE.growthPerDayMax;
  for (let zone = 1; zone < wants.length; zone++) {
    const want = wants[zone] ?? 0;
    const whole = Math.floor(want);
    const fits = whole + 1 <= left;
    out.push(fits ? want - whole : 0);
    left -= Math.min(whole, left) + (fits && want > whole ? 1 : 0);
  }
  return out;
}

/**
 * The buildings each zone of `state` adds on its tick, by zone number, as
 * the header says: its quota's share of the tick, and on the day's last
 * tick one more where the zone's draw falls below its chance. A zone draws
 * only on that tick, with a chance above 0 and a free zoned cell by a road.
 */
export function dueOnTick(state: SimState): number[] {
  const shares = chargeShares(state.budget.chargeRates);
  const due = dayQuotas(state.demand, shares).map((quota) => growthOnTick(state.tick, quota));
  if (state.tick % TIME_BALANCE.ticksPerDay !== TIME_BALANCE.ticksPerDay - 1) return due;
  const chances = extraChances(state.demand, shares);
  for (let zone = 1; zone < due.length; zone++) {
    const chance = chances[zone] ?? 0;
    if (!(chance > 0) || freeFrontCells(state, zone) === 0) continue;
    if (nextFloat(state.rng) < chance) due[zone] = (due[zone] ?? 0) + 1;
  }
  return due;
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
 * Adds one building on the free cell of zone number `zone`, or of every
 * zone for 0, the default, with the highest land value, as the header
 * says; or none when no free cell has a lot. Returns the id or -1.
 */
export function growOne(state: SimState, zone = 0): number {
  const grid = () => pollutionGrid(state);
  for (;;) {
    const index = syncCells(state);
    const ref = bestCandidate(state, index, () => segmentBuildings(state), grid, zone);
    if (!ref) return -1;
    const { options, leaving } = optionsFromEnd(state, ref);
    if (!options.ok) {
      setAside(state, ref, hasThroughLots(state, ref));
      continue;
    }
    const lot = chooseLot(state.rng, options.lots, options.free, leaving);
    const type = BUILDING_TYPES[lot.type] as BuildingType;
    const residents = residentsFor(type, lot.width, lot.depth);
    const variant = nextInt(state.rng, VARIANTS);
    const id = addBuilding(state, { ...lot, residents, variant });
    payDevelopmentCharge(state, id);
    return id;
  }
}

/**
 * Tries, for each zone, the free cells at the top of its land value order
 * that find no lot, and sets them aside, down to the first that finds one;
 * as `growOne` would on the zone's next building, without building it. A
 * host calls it at load (derived.ts), so a city loaded from a save, with
 * nothing set aside, pays for those tries there and not in its first ticks
 * (issue #324): the 500,000 scale city has about 2,500 such cells, and its
 * first grower tick after the load took 50 to 80 ms trying them. Set
 * aside is not state and a try spends nothing from the generator, so the
 * buildings land as they would without it. Nothing while a change of roads
 * is settling, as the grower adds nothing then.
 */
export function setAsideCellsWithNoLot(state: SimState): void {
  if (!cellsSettled(state)) return;
  const grid = () => pollutionGrid(state);
  for (let zone = 1; zone <= ZONING_BALANCE.zones.length; zone++) {
    for (;;) {
      const index = syncCells(state);
      const ref = bestCandidate(state, index, () => segmentBuildings(state), grid, zone);
      if (!ref || optionsFromEnd(state, ref).options.ok) break;
      setAside(state, ref, hasThroughLots(state, ref));
    }
  }
}

/** Whether a try at the free front cell `ref` finds a lot, as `growOne` tries it. For tests: a cell set aside must find none. */
export function tryFindsLot(state: SimState, ref: CellRef): boolean {
  return optionsFromEnd(state, ref).options.ok;
}

/** The free zoned front cells of zone number `zone`, or of every zone for 0, the default: the grower's candidates. */
export function freeFrontCells(state: SimState, zone = 0): number {
  return candidateCount(state, syncCells(state), () => segmentBuildings(state), zone);
}

/** Zone numbers with a type people live in: residential and mixed. */
const HOME_ZONES: ReadonlySet<number> = new Set(BUILDING_TYPES.filter((t) => t.residents[1] > 0).map((t) => t.zoneNumber));

/** Zone numbers with a type that offers jobs: commercial, office, industrial and mixed. */
const WORK_ZONES: ReadonlySet<number> = new Set(BUILDING_TYPES.filter((t) => t.jobsPerCell > 0).map((t) => t.zoneNumber));

/** Whether `room` holds new homes back: `unfilledHomesMax` or more of its homes are still filling. */
export function holdsHomes(room: ReachableRoom): boolean {
  return room.unfilled >= DEMAND_BALANCE.unfilledHomesMax;
}

/** Whether the grower holds new homes back: `unfilledHomesMax` or more of the homes newcomers can reach are still filling. */
export function homesHeld(state: SimState): boolean {
  return holdsHomes(reachableRoom(state));
}

/** Adds new home `id` to `room`, as `reachableRoom` would count it, if newcomers can reach it: all its room is empty. */
export function countNewHome(state: SimState, room: ReachableRoom, id: number): void {
  const residents = state.buildings.residents[id] ?? 0;
  if (residents <= 0 || !buildingReachesOutside(state, id)) return;
  const left = newcomerRoomLeft(state, id);
  room.capacity += residents;
  room.empty += left;
  if (homeUnfilled(residents, left)) room.unfilled++;
}

/** The grower's work for one tick. */
export function grow(state: SimState): void {
  if (!cellsSettled(state)) return;
  const dues = dueOnTick(state);
  // Each worked out on the first building of its kind the tick may add, then kept as it adds them.
  let room: ReachableRoom | null = null;
  let jobs: ZoneJobs | null = null;
  let waiting: Int32Array | null = null;
  for (let zone = 1; zone < dues.length; zone++) {
    const due = dues[zone] ?? 0;
    const homes = HOME_ZONES.has(zone);
    const work = WORK_ZONES.has(zone);
    if (due > 0) {
      waiting ??= abandonedWaiting(state);
      if ((waiting[zone] ?? 0) > 0) continue;
    }
    for (let i = 0; i < due; i++) {
      if (homes) {
        room ??= reachableRoom(state);
        if (holdsHomes(room)) break;
      }
      if (work) {
        jobs ??= zoneJobs(state);
        if (workplacesHeldBy(jobs, zone)) break;
      }
      const id = growOne(state, zone);
      if (id < 0) break;
      // A new home is empty and still filling.
      if (room) countNewHome(state, room, id);
      // And a new workplace's jobs are all open.
      const offered = buildingJobs(state.buildings, id);
      if (jobs && offered > 0 && buildingReachesOutside(state, id)) {
        jobs.jobs[zone] = (jobs.jobs[zone] ?? 0) + offered;
        jobs.open[zone] = (jobs.open[zone] ?? 0) + offered;
      }
    }
  }
}

export const GROWER: System = { name: GROWER_SYSTEM, run: grow };
