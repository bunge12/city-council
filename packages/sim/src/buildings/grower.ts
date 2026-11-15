// The grower (M2-10, PRD "M2 Zoning and buildings"): buildings appear on
// zoned cells at a fixed rate. M2 has no demand, so every zone, mixed
// included, grows as if its demand were positive; M3 puts the demand bars
// in front of this.
//
// `growthPerDay` buildings a game day across the whole city, on fixed
// ticks: tick t adds floor((t + 1) r / T) - floor(t r / T) of them, for r
// a day over T ticks a day, so the count follows from the tick alone. A
// tick that falls while a change of roads is still settling adds none
// (`cellsSettled`); those buildings are not made up later.
//
// For each building the grower draws a free zoned cell by the road from
// the generator in state (candidates.ts; M3 replaces the draw with land
// value) and asks the lot finder what fits there. The draw then picks the
// type among those that fit: the ones whose lot reaches the back of the
// free ground at the cell, or every one that fits if none does, each as
// likely, on its largest lot. So a deep R2 strip grows apartments and a
// shallow one townhomes, as the PRD says the lot's shape decides, while a
// long R1 strip zoned six deep, where neither type reaches the back, grows
// houses and plexes both and not plexes alone. When the cell has no lot,
// as on an R3 strip under 4 x 4, the grower draws again, up to
// `growthTries` cells, then gives that building up.
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
import { candidateAt, candidateCount } from "./candidates";
import { lotOptions, type Lot } from "./lots";
import { segmentBuildings } from "./where";

/** Name the timer hook reports for the grower. */
export const GROWER_SYSTEM = "grower";

/** Variants a building may draw: the values a byte holds. */
const VARIANTS = 256;

/** How many buildings the grower adds on `tick`, from the tick alone. */
export function growthOnTick(tick: number): number {
  const r = BUILDINGS_BALANCE.growthPerDay;
  const t = TIME_BALANCE.ticksPerDay;
  return Math.floor(((tick + 1) * r) / t) - Math.floor((tick * r) / t);
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

/** The grower's work for one tick. */
export function grow(state: SimState): void {
  const due = growthOnTick(state.tick);
  if (due === 0 || !cellsSettled(state)) return;
  for (let i = 0; i < due; i++) if (growOne(state) < 0) return;
}

export const GROWER: System = { name: GROWER_SYSTEM, run: grow };
