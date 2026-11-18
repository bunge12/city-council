// Where buildings stand (M2-09, M2-11). Derived data (PRD, "Derived data"):
// which building stands on each cell, and which 500 m chunk each building
// is in, built from the buildings in state and the cells, never saved or
// hashed.
//
// A building's row names its lot by its first column and its size
// (buildings.ts). The lot's cells are found by walking the strip from that
// column (`nextColumn`), across a segment end where the road runs straight
// on, so they follow from the roads as they are.
//
// The index is kept by segment: for each segment a building stands on, the
// building on each cell of its run. It is built on first use and kept
// current after, as buildings come and go and as the roads change. A change
// of roads tells it which segments were laid out again and the nodes at
// their ends (`CellIndex.buildingWatch`). Only the buildings filed on those
// segments, or on the segments a lot could reach from those nodes
// (`segmentsNear`, as the grower's candidates do), are filed again, so a
// street across a grown city costs the buildings near it and not all of
// them.
//
// On the sim, filing again first moves each such building's row onto the
// ground it stood on (`columnMover`): a split, a join, an upgrade and a
// reverse renumber the cells under a building but keep them. A building
// whose first cell has no segment any more, or whose lot the strip no
// longer holds, is lost, and the sim removes it (upkeep.ts). Each building
// filed again waits to be checked against the cells' status once they
// settle, with any building on a segment where a cell stopped being open.
// A client's copy (`CellIndex.follows`) only files: its rows come from the
// sim.
//
// A through-lot (M2-14) is two lots, one on each of two back-to-back
// strips, and stands while both do. Each is filed on its own strip's cells
// and followed across a change of roads from its own first column, so a
// building whose back road goes is lost like one whose front road goes.

import { BUILDING_ALIVE, BUILDING_ARRAYS, type BuildingState } from "./buildings";
import { noteColumns, noteFrontColumns, segmentsNear } from "./candidates";
import { noteBuildingChanged } from "./changes";
import type { SimState } from "../state";
import {
  CELL_OPEN,
  chunkAt,
  columnExists,
  columnMover,
  columnStatus,
  laidOutCells,
  lotCorners,
  nextColumn,
  syncCells,
  type CellIndex,
  type Column,
} from "../zoning/cell-index";
import { ZONING_BALANCE } from "../zoning/balance";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { localIndex } from "../zoning/cells";
import { anchorSpan, measureCurve } from "../zoning/shape";
import { readAnchor } from "../roads/network";

const DEPTH = ZONING_BALANCE.zoneDepthCells;

/** No building on a cell, or no chunk for a building whose lot is not there. */
export const NO_BUILDING = -1;

