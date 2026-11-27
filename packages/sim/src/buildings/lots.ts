// The lot finder (M2-09, PRD "M2 Zoning and buildings").
//
// A lot is a rectangle of free cells with one zone and one density, fronting
// a road: `width` columns along the road, each `depth` cells back from its
// edge. A free cell is open (not blocked), zoned, and has no building on it.
// The columns of a lot follow the strip along one side of the road, and run
// on into the next segment where the road continues straight on with the
// same width (`nextColumn`): a T-junction across the street splits the
// segment, and a lot that stopped at the cut would be cut for no reason the
// player can see.
//
// Along a curve a strip's cells fan out on the outside and close up on the
// inside, but they still meet edge to edge, so a lot is fitted there the
// same way, column by column, at any width. Its ground is the cells it
// covers, and its corners (`lotCorners`) are those of its end cells. The
// inside of a bend too tight for a cell is blocked already (CELL_BEND).
//
// Given a free zoned cell, the finder returns the largest lot holding that
// cell that fits a building type for its zone and density, and the type.
// The lot's shape picks the type: in each zone and density no two types
// take the same shape (balance.ts). Between lots of one area it takes the
// deeper one, then the one whose first column comes first along the strip.
// When no type fits it says why, for the zoning overlay. A cell further
// back than any type of its zone and density reaches says so ("too-deep"):
// with zoning six cells deep, the back rows of R1, C1, O1 and M1 never
// take a building.
//
// Through-lots (M2-14). A type marked `throughLot` stands on two lots of one
// zone and density, back to back on one block: the cell's strip from the
// road to the back of its free ground, and the strip behind, which fronts
// the road on the far side of the block, likewise from its road to the
// back. The block is the M1 block index's (roads/blocks.ts): every column
// of both lots must face the same one. Both lots are the same number of
// columns wide, each column free all the way to its strip's back, and the
// two backs meet: the back corners of the cell's lot are each within
// `throughLotMaxGap` of the matching back corner of the other. The whole
// lot is the two together, so it is deeper than one strip. A grid's default
// block, two strips deep between road edges, has the backs meet exactly. A
// strip around a corner is never behind another, since its block side is
// the same block but its back faces away. Among the lots behind that fit,
// the finder takes the one whose corners are nearest, then the first by
// cell key and direction.

import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { CELL_OPEN, cellSlotIn, columnStatus, nextColumn, nextColumnInto, syncCells, type CellIndex, type Column } from "../zoning/cell-index";
import { CELL_RIGHT, ZONE_NONE, fromLocal, localIndex, type CellRef, type CellState } from "../zoning/cells";
import { blockIndexOf, blockOnSide } from "../roads/blocks";
import { NONE, type RoadNetwork } from "../roads/network";
import { ROAD_TYPES } from "../roads/balance";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { lotCorners, openCellsNear } from "../zoning/cell-index";
import { BUILDINGS_BALANCE, WIDEST_LOT, typesFor, type BuildingType } from "./balance";
import { NO_BUILDING, lotColumns, segmentBuildings } from "./where";

/** A lot a building type fits. Its first column and size, as a building row holds them. */
export interface Lot {
  /** Index into `BUILDING_TYPES`. */
  type: number;
  firstSeg: number;
  firstSide: number;
  firstPlace: number;
  /** Which way the lot runs from its first column: 0 toward the segment's node B, 1 toward node A. */
  dir: number;
  width: number;
  /** The whole lot's depth, both strips together on a through-lot. */
  depth: number;
  /** The back lot of a through-lot, as a building row holds it; all 0 for a lot on one strip. */
  backSeg: number;
  backSide: number;
  backPlace: number;
  backDir: number;
  backDepth: number;
}

/** The back fields of a lot on one strip. */
const NO_BACK = { backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 } as const;

/** Why no building type fits at a cell. */
export type LotProblem =
  /** The cell named does not exist. */
  | "no-cell"
  /** The cell is blocked: water, steep ground, a road or another cell. */
  | "blocked"
  /** The cell has no zone. */
  | "unzoned"
  /** A building stands on it. */
  | "built"
  /** A cell between it and the road is not free with its zone and density. */
  | "off-road"
  /** No type of its zone and density fits: the free ground is not deep enough. */
  | "too-shallow"
  /** No type fits: the free ground is deep enough but not wide enough. */
  | "too-narrow"
  /** No type of its zone and density reaches this far back from the road. */
  | "too-deep"
  /** The balance has no type for its zone and density. */
  | "no-types";

