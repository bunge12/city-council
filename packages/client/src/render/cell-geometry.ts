// The zoning overlay's mesh for one 500 m chunk (issue M2-06), built from
// the mirror alone: where each cell is and whether it is blocked come from
// the sim's own cell index run on the mirror's copy (`cellShapesInChunk`),
// and what it is zoned for from the copy's `cells` arrays. A blocked cell
// is not drawn, and nor is a cell a building stands on (issue M2-12).
//
// Each open cell is one quad, four vertices of its own, lying on the ground
// at its corners. A vertex carries the cell's fill colour, with alpha 255
// for a zoned cell and 0 for an unzoned one, which shows only its outline,
// and where it is in the cell, (0, 0) to (1, 1), from which the shader draws
// the cell's lines (cell-meshes.ts). A vertex also carries whether its
// cell is free ground where no building type fits (issue M2-15,
// `lotMarksInChunk`), which the shader hatches.
//
// The city band draws the same chunk coarser (issue #133, `buildCityCells`):
// zoned cells only, no lines or hatch, and one quad per straight run of
// cells of one colour along a road.

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
  /**
   * 1 per vertex of a cell where no building type fits, 0 elsewhere. A
   * float, since WebGPU has no vertex format for a single byte.
   */
  marks: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Cells drawn: zoned ones filled, unzoned ones as outlines. */
  zoned: number;
  unzoned: number;
  /** Cells drawn with the hatch. */
  marked: number;
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
 * `built`, by the order of `shapes`, is the building on each cell, or -1
 * for none (`buildingsOnSlots`); a cell with a building is not drawn.
 * `marks`, by the same order, is 1 for a cell where no building type fits
 * (`lotMarksInChunk`), drawn hatched.
 */
export function buildCellChunk(
  shapes: ChunkCellShapes,
  zone: ArrayLike<number>,
  density: ArrayLike<number>,
  height: (x: number, z: number) => number,
  built: ArrayLike<number> | null = null,
  marks: ArrayLike<number> | null = null,
): CellArrays {
  const { slots, statuses, corners } = shapes;
  const shown = (k: number) => statuses[k] === CELL_OPEN && (built === null || (built[k] ?? -1) < 0);
  let drawn = 0;
  for (let k = 0; k < statuses.length; k++) if (shown(k)) drawn++;
  const positions = new Float32Array(drawn * 12);
  const fills = new Uint8Array(drawn * 16);
  const uv = new Uint8Array(drawn * 8);
  const hatch = new Float32Array(drawn * 4);
  const indices = drawn * 4 > 0xffff ? new Uint32Array(drawn * 6) : new Uint16Array(drawn * 6);
  const densities = ZONING_BALANCE.densities.length;
  let zoned = 0;
  let marked = 0;
  let n = 0;
  for (let k = 0; k < statuses.length; k++) {
    if (!shown(k)) continue;
    const slot = slots[k] ?? 0;
    const z = zone[slot] ?? ZONE_NONE;
    const d = density[slot] ?? DENSITY_NONE;
    const filled = z !== ZONE_NONE && d !== DENSITY_NONE;
    if (filled) zoned++;
    const mark = filled && (marks?.[k] ?? 0) !== 0 ? 1 : 0;
    if (mark) marked++;
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
      hatch[v] = mark;
    }
    indices.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], n * 6);
    n++;
  }
  return { positions, fills, corners: uv, marks: hatch, indices, zoned, unzoned: drawn - zoned, marked };
}

/** One chunk's zoned cells for the city band: a quad per run, flat colour, no lines. */
export interface CityCellArrays {
  /** x, y, z per vertex, world metres. */
  positions: Float32Array;
  /** r, g, b per vertex and 255, sRGB bytes. */
  fills: Uint8Array;
  indices: Uint32Array;
  /** Quads drawn, and the zoned cells they cover. */
  runs: number;
  cells: number;
}

/**
 * The city band's mesh for one chunk's cells (issue #133). Only zoned open
 * cells with no building are drawn, as `buildCellChunk` fills them, with
 * `built` likewise by the order of `shapes`. Cells
 * of one colour that follow each other along a road, one's end edge the
 * next one's start edge exactly, are joined into one quad from the first
 * one's start edge to the last one's end edge, while the run's two sides
 * stay straight to within `turn`, the sine of the angle between the run's
 * first cell and each one after. A run is at most `maxCells` long, and the
 * ground under each joint inside it may stand at most `sag` metres above
 * the quad.
 */
