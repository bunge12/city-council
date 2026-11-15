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
import { CELL_OPEN, columnStatus, nextColumn, syncCells, type Column } from "../zoning/cell-index";
import { CELL_RIGHT, ZONE_NONE, cellSlot, fromLocal, localIndex, type CellRef } from "../zoning/cells";
import { blockIndexOf, blockOnSide } from "../roads/blocks";
import { NONE } from "../roads/network";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { lotCorners, openCellsNear } from "../zoning/cell-index";
import { WIDEST_LOT, typesFor, type BuildingType } from "./balance";
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
 * Every building type that fits at the cell `ref` names, each on the
 * largest lot holding the cell that it takes, or why none does. `findLot`
 * takes the largest of these; the grower draws among them (grower.ts).
 * Settles cells as `findLot` does, with the same caution for systems.
 */
export function lotOptions(state: SimState, ref: CellRef): LotOptions {
  const index = syncCells(state);
  const cells = state.cells;
  const slot = cellSlot(state.roads, cells, ref);
  if (slot < 0) return refuse("no-cell", "There is no such cell");
  const start: Column = { seg: ref.segment, side: ref.side, place: ref.place, dir: 0 };
  if (columnStatus(index, start, ref.depth) !== CELL_OPEN) return refuse("blocked", "The ground is blocked");
  const zone = cells.zone[slot] ?? ZONE_NONE;
  const density = cells.density[slot] ?? 0;
  if (zone === ZONE_NONE) return refuse("unzoned", "The ground is not zoned");
  const onCell = segmentBuildings(state);
  const builtOn = (col: Column, depth: number): boolean => (onCell[col.seg]?.[localIndex(col.side, col.place, depth)] ?? NO_BUILDING) !== NO_BUILDING;
  if (builtOn(start, ref.depth)) return refuse("built", "A building stands here");
  const label = zoneLabel(zone, density);
  const types = typesFor(zone, density);
  if (types.length === 0) return refuse("no-types", `Nothing grows in ${label}`);

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
  const seen = new Set<string>([`${start.seg}/${start.side}/${start.place}`]);
  const walk = (from: Column): { col: Column; free: number }[] => {
    const out: { col: Column; free: number }[] = [];
    let col: Column | null = from;
    while (out.length < reach && (col = nextColumn(index, col)) !== null) {
      const key = `${col.seg}/${col.side}/${col.place}`;
      if (seen.has(key)) break;
      seen.add(key);
      const free = freeDepth(col);
      if (free === 0) break;
      out.push({ col, free });
    }
    return out;
  };
  const ahead = walk(start);
  // Walked the other way, each column's way on along the strip is the
  // opposite of the walk's.
  const behind = walk({ ...start, dir: 1 })
    .reverse()
    .map(({ col, free }) => ({ col: { ...col, dir: 1 - col.dir }, free }));
  const strip = [...behind, { col: start, free: freeDepth(start) }, ...ahead];
  const at = behind.length;
  const own = strip[at]?.free ?? 0;
  if (own <= ref.depth) return refuse("off-road", "The ground between here and the road is not free");

  /**
   * The lot behind `w` columns from `first`, each free `depth` deep to the
   * back of its strip: as the header says, or null.
   */
  const gap2 = ZONING_BALANCE.throughLotMaxGap * ZONING_BALANCE.throughLotMaxGap;
  const blocks = blockIndexOf(state.roads);
  const blockOf = (col: Column) => blockOnSide(blocks, col.seg, col.side === CELL_RIGHT);
  /** The one block every column of `cols` faces, or NONE. */
  const sameBlock = (cols: readonly Column[]): number => {
    const block = blockOf(cols[0] as Column);
    return cols.every((c) => blockOf(c) === block) ? block : NONE;
  };
  const lotBehind = (first: Column, w: number, depth: number): { first: Column; depth: number } | null => {
    const cols = lotColumns(index, first, w);
    const corners = lotCorners(index, first, w, depth);
    if (!cols || !corners) return null;
    const block = sameBlock(cols);
    if (block === NONE) return null;
    const nx = corners[2] ?? 0;
    const nz = corners[3] ?? 0;
    const fx = corners[4] ?? 0;
    const fz = corners[5] ?? 0;
    const tried = new Set<string>();
    let best: { first: Column; depth: number; worst: number } | null = null;
    // The lot behind's first column has its back corner within the gap of
    // this lot's near back corner, so its back cell has a corner within the
    // gap plus two cells of it.
    for (const key of openCellsNear(index, nx, nz, ZONING_BALANCE.throughLotMaxGap + 2 * ZONING_BALANCE.cellSize)) {
      const seg = Math.floor(key / CELL_KEY_STRIDE);
      const { side, place } = fromLocal(key - seg * CELL_KEY_STRIDE);
      if (seg === first.seg && side === first.side) continue;
      for (let dir = 0; dir < 2; dir++) {
        const col: Column = { seg, side, place, dir };
        const name = `${seg}/${side}/${place}/${dir}`;
        if (tried.has(name)) continue;
        tried.add(name);
        const d = freeDepth(col);
        if (d === 0) continue;
        const backCols = lotColumns(index, col, w);
        const back = lotCorners(index, col, w, d);
        if (!backCols || !back || !backCols.every((c) => freeDepth(c) === d) || sameBlock(backCols) !== block) continue;
        const near = squared((back[2] ?? 0) - nx, (back[3] ?? 0) - nz);
        const far = squared((back[4] ?? 0) - fx, (back[5] ?? 0) - fz);
        if (near > gap2 || far > gap2) continue;
        const worst = Math.max(near, far);
        if (!best || worst < best.worst) best = { first: col, depth: d, worst };
      }
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
        const back = lotBehind(first, w, d);
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
    // the one whose first column comes first along the strip.
    let best: { lot: Lot; area: number } | null = null;
    for (let w = type.width[0]; w <= type.width[1]; w++) {
      for (let d = Math.max(type.depth[0], ref.depth + 1); d <= type.depth[1]; d++) {
        const area = w * d;
        if (best && (area < best.area || (area === best.area && d <= best.lot.depth))) continue;
        // The first start, along the strip, whose `w` columns are all free `d` deep.
        for (let s = Math.max(0, at - w + 1); s <= at && s + w <= strip.length; s++) {
          let fits = true;
          for (let i = s; i < s + w && fits; i++) fits = (strip[i]?.free ?? 0) >= d;
          if (!fits) continue;
          const first = (strip[s] as { col: Column }).col;
          best = { area, lot: { type: type.index, firstSeg: first.seg, firstSide: first.side, firstPlace: first.place, dir: first.dir, width: w, depth: d, ...NO_BACK } };
          break;
        }
      }
    }
    if (best) lots.push(best.lot);
  }
  if (lots.length > 0) return { ok: true, lots, free: own };

  // A lot holding the cell is at least `ref.depth + 1` deep, so only the
  // types that reach that far back count. A through-lot needs a second
  // strip, which the reasons below do not go into.
  const plain = types.filter((t) => !t.throughLot);
  const reaching = plain.filter((t) => t.depth[1] > ref.depth);
  if (reaching.length === 0) {
    const deepest = Math.max(0, ...plain.map((t) => t.depth[1]));
    return refuse("too-deep", `No ${label} building reaches ${ref.depth + 1} cells back from the road; the deepest lot is ${deepest}`);
  }
  const need = {
    width: Math.min(...reaching.map((t) => t.width[0])),
    depth: Math.min(...reaching.map((t) => Math.max(t.depth[0], ref.depth + 1))),
  };
  // How wide the free ground runs through the cell at the depth needed.
  const deep = need.depth;
  let lo = at;
  let hi = at;
  while (lo > 0 && (strip[lo - 1]?.free ?? 0) >= deep) lo--;
  while (hi < strip.length - 1 && (strip[hi + 1]?.free ?? 0) >= deep) hi++;
  const room = { width: own >= deep ? hi - lo + 1 : 0, depth: own };
  const needs = `${label} needs a lot at least ${need.width} wide and ${need.depth} deep`;
  if (own < need.depth) return refuse("too-shallow", `${needs}; the zoned ground here is ${own} deep`, { need, room });
  return refuse("too-narrow", `${needs}; the zoned ground here is ${room.width} wide`, { need, room });
}

