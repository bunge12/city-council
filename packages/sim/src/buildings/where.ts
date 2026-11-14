// Where buildings stand (M2-09). Derived data (PRD, "Derived data"): which
// building stands on each cell, and which 500 m chunk each building is in,
// rebuilt from the buildings in state and the cells, never saved or hashed.
//
// A building's row names its lot by its first column and its size
// (buildings.ts). The lot's cells are found by walking the strip from that
// column (`nextColumn`), across a segment end where the road runs straight
// on, so they follow from the roads as they are. The index is built on
// first use and kept up to date as buildings come and go; any change of
// roads lays the cells out again, and the next question rebuilds it.

import { BUILDING_ALIVE, BUILDING_ARRAYS, type BuildingState } from "./buildings";
import type { SimState } from "../state";
import { chunkAt, columnExists, lotCorners, nextColumn, syncCells, type CellIndex, type Column } from "../zoning/cell-index";
import { ZONING_BALANCE } from "../zoning/balance";
import { localIndex, type CellState } from "../zoning/cells";

const DEPTH = ZONING_BALANCE.zoneDepthCells;

/** No building on a cell, or no chunk for a building whose lot is not there. */
export const NO_BUILDING = -1;

/** Fields `filed` keeps per building, to find its cells again once its row is gone. */
const FILED = 6;

interface BuildingIndex {
  /** The cell layout this was built for. A new layout means the roads changed. */
  cells: CellState;
  /** By slot in `cells.zone`: the building on the cell, or NO_BUILDING. */
  cellBuilding: Int32Array;
  /** By building id: the chunk its lot's centre is in, or NO_BUILDING. */
  chunk: number[];
  /** Building ids by chunk. */
  byChunk: Map<number, Set<number>>;
  /** By building id, FILED numbers: the first column and size it was filed with. */
  filed: number[];
}

const live = new WeakMap<BuildingState, BuildingIndex>();

/**
 * The `width` columns of a lot from `first` on, or null if `first` is not
 * there or the strip ends before that many.
 */
export function lotColumns(index: CellIndex, first: Column, width: number): Column[] | null {
  if (!columnExists(index, first)) return null;
  const cols: Column[] = [first];
  for (let i = 1; i < width; i++) {
    const next = nextColumn(index, cols[i - 1] as Column);
    if (!next) return null;
    cols.push(next);
  }
  return cols;
}

/** The first column of building `id` as its row names it. */
function firstColumnOf(b: BuildingState, id: number): Column {
  return { seg: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, dir: b.dir[id] ?? 0 };
}

function file(bi: BuildingIndex, index: CellIndex, first: Column, width: number, depth: number, id: number): void {
  bi.filed.length = Math.max(bi.filed.length, (id + 1) * FILED);
  bi.filed.splice(id * FILED, FILED, first.seg, first.side, first.place, first.dir, width, depth);
  bi.chunk[id] = NO_BUILDING;
  const cols = lotColumns(index, first, width);
  if (!cols) return;
  const cells = bi.cells;
  for (const col of cols) {
    const start = (cells.offset[col.seg] ?? 0) + localIndex(col.side, col.place, 0);
    for (let d = 0; d < depth && d < DEPTH; d++) if (bi.cellBuilding[start + d] === NO_BUILDING) bi.cellBuilding[start + d] = id;
  }
  const corners = lotCorners(index, first, width, depth);
  if (!corners) return;
  const x = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
  const z = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
  const chunk = chunkAt(x, z);
  bi.chunk[id] = chunk;
  let set = bi.byChunk.get(chunk);
  if (!set) bi.byChunk.set(chunk, (set = new Set()));
  set.add(id);
}

function unfile(bi: BuildingIndex, index: CellIndex, id: number): void {
  if (id * FILED >= bi.filed.length) return;
  const f = bi.filed.slice(id * FILED, (id + 1) * FILED);
  const first: Column = { seg: f[0] ?? 0, side: f[1] ?? 0, place: f[2] ?? 0, dir: f[3] ?? 0 };
  const cols = lotColumns(index, first, f[4] ?? 0);
  if (cols) {
    const cells = bi.cells;
    for (const col of cols) {
      const start = (cells.offset[col.seg] ?? 0) + localIndex(col.side, col.place, 0);
      for (let d = 0; d < (f[5] ?? 0) && d < DEPTH; d++) if (bi.cellBuilding[start + d] === id) bi.cellBuilding[start + d] = NO_BUILDING;
    }
  }
  const chunk = bi.chunk[id] ?? NO_BUILDING;
  if (chunk !== NO_BUILDING) bi.byChunk.get(chunk)?.delete(id);
  bi.chunk[id] = NO_BUILDING;
  bi.filed.fill(0, id * FILED, (id + 1) * FILED);
}

