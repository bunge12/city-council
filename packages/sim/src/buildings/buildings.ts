// Buildings in state (M2-09, PRD "M2 Zoning and buildings").
//
// One row per building id in flat typed arrays, like the road network: a
// removed id's row is zeros and its id goes on the free list, the next one
// to reuse last. A building stands on a lot, a rectangle of cells fronting
// a road, and the row names the lot by its first cell and its size: the
// first cell's segment, side and place, which way along the road the lot
// runs from it, how many columns wide and how many cells deep. The lot may
// run on into the next segment where the road continues straight on
// (zoning/cell-index.ts, `nextColumn`), so the row does not list its
// cells. Which building stands on each cell is derived (where.ts).
//
// A through-lot (M2-14) joins that lot to a second one on the strip behind
// it, which fronts the road on the far side of the block. The row names the
// second lot the same way, by its first column, which stands across the
// block from the first lot's first column and runs the same way on the
// ground. `depth` is the whole lot's, and `backDepth` how many of those
// cells are on the back strip; 0 for a lot on one strip, whose back fields
// are all 0.
//
// Only this module and its callers in the sim add or remove buildings. The
// grower (grower.ts, issue 10) adds them. `BulldozeBuilding` (bulldoze.ts)
// removes the ones a player names, and the upkeep after a change of roads
// (upkeep.ts) the ones whose ground went or was blocked.
//
// A live building is in use, vacant or abandoned (M3-24, vacancy.ts), as
// bits of `flags` say, and `statusSince` holds the tick it became so:
// the tick it was built or came back into use while it is in use. An
// abandoned building offers no jobs (jobs.ts, `buildingJobs`) and no room
// (`homeRoom`), so the running totals and everything that looks for room
// or work leave it out.