export type LotResult =
  | { ok: true; lot: Lot }
  | {
      ok: false;
      problem: LotProblem;
      /** The same in words, for the overlay. */
      reason: string;
      /** For "too-shallow" and "too-narrow": the smallest width and depth any type of the zone and density takes. */
      need?: { width: number; depth: number };
      /** For "too-shallow" and "too-narrow": how deep the free ground is at the cell, and how wide it runs at the depth needed. */
      room?: { width: number; depth: number };
    };

const DEPTH = ZONING_BALANCE.zoneDepthCells;

/** dx² + dz², by multiplying, which every engine rounds alike (CLAUDE.md rule 6). */
const squared = (dx: number, dz: number): number => dx * dx + dz * dz;

/** The zone and density as a player reads them, as in R3. */
function zoneLabel(zone: number, density: number): string {
  return `${ZONING_BALANCE.zones[zone - 1]?.letter ?? "?"}${density}`;
}

function refuse(problem: LotProblem, reason: string, extra: Partial<Extract<LotResult, { ok: false }>> = {}): Extract<LotResult, { ok: false }> {
  return { ok: false, problem, reason, ...extra };
}

/** One refusal per problem with no reason, made once, for callers that read only whether a lot fits. */
const QUIET = new Map<LotProblem, Extract<LotResult, { ok: false }>>();

/** `refuse`, or when `explain` is false the problem alone, shared and made once, with an empty reason. */
function refuseIf(explain: boolean, problem: LotProblem, reason: string): Extract<LotResult, { ok: false }> {
  if (explain) return refuse(problem, reason);
  let quiet = QUIET.get(problem);
  if (!quiet) QUIET.set(problem, (quiet = Object.freeze({ ok: false, problem, reason: "" }) as Extract<LotResult, { ok: false }>));
  return quiet;
}

/** Every type that fits at a cell, each on its largest lot, and how deep the free ground at the cell runs. */
export type LotOptions =
  | {
      ok: true;
      /** One per type that fits, in `BUILDING_TYPES` order: the type's largest lot holding the cell. Never empty. */
      lots: Lot[];
      /** Free cells of the cell's zone and density in its column, from the road back. */
      free: number;
    }
  | Extract<LotResult, { ok: false }>;

/** The free frontage a cell lies on: its two ends and how many columns it runs. */
export interface Frontage {
  /** The front cells at its ends, the nearer first; one when it is one column, none when it has no end. */
  ends: CellRef[];
  /** Columns from end to end; 0 when it has no end, Infinity when it runs on past `FRONTAGE_REACH` either way. */
  width: number;
}

/**
 * How many columns `freeFrontage` walks each way before it gives up on an
 * end, about a kilometre of 8 m cells. It bounds the walk on every grower
 * draw. A long free run with no end that near builds as it did before
 * issue 194, at the drawn cell, or at the one end in reach. A limit of
 * the walk, not a rate or a price, so it is not in the balance files.
 */
export const FRONTAGE_REACH = 128;

/**
 * The columns one walk along a strip has passed, as a small table kept
 * between calls, so the grower's many walks a draw make no garbage (issue
 * 166): a set of keys built per walk, as strings, was most of what the
 * grower allocated. A column is its segment and its front cell's place in
 * the segment's run. Clearing moves to the next generation rather than
 * wiping the table. Scratch for one call at a time, never state.
 */
interface ColumnMarks {
  seg: Int32Array;
  local: Int32Array;
  gen: Int32Array;
  now: number;
}

/** A table for walks that mark up to `most` columns, at most a quarter full. */
function columnMarks(most: number): ColumnMarks {
  let size = 1;
  while (size < 4 * most) size *= 2;
  return { seg: new Int32Array(size), local: new Int32Array(size), gen: new Int32Array(size), now: 0 };
}

function clearMarks(m: ColumnMarks): void {
  m.now++;
  if (m.now < 0x7fffffff) return;
  m.gen.fill(0);
  m.now = 1;
}

/** Marks the column; false when it was marked already since the last clear. */
function markColumn(m: ColumnMarks, seg: number, local: number): boolean {
  const mask = m.seg.length - 1;
  for (let h = (seg * 31 + local) & mask; ; h = (h + 1) & mask) {
    if (m.gen[h] !== m.now) {
      m.gen[h] = m.now;
      m.seg[h] = seg;
      m.local[h] = local;
      return true;
    }
    if (m.seg[h] === seg && m.local[h] === local) return false;
  }
}

/** A frontage walk marks its start and up to `FRONTAGE_REACH` columns each way. */
const frontageMarks = columnMarks(2 * FRONTAGE_REACH + 1);

/** A strip walk marks its start and each way up to `WIDEST_LOT - 1` columns and the one that stops it. */
const stripMarks = columnMarks(2 * WIDEST_LOT + 1);

