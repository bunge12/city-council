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

import type { SimState } from "../state";
import { ZONING_BALANCE } from "../zoning/balance";
import { CELL_OPEN, columnStatus, nextColumn, syncCells, type Column } from "../zoning/cell-index";
import { ZONE_NONE, cellSlot, localIndex, type CellRef } from "../zoning/cells";
import { BUILDINGS_BALANCE, typesFor } from "./balance";
import { NO_BUILDING, cellBuildings } from "./where";

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
  depth: number;
}

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

/** The zone and density as a player reads them, as in R3. */
function zoneLabel(zone: number, density: number): string {
  return `${ZONING_BALANCE.zones[zone - 1]?.letter ?? "?"}${density}`;
}

function refuse(problem: LotProblem, reason: string, extra: Partial<Extract<LotResult, { ok: false }>> = {}): LotResult {
  return { ok: false, problem, reason, ...extra };
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
  const index = syncCells(state);
  const cells = state.cells;
  const slot = cellSlot(state.roads, cells, ref);
  if (slot < 0) return refuse("no-cell", "There is no such cell");
  const start: Column = { seg: ref.segment, side: ref.side, place: ref.place, dir: 0 };
  if (columnStatus(index, start, ref.depth) !== CELL_OPEN) return refuse("blocked", "The ground is blocked");
  const zone = cells.zone[slot] ?? ZONE_NONE;
  const density = cells.density[slot] ?? 0;
  if (zone === ZONE_NONE) return refuse("unzoned", "The ground is not zoned");
  const onCell = cellBuildings(state);
  if (onCell[slot] !== NO_BUILDING) return refuse("built", "A building stands here");
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
      onCell[run + d] === NO_BUILDING
    ) {
      d++;
    }
    return d;
  };

  // The strip around the cell's column, in the order of its segment's
  // places, each column with the way that runs on along it. Columns with no
  // free cell at the road end it: no lot crosses them.
  const reach = BUILDINGS_BALANCE.maxLotWidth - 1;
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

  let best: { lot: Lot; area: number } | null = null;
  for (const type of types) {
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
          best = { area, lot: { type: type.index, firstSeg: first.seg, firstSide: first.side, firstPlace: first.place, dir: first.dir, width: w, depth: d } };
          break;
        }
      }
    }
  }
  if (best) return { ok: true, lot: best.lot };

  // A lot holding the cell is at least `ref.depth + 1` deep, so only the
  // types that reach that far back count.
  const reaching = types.filter((t) => t.depth[1] > ref.depth);
  if (reaching.length === 0) {
    const deepest = Math.max(...types.map((t) => t.depth[1]));
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