export function buildCityCells(
  shapes: ChunkCellShapes,
  zone: ArrayLike<number>,
  density: ArrayLike<number>,
  height: (x: number, z: number) => number,
  built: ArrayLike<number> | null = null,
  limits: { turn: number; maxCells: number; sag: number } = { turn: CELLS.runTurn, maxCells: CELLS.runMaxCells, sag: CELLS.runSag },
): CityCellArrays {
  const { slots, statuses, corners } = shapes;
  const densities = ZONING_BALANCE.densities.length;
  const n = statuses.length;
  /** Each drawn cell's palette offset, or -1 for one not drawn. */
  const colour = new Int32Array(n).fill(-1);
  const at = (k: number, c: number) => [corners[k * 8 + c * 2] ?? 0, corners[k * 8 + c * 2 + 1] ?? 0] as const;
  /** Cells are found by their inner start corner, and an edge matches only when its outer corner matches too. */
  const key = (p: readonly [number, number]) => `${p[0]},${p[1]}`;
  const byStart = new Map<string, number>();
  /** The ground under each drawn cell's end corners, inner and outer, sampled once. */
  const ground = new Float64Array(n * 2);
  let cells = 0;
  for (let k = 0; k < n; k++) {
    if (statuses[k] !== CELL_OPEN) continue;
    const slot = slots[k] ?? 0;
    if (built !== null && (built[k] ?? -1) >= 0) continue;
    const z = zone[slot] ?? ZONE_NONE;
    const d = density[slot] ?? DENSITY_NONE;
    if (z === ZONE_NONE || d === DENSITY_NONE) continue;
    colour[k] = ((z - 1) * densities + d - 1) * 3;
    cells++;
    // Corners run inner start, inner end, outer end, outer start.
    byStart.set(key(at(k, 0)), k);
    ground[k * 2] = height(...at(k, 1));
    ground[k * 2 + 1] = height(...at(k, 2));
  }
  /** The cell after each, or -1: one of the same colour starting where it ends. */
  const next = new Int32Array(n).fill(-1);
  const hasPrev = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if ((colour[k] ?? -1) < 0) continue;
    const j = byStart.get(key(at(k, 1)));
    if (j === undefined || j === k || colour[j] !== colour[k]) continue;
    const outer = at(k, 2);
    const start = at(j, 3);
    if (outer[0] !== start[0] || outer[1] !== start[1]) continue;
    next[k] = j;
    hasPrev[j] = 1;
  }
  const quads: number[] = [];
  const unit = (k: number, from: number, to: number) => {
    const a = at(k, from);
    const b = at(k, to);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / len, (b[1] - a[1]) / len] as const;
  };
  const straight = (first: number, k: number) => {
    for (const [from, to] of [
      [0, 1],
      [3, 2],
    ] as const) {
      const u = unit(first, from, to);
      const v = unit(k, from, to);
      if (Math.abs(u[0] * v[1] - u[1] * v[0]) > limits.turn || u[0] * v[0] + u[1] * v[1] < 0) return false;
    }
    return true;
  };
  /** Whether the quad from `run[0]`'s start edge to `k`'s end edge stays over the ground at every joint of `run`. */
  const clear = (run: readonly number[], k: number) => {
    const first = run[0] ?? k;
    for (const side of [0, 1] as const) {
      const a = at(first, side === 0 ? 0 : 3);
      const b = at(k, side === 0 ? 1 : 2);
      const ha = height(a[0], a[1]);
      const hb = ground[k * 2 + side] ?? 0;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      for (const j of run) {
        const p = at(j, side === 0 ? 1 : 2);
        const t = Math.hypot(p[0] - a[0], p[1] - a[1]) / len;
        if ((ground[j * 2 + side] ?? 0) - (ha + (hb - ha) * t) > limits.sag) return false;
      }
    }
    return true;
  };
  const taken = new Uint8Array(n);
  const emit = (run: readonly number[]) => quads.push(run[0] ?? 0, run[run.length - 1] ?? 0);
  // Runs start at cells nothing leads into; a loop with no start, as round a closed ring of road, starts anywhere.
  for (const pass of [0, 1]) {
    for (let k = 0; k < n; k++) {
      if ((colour[k] ?? -1) < 0 || taken[k] || (pass === 0 && hasPrev[k])) continue;
      let run = [k];
      taken[k] = 1;
      for (let j = next[k] ?? -1; j >= 0 && !taken[j]; j = next[j] ?? -1) {
        if (run.length >= limits.maxCells || !straight(run[0] ?? j, j) || !clear(run, j)) {
          emit(run);
          run = [];
        }
        run.push(j);
        taken[j] = 1;
      }
      emit(run);
    }
  }
  const runs = quads.length / 2;
  const positions = new Float32Array(runs * 12);
  const fills = new Uint8Array(runs * 16);
  const indices = new Uint32Array(runs * 6);
  for (let r = 0; r < runs; r++) {
    const first = quads[r * 2] ?? 0;
    const last = quads[r * 2 + 1] ?? 0;
    const p = colour[first] ?? 0;
    const quad = [at(first, 0), at(last, 1), at(last, 2), at(first, 3)];
    for (let c = 0; c < 4; c++) {
      const [x, z] = quad[c] ?? [0, 0];
      const v = r * 4 + c;
      positions[v * 3] = x;
      positions[v * 3 + 1] = height(x, z);
      positions[v * 3 + 2] = z;
      fills[v * 4] = PALETTE[p] ?? 0;
      fills[v * 4 + 1] = PALETTE[p + 1] ?? 0;
      fills[v * 4 + 2] = PALETTE[p + 2] ?? 0;
      fills[v * 4 + 3] = 255;
    }
    indices.set([r * 4, r * 4 + 1, r * 4 + 2, r * 4, r * 4 + 2, r * 4 + 3], r * 6);
  }
  return { positions, fills, indices, runs, cells };
}