/**
 * The free frontage `ref` lies on (issue 194): the run of free front cells
 * of `ref`'s zone and density along its strip, walked the way lots run
 * (`nextColumn`), so it runs on across a segment's end where a lot would.
 * Each end is the last such cell before something else: the strip's end at
 * a junction or a road's end, a building, ground of another zone or
 * density, or a blocked cell. The nearer end comes first, and of two the
 * same distance away, the one toward node A. An end further than
 * `FRONTAGE_REACH` columns away is not found. A run that closes on itself
 * has no end, and unzoned ground no frontage. Settles cells as `findLot`
 * does, with the same caution for systems. Read only.
 *
 * The grower builds from an end, so a building stands against whatever
 * ends the run and the free ground it leaves stays in one piece.
 */
export function freeFrontage(state: SimState, ref: CellRef): Frontage {
  const index = syncCells(state);
  const cells = state.cells;
  const slot = cellSlotIn(index, cells, ref.segment, ref.side, ref.place, 0);
  if (slot < 0) return { ends: [], width: 0 };
  const zone = cells.zone[slot] ?? ZONE_NONE;
  const density = cells.density[slot] ?? 0;
  if (zone === ZONE_NONE) return { ends: [], width: 0 };
  const onCell = segmentBuildings(state);
  const start = frontageStart;
  start.seg = ref.segment;
  start.side = ref.side;
  start.place = ref.place;
  start.dir = 0;
  if (!freeFront(index, cells, onCell, zone, density, start)) return { ends: [], width: 0 };
  clearMarks(frontageMarks);
  markColumn(frontageMarks, start.seg, localIndex(start.side, start.place, 0));
  const towardA = frontageA;
  const towardB = frontageB;
  if (!walkFrontage(index, cells, onCell, zone, density, 1, towardA)) return { ends: [], width: 0 };
  if (!walkFrontage(index, cells, onCell, zone, density, 0, towardB)) return { ends: [], width: 0 };
  if (towardA.open || towardB.open) {
    const ends: CellRef[] = [];
    if (!towardA.open) ends.push(endRef(towardA.col));
    if (!towardB.open) ends.push(endRef(towardB.col));
    return { ends, width: Infinity };
  }
  const width = towardA.steps + towardB.steps + 1;
  if (width === 1) return { ends: [endRef(start)], width };
  const near = towardA.steps <= towardB.steps ? towardA : towardB;
  const far = near === towardA ? towardB : towardA;
  return { ends: [endRef(near.col), endRef(far.col)], width };
}

/** Where one walk of `freeFrontage` stopped: the last free column, how many steps on, and whether it stopped at `FRONTAGE_REACH` with no end. */
interface FrontageWalk {
  col: Column;
  steps: number;
  open: boolean;
}

/** Scratch for `freeFrontage`, one call at a time, so its walks make no garbage (issue 166). */
const frontageStart: Column = { seg: 0, side: 0, place: 0, dir: 0 };
const frontageNext: Column = { seg: 0, side: 0, place: 0, dir: 0 };
const frontageA: FrontageWalk = { col: { seg: 0, side: 0, place: 0, dir: 0 }, steps: 0, open: false };
const frontageB: FrontageWalk = { col: { seg: 0, side: 0, place: 0, dir: 0 }, steps: 0, open: false };

const endRef = (col: Column): CellRef => ({ segment: col.seg, side: col.side, place: col.place, depth: 0 });

/** Whether the front cell of `col` is open, of `zone` and `density`, and has no building. */
function freeFront(index: CellIndex, cells: CellState, onCell: readonly (Int32Array | null)[], zone: number, density: number, col: Column): boolean {
  if (columnStatus(index, col, 0) !== CELL_OPEN) return false;
  const local = localIndex(col.side, col.place, 0);
  const at = (cells.offset[col.seg] ?? 0) + local;
  return cells.zone[at] === zone && cells.density[at] === density && (onCell[col.seg]?.[local] ?? NO_BUILDING) === NO_BUILDING;
}

/**
 * Walks `dir` from `frontageStart` while the front cells stay free, into
 * `out`: the last free column and how many steps on, with `open` set when
 * the walk stopped at `FRONTAGE_REACH` and no end. False if the walk comes
 * round to a column already passed.
 */
function walkFrontage(index: CellIndex, cells: CellState, onCell: readonly (Int32Array | null)[], zone: number, density: number, dir: number, out: FrontageWalk): boolean {
  const col = out.col;
  col.seg = frontageStart.seg;
  col.side = frontageStart.side;
  col.place = frontageStart.place;
  col.dir = dir;
  out.steps = 0;
  out.open = false;
  const next = frontageNext;
  while (nextColumnInto(index, col, next) && freeFront(index, cells, onCell, zone, density, next)) {
    if (out.steps === FRONTAGE_REACH) {
      out.open = true;
      return true;
    }
    if (!markColumn(frontageMarks, next.seg, localIndex(next.side, next.place, 0))) return false;
    col.seg = next.seg;
    col.side = next.side;
    col.place = next.place;
    col.dir = next.dir;
    out.steps++;
  }
  return true;
}

