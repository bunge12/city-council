// Landmarks (M4-13, PRD "Landmarks").
//
// A landmark is a unique, city-owned building the player places: City Hall
// in M4, the central station in M7 and the rest in M11. Each kind is one
// entry of `landmarks` in economy.json, with its lot, its price, its floor
// space and its upkeep, and the unlock that opens it (progression.json).
//
// It is a row in the building arrays with `BUILDING_LANDMARK` set beside
// `BUILDING_ALIVE` and its kind's place in `ECONOMY.landmarks` as its type,
// so the building index, picking, the bulldozer and the road commands find
// it as they find any building. It has no zone or density, no room and no
// jobs, so it is never vacant, abandoned or redeveloped, counts in no zone's
// statistics, draws no arrivals or workers and pays no tax or development
// charge. Each of those systems passes over it by its flag.
//
// `PlaceLandmark` names the kind and the lot's first cell: the segment, the
// side, the place along it and, optionally, which way the lot runs. It is
// refused before the kind's unlock, while one of the kind stands, off a
// road, or where any cell of the lot is not there, open and free of
// buildings. It never clears buildings. The lot's cells leave the zoning as
// it is placed, and `ZoneCells` and a zoning undo pass over them while it
// stands. Its price goes on the construction line, and its upkeep, a share
// of its price each year, joins the building upkeep (economy/upkeep.ts).
// Clearing it costs its demolition less the refund share of its price
// (economy/compensation.ts), and its cells come back unzoned.
//
// Its stage, 1 and up, follows the milestones reached: one more for each
// milestone that names it in `grows`, whenever it was placed. Derived, never
// stored.

import { ECONOMY, type Landmark } from "../economy/balance";
import { moveMoney } from "../economy/budget";
import { spendingRefusal } from "../economy/spend";
import { MILESTONES, type Unlock } from "../progression/balance";
import { lockNote } from "../progression/milestones";
import { NETWORK_ROAD, SEG_FIXED, isSegment } from "../roads/network";
import type { SimState } from "../state";
import { noteCellsPainted } from "../zoning/cell-changes";
import { syncCells, type CellIndex } from "../zoning/cell-index";
import { CELL_LEFT, CELL_RIGHT, DENSITY_NONE, ZONE_NONE, localIndex, placesAlong } from "../zoning/cells";
import { noteFrontCells } from "./candidates";
import { BUILDING_LANDMARK, addLandmarkRow, type BuildingState, type LandmarkLot } from "./buildings";
import { lotColumns, lotProblem, lotShapeOf, lotSlots, type LotShape } from "./where";

/** The landmark kinds, by their type. */
export const LANDMARKS: readonly Landmark[] = ECONOMY.landmarks;

/** The kind with id `id`, or undefined. */
export function landmarkKind(id: string): Landmark | undefined {
  return LANDMARKS.find((l) => l.id === id);
}

/** What a `PlaceLandmark` command carries besides the player id. */
export interface PlaceLandmarkPayload {
  /** A landmark id from economy.json, "cityHall". */
  landmark: string;
  /** The lot's first cell: its segment, side and place along the segment from node A. */
  segment: number;
  side: number;
  place: number;
  /** Which way the lot runs from its first cell: 0 toward node B, the default, 1 toward node A. */
  dir?: number;
}

/** What placing a landmark would do. */
export interface LandmarkPlan {
  landmark: Landmark;
  lot: LandmarkLot;
  /** The lot as the building index names one. */
  shape: LotShape;
  /** The slots in `state.cells` of the lot's cells, front to back, column by column: the footprint. */
  slots: number[];
  /** Whole dollars it costs, on the construction line. */
  price: number;
  /** Why the treasury cannot pay it, or null. */
  refusal: string | null;
}

export type LandmarkPlanResult = { ok: true; plan: LandmarkPlan } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The id of the standing landmark of kind `type`, or -1. One pass over the flags. */
export function findLandmark(b: Pick<BuildingState, "flags" | "type">, type: number): number {
  const { flags } = b;
  for (let id = 0; id < flags.length; id++) if (((flags[id] as number) & BUILDING_LANDMARK) !== 0 && b.type[id] === type) return id;
  return -1;
}

/** The ids of every standing landmark, ascending. One pass over the flags. */
export function landmarkIds(b: Pick<BuildingState, "flags">): number[] {
  const out: number[] = [];
  const { flags } = b;
  for (let id = 0; id < flags.length; id++) if (((flags[id] as number) & BUILDING_LANDMARK) !== 0) out.push(id);
  return out;
}

/**
 * Where `PlaceLandmark` with this payload would put its landmark, its
 * footprint and its price, or why `state` refuses it whatever the
 * treasury holds. A plan the treasury cannot pay is still a plan, with
 * `refusal` saying why, so the tool can show the price and the reason
 * together. Changes nothing. For the placement tool (M4-17) and the command.
 */
