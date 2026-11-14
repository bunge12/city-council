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
// Only this module and its callers in the sim add or remove buildings. No
// command does yet: the grower is issue 10 and `BulldozeBuilding` issue 11.

import { isSegment, resized, segmentIdLimit, type AnyTypedArray, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { CELL_LEFT, CELL_RIGHT, placesAlong } from "../zoning/cells";
import { BUILDING_TYPES } from "./balance";
import { noteBuildingChanged } from "./changes";
import { fileBuilding, unfileBuilding } from "./where";

/** Set in `flags` for a live building. */
export const BUILDING_ALIVE = 1;

/** Every building. Plain typed arrays only (CLAUDE.md rule 7). */
export interface BuildingState {
  /** BUILDING_ALIVE for a live id, 0 for a free one. */
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
  /** Cells back from the road. */
  depth: Uint8Array;
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
  /** Removed ids, the next one to reuse last. */
  free: Int32Array;
}

/** The per-building arrays, in the order a new state has them. */
export const BUILDING_ARRAYS = [
  "flags",
  "firstSeg",
  "firstSide",
  "firstPlace",
  "dir",
  "width",
  "depth",
  "zone",
  "density",
  "type",
  "residents",
  "variant",
  "builtAt",
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
  zone: Uint8Array,
  density: Uint8Array,
  type: Uint16Array,
  residents: Int32Array,
  variant: Uint8Array,
  builtAt: Float64Array,
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
    zone: new Uint8Array(0),
    density: new Uint8Array(0),
    type: new Uint16Array(0),
    residents: new Int32Array(0),
    variant: new Uint8Array(0),
    builtAt: new Float64Array(0),
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
  depth: number;
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
    zone: b.zone[id] ?? 0,
    density: b.density[id] ?? 0,
    type: b.type[id] ?? 0,
    residents: b.residents[id] ?? 0,
    variant: b.variant[id] ?? 0,
    builtAt: b.builtAt[id] ?? 0,
  };
}

/**
 * Adds a building on the current tick and returns its id, the last free id
 * or a new one. Internal: the grower (issue 10) calls it with a lot the
 * finder gave, on cells it has checked are free. It checks only that the
 * row is well formed. Not undoable.
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
  b.zone[id] = type.zoneNumber;
  b.density[id] = type.density;
  b.type[id] = spec.type;
  b.residents[id] = spec.residents;
  b.variant[id] = spec.variant;
  b.builtAt[id] = state.tick;
  noteBuildingChanged(b, id);
  fileBuilding(state, id);
  return id;
}

/** Removes building `id`: its row becomes zeros and its id goes on the free list. Internal, like `addBuilding`. */
export function removeBuilding(state: SimState, id: number): void {
  const b = state.buildings;
  if (!isBuilding(b, id)) throw new RangeError(`building ${id} does not exist`);
  unfileBuilding(state, id);
  const arrays = b as unknown as Record<BuildingKey, AnyTypedArray>;
  for (const key of BUILDING_ARRAYS) arrays[key][id] = 0;
  const free = resized(b.free, b.free.length + 1);
  free[free.length - 1] = id;
  b.free = free;
  noteBuildingChanged(b, id);
}

/**
 * Why `value` is not a well-formed set of buildings on network `net`, or
 * null if it is. For loading a save: every id live or free, never both, a
 * free id's row all zeros, and every live building of a known type, on a
 * lot that type takes, starting at a cell its segment has. Whether the lot's
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
    if (flags !== 0 && flags !== BUILDING_ALIVE) return `building ${id} has unknown flags`;
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
    const built = b.builtAt[id] ?? 0;
    if (!Number.isSafeInteger(built) || built < 0 || built > tick) return `building ${id} was built on a bad tick`;
    if ((b.residents[id] ?? 0) < 0) return `building ${id} has fewer than no residents`;
  }
  return null;
}