/**
 * The largest lot holding the cell `ref` names that fits a building type,
 * and the type; or why none does. Settles any change of roads first, as
 * every cell query does, so the answer follows from the roads alone and is
 * the same on every machine. Read only.
 *
 * A system in the step that acts on the answer, such as the grower, must
 * not call this before `cellsSettled` (cell-index.ts). Until that tick a
 * big change of roads is settling a slice a tick, and a call would walk the
 * rest in one step, past the tick budget the slicing exists to protect. The
 * PRD has the grower wait for that tick.
 */
export function findLot(state: SimState, ref: CellRef): LotResult {
  const options = lotOptions(state, ref);
  if (!options.ok) return options;
  // The largest; between lots of one area the deeper; then the first type.
  let best = options.lots[0] as Lot;
  for (const lot of options.lots) {
    const area = lot.width * lot.depth;
    const bestArea = best.width * best.depth;
    if (area > bestArea || (area === bestArea && lot.depth > best.depth)) best = lot;
  }
  return { ok: true, lot: best };
}

/**
 * How far any cell of a segment can lie outside the box of its ends and its
 * control point, which holds its curve: cells stand beside the road, out
 * from its line by half its width and the zoning depth, so the widest
 * road's whole width and the zoning depth with two cells to spare is more
 * than enough. A geometric bound, not a balance number.
 */
export const CELL_SLACK = Math.max(...ROAD_TYPES.map((t) => t.width)) + (ZONING_BALANCE.zoneDepthCells + 2) * ZONING_BALANCE.cellSize;

/** Widens `reads`'s box to take in the box from (x0, z0) to (x1, z1). */
export function readBox(reads: LotReads, x0: number, z0: number, x1: number, z1: number): void {
  if (x0 < reads.x0) reads.x0 = x0;
  if (z0 < reads.z0) reads.z0 = z0;
  if (x1 > reads.x1) reads.x1 = x1;
  if (z1 > reads.z1) reads.z1 = z1;
}

/** Widens `reads`'s box to take in every cell of segment `seg` of `net`: its ends and control point, out to `CELL_SLACK`. */
export function readSegmentBox(reads: LotReads, net: RoadNetwork, seg: number): void {
  const a = net.segA[seg] ?? NONE;
  const b = net.segB[seg] ?? NONE;
  const ax = net.nodeX[a] ?? 0;
  const az = net.nodeZ[a] ?? 0;
  const bx = net.nodeX[b] ?? 0;
  const bz = net.nodeZ[b] ?? 0;
  const cx = net.segCX[seg] ?? 0;
  const cz = net.segCZ[seg] ?? 0;
  readBox(reads, Math.min(ax, bx, cx) - CELL_SLACK, Math.min(az, bz, cz) - CELL_SLACK, Math.max(ax, bx, cx) + CELL_SLACK, Math.max(az, bz, cz) + CELL_SLACK);
}

/** Empties `reads`, for a new try. */
export function clearReads(reads: LotReads): void {
  reads.across = false;
  reads.blocks = false;
  reads.sides.length = 0;
  reads.x0 = Infinity;
  reads.z0 = Infinity;
  reads.x1 = -Infinity;
  reads.z1 = -Infinity;
}

/**
 * What lot searches read beyond the strip they walked, for the grower's
 * set-aside cells (lot-order.ts, #426). `lotOptions` sets each flag it
 * comes to and clears nothing, so one object can gather a grower's try at
 * both ends of a frontage and at the cell. A search that sets neither flag
 * read only its own strip's columns.
 */
export interface LotReads {
  /** It looked across the block for the back lot of a through-lot: the cells near the back of the strip. */
  across: boolean;
  /**
   * A box round all it read across the block, in metres: the ground round
   * each point it looked for cells near, and every segment whose cells it
   * read, out to `CELL_SLACK`. Empty, with x0 above x1, until it looks.
   */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /**
   * A block test turned a back lot away: the strips faced different blocks,
   * or none. A change of roads anywhere round a block can change that, by
   * closing it or joining it to the next. With this clear, every block test
   * passed, so a search with other blocks finds no more than this one did.
   */
  blocks: boolean;
  /**
   * Each side of a road whose block a test read, as the half-edge
   * `2 * segment`, plus 1 for the left side (roads/blocks.ts), repeats and
   * all. While none of them faces anything new, every block test answers
   * as it did.
   */
  sides: number[];
}

