// The zoning overlay's mesh for one 500 m chunk (issue M2-06), built from
// the mirror alone: where each cell is and whether it is blocked come from
// the sim's own cell index run on the mirror's copy (`cellShapesInChunk`),
// and what it is zoned for from the copy's `cells` arrays. A blocked cell
// is not drawn.
//
// Each open cell is one quad, four vertices of its own, lying on the ground
// at its corners. A vertex carries the cell's fill colour, with alpha 255
// for a zoned cell and 0 for an unzoned one, which shows only its outline,
// and where it is in the cell, (0, 0) to (1, 1), from which the shader draws
// the cell's lines (cell-meshes.ts).

import { CELL_OPEN, DENSITY_NONE, ZONE_NONE, ZONING_BALANCE, type ChunkCellShapes } from "@city-council/sim";
import { CELLS } from "./config";

/** Typed arrays for one chunk's cells, ready for a BufferGeometry. Empty when no cell is drawn. */
export interface CellArrays {
  /** x, y, z per vertex, world metres. */
  positions: Float32Array;
  /** r, g, b, a per vertex, 0 to 255. Alpha 255 fills the cell; 0 draws its outline only. */
  fills: Uint8Array;
  /** u, v per vertex, 0 or 255: u along the road, v back from it. */
  corners: Uint8Array;
  indices: Uint16Array | Uint32Array;
  /** Cells drawn: zoned ones filled, unzoned ones as outlines. */
  zoned: number;
  unzoned: number;
}

/** The fill colour of zone `zone` (1-based, as `state.cells.zone` holds it) at density `density`, as sRGB hex. */
export function cellColour(zone: number, density: number): number {
  const id = ZONING_BALANCE.zones[zone - 1]?.id;
  const shades = id === undefined ? undefined : CELLS.zones[id];
  return shades?.[density - 1] ?? CELLS.unzoned;
}

/** Each zone's three shades as r, g, b bytes, by zone (1-based) and density (1-based), and the unzoned outline last. */
function palette(): Uint8Array {
  const zones = ZONING_BALANCE.zones.length;
  const densities = ZONING_BALANCE.densities.length;
  const out = new Uint8Array((zones * densities + 1) * 3);
  for (let z = 1; z <= zones; z++) {
    for (let d = 1; d <= densities; d++) {
      const hex = cellColour(z, d);
      out.set([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255], ((z - 1) * densities + d - 1) * 3);
    }
  }
  const u = CELLS.unzoned;
  out.set([(u >> 16) & 255, (u >> 8) & 255, u & 255], zones * densities * 3);
  return out;
}

const PALETTE = palette();
const UNZONED = ZONING_BALANCE.zones.length * ZONING_BALANCE.densities.length;
/** Where each corner sits in its cell, in the order `cellShapesInChunk` gives corners: inner start, inner end, outer end, outer start. */
const CORNER_UV = [0, 0, 255, 0, 255, 255, 0, 255] as const;

/**
 * The overlay mesh for one chunk's cells. `zone` and `density` are the
 * mirror's `state.cells` arrays and `height` gives the ground under a point.
 */
export function buildCellChunk(
  shapes: ChunkCellShapes,
  zone: ArrayLike<number>,
  density: ArrayLike<number>,
  height: (x: number, z: number) => number,
): CellArrays {
  const { slots, statuses, corners } = shapes;
  let drawn = 0;
  for (let k = 0; k < statuses.length; k++) if (statuses[k] === CELL_OPEN) drawn++;
  const positions = new Float32Array(drawn * 12);
  const fills = new Uint8Array(drawn * 16);
  const uv = new Uint8Array(drawn * 8);
  const indices = drawn * 4 > 0xffff ? new Uint32Array(drawn * 6) : new Uint16Array(drawn * 6);
  const densities = ZONING_BALANCE.densities.length;
  let zoned = 0;
  let n = 0;
  for (let k = 0; k < statuses.length; k++) {
    if (statuses[k] !== CELL_OPEN) continue;
    const slot = slots[k] ?? 0;
    const z = zone[slot] ?? ZONE_NONE;
    const d = density[slot] ?? DENSITY_NONE;
    const filled = z !== ZONE_NONE && d !== DENSITY_NONE;
    if (filled) zoned++;
    const p = (filled ? (z - 1) * densities + d - 1 : UNZONED) * 3;
    const v0 = n * 4;
    for (let c = 0; c < 4; c++) {
      const x = corners[k * 8 + c * 2] ?? 0;
      const zz = corners[k * 8 + c * 2 + 1] ?? 0;
      const v = v0 + c;
      positions[v * 3] = x;
      positions[v * 3 + 1] = height(x, zz);
      positions[v * 3 + 2] = zz;
      fills[v * 4] = PALETTE[p] ?? 0;
      fills[v * 4 + 1] = PALETTE[p + 1] ?? 0;
      fills[v * 4 + 2] = PALETTE[p + 2] ?? 0;
      fills[v * 4 + 3] = filled ? 255 : 0;
      uv[v * 2] = CORNER_UV[c * 2] ?? 0;
      uv[v * 2 + 1] = CORNER_UV[c * 2 + 1] ?? 0;
    }
    indices.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], n * 6);
    n++;
  }
  return { positions, fills, corners: uv, indices, zoned, unzoned: drawn - zoned };
}
