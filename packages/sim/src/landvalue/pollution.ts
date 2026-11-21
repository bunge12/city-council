// Pollution from industry on a grid of squares (M3-13). Derived data: the
// building index (buildings/where.ts) keeps the grid, stamping each
// industrial building on when it is filed and off when it is unfiled.
//
// Every stamp is whole points, so the grid is a sum of integers and comes
// out the same in any order: kept current building by building, or built
// afresh from the buildings in state at load, it holds the same numbers.
// Distances use multiply, add and `Math.sqrt` only (CLAUDE.md rule 6).

import { BUILDING_TYPES } from "../buildings/balance";
import { TERRAIN_BALANCE, mapSize } from "../terrain/terrain";
import { LAND_VALUE_BALANCE } from "./balance";

/** Squares along each side of the map. */
export function pollutionSide(): number {
  return Math.ceil(mapSize(TERRAIN_BALANCE) / LAND_VALUE_BALANCE.squareSize);
}

/** An empty grid, one entry per square, row by row from the north-west corner. */
export function createPollutionGrid(): Int32Array {
  const side = pollutionSide();
  return new Int32Array(side * side);
}

/** By building type index: the industrial density, 1 to 3, or 0 for a type that does not pollute. */
const SOURCE_DENSITY: readonly number[] = BUILDING_TYPES.map((t) => (t.zone === "industrial" ? t.density : 0));

/** The industrial density of a building of type `type`, or 0 if it does not pollute. */
export function pollutionSourceOf(type: number): number {
  return SOURCE_DENSITY[type] ?? 0;
}

/**
 * Adds (`sign` 1) or takes away (`sign` -1) what an industrial building of
 * density `density` whose lot's centre is at (x, z) gives each square:
 * `strength` at its centre, falling in a straight line to nothing at
 * `radius`, rounded down, measured to the square's centre.
 */
export function stampPollution(grid: Int32Array, x: number, z: number, density: number, sign: 1 | -1): void {
  const source = LAND_VALUE_BALANCE.industry[density - 1];
  if (!source) return;
  const { strength, radius } = source;
  const q = LAND_VALUE_BALANCE.squareSize;
  const side = pollutionSide();
  const i0 = Math.max(0, Math.floor((x - radius) / q));
  const i1 = Math.min(side - 1, Math.floor((x + radius) / q));
  const j0 = Math.max(0, Math.floor((z - radius) / q));
  const j1 = Math.min(side - 1, Math.floor((z + radius) / q));
  for (let j = j0; j <= j1; j++) {
    const dz = (j + 0.5) * q - z;
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * q - x;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= radius) continue;
      const points = Math.floor((strength * (radius - d)) / radius);
      if (points > 0) grid[j * side + i] = (grid[j * side + i] ?? 0) + sign * points;
    }
  }
}

/** The pollution points on the square that holds (x, z); 0 off the map. */
export function pollutionAt(grid: Int32Array, x: number, z: number): number {
  const q = LAND_VALUE_BALANCE.squareSize;
  const side = pollutionSide();
  const i = Math.floor(x / q);
  const j = Math.floor(z / q);
  if (i < 0 || j < 0 || i >= side || j >= side) return 0;
  return grid[j * side + i] ?? 0;
}