/**
 * Every building type that fits at the cell `ref` names, each on the
 * largest lot holding the cell that it takes, or why none does. `findLot`
 * takes the largest of these; the grower draws among them (grower.ts).
 * Settles cells as `findLot` does, with the same caution for systems.
 * Given `free`, a cell under a building it says yes to counts as free, so
 * redevelopment can fit a lot over the buildings it would replace. Given
 * `reads`, it notes there what it read beyond its strip (`LotReads`).
 */
export function lotOptions(state: SimState, ref: CellRef, explain = true, free?: (id: number) => boolean, reads?: LotReads): LotOptions {
  const index = syncCells(state);
  const cells = state.cells;
  const slot = cellSlotIn(index, cells, ref.segment, ref.side, ref.place, ref.depth);
  if (slot < 0) return refuseIf(explain, "no-cell", "There is no such cell");
  const start: Column = { seg: ref.segment, side: ref.side, place: ref.place, dir: 0 };
  if (columnStatus(index, start, ref.depth) !== CELL_OPEN) return refuseIf(explain, "blocked", "The ground is blocked");
  const zone = cells.zone[slot] ?? ZONE_NONE;
  const density = cells.density[slot] ?? 0;
  if (zone === ZONE_NONE) return refuseIf(explain, "unzoned", "The ground is not zoned");
  const onCell = segmentBuildings(state);
  // Redevelopment (redevelop.ts, M3-14) asks with some buildings counted as free ground.
  const builtOn = (col: Column, depth: number): boolean => {
    const id = onCell[col.seg]?.[localIndex(col.side, col.place, depth)] ?? NO_BUILDING;
    return id !== NO_BUILDING && !(free !== undefined && free(id));
  };
  if (builtOn(start, ref.depth)) return refuseIf(explain, "built", "A building stands here");
  const types = typesFor(zone, density);
  if (types.length === 0) return refuseIf(explain, "no-types", explain ? `Nothing grows in ${zoneLabel(zone, density)}` : "");

  /** Free cells from the road back in `col`, up to the zoning depth. */
  const freeDepth = (col: Column): number => {
    const run = (cells.offset[col.seg] ?? 0) + localIndex(col.side, col.place, 0);
    let d = 0;
    while (
      d < DEPTH &&
      columnStatus(index, col, d) === CELL_OPEN &&
      cells.zone[run + d] === zone &&
      cells.density[run + d] === density &&
      !builtOn(col, d)
    ) {
      d++;
    }
    return d;
  };

  // The strip around the cell's column, in the order of its segment's
  // places, each column with the way that runs on along it. Columns with no
  // free cell at the road end it: no lot crosses them.
  const reach = WIDEST_LOT - 1;
  clearMarks(stripMarks);
  markColumn(stripMarks, start.seg, localIndex(start.side, start.place, 0));
  // Each way first as far as a lot on one strip reaches, then on as far as
  // a through-lot does, so on a strip that closes on itself the plain types
  // see the same columns either side as they would with no through-lots.
  const walk = (from: Column, out: { col: Column; free: number }[] = [], limit = reach): { col: Column; free: number }[] => {
    let col: Column | null = out.length > 0 ? (out[out.length - 1] as { col: Column }).col : from;
    while (out.length < limit && (col = nextColumn(index, col)) !== null) {
      if (!markColumn(stripMarks, col.seg, localIndex(col.side, col.place, 0))) break;
      const free = freeDepth(col);
      if (free === 0) break;
      out.push({ col, free });
    }
    return out;
  };
  const plainReach = BUILDINGS_BALANCE.maxLotWidth - 1;
  const ahead = walk(start, [], plainReach);
  const behindWalk = walk({ ...start, dir: 1 }, [], plainReach);
  if (reach > plainReach && types.some((t) => t.throughLot)) {
    if (ahead.length === plainReach) walk(start, ahead);
    if (behindWalk.length === plainReach) walk({ ...start, dir: 1 }, behindWalk);
  }
  // Walked the other way, each column's way on along the strip is the
  // opposite of the walk's.
  const behind = behindWalk
    .reverse()
    .map(({ col, free }) => ({ col: { ...col, dir: 1 - col.dir }, free }));
  const strip = [...behind, { col: start, free: freeDepth(start) }, ...ahead];
  const at = behind.length;
  const own = strip[at]?.free ?? 0;
  if (own <= ref.depth) return refuseIf(explain, "off-road", "The ground between here and the road is not free");

  /**
   * The lot behind `w` columns from `first`, each free `depth` deep to the
   * back of its strip: as the header says, or null.
   */
  const gap2 = ZONING_BALANCE.throughLotMaxGap * ZONING_BALANCE.throughLotMaxGap;
  const blocks = blockIndexOf(state.roads);
  const blockOf = (col: Column) => {
    const h = 2 * col.seg + (col.side === CELL_RIGHT ? 0 : 1);
    // Most reads repeat the last: the columns of one lot face one side of one road.
    if (reads && reads.sides[reads.sides.length - 1] !== h) reads.sides.push(h);
    return blockOnSide(blocks, col.seg, col.side === CELL_RIGHT);
  };
  /** Notes in `reads` that a block test turned a back lot away, and returns `value`. */
  const turnedAway = <T>(value: T): T => {
    if (reads) reads.blocks = true;
    return value;
  };
  /** The one block every column of `cols` faces, or NONE. */
  const sameBlock = (cols: readonly Column[]): number => {
    const block = blockOf(cols[0] as Column);
    return cols.every((c) => blockOf(c) === block) ? block : NONE;
  };
  /**
   * The columns that could start a lot behind one starting at strip column
   * `s`, free `depth` deep: on the same block, free some depth of their
   * own, with their near back corner within the gap of this column's.
   * Found once per column and reused for every width, since a failed search
   * on a deep strip with no partner is the slow case.
   */
  // Only through-lots look for partners, so most calls make no map.
  let partners: Map<number, { col: Column; depth: number; near: number }[]> | null = null;
  const partnersAt = (s: number, depth: number): { col: Column; depth: number; near: number }[] => {
    partners ??= new Map();
    const known = partners.get(s);
    if (known) return known;
    const out: { col: Column; depth: number; near: number }[] = [];
    partners.set(s, out);
    if (reads) reads.across = true;
    const first = (strip[s] as { col: Column }).col;
    const corners = lotCorners(index, first, 1, depth);
    if (!corners) return out;
    const block = blockOf(first);
    if (block === NONE) return turnedAway(out);
    const nx = corners[2] ?? 0;
    const nz = corners[3] ?? 0;
    const gap = ZONING_BALANCE.throughLotMaxGap;
    if (reads) readBox(reads, nx - gap, nz - gap, nx + gap, nz + gap);
    const tried = new Set<string>();
    // The lot behind's first column has its back corner within the gap of
    // this column's near back corner, and that corner is its back cell's.
    for (const key of openCellsNear(index, nx, nz, ZONING_BALANCE.throughLotMaxGap)) {
      const seg = Math.floor(key / CELL_KEY_STRIDE);
      const { side, place } = fromLocal(key - seg * CELL_KEY_STRIDE);
      if (seg === first.seg && side === first.side) continue;
      if (reads) readSegmentBox(reads, state.roads, seg);
      for (let dir = 0; dir < 2; dir++) {
        const col: Column = { seg, side, place, dir };
        const name = `${seg}/${side}/${place}/${dir}`;
        if (tried.has(name)) continue;
        tried.add(name);
        if (blockOf(col) !== block) {
          turnedAway(null);
          continue;
        }
        const d = freeDepth(col);
        if (d === 0) continue;
        const back = lotCorners(index, col, 1, d);
        if (!back) continue;
        const near = squared((back[2] ?? 0) - nx, (back[3] ?? 0) - nz);
        if (near <= gap2) out.push({ col, depth: d, near });
      }
    }
    return out;
  };

  /** `lotColumns` for a lot behind, noting in `reads` each segment its walk reads, as far as it gets. */
  const backColumns = (col: Column, w: number): Column[] | null => {
    if (reads) {
      let c: Column | null = col;
      for (let i = 0; c && i < w; i++) {
        readSegmentBox(reads, state.roads, c.seg);
        c = i + 1 < w ? nextColumn(index, c) : null;
      }
    }
    return lotColumns(index, col, w);
  };

  /** The lot behind `w` columns from strip column `s`, each free `depth` deep: as the header says, or null. */
  const lotBehind = (s: number, w: number, depth: number): { first: Column; depth: number } | null => {
    const first = (strip[s] as { col: Column }).col;
    const options = partnersAt(s, depth);
    if (options.length === 0) return null;
    const cols = lotColumns(index, first, w);
    const corners = lotCorners(index, first, w, depth);
    if (!cols || !corners) return null;
    const block = sameBlock(cols);
    if (block === NONE) return turnedAway(null);
    const fx = corners[4] ?? 0;
    const fz = corners[5] ?? 0;
    let best: { first: Column; depth: number; worst: number } | null = null;
    for (const { col, depth: d, near } of options) {
      const backCols = backColumns(col, w);
      const back = lotCorners(index, col, w, d);
      if (!backCols || !back) continue;
      const far = squared((back[4] ?? 0) - fx, (back[5] ?? 0) - fz);
      if (far > gap2 || !backCols.every((c) => freeDepth(c) === d)) continue;
      if (sameBlock(backCols) !== block) {
        turnedAway(null);
        continue;
      }
      const worst = Math.max(near, far);
      if (!best || worst < best.worst) best = { first: col, depth: d, worst };
    }
    return best ? { first: best.first, depth: best.depth } : null;
  };

  /**
   * A through-lot type's largest lot holding the cell; between lots of one
   * area the deeper, then the one whose first column comes first along the
   * strip. Every column of its front lot is free to the same depth, the
   * back of its strip.
   */
  const throughLot = (type: BuildingType): Lot | null => {
    let best: { lot: Lot; area: number } | null = null;
    for (let w = type.width[0]; w <= type.width[1]; w++) {
      for (let s = Math.max(0, at - w + 1); s <= at && s + w <= strip.length; s++) {
        const d = strip[s]?.free ?? 0;
        if (d <= ref.depth) continue;
        let even = true;
        for (let i = s + 1; i < s + w && even; i++) even = strip[i]?.free === d;
        if (!even) continue;
        const first = (strip[s] as { col: Column }).col;
        const back = lotBehind(s, w, d);
        if (!back) continue;
        const depth = d + back.depth;
        if (depth < type.depth[0] || depth > type.depth[1]) continue;
        const area = w * depth;
        if (best && (area < best.area || (area === best.area && depth <= best.lot.depth))) continue;
        best = {
          area,
          lot: {
            type: type.index,
            firstSeg: first.seg,
            firstSide: first.side,
            firstPlace: first.place,
            dir: first.dir,
            width: w,
            depth,
            backSeg: back.first.seg,
            backSide: back.first.side,
            backPlace: back.first.place,
            backDir: back.first.dir,
            backDepth: back.depth,
          },
        };
      }
    }
    return best?.lot ?? null;
  };

  const lots: Lot[] = [];
  for (const type of types) {
    if (type.throughLot) {
      const lot = throughLot(type);
      if (lot) lots.push(lot);
      continue;
    }
    // The type's largest lot; between lots of one area the deeper, then
    // the one whose first column comes first along the strip. Kept as
    // numbers until the end, so trying sizes makes no garbage (issue 166).
    let bestArea = 0;
    let bestDepth = 0;
    let bestWidth = 0;
    let bestStart = -1;
    for (let w = type.width[0]; w <= type.width[1]; w++) {
      for (let d = Math.max(type.depth[0], ref.depth + 1); d <= type.depth[1]; d++) {
        const area = w * d;
        if (bestStart >= 0 && (area < bestArea || (area === bestArea && d <= bestDepth))) continue;
        // The first start, along the strip, whose `w` columns are all free `d` deep.
        for (let s = Math.max(0, at - w + 1); s <= at && s + w <= strip.length; s++) {
          let fits = true;
          for (let i = s; i < s + w && fits; i++) fits = (strip[i]?.free ?? 0) >= d;
          if (!fits) continue;
          bestArea = area;
          bestDepth = d;
          bestWidth = w;
          bestStart = s;
          break;
        }
      }
    }
    if (bestStart >= 0) {
      const first = (strip[bestStart] as { col: Column }).col;
      lots.push({ type: type.index, firstSeg: first.seg, firstSide: first.side, firstPlace: first.place, dir: first.dir, width: bestWidth, depth: bestDepth, ...NO_BACK });
    }
  }
  if (lots.length > 0) return { ok: true, lots, free: own };

  // A lot holding the cell is at least `ref.depth + 1` deep, so only the
  // types that reach that far back count. A through-lot needs a second
  // strip, which the reasons below do not go into. Counted in loops, so a
  // refusal the grower reads no further than `ok` makes no garbage.
  let deepest = 0;
  let reaching = 0;
  let needWidth = Infinity;
  let needDepth = Infinity;
  for (const t of types) {
    if (t.throughLot) continue;
    deepest = Math.max(deepest, t.depth[1]);
    if (t.depth[1] <= ref.depth) continue;
    reaching++;
    needWidth = Math.min(needWidth, t.width[0]);
    needDepth = Math.min(needDepth, Math.max(t.depth[0], ref.depth + 1));
  }
  const label = explain ? zoneLabel(zone, density) : "";
  if (reaching === 0) {
    return refuseIf(explain, "too-deep", explain ? `No ${label} building reaches ${ref.depth + 1} cells back from the road; the deepest lot is ${deepest}` : "");
  }
  const problem: LotProblem = own < needDepth ? "too-shallow" : "too-narrow";
  if (!explain) return refuseIf(false, problem, "");
  const need = { width: needWidth, depth: needDepth };
  // How wide the free ground runs through the cell at the depth needed.
  const deep = need.depth;
  let lo = at;
  let hi = at;
  while (lo > 0 && (strip[lo - 1]?.free ?? 0) >= deep) lo--;
  while (hi < strip.length - 1 && (strip[hi + 1]?.free ?? 0) >= deep) hi++;
  const room = { width: own >= deep ? hi - lo + 1 : 0, depth: own };
  const needs = `${label} needs a lot at least ${need.width} wide and ${need.depth} deep`;
  if (problem === "too-shallow") return refuse("too-shallow", `${needs}; the zoned ground here is ${own} deep`, { need, room });
  return refuse("too-narrow", `${needs}; the zoned ground here is ${room.width} wide`, { need, room });
}