interface BuildingIndex {
  /** The cell index this was built for. A new one means a new city. */
  cellIndex: CellIndex;
  /** By segment id: the building on each cell of its run, or NO_BUILDING. Null where no building stands. */
  segCells: (Int32Array | null)[];
  /** By building id: the chunk its lot's centre is in, or NO_BUILDING. */
  chunk: number[];
  /** Building ids by chunk. */
  byChunk: Map<number, Set<number>>;
  /** By building id: the segment, front cell and depth filed of each column it holds, three numbers a column. */
  filed: (number[] | null)[];
  /**
   * Buildings to check once the cells settle: filed again since the last
   * check, or, in an index built afresh, any whose lot did not stand.
   */
  toCheck: Set<number>;
  /** Buildings whose ground a change of roads took, for the sim to remove. Never on a copy. */
  lost: Set<number>;
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

/** The column whose front cell is at `local` in segment `seg`'s run. */
function columnOfFront(seg: number, local: number): Column {
  const rest = local / DEPTH;
  return { seg, side: rest & 1, place: rest >> 1, dir: 0 };
}

/** The first column of building `id` as its row names it. */
function firstColumnOf(b: BuildingState, id: number): Column {
  return { seg: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, dir: b.dir[id] ?? 0 };
}

/** The back lot's first column of building `id` as its row names it. Only for a through-lot. */
function backColumnOf(b: BuildingState, id: number): Column {
  return { seg: b.backSeg[id] ?? 0, side: b.backSide[id] ?? 0, place: b.backPlace[id] ?? 0, dir: b.backDir[id] ?? 0 };
}

/**
 * A lot as the finder and the index walk it: `width` columns from `first`,
 * `depth` cells back, and on a through-lot the back lot, `width` columns
 * from its own first column on the strip behind, `back.depth` cells back
 * from its road.
 */
export interface LotShape {
  first: Column;
  width: number;
  /** Cells on the first strip. */
  depth: number;
  back: { first: Column; depth: number } | null;
}

/** The fields a row or a new building names its lot by. */
interface LotFields {
  firstSeg: number;
  firstSide: number;
  firstPlace: number;
  dir: number;
  width: number;
  depth: number;
  backSeg: number;
  backSide: number;
  backPlace: number;
  backDir: number;
  backDepth: number;
}

/** The lot `spec` names. */
export function lotShapeOf(spec: LotFields): LotShape {
  return {
    first: { seg: spec.firstSeg, side: spec.firstSide, place: spec.firstPlace, dir: spec.dir },
    width: spec.width,
    depth: spec.depth - spec.backDepth,
    back: spec.backDepth > 0 ? { first: { seg: spec.backSeg, side: spec.backSide, place: spec.backPlace, dir: spec.backDir }, depth: spec.backDepth } : null,
  };
}

/** The lot building `id`'s row names. */
function shapeOfBuilding(b: BuildingState, id: number): LotShape {
  const total = b.depth[id] ?? 0;
  const backDepth = b.backDepth[id] ?? 0;
  return {
    first: firstColumnOf(b, id),
    width: b.width[id] ?? 0,
    depth: total - backDepth,
    back: backDepth > 0 ? { first: backColumnOf(b, id), depth: backDepth } : null,
  };
}

/** Each part of a lot, front then back, as its columns and depth; or null if the strips do not hold it. */
function lotParts(index: CellIndex, shape: LotShape): { cols: Column[]; depth: number }[] | null {
  const front = lotColumns(index, shape.first, shape.width);
  if (!front) return null;
  const parts = [{ cols: front, depth: shape.depth }];
  if (shape.back) {
    const back = lotColumns(index, shape.back.first, shape.width);
    if (!back) return null;
    parts.push({ cols: back, depth: shape.back.depth });
  }
  return parts;
}

/**
 * The corners of a lot's ground as `lotCorners` gives them: at the road and
 * at the back of the first column's near edge, then at the back and at the
 * road of the last column's far edge. On a through-lot the back is the far
 * road's edge, so the four corners hold both strips. Null if the strips do
 * not hold the lot.
 */
export function lotShapeCorners(index: CellIndex, shape: LotShape): number[] | null {
  const front = lotCorners(index, shape.first, shape.width, shape.depth);
  if (!front || !shape.back) return front;
  const back = lotCorners(index, shape.back.first, shape.width, shape.back.depth);
  if (!back) return null;
  // The back lot's first column stands across the block from the front's,
  // so its near edge is at the same end.
  return [front[0] ?? 0, front[1] ?? 0, back[0] ?? 0, back[1] ?? 0, back[6] ?? 0, back[7] ?? 0, front[6] ?? 0, front[7] ?? 0];
}

const isLive = (b: BuildingState, id: number): boolean => ((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0;

/** Files building `id` on its lot's cells. Returns false, filing nothing, if the strip does not hold the lot. */
function file(bi: BuildingIndex, b: BuildingState, id: number): boolean {
  const shape = shapeOfBuilding(b, id);
  const index = bi.cellIndex;
  bi.chunk[id] = NO_BUILDING;
  const parts = lotParts(index, shape);
  if (!parts) {
    bi.filed[id] = null;
    return false;
  }
  const rec: number[] = [];
  for (const { cols, depth } of parts) {
    for (const col of cols) {
      const start = localIndex(col.side, col.place, 0);
      let cells = bi.segCells[col.seg];
      if (!cells) {
        cells = new Int32Array(index.segs[col.seg]?.status?.length ?? 0).fill(NO_BUILDING);
        bi.segCells[col.seg] = cells;
      }
      for (let d = 0; d < depth && d < DEPTH; d++) if (cells[start + d] === NO_BUILDING) cells[start + d] = id;
      rec.push(col.seg, start, depth);
    }
  }
  bi.filed[id] = rec;
  const corners = lotShapeCorners(index, shape);
  if (!corners) return true;
  const x = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
  const z = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
  const chunk = chunkAt(x, z);
  bi.chunk[id] = chunk;
  let set = bi.byChunk.get(chunk);
  if (!set) bi.byChunk.set(chunk, (set = new Set()));
  set.add(id);
  return true;
}

/**
 * Takes building `id` off the cells it was filed on, from what `file`
 * kept, so it works whatever the row or the roads say now. Adds to `fronts`
 * the front cells it held, as segment and place in the run, and returns it.
 */
function unfile(bi: BuildingIndex, id: number, fronts: number[] = []): number[] {
  const rec = bi.filed[id];
  if (rec) {
    for (let i = 0; i < rec.length; i += 3) {
      const seg = rec[i] ?? 0;
      const start = rec[i + 1] ?? 0;
      const depth = rec[i + 2] ?? 0;
      fronts.push(seg, start);
      const cells = bi.segCells[seg];
      if (!cells) continue;
      for (let d = 0; d < depth && d < DEPTH && start + d < cells.length; d++) if (cells[start + d] === id) cells[start + d] = NO_BUILDING;
    }
  }
  bi.filed[id] = null;
  const chunk = bi.chunk[id] ?? NO_BUILDING;
  if (chunk !== NO_BUILDING) bi.byChunk.get(chunk)?.delete(id);
  bi.chunk[id] = NO_BUILDING;
  return fronts;
}

/** A building index for `cellIndex`, every live building filed in id order. */
function build(b: BuildingState, cellIndex: CellIndex): BuildingIndex {
  const bi: BuildingIndex = {
    cellIndex,
    segCells: new Array<Int32Array | null>(cellIndex.segs.length).fill(null),
    chunk: [],
    byChunk: new Map(),
    filed: [],
    toCheck: new Set(),
    lost: new Set(),
  };
  for (let id = 0; id < b.flags.length; id++) {
    if (!isLive(b, id)) continue;
    file(bi, b, id);
    if (!stands(cellIndex, b, id)) bi.toCheck.add(id);
  }
  return bi;
}

/** Adds to `out` every building filed on segment `seg`. */
function collect(bi: BuildingIndex, seg: number, out: Set<number>): void {
  const cells = bi.segCells[seg];
  if (!cells) return;
  for (const id of cells) if (id !== NO_BUILDING) out.add(id);
}

/** Brings `bi` up to date with the changes of roads its cell index has seen since it last looked, as the header says. */
function catchUp(state: SimState, bi: BuildingIndex): void {
  const index = bi.cellIndex;
  const watch = index.buildingWatch;
  if (!watch || (watch.relaid.size === 0 && watch.nodes.size === 0)) return;
  const b = state.buildings;
  const affected = new Set<number>();
  for (const seg of watch.relaid.keys()) collect(bi, seg, affected);
  const near = new Set<number>();
  for (const node of watch.nodes) segmentsNear(index, state.roads, node, near);
  for (const seg of near) collect(bi, seg, affected);
  const ids = [...affected].sort((p, q) => p - q);
  // The columns each held, for the grower's candidates: a through-lot whose
  // back road went held columns on a road that did not change, which the
  // candidates would not otherwise look at again.
  const held: Column[] = [];
  for (const id of ids) {
    const fronts = unfile(bi, id);
    for (let i = 0; i < fronts.length; i += 2) held.push(columnOfFront(fronts[i] ?? 0, fronts[i + 1] ?? 0));
  }
  noteColumns(state, held);
  bi.segCells.length = index.segs.length;
  for (let seg = 0; seg < bi.segCells.length; seg++) bi.segCells[seg] ??= null;
  for (const seg of watch.relaid.keys()) if (seg < bi.segCells.length) bi.segCells[seg] = null;
  if (!index.follows) {
    const move = columnMover(index, watch.relaid.keys());
    /** Moves one of a row's first columns onto its ground; false if the ground has no segment any more. */
    const follow = (id: number, col: Column, set: (to: Column) => void): boolean => {
      if (!watch.relaid.has(col.seg)) return true;
      const old = watch.relaid.get(col.seg) ?? null;
      const to = old ? move(old, col) : null;
      if (!to) return false;
      if (to.seg === col.seg && to.side === col.side && to.place === col.place && to.dir === col.dir) return true;
      set(to);
      noteBuildingChanged(b, id);
      return true;
    };
    for (const id of ids) {
      if (!isLive(b, id)) continue;
      const kept = follow(id, firstColumnOf(b, id), (to) => {
        b.firstSeg[id] = to.seg;
        b.firstSide[id] = to.side;
        b.firstPlace[id] = to.place;
        b.dir[id] = to.dir;
      });
      const backKept =
        (b.backDepth[id] ?? 0) === 0 ||
        follow(id, backColumnOf(b, id), (to) => {
          b.backSeg[id] = to.seg;
          b.backSide[id] = to.side;
          b.backPlace[id] = to.place;
          b.backDir[id] = to.dir;
        });
      if (!kept || !backKept) bi.lost.add(id);
    }
  }
  for (const id of ids) {
    if (!isLive(b, id) || bi.lost.has(id)) continue;
    if (file(bi, b, id)) bi.toCheck.add(id);
    else if (!index.follows) bi.lost.add(id);
  }
  watch.relaid.clear();
  watch.nodes.clear();
}

/**
 * The building index of `state`, with the cells settled and laid out for
 * the roads as they are now, built on first use and caught up with any
 * change of roads since. Buildings are filed in id order, so where two lots
 * overlap, which a well-run city never has, the lower id holds the cell.
 */
function indexOf(state: SimState, settle = true): { bi: BuildingIndex; cellIndex: CellIndex } {
  // Filing follows the segment shapes alone, so a change still settling
  // need not be walked to file. Building the index afresh lists the
  // buildings whose lot does not stand, which needs the statuses.
  const known = live.get(state.buildings);
  const cellIndex = settle || !known ? syncCells(state) : laidOutCells(state);
  const b = state.buildings;
  let bi = known;
  if (!bi || bi.cellIndex !== cellIndex) {
    cellIndex.buildingWatch = { relaid: new Map(), nodes: new Set(), blocked: new Set() };
    bi = build(b, cellIndex);
    live.set(b, bi);
  } else {
    catchUp(state, bi);
  }
  return { bi, cellIndex };
}

/** Builds the building index now if there is none, so a host's load pays for it and not a tick. */
export function prepareBuildingIndex(state: SimState): void {
  indexOf(state);
}

/**
 * Why a building of this zone and density cannot stand on the lot, or null
 * if every one of its cells is there, open, zoned that way and free of
 * buildings. `addBuilding` checks this, so two lots never overlap and the
 * index gives the same answer kept current or built afresh.
 */
export function lotProblem(state: SimState, shape: LotShape, zone: number, density: number): string | null {
  const { bi, cellIndex } = indexOf(state);
  const parts = lotParts(cellIndex, shape);
  if (!parts) return "the strip ends before the lot does";
  const cells = state.cells;
  for (const { cols, depth } of parts) for (const col of cols) {
    const local = localIndex(col.side, col.place, 0);
    const start = (cells.offset[col.seg] ?? 0) + local;
    const held = bi.segCells[col.seg];
    for (let d = 0; d < depth; d++) {
      if (columnStatus(cellIndex, col, d) !== CELL_OPEN) return `a cell of the lot on segment ${col.seg} is blocked`;
      if (cells.zone[start + d] !== zone || cells.density[start + d] !== density) return `a cell of the lot on segment ${col.seg} is not zoned for it`;
      if (held && held[local + d] !== NO_BUILDING) return `a cell of the lot on segment ${col.seg} has a building`;
    }
  }
  return null;
}

/**
 * Whether building `id`'s lot is all there and every cell of it open, with
 * the cells as they are now. Its zoning does not count: a rezoned building
 * stands (PRD, "Rezoning").
 */
export function lotStands(state: SimState, id: number): boolean {
  return stands(syncCells(state), state.buildings, id);
}

function stands(cellIndex: CellIndex, b: BuildingState, id: number): boolean {
  const parts = lotParts(cellIndex, shapeOfBuilding(b, id));
  if (!parts) return false;
  for (const { cols, depth } of parts) for (const col of cols) for (let d = 0; d < depth; d++) if (columnStatus(cellIndex, col, d) !== CELL_OPEN) return false;
  return true;
}

/** The current index, if there is one, without building or catching it up. */
function current(state: SimState): BuildingIndex | null {
  return live.get(state.buildings) ?? null;
}

/** Files a building just added, if the index exists. Otherwise the next question builds it. */
export function fileBuilding(state: SimState, id: number): void {
  if (!current(state)) return;
  const { bi } = indexOf(state);
  file(bi, state.buildings, id);
}

/**
 * Unfiles a building about to be removed, or whose row is about to change,
 * if the index exists. Returns the columns it held, so the grower can look
 * at them again.
 */
export function unfileBuilding(state: SimState, id: number): Column[] {
  if (!current(state)) return [];
  const { bi } = indexOf(state, false);
  bi.toCheck.delete(id);
  bi.lost.delete(id);
  const fronts = unfile(bi, id);
  const cols: Column[] = [];
  for (let i = 0; i < fronts.length; i += 2) cols.push(columnOfFront(fronts[i] ?? 0, fronts[i + 1] ?? 0));
  return cols;
}

/**
 * Unfiles buildings about to be removed, as `unfileBuilding` does each,
 * catching the index up once for all of them, and tells the grower's
 * candidates which columns they held. For a command that clears thousands
 * at once (issue #162).
 */
export function unfileBuildings(state: SimState, ids: readonly number[]): void {
  if (!current(state)) return;
  const { bi } = indexOf(state, false);
  const fronts: number[] = [];
  for (const id of ids) {
    bi.toCheck.delete(id);
    bi.lost.delete(id);
    unfile(bi, id, fronts);
  }
  const keys: number[] = [];
  for (let i = 0; i < fronts.length; i += 2) keys.push((fronts[i] ?? 0) * CELL_KEY_STRIDE + (fronts[i + 1] ?? 0) / DEPTH);
  noteFrontColumns(state, keys);
}

/** The chunk building `id` was filed in, or NO_BUILDING, without building the index. For deltas. */
export function filedChunk(state: SimState, id: number): number {
  const bi = current(state);
  return bi && bi.cellIndex === syncCells(state) ? (bi.chunk[id] ?? NO_BUILDING) : NO_BUILDING;
}

/** Whether the building index exists and fits the cells, so a delta can report chunks. */
export function hasBuildingIndex(state: SimState): boolean {
  const bi = current(state);
  return !!bi && bi.cellIndex === syncCells(state);
}

/** By segment id, the building on each cell of its run, or null where none stands. Read only. */
export function segmentBuildings(state: SimState): readonly (Int32Array | null)[] {
  return indexOf(state).bi.segCells;
}

/** The building standing on the cell at `slot` of `state.cells.zone`, or NO_BUILDING. */
export function buildingOnSlot(state: SimState, slot: number): number {
  const { bi } = indexOf(state);
  const offset = state.cells.offset;
  if (!(Number.isInteger(slot) && slot >= 0 && slot < (offset[offset.length - 1] ?? 0))) return NO_BUILDING;
  // The last segment whose run starts at or before the slot.
  let lo = 0;
  let hi = offset.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((offset[mid] ?? 0) <= slot) lo = mid;
    else hi = mid;
  }
  return bi.segCells[lo]?.[slot - (offset[lo] ?? 0)] ?? NO_BUILDING;
}

/** By slot in `state.cells.zone`, the building on each cell or NO_BUILDING. A new array each call. For tests. */
export function cellBuildings(state: SimState): Int32Array {
  return flatten(state, indexOf(state).bi);
}

function flatten(state: SimState, bi: BuildingIndex): Int32Array {
  const { offset, zone } = state.cells;
  const out = new Int32Array(zone.length).fill(NO_BUILDING);
  bi.segCells.forEach((cells, seg) => cells && out.set(cells.subarray(0, (offset[seg + 1] ?? 0) - (offset[seg] ?? 0)), offset[seg] ?? 0));
  return out;
}

/**
 * The index as kept and as built afresh from state, each as the building on
 * every cell by slot and the chunk of every building, for tests that check
 * the two never part.
 */
export function buildingIndexSets(state: SimState): { kept: { cells: Int32Array; chunks: number[] }; fresh: { cells: Int32Array; chunks: number[] } } {
  const { bi, cellIndex } = indexOf(state);
  const fresh = build(state.buildings, cellIndex);
  const chunks = (x: BuildingIndex) => Array.from(state.buildings.flags, (_, id) => (isLive(state.buildings, id) ? (x.chunk[id] ?? NO_BUILDING) : NO_BUILDING));
  return { kept: { cells: flatten(state, bi), chunks: chunks(bi) }, fresh: { cells: flatten(state, fresh), chunks: chunks(fresh) } };
}

/** The ids of the buildings filed on any of `segs`, ascending. */
export function buildingsOnSegments(state: SimState, segs: Iterable<number>): number[] {
  const { bi } = indexOf(state);
  const out = new Set<number>();
  for (const seg of segs) collect(bi, seg, out);
  return [...out].sort((p, q) => p - q);
}

/**
 * The ids of the buildings filed on segment `seg` with a cell on the
 * stretch from curve parameter `from` to `to` along it, ascending: those a
 * cut there would leave on the piece between (roads/edit.ts). Each cell
 * goes to the piece its anchor cell falls in, as when the cut is made.
 */
export function buildingsOnStretch(state: SimState, seg: number, from: number, to: number): number[] {
  const { bi } = indexOf(state);
  const cells = bi.segCells[seg];
  if (!cells) return [];
  const net = state.roads;
  const anchor = readAnchor(net, seg);
  const road = measureCurve(anchor.ax, anchor.az, anchor.cx, anchor.cz, anchor.bx, anchor.bz);
  const along = (u: number) => (u === 0 ? anchor.tA : u === 1 ? anchor.tB : anchor.tA + u * (anchor.tB - anchor.tA));
  const CELL = ZONING_BALANCE.cellSize;
  const all = anchorSpan(road, anchor.tA, anchor.tB, CELL);
  const part = anchorSpan(road, along(from), along(to), CELL);
  const places = all.to - all.from;
  const out = new Set<number>();
  for (let place = 0; place < places; place++) {
    const k = all.reversed ? all.from + places - 1 - place : all.from + place;
    if (k < part.from || k >= part.to) continue;
    for (let side = 0; side < 2; side++) {
      for (let depth = 0; depth < DEPTH; depth++) {
        const id = cells[localIndex(side, place, depth)] ?? NO_BUILDING;
        if (id !== NO_BUILDING) out.add(id);
      }
    }
  }
  return [...out].sort((p, q) => p - q);
}

/** The ids of the buildings filed on any cell of `keys`, as `segment * CELL_KEY_STRIDE + place in its run`, ascending. */
export function buildingsOnCells(state: SimState, keys: readonly number[], stride: number): number[] {
  const { bi } = indexOf(state);
  const out = new Set<number>();
  for (const key of keys) {
    const seg = Math.floor(key / stride);
    const id = bi.segCells[seg]?.[key - seg * stride] ?? NO_BUILDING;
    if (id !== NO_BUILDING) out.add(id);
  }
  return [...out].sort((p, q) => p - q);
}

/** Whether the sim has buildings to remove or check (upkeep.ts), without building the index. */
export function buildingWorkDue(state: SimState): boolean {
  const bi = current(state);
  if (!bi) return state.buildings.flags.length > 0;
  const watch = bi.cellIndex.buildingWatch;
  return bi.toCheck.size > 0 || bi.lost.size > 0 || (!!watch && (watch.blocked.size > 0 || watch.relaid.size > 0 || watch.nodes.size > 0));
}

/** The buildings a change of roads took the ground of, ascending, and forgets them. */
export function takeLostBuildings(state: SimState): number[] {
  const { bi } = indexOf(state, false);
  const ids = [...bi.lost].sort((p, q) => p - q);
  bi.lost.clear();
  return ids;
}

/**
 * The buildings to check against the cells now, ascending, and forgets
 * them: the ones waiting (`BuildingIndex.toCheck`) and the ones on a
 * segment where a cell stopped being open. Only once the cells have
 * settled.
 */
export function takeBuildingsToCheck(state: SimState): number[] {
  const { bi, cellIndex } = indexOf(state);
  const watch = cellIndex.buildingWatch;
  const set = bi.toCheck;
  if (watch) for (const seg of watch.blocked) collect(bi, seg, set);
  const ids = [...set].sort((p, q) => p - q);
  bi.toCheck = new Set();
  watch?.blocked.clear();
  return ids;
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
  /** The whole lot's depth, both strips together on a through-lot. */
  depth: number;
  backSeg: number;
  backSide: number;
  backPlace: number;
  backDir: number;
  /** Cells of `depth` on the back strip of a through-lot; 0 for a lot on one strip. */
  backDepth: number;
  zone: number;
  density: number;
  type: number;
  residents: number;
  variant: number;
  builtAt: number;
  /**
   * The lot's corners as x0, z0, ..., x3, z3: at the road and at the back of
   * its first column's near edge, then at the back and at the road of its
   * last column's far edge. On a through-lot the back is the far road's
   * edge, so the corners hold both strips. Null if the lot's cells are not
   * there.
   */
  corners: number[] | null;
  /** The 500 m chunk its lot's centre is in, or NO_BUILDING. */
  chunk: number;
}

/** Building `id` with its lot's corners, or null if there is no such building. */
export function buildingInfo(state: SimState, id: number): BuildingInfo | null {
  const b = state.buildings;
  if (!Number.isInteger(id) || id < 0 || id >= b.flags.length || !isLive(b, id)) return null;
  const { bi, cellIndex } = indexOf(state);
  const row = Object.fromEntries(BUILDING_ARRAYS.filter((key) => key !== "flags").map((key) => [key, b[key][id] ?? 0])) as Omit<
    BuildingInfo,
    "id" | "corners" | "chunk"
  >;
  return { id, ...row, corners: lotShapeCorners(cellIndex, shapeOfBuilding(b, id)), chunk: bi.chunk[id] ?? NO_BUILDING };
}