import { isSegment, resized, segmentIdLimit, type AnyTypedArray, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { syncCells, type Column } from "../zoning/cell-index";
import { CELL_LEFT, CELL_RIGHT, placesAlong } from "../zoning/cells";
import { BUILDING_TYPES } from "./balance";
import { noteColumns } from "./candidates";
import { noteBuildingChanged, noteBuildingsChanged } from "./changes";
import { ZONING_BALANCE } from "../zoning/balance";
import { displaceBuildingPops } from "../pops/pops";
import { noteOpening } from "../pops/opening-changes";
import { countBuilding, countBuildings } from "../stats/stats";
import { fileBuilding, lotColumns, lotProblem, lotShapeOf, unfileBuildings } from "./where";

/** Set in `flags` for a live building. */
export const BUILDING_ALIVE = 1;
/** Set in `flags`, beside `BUILDING_ALIVE`, for a building that stands vacant (M3-24). */
export const BUILDING_VACANT = 2;
/** Set in `flags`, beside `BUILDING_ALIVE`, for an abandoned building, which offers no room and no jobs (M3-24). */
export const BUILDING_ABANDONED = 4;
/**
 * Set in `flags` beside `BUILDING_ABANDONED` when the vacancy check last
 * found the building's ground no longer zoned for what it is, so it cannot
 * come back into use (M3-24, vacancy.ts). Issue 14 clears such buildings.
 */
export const BUILDING_UNZONED = 8;

/** Every value `flags` may hold: free, in use, vacant, abandoned, and abandoned on ground zoned for something else. */
export const BUILDING_FLAG_VALUES: readonly number[] = [
  0,
  BUILDING_ALIVE,
  BUILDING_ALIVE | BUILDING_VACANT,
  BUILDING_ALIVE | BUILDING_ABANDONED,
  BUILDING_ALIVE | BUILDING_ABANDONED | BUILDING_UNZONED,
];

/** Every building. Plain typed arrays only (CLAUDE.md rule 7). */
export interface BuildingState {
  /** BUILDING_ALIVE for a live id, with BUILDING_VACANT or BUILDING_ABANDONED beside it when it is so; 0 for a free one. */
  flags: Uint8Array;
  /** The segment of the lot's first cell: the column it starts from, at the road. */
  firstSeg: Int32Array;
  /** CELL_LEFT or CELL_RIGHT. */
  firstSide: Uint8Array;
  /** The first cell's place along its segment, from node A. */
  firstPlace: Int32Array;
  /** Which way the lot runs from its first cell: 0 toward the segment's node B, 1 toward node A. */
  dir: Uint8Array;
  /** Columns along the road. */
  width: Uint8Array;
  /** Cells back from the road, both strips together on a through-lot. */
  depth: Uint8Array;
  /** On a through-lot, the segment of the back lot's first column (M2-14). 0 otherwise. */
  backSeg: Int32Array;
  /** On a through-lot, the back lot's first column's side. */
  backSide: Uint8Array;
  /** On a through-lot, the back lot's first column's place along its segment. */
  backPlace: Int32Array;
  /** On a through-lot, which way the back lot runs from its first column, as `dir`. */
  backDir: Uint8Array;
  /** On a through-lot, how many of `depth`'s cells are on the back strip, from its road. 0 for a lot on one strip. */
  backDepth: Uint8Array;
  /** The zone it was built under, as a cell stores it. A rezone does not change it. */
  zone: Uint8Array;
  /** The density it was built under. */
  density: Uint8Array;
  /** Its place in `BUILDING_TYPES`. */
  type: Uint16Array;
  /** How many people it holds room for. 0 for a type nobody lives in. M3 moves people in. */
  residents: Int32Array;
  /** Which model the client draws, from the type's set. Drawn when it is built. */
  variant: Uint8Array;
  /** The tick it was built on. */
  builtAt: Float64Array;
  /** The tick it became vacant or abandoned, as `flags` says it is; while it is in use, the tick it was built or came back into use (M3-24). */
  statusSince: Float64Array;
  /** Removed ids, the next one to reuse last. */
  free: Int32Array;
}

/** By type index: 1 for a type that offers jobs, as `jobsForLot` has it (jobs.ts). */
export const OFFERS_JOBS = Uint8Array.from(BUILDING_TYPES, (t) => (t.jobsPerCell > 0 ? 1 : 0));

/** The per-building arrays, in the order a new state has them. */
export const BUILDING_ARRAYS = [
  "flags",
  "firstSeg",
  "firstSide",
  "firstPlace",
  "dir",
  "width",
  "depth",
  "backSeg",
  "backSide",
  "backPlace",
  "backDir",
  "backDepth",
  "zone",
  "density",
  "type",
  "residents",
  "variant",
  "builtAt",
  "statusSince",
] as const;

export type BuildingKey = (typeof BUILDING_ARRAYS)[number];

const ARRAY_TYPES: Readonly<Record<keyof BuildingState, new (n: number) => AnyTypedArray | Uint16Array>> = {
  flags: Uint8Array,
  firstSeg: Int32Array,
  firstSide: Uint8Array,
  firstPlace: Int32Array,
  dir: Uint8Array,
  width: Uint8Array,
  depth: Uint8Array,
  backSeg: Int32Array,
  backSide: Uint8Array,
  backPlace: Int32Array,
  backDir: Uint8Array,
  backDepth: Uint8Array,
  zone: Uint8Array,
  density: Uint8Array,
  type: Uint16Array,
  residents: Int32Array,
  variant: Uint8Array,
  builtAt: Float64Array,
  statusSince: Float64Array,
  free: Int32Array,
};

/** No buildings. */
export function createBuildings(): BuildingState {
  return {
    flags: new Uint8Array(0),
    firstSeg: new Int32Array(0),
    firstSide: new Uint8Array(0),
    firstPlace: new Int32Array(0),
    dir: new Uint8Array(0),
    width: new Uint8Array(0),
    depth: new Uint8Array(0),
    backSeg: new Int32Array(0),
    backSide: new Uint8Array(0),
    backPlace: new Int32Array(0),
    backDir: new Uint8Array(0),
    backDepth: new Uint8Array(0),
    zone: new Uint8Array(0),
    density: new Uint8Array(0),
    type: new Uint16Array(0),
    residents: new Int32Array(0),
    variant: new Uint8Array(0),
    builtAt: new Float64Array(0),
    statusSince: new Float64Array(0),
    free: new Int32Array(0),
  };
}

/** Number of building ids handed out, removed ones included. */
export function buildingIdLimit(b: BuildingState): number {
  return b.flags.length;
}

export function isBuilding(b: BuildingState, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < b.flags.length && ((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0;
}

/** Whether building `id` stands vacant (M3-24). */
export function isVacant(b: Pick<BuildingState, "flags">, id: number): boolean {
  return ((b.flags[id] ?? 0) & BUILDING_VACANT) !== 0;
}

/** Whether building `id` is abandoned (M3-24). */
export function isAbandoned(b: Pick<BuildingState, "flags">, id: number): boolean {
  return ((b.flags[id] ?? 0) & BUILDING_ABANDONED) !== 0;
}

/** The people building `id` holds room for: its `residents`, or none while it is abandoned (M3-24) or for a free id. */
export function homeRoom(b: Pick<BuildingState, "flags" | "residents">, id: number): number {
  const flags = b.flags[id] ?? 0;
  return (flags & BUILDING_ALIVE) === 0 || (flags & BUILDING_ABANDONED) !== 0 ? 0 : (b.residents[id] ?? 0);
}

/** Live buildings. */
export function buildingCount(b: BuildingState): number {
  let n = 0;
  for (const f of b.flags) if ((f & BUILDING_ALIVE) !== 0) n++;
  return n;
}

/** What a new building is: its lot, its type and the numbers drawn for it. */
export interface NewBuilding {
  firstSeg: number;
  firstSide: number;
  firstPlace: number;
  dir: number;
  width: number;
  /** The whole lot's depth, both strips together on a through-lot. */
  depth: number;
  /** The back lot of a through-lot, as the row's back fields hold it; all 0 for a lot on one strip. */
  backSeg: number;
  backSide: number;
  backPlace: number;
  backDir: number;
  backDepth: number;
  /** Its place in `BUILDING_TYPES`. The zone and density come from the type. */
  type: number;
  residents: number;
  variant: number;
}

/** One building's row. */
export interface BuildingRow extends NewBuilding {
  id: number;
  zone: number;
  density: number;
  builtAt: number;
  /** Whether it stands vacant, and whether it is abandoned (M3-24). */
  vacant: boolean;
  abandoned: boolean;
  statusSince: number;
}

/** The row of building `id`. Throws if there is no such building. */
export function readBuilding(b: BuildingState, id: number): BuildingRow {
  if (!isBuilding(b, id)) throw new RangeError(`building ${id} does not exist`);
  return {
    id,
    firstSeg: b.firstSeg[id] ?? 0,
    firstSide: b.firstSide[id] ?? 0,
    firstPlace: b.firstPlace[id] ?? 0,
    dir: b.dir[id] ?? 0,
    width: b.width[id] ?? 0,
    depth: b.depth[id] ?? 0,
    backSeg: b.backSeg[id] ?? 0,
    backSide: b.backSide[id] ?? 0,
    backPlace: b.backPlace[id] ?? 0,
    backDir: b.backDir[id] ?? 0,
    backDepth: b.backDepth[id] ?? 0,
    zone: b.zone[id] ?? 0,
    density: b.density[id] ?? 0,
    type: b.type[id] ?? 0,
    residents: b.residents[id] ?? 0,
    variant: b.variant[id] ?? 0,
    builtAt: b.builtAt[id] ?? 0,
    vacant: isVacant(b, id),
    abandoned: isAbandoned(b, id),
    statusSince: b.statusSince[id] ?? 0,
  };
}

/**
 * Adds a building on the current tick and returns its id, the last free id
 * or a new one. Internal: the grower (grower.ts) calls it with a lot the
 * finder gave. Throws if the row is malformed or any cell of the lot is not
 * open, zoned for the type and free, so two lots never overlap. Not
 * undoable.
 */
export function addBuilding(state: SimState, spec: NewBuilding): number {
  const type = BUILDING_TYPES[spec.type];
  if (!type) throw new RangeError(`no building type ${spec.type}`);
  if (!isSegment(state.roads, spec.firstSeg) || spec.firstPlace < 0 || spec.firstPlace >= placesAlong(state.roads, spec.firstSeg)) {
    throw new RangeError(`segment ${spec.firstSeg} has no place ${spec.firstPlace}`);
  }
  if ((spec.firstSide !== CELL_LEFT && spec.firstSide !== CELL_RIGHT) || (spec.dir !== 0 && spec.dir !== 1)) throw new RangeError("bad side or direction");
  if (spec.width < type.width[0] || spec.width > type.width[1] || spec.depth < type.depth[0] || spec.depth > type.depth[1]) {
    throw new RangeError(`a ${spec.width} x ${spec.depth} lot does not fit a ${type.id}`);
  }
  if (!Number.isSafeInteger(spec.residents) || spec.residents < 0 || !Number.isInteger(spec.variant) || spec.variant < 0 || spec.variant > 255) {
    throw new RangeError("bad residents or variant");
  }
  const shape = lotShapeOf(spec);
  const shapeProblem = lotShapeProblem(state, spec, type.throughLot === true);
  if (shapeProblem) throw new RangeError(shapeProblem);
  const problem = lotProblem(state, shape, type.zoneNumber, type.density);
  if (problem) throw new RangeError(`no ${type.id} can stand there: ${problem}`);
  const b = state.buildings;
  let id: number;
  if (b.free.length > 0) {
    id = b.free[b.free.length - 1] ?? 0;
    b.free = resized(b.free, b.free.length - 1);
  } else {
    id = b.flags.length;
    const arrays = b as unknown as Record<BuildingKey, AnyTypedArray>;
    for (const key of BUILDING_ARRAYS) arrays[key] = resized(arrays[key], id + 1);
  }
  b.flags[id] = BUILDING_ALIVE;
  b.firstSeg[id] = spec.firstSeg;
  b.firstSide[id] = spec.firstSide;
  b.firstPlace[id] = spec.firstPlace;
  b.dir[id] = spec.dir;
  b.width[id] = spec.width;
  b.depth[id] = spec.depth;
  b.backSeg[id] = spec.backSeg;
  b.backSide[id] = spec.backSide;
  b.backPlace[id] = spec.backPlace;
  b.backDir[id] = spec.backDir;
  b.backDepth[id] = spec.backDepth;
  b.zone[id] = type.zoneNumber;
  b.density[id] = type.density;
  b.type[id] = spec.type;
  b.residents[id] = spec.residents;
  b.variant[id] = spec.variant;
  b.builtAt[id] = state.tick;
  b.statusSince[id] = state.tick;
  countBuilding(state, id, 1);
  noteBuildingChanged(b, id);
  noteOpening(state.pops, id);
  fileBuilding(state, id);
  noteLotFronts(state, shape.first, spec.width);
  if (shape.back) noteLotFronts(state, shape.back.first, spec.width);
  return id;
}

/** Tells the grower's candidates (candidates.ts) that the front cells of a lot gained or lost a building. */
function noteLotFronts(state: SimState, first: Column, width: number): void {
  const cols = lotColumns(syncCells(state), first, width);
  if (cols) noteColumns(state, cols);
}

/**
 * Why a row's back fields do not fit its kind of lot, or null: all 0 on a
 * lot on one strip, and on a through-lot a back column on a segment with
 * cells and at least one cell on each strip, none deeper than a strip.
 */
function lotShapeProblem(state: SimState, spec: NewBuilding, through: boolean): string | null {
  const DEPTH = ZONING_BALANCE.zoneDepthCells;
  if (!through) {
    return spec.backSeg === 0 && spec.backSide === 0 && spec.backPlace === 0 && spec.backDir === 0 && spec.backDepth === 0
      ? null
      : "a lot on one strip has no back lot";
  }
  if (!isSegment(state.roads, spec.backSeg) || spec.backPlace < 0 || spec.backPlace >= placesAlong(state.roads, spec.backSeg)) {
    return `segment ${spec.backSeg} has no place ${spec.backPlace}`;
  }
  if ((spec.backSide !== CELL_LEFT && spec.backSide !== CELL_RIGHT) || (spec.backDir !== 0 && spec.backDir !== 1)) return "bad back side or direction";
  const front = spec.depth - spec.backDepth;
  if (spec.backDepth < 1 || spec.backDepth > DEPTH || front < 1 || front > DEPTH) return "a through-lot needs one to a strip's depth of cells on each strip";
  return null;
}

/** Removes building `id`: its row becomes zeros and its id goes on the free list. Internal, like `addBuilding`. */
export function removeBuilding(state: SimState, id: number): void {
  removeBuildings(state, [id]);
}

/**
 * Removes buildings `ids`, in that order, as `removeBuilding` does each: the
 * free list ends with them in that order. Throws, changing nothing, if any
 * is not a live building or is named twice. One pass for the lot, so a
 * clear of thousands catches the building index up once, not once a
 * building (issue #162).
 */
export function removeBuildings(state: SimState, ids: readonly number[]): void {
  const b = state.buildings;
  // Only a list can name one twice; the upkeep removes one at a time.
  const named = ids.length > 1 ? new Uint8Array(b.flags.length) : null;
  for (const id of ids) {
    if (!isBuilding(b, id)) throw new RangeError(`building ${id} does not exist`);
    if (named) {
      if (named[id]) throw new RangeError(`building ${id} is named twice`);
      named[id] = 1;
    }
  }
  if (ids.length === 0) return;
  // Their residents are displaced, to find new homes (M3-12), and their
  // jobs are freed, while the rows still say what each building was.
  displaceBuildingPops(state, ids);
  // The columns each was filed on, which a lot a change of roads took may
  // no longer walk to from its row.
  unfileBuildings(state, ids);
  countBuildings(state, ids, -1);
  // Only a workplace was ever among the openings (pops/openings.ts), so
  // only one needs looking at again there: a bulldoze is mostly homes.
  const p = state.pops;
  for (const id of ids) {
    if ((OFFERS_JOBS[b.type[id] as number] as number) === 1) noteOpening(p, id);
    clearRow(b, id);
  }
  const free = resized(b.free, b.free.length + ids.length);
  free.set(ids, b.free.length);
  b.free = free;
  noteBuildingsChanged(b, ids);
}

/**
 * Sets every field of row `id` to 0. Written out field by field, not as a
 * loop over `BUILDING_ARRAYS`: one store into nineteen kinds of typed array
 * is slow, and a clear of thousands pays it on each (issue #162). A test
 * checks the list here against `BUILDING_ARRAYS`.
 */
function clearRow(b: BuildingState, id: number): void {
  b.flags[id] = 0;
  b.firstSeg[id] = 0;
  b.firstSide[id] = 0;
  b.firstPlace[id] = 0;
  b.dir[id] = 0;
  b.width[id] = 0;
  b.depth[id] = 0;
  b.backSeg[id] = 0;
  b.backSide[id] = 0;
  b.backPlace[id] = 0;
  b.backDir[id] = 0;
  b.backDepth[id] = 0;
  b.zone[id] = 0;
  b.density[id] = 0;
  b.type[id] = 0;
  b.residents[id] = 0;
  b.variant[id] = 0;
  b.builtAt[id] = 0;
  b.statusSince[id] = 0;
}

/**
 * Why `value` is not a well-formed set of buildings on network `net`, or
 * null if it is. For loading a save: every id live or free, never both, a
 * free id's row all zeros, and every live building of a known type, on a
 * lot that type takes, in use, vacant or abandoned since a tick from when it
 * was built to now, starting at a cell its segment has. Whether the lot's
 * cells are all there is not checked: that needs the derived cells.
 */
export function checkBuildings(value: unknown, net: RoadNetwork, tick: number): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not an object";
  const raw = value as Record<string, unknown>;
  for (const [key, Type] of Object.entries(ARRAY_TYPES)) {
    if (!(raw[key] instanceof Type)) return `${key} is not a ${Type.name}`;
  }
  const extra = Object.keys(raw).find((key) => !(key in ARRAY_TYPES));
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  const b = raw as unknown as BuildingState;
  const limit = b.flags.length;
  if (BUILDING_ARRAYS.some((key) => b[key].length !== limit)) return "its arrays differ in length";
  const seen = new Uint8Array(limit);
  for (const id of b.free) {
    if (id < 0 || id >= limit || seen[id] || isBuilding(b, id)) return "its free list is malformed";
    seen[id] = 1;
  }
  const segs = segmentIdLimit(net);
  for (let id = 0; id < limit; id++) {
    const flags = b.flags[id] ?? 0;
    if (!BUILDING_FLAG_VALUES.includes(flags)) return `building ${id} has unknown flags`;
    if (flags === 0) {
      if (!seen[id]) return `id ${id} is neither live nor free`;
      if (BUILDING_ARRAYS.some((key) => b[key][id] !== 0)) return `free id ${id} has a row`;
      continue;
    }
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    if (!type) return `building ${id} has an unknown type`;
    if (b.zone[id] !== type.zoneNumber || b.density[id] !== type.density) return `building ${id} does not have its type's zone and density`;
    const width = b.width[id] ?? 0;
    const depth = b.depth[id] ?? 0;
    if (width < type.width[0] || width > type.width[1] || depth < type.depth[0] || depth > type.depth[1]) return `building ${id}'s lot does not fit its type`;
    const seg = b.firstSeg[id] ?? 0;
    if (seg >= segs || !isSegment(net, seg)) return `building ${id} is on a segment that is not there`;
    const place = b.firstPlace[id] ?? 0;
    if (place < 0 || place >= placesAlong(net, seg)) return `building ${id} starts at a place its segment does not have`;
    if ((b.firstSide[id] ?? 0) > CELL_RIGHT || (b.dir[id] ?? 0) > 1) return `building ${id} has a bad side or direction`;
    const backDepth = b.backDepth[id] ?? 0;
    if (type.throughLot !== true) {
      if (backDepth !== 0 || b.backSeg[id] !== 0 || b.backSide[id] !== 0 || b.backPlace[id] !== 0 || b.backDir[id] !== 0) return `building ${id} has a back lot its type does not take`;
    } else {
      const DEPTH = ZONING_BALANCE.zoneDepthCells;
      if (backDepth < 1 || backDepth > DEPTH || depth - backDepth < 1 || depth - backDepth > DEPTH) return `building ${id}'s through-lot does not split across two strips`;
      const back = b.backSeg[id] ?? 0;
      if (back >= segs || !isSegment(net, back)) return `building ${id}'s back lot is on a segment that is not there`;
      const backPlace = b.backPlace[id] ?? 0;
      if (backPlace < 0 || backPlace >= placesAlong(net, back)) return `building ${id}'s back lot starts at a place its segment does not have`;
      if ((b.backSide[id] ?? 0) > CELL_RIGHT || (b.backDir[id] ?? 0) > 1) return `building ${id}'s back lot has a bad side or direction`;
    }
    const built = b.builtAt[id] ?? 0;
    if (!Number.isSafeInteger(built) || built < 0 || built > tick) return `building ${id} was built on a bad tick`;
    const since = b.statusSince[id] ?? 0;
    if (!Number.isSafeInteger(since) || since < built || since > tick) return `building ${id} became what it is on a bad tick`;
    if ((b.residents[id] ?? 0) < 0) return `building ${id} has fewer than no residents`;
  }
  return null;
}