/**
 * Whether a type that stands on one strip fits a lot holding the front
 * cell of `ref`'s column, worked out more cheaply than `lotOptions` does
 * (issue #164). True only where `lotOptions` at that front cell finds a lot.
 * False says nothing either way: the caller asks the finder. The zoning
 * overlay asks this of every free column in a chunk and the finder only of
 * the rest, which are few.
 *
 * It walks the strip as `lotOptions` does, each way as far as a lot on one
 * strip reaches, and a type fits when the run of columns round the cell
 * free to one of its depths is as wide as its narrowest lot. `known` keeps
 * each column's free run from the road, with its zone and density, by the
 * slot of its front cell. Neighbouring columns share it, so pass one map
 * for every call on one unchanged state.
 */
export function plainLotFits(state: SimState, ref: Pick<CellRef, "segment" | "side" | "place">, known: Map<number, number>): boolean {
  const index = syncCells(state);
  const cells = state.cells;
  if (cellSlotIn(index, cells, ref.segment, ref.side, ref.place, 0) < 0) return false;
  const onCell = segmentBuildings(state);
  /** A column's free run from the road, as `(zone * 16 + density) * 16 + depth`, or 0 where its front cell is not free. */
  const run = (col: Column): number => {
    const front = (cells.offset[col.seg] ?? 0) + localIndex(col.side, col.place, 0);
    let r = known.get(front);
    if (r === undefined) {
      const zone = cells.zone[front] ?? ZONE_NONE;
      const density = cells.density[front] ?? 0;
      const built = onCell[col.seg];
      const local = localIndex(col.side, col.place, 0);
      let d = 0;
      while (
        d < DEPTH &&
        columnStatus(index, col, d) === CELL_OPEN &&
        cells.zone[front + d] === zone &&
        cells.density[front + d] === density &&
        (built?.[local + d] ?? NO_BUILDING) === NO_BUILDING
      ) {
        d++;
      }
      r = zone === ZONE_NONE || d === 0 ? 0 : (zone * 16 + density) * 16 + d;
      known.set(front, r);
    }
    return r;
  };
  const start: Column = { seg: ref.segment, side: ref.side, place: ref.place, dir: 0 };
  const own = run(start);
  if (own === 0) return false;
  const kind = Math.floor(own / 16);
  const types = typesFor(Math.floor(kind / 16), kind % 16).filter((t) => !t.throughLot);
  if (types.length === 0) return false;
  // As `lotOptions` walks: ahead first, then behind, never a column twice.
  const reach = BUILDINGS_BALANCE.maxLotWidth - 1;
  const key = (col: Column): number => col.seg * CELL_KEY_STRIDE + localIndex(col.side, col.place, 0);
  const seen = new Set<number>([key(start)]);
  const walk = (dir: number): number[] => {
    const out: number[] = [];
    let col: Column | null = { ...start, dir };
    while (out.length < reach && (col = nextColumn(index, col)) !== null) {
      const k = key(col);
      if (seen.has(k)) break;
      seen.add(k);
      const r = run(col);
      const free = Math.floor(r / 16) === kind ? r % 16 : 0;
      if (free === 0) break;
      out.push(free);
    }
    return out;
  };
  const ahead = walk(0);
  const behind = walk(1);
  /** Columns from the cell, not counting it, free at least `d` deep. */
  const within = (list: readonly number[], d: number): number => {
    let n = 0;
    while (n < list.length && (list[n] ?? 0) >= d) n++;
    return n;
  };
  const free = own % 16;
  for (const t of types) {
    for (let d = Math.max(t.depth[0], 1); d <= Math.min(t.depth[1], free); d++) {
      if (within(behind, d) + 1 + within(ahead, d) >= t.width[0]) return true;
    }
  }
  return false;
}