/**
 * The building index of `state`, with the cells settled and laid out for
 * the roads as they are now. Built on first use, and again after the roads
 * change. Buildings are filed in id order, so where two lots overlap, which
 * a well-run city never has, the lower id holds the cell.
 */
function indexOf(state: SimState): { bi: BuildingIndex; cellIndex: CellIndex } {
  const cellIndex = syncCells(state);
  const b = state.buildings;
  const known = live.get(b);
  if (known && known.cells === state.cells) return { bi: known, cellIndex };
  const bi: BuildingIndex = {
    cells: state.cells,
    cellBuilding: new Int32Array(state.cells.zone.length).fill(NO_BUILDING),
    chunk: [],
    byChunk: new Map(),
    filed: [],
  };
  for (let id = 0; id < b.flags.length; id++) {
    if (((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0) file(bi, cellIndex, firstColumnOf(b, id), b.width[id] ?? 0, b.depth[id] ?? 0, id);
  }
  live.set(b, bi);
  return { bi, cellIndex };
}

/** Files a building just added, if the index exists and is current. Otherwise the next question builds it. */
export function fileBuilding(state: SimState, id: number): void {
  const bi = live.get(state.buildings);
  if (!bi) return;
  const cellIndex = syncCells(state);
  if (bi.cells !== state.cells) {
    live.delete(state.buildings);
    return;
  }
  const b = state.buildings;
  file(bi, cellIndex, firstColumnOf(b, id), b.width[id] ?? 0, b.depth[id] ?? 0, id);
}

/** Unfiles a building about to be removed, or whose row is about to change, if the index exists and is current. */
export function unfileBuilding(state: SimState, id: number): void {
  const bi = live.get(state.buildings);
  if (!bi) return;
  const cellIndex = syncCells(state);
  if (bi.cells !== state.cells) {
    live.delete(state.buildings);
    return;
  }
  unfile(bi, cellIndex, id);
}

/** The chunk building `id` was filed in, or NO_BUILDING, without building the index. For deltas. */
export function filedChunk(state: SimState, id: number): number {
  const bi = live.get(state.buildings);
  return bi && bi.cells === state.cells ? (bi.chunk[id] ?? NO_BUILDING) : NO_BUILDING;
}

/** Whether the building index exists and fits the cells, so a delta can report chunks. */
export function hasBuildingIndex(state: SimState): boolean {
  return live.get(state.buildings)?.cells === state.cells;
}

/** The building standing on the cell at `slot` of `state.cells.zone`, or NO_BUILDING. */
export function buildingOnSlot(state: SimState, slot: number): number {
  const { bi } = indexOf(state);
  return bi.cellBuilding[slot] ?? NO_BUILDING;
}

/** By slot in `state.cells.zone`, the building on each cell or NO_BUILDING. Read only. For the lot finder and tests. */
export function cellBuildings(state: SimState): Int32Array {
  return indexOf(state).bi.cellBuilding;
}

/** The ids of the buildings whose lot's centre is in 500 m chunk `chunk`, ascending. */
export function buildingsInChunk(state: SimState, chunk: number): number[] {
  const { bi } = indexOf(state);
  return [...(bi.byChunk.get(chunk) ?? [])].sort((p, q) => p - q);
}

/** One building as a view draws it: its row and the four corners of its lot. */
export interface BuildingInfo {
  id: number;
  firstSeg: number;
  firstSide: number;
  firstPlace: number;
  dir: number;
  width: number;
  depth: number;
  zone: number;
  density: number;
  type: number;
  residents: number;
  variant: number;
  builtAt: number;
  /**
   * The lot's corners as x0, z0, ..., x3, z3: at the road and at the back of
   * its first column's near edge, then at the back and at the road of its
   * last column's far edge. Null if the lot's cells are not there.
   */
  corners: number[] | null;
  /** The 500 m chunk its lot's centre is in, or NO_BUILDING. */
  chunk: number;
}

/** Building `id` with its lot's corners, or null if there is no such building. */
export function buildingInfo(state: SimState, id: number): BuildingInfo | null {
  const b = state.buildings;
  if (!Number.isInteger(id) || id < 0 || id >= b.flags.length || ((b.flags[id] ?? 0) & BUILDING_ALIVE) === 0) return null;
  const { bi, cellIndex } = indexOf(state);
  const row = Object.fromEntries(BUILDING_ARRAYS.filter((key) => key !== "flags").map((key) => [key, b[key][id] ?? 0])) as Omit<
    BuildingInfo,
    "id" | "corners" | "chunk"
  >;
  return { id, ...row, corners: lotCorners(cellIndex, firstColumnOf(b, id), row.width, row.depth), chunk: bi.chunk[id] ?? NO_BUILDING };
}
