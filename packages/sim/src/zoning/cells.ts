// Zoning cells in state (M2-03, PRD "M2 Zoning and buildings").
//
// Every ground-level road segment of a zonable type has cells along both
// sides, `zoneDepthCells` deep, one for each whole cell size along it from
// node A. A cell is named by its segment, its side, its place along the
// segment from node A and its depth back from the road's edge. That name is
// what state, commands and deltas use.
//
// State holds what a player sets: a zone and a density per cell, in two flat
// arrays. The cells of one segment are a run in those arrays, starting at
// `offset[segment]`, and `offset` has one more entry than there are segment
// ids, so the run of segment s ends at `offset[s + 1]`. Within a run, cells
// go by place, then side, then depth, which is also the order in which
// cells of one segment claim ground. The runs are in segment id order and
// the number of cells a segment has follows from its type, level and length,
// so the layout is a function of the road graph and two cities with the same
// roads lay their cells out the same way.
//
// Everything else about a cell is derived (cell-index.ts): where it is and
// whether it is blocked. That keeps a save to two bytes a cell.

import { ROAD_TYPES } from "../roads/balance";
import { LEVEL_GROUND, NETWORK_ROAD, isSegment, segmentIdLimit, type RoadNetwork } from "../roads/network";
import { ZONING_BALANCE } from "./balance";
import { cellsAlong } from "./shape";

/** A cell on the left of its segment, travelling from node A to node B with north up. */
export const CELL_LEFT = 0;
/** A cell on the right of its segment. */
export const CELL_RIGHT = 1;

/** A cell's zone before a player paints it. Zones count from 1, in `ZONING_BALANCE.zones` order. */
export const ZONE_NONE = 0;
/** A cell's density before a player paints it. Densities are 1 to 3. */
export const DENSITY_NONE = 0;

/** The zone and density of every cell. Plain typed arrays only (CLAUDE.md rule 7). */
export interface CellState {
  /**
   * Where each segment's cells start in `zone` and `density`, by segment id,
   * with one entry past the last id holding the total. A segment with no
   * cells has a run of length zero.
   */
  offset: Int32Array;
  /** ZONE_NONE, or 1 plus the zone's place in `ZONING_BALANCE.zones`. */
  zone: Uint8Array;
  /** DENSITY_NONE, or the density level, 1 to 3. */
  density: Uint8Array;
}

/** A cell's name: segment, side, place along from node A, depth back from the road's edge. */
export interface CellRef {
  segment: number;
  /** CELL_LEFT or CELL_RIGHT. */
  side: number;
  place: number;
  depth: number;
}

/** Cells per place along a segment: both sides, every depth. */
export function cellsPerPlace(): number {
  return 2 * ZONING_BALANCE.zoneDepthCells;
}

/**
 * Whether a segment with these fields has cells: a road on the ground at
 * both ends, of a zonable type. Bridges, tunnels, elevated roads, ramps,
 * rail, paths and highways have none.
 */
export function zonableFields(network: number, type: number, levelA: number, levelB: number): boolean {
  return network === NETWORK_ROAD && levelA === LEVEL_GROUND && levelB === LEVEL_GROUND && ROAD_TYPES[type]?.zonable === true;
}

/** Places along segment `seg`: 0 when it has no cells. */
export function placesAlong(net: RoadNetwork, seg: number): number {
  if (!isSegment(net, seg)) return 0;
  if (!zonableFields(net.segNetwork[seg] ?? 0, net.segType[seg] ?? 0, net.segLevelA[seg] ?? 0, net.segLevelB[seg] ?? 0)) return 0;
  return cellsAlong(net.segLength[seg] ?? 0, ZONING_BALANCE.cellSize);
}

/** How many cells segment `seg` has. */
export function cellCountOf(net: RoadNetwork, seg: number): number {
  return placesAlong(net, seg) * cellsPerPlace();
}

/** Where a cell sits in its segment's run, from its name. */
export function localIndex(side: number, place: number, depth: number): number {
  const d = ZONING_BALANCE.zoneDepthCells;
  return (place * 2 + side) * d + depth;
}

/** A cell's side, place and depth from where it sits in its segment's run. */
export function fromLocal(local: number): { side: number; place: number; depth: number } {
  const d = ZONING_BALANCE.zoneDepthCells;
  const depth = local % d;
  const rest = (local - depth) / d;
  const side = rest % 2;
  return { side, place: (rest - side) / 2, depth };
}

/** Cells for every segment of `net`, none of them zoned. */
export function unzonedCells(net: RoadNetwork): CellState {
  const limit = segmentIdLimit(net);
  const offset = new Int32Array(limit + 1);
  let total = 0;
  for (let seg = 0; seg < limit; seg++) {
    offset[seg] = total;
    total += cellCountOf(net, seg);
  }
  offset[limit] = total;
  return { offset, zone: new Uint8Array(total), density: new Uint8Array(total) };
}

/**
 * The index in `cells.zone` and `cells.density` of the cell `ref` names, or
 * -1 when no such cell exists.
 */
export function cellSlot(net: RoadNetwork, cells: CellState, ref: CellRef): number {
  const { segment, side, place, depth } = ref;
  if (!Number.isInteger(segment) || segment < 0 || segment >= cells.offset.length - 1) return -1;
  if (side !== CELL_LEFT && side !== CELL_RIGHT) return -1;
  if (!Number.isInteger(depth) || depth < 0 || depth >= ZONING_BALANCE.zoneDepthCells) return -1;
  if (!Number.isInteger(place) || place < 0 || place >= placesAlong(net, segment)) return -1;
  const start = cells.offset[segment] ?? 0;
  const local = localIndex(side, place, depth);
  return local < (cells.offset[segment + 1] ?? 0) - start ? start + local : -1;
}

/**
 * Why `value` is not a well-formed cell state for network `net`, or null if
 * it is. For loading a save: the runs must be the ones the roads give, and
 * every zone and density one the balance knows, both set or both not.
 */
export function checkCells(value: unknown, net: RoadNetwork): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not an object";
  const cells = value as Record<string, unknown>;
  const extra = Object.keys(cells).find((key) => key !== "offset" && key !== "zone" && key !== "density");
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  const { offset, zone, density } = cells;
  if (!(offset instanceof Int32Array)) return "offset is not an Int32Array";
  if (!(zone instanceof Uint8Array) || !(density instanceof Uint8Array)) return "zone or density is not a Uint8Array";
  const limit = segmentIdLimit(net);
  if (offset.length !== limit + 1) return "offset does not have one entry per segment id and one more";
  let total = 0;
  for (let seg = 0; seg < limit; seg++) {
    if (offset[seg] !== total) return `segment ${seg}'s cells do not follow the ones before them`;
    total += cellCountOf(net, seg);
  }
  if (offset[limit] !== total) return "offset's last entry is not the number of cells";
  if (zone.length !== total || density.length !== total) return "zone or density does not have one entry per cell";
  const zones = ZONING_BALANCE.zones.length;
  const densities = ZONING_BALANCE.densities.length;
  for (let i = 0; i < total; i++) {
    const z = zone[i] ?? 0;
    const d = density[i] ?? 0;
    if (z > zones || d > densities) return `cell ${i} has an unknown zone or density`;
    if ((z === ZONE_NONE) !== (d === DENSITY_NONE)) return `cell ${i} has a zone without a density, or a density without a zone`;
  }
  return null;
}