export function planPlaceLandmark(state: SimState, payload: unknown): LandmarkPlanResult {
  const need = "PlaceLandmark needs { landmark, segment, side, place }, and optionally dir";
  if (!isRecord(payload)) return { ok: false, reason: need };
  const { landmark: id, segment, side, place } = payload;
  const dir = payload["dir"] ?? 0;
  if (typeof id !== "string" || ![segment, side, place, dir].every((v) => Number.isSafeInteger(v))) return { ok: false, reason: need };
  const kind = landmarkKind(id);
  if (!kind) return { ok: false, reason: `unknown landmark ${JSON.stringify(id)}: it must be one of ${LANDMARKS.map((l) => l.id).join(", ")}` };
  if (side !== CELL_LEFT && side !== CELL_RIGHT) return { ok: false, reason: "side must be 0 or 1" };
  if (dir !== 0 && dir !== 1) return { ok: false, reason: "dir must be 0 or 1" };
  const locked = lockNote(state, kind.unlock as Unlock);
  if (locked !== null) return { ok: false, reason: locked };
  if (findLandmark(state.buildings, kind.index) >= 0) return { ok: false, reason: `The city has a ${kind.name} already. Bulldoze it first to build another` };
  const net = state.roads;
  const seg = segment as number;
  const frontage = isSegment(net, seg) && net.segNetwork[seg] === NETWORK_ROAD && ((net.segFlags[seg] ?? 0) & SEG_FIXED) === 0;
  if (!frontage || (place as number) < 0 || (place as number) >= placesAlong(net, seg)) return { ok: false, reason: `${kind.name} needs road frontage: its lot must start at a cell along a road` };
  const lot: LandmarkLot = { firstSeg: seg, firstSide: side, firstPlace: place as number, dir };
  const shape = lotShapeOf({ ...lot, width: kind.width, depth: kind.depth, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 });
  const problem = lotProblem(state, shape, null, null);
  if (problem !== null) return { ok: false, reason: `${kind.name} needs a free lot of ${kind.width} by ${kind.depth} cells: ${problem}` };
  const slots = lotSlots(state, shape) ?? [];
  return { ok: true, plan: { landmark: kind, lot, shape, slots, price: kind.price, refusal: spendingRefusal(state, kind.price) } };
}

/**
 * Places the landmark `plan` names: unzones its cells, adds its row and
 * charges its price on the construction line. Only after the plan passed,
 * on the state it was made from.
 */
export function placeLandmark(state: SimState, plan: LandmarkPlan): number {
  const cells = state.cells;
  const changed: number[] = [];
  for (const slot of plan.slots) {
    if (cells.zone[slot] === ZONE_NONE && cells.density[slot] === DENSITY_NONE) continue;
    cells.zone[slot] = ZONE_NONE;
    cells.density[slot] = DENSITY_NONE;
    changed.push(slot);
  }
  if (changed.length > 0) {
    const slots = Int32Array.from(changed);
    noteCellsPainted(state.roads, cells, slots);
    noteFrontCells(state, slots);
  }
  const id = addLandmarkRow(state, plan.landmark.index, plan.lot);
  if (plan.price !== 0) moveMoney(state, "construction", plan.price);
  return id;
}

/**
 * The stage of a landmark of kind `type` in `state`: 1, and one more for
 * each milestone reached that names it in `grows` (progression.json).
 * City Hall goes from 1 to 4.
 */
export function landmarkStage(state: Pick<SimState, "milestones">, type: number): number {
  const kind = LANDMARKS[type];
  if (!kind) return 0;
  let stage = 1;
  const reached = Math.min(state.milestones.length, MILESTONES.length);
  for (let i = 0; i < reached; i++) if ((MILESTONES[i] as (typeof MILESTONES)[number]).grows.includes(kind.id)) stage++;
  return stage;
}

/** The most stages a landmark of kind `type` has: 1 plus the milestones that grow it. */
export function landmarkStages(type: number): number {
  const kind = LANDMARKS[type];
  if (!kind) return 0;
  return 1 + MILESTONES.filter((m) => m.grows.includes(kind.id)).length;
}

/** What the city's landmarks cost a year to keep, in whole dollars: each standing one's upkeep. One pass over the flags. */
export function landmarkUpkeepPerYear(b: Pick<BuildingState, "flags" | "type">): number {
  let total = 0;
  for (const id of landmarkIds(b)) total += LANDMARKS[b.type[id] ?? 0]?.upkeepPerYear ?? 0;
  return total;
}

/** What clearing landmark `id` costs, in whole dollars: its demolition and the refund share of its price, which comes off it. */
export function landmarkClearing(b: Pick<BuildingState, "type">, id: number): { demolition: number; refund: number } {
  const kind = LANDMARKS[b.type[id] ?? 0];
  if (!kind) return { demolition: 0, refund: 0 };
  return {
    demolition: Math.floor(kind.floorSpace * ECONOMY.eminentDomain.demolitionPerSquareMetre),
    refund: Math.floor(kind.price * ECONOMY.eminentDomain.refundShare),
  };
}

/**
 * The slots in `state.cells` under every standing landmark, which
 * `ZoneCells` and a zoning undo pass over, read on `index`: the cells
 * settled by default, or as a zoning undo reads them, laid out but maybe
 * still settling. Empty, with no cell read, in a city with none.
 */
export function landmarkSlots(state: SimState, index?: CellIndex): Set<number> {
  const out = new Set<number>();
  const b = state.buildings;
  const ids = landmarkIds(b);
  if (ids.length === 0) return out;
  const cells = index ?? syncCells(state);
  const offset = state.cells.offset;
  for (const id of ids) {
    const first = { seg: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, dir: b.dir[id] ?? 0 };
    const depth = b.depth[id] ?? 0;
    for (const col of lotColumns(cells, first, b.width[id] ?? 0) ?? []) {
      const start = (offset[col.seg] ?? 0) + localIndex(col.side, col.place, 0);
      for (let d = 0; d < depth; d++) out.add(start + d);
    }
  }
  return out;
}
