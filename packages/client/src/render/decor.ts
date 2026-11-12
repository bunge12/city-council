// Decoration placement: where trees and grass tufts stand. Plain typed
// arrays and no three.js, so placement can be tested in Node.
//
// Decoration is presentation only. It is not sim state, it is never saved
// and nothing in the game reads it. It must still look the same on every
// load and for every player, so placement is a pure function of the seed
// and the terrain: a jittered grid in world space, where each cell's dice
// come from an integer hash of the seed and the cell's position. The
// renderer's frame clock and Math.random play no part.

import { heightAt, slopeAt, type Terrain } from "@city-council/sim";
import { CHUNK_SIZE, DECOR } from "./config";

/** Floats per placed instance: x, y, z, height, yaw, shade. */
export const DECOR_STRIDE = 6;

/** Placed instances of one kind in one chunk. */
export interface DecorInstances {
  count: number;
  /**
   * `DECOR_STRIDE` floats per instance: world position of the base in
   * metres, height in metres, yaw in radians, and a shade from 0 to 1 that
   * picks the instance's tint.
   */
  data: Float32Array;
}

/** Decoration in one chunk. */
export interface ChunkDecor {
  broadleaf: DecorInstances;
  conifer: DecorInstances;
  grass: DecorInstances;
}

// Salts that give each die its own stream from one cell hash.
const SALT_TREE = 0x9e37;
const SALT_GRASS = 0x85eb;

/** A 32-bit integer hash of the seed, a cell and a salt. Same answer on every engine. */
export function cellHash(seed: number, gx: number, gz: number, salt: number): number {
  let h = Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(gx | 0, 0x165667b1) ^ Math.imul(gz | 0, 0x9e3779b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A small stream of dice from one starting hash. Each call returns a number in [0, 1). */
function dice(start: number): () => number {
  let h = start;
  return () => {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) + 0x6b43a9b5;
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** True where the nearest height sample to (x, z) is forest. */
function forestAt(t: Terrain, x: number, z: number): boolean {
  const last = t.samples - 1;
  const i = Math.min(last, Math.max(0, Math.floor(x / t.spacing + 0.5)));
  const j = Math.min(last, Math.max(0, Math.floor(z / t.spacing + 0.5)));
  return t.forest[j * t.samples + i] === 1;
}

class Builder {
  private data: Float32Array;
  count = 0;
  constructor(capacity: number) {
    this.data = new Float32Array(Math.max(1, capacity) * DECOR_STRIDE);
  }
  push(x: number, y: number, z: number, height: number, yaw: number, shade: number): void {
    const o = this.count * DECOR_STRIDE;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = height;
    this.data[o + 4] = yaw;
    this.data[o + 5] = shade;
    this.count++;
  }
  done(): DecorInstances {
    return { count: this.count, data: this.data.slice(0, this.count * DECOR_STRIDE) };
  }
}

/** Global cell indices whose origin lies in [from, from + CHUNK_SIZE). */
function cellRange(from: number, cell: number): [number, number] {
  return [Math.ceil(from / cell), Math.ceil((from + CHUNK_SIZE) / cell)];
}

/** Where the trees and grass in chunk (ci, cj) stand. */
export function placeDecor(terrain: Terrain, ci: number, cj: number): ChunkDecor {
  const x0 = ci * CHUNK_SIZE;
  const z0 = cj * CHUNK_SIZE;
  const water = terrain.waterLevel;
  const tau = 2 * Math.PI;

  const tc = DECOR.trees;
  const [tx0, tx1] = cellRange(x0, tc.cell);
  const [tz0, tz1] = cellRange(z0, tc.cell);
  const treeCells = (tx1 - tx0) * (tz1 - tz0);
  const broadleaf = new Builder(treeCells);
  const conifer = new Builder(treeCells);
  for (let gz = tz0; gz < tz1; gz++) {
    for (let gx = tx0; gx < tx1; gx++) {
      const roll = dice(cellHash(terrain.seed, gx, gz, SALT_TREE));
      const x = (gx + roll()) * tc.cell;
      const z = (gz + roll()) * tc.cell;
      const chance = forestAt(terrain, x, z) ? tc.forestChance : tc.scatterChance;
      if (roll() >= chance) continue;
      const y = heightAt(terrain, x, z);
      const above = y - water;
      if (above < tc.minAbove || above > tc.maxAbove) continue;
      if (slopeAt(terrain, x, z) > tc.maxSlope) continue;
      const height = tc.minHeight + (tc.maxHeight - tc.minHeight) * roll();
      const yaw = roll() * tau;
      const shade = roll();
      // Conifers take over with height; below the line they mix in with broadleaf.
      const isConifer = above > tc.coniferAbove || roll() < 0.3 + (0.7 * above) / tc.coniferAbove;
      // Sink the base a little so a tree on a slope has no gap under it.
      (isConifer ? conifer : broadleaf).push(x, y - 0.6, z, height, yaw, shade);
    }
  }

  const gc = DECOR.grass;
  const [gx0, gx1] = cellRange(x0, gc.cell);
  const [gz0, gz1] = cellRange(z0, gc.cell);
  const grass = new Builder((gx1 - gx0) * (gz1 - gz0));
  for (let gz = gz0; gz < gz1; gz++) {
    for (let gx = gx0; gx < gx1; gx++) {
      const roll = dice(cellHash(terrain.seed, gx, gz, SALT_GRASS));
      if (roll() >= gc.chance) continue;
      const x = (gx + roll()) * gc.cell;
      const z = (gz + roll()) * gc.cell;
      // Grass stays out of the woods, where the trees already cover the ground.
      if (forestAt(terrain, x, z)) continue;
      const y = heightAt(terrain, x, z);
      const above = y - water;
      if (above < gc.minAbove || above > gc.maxAbove) continue;
      if (slopeAt(terrain, x, z) > gc.maxSlope) continue;
      grass.push(x, y - 0.05, z, gc.minHeight + (gc.maxHeight - gc.minHeight) * roll(), roll() * tau, roll());
    }
  }

  return { broadleaf: broadleaf.done(), conifer: conifer.done(), grass: grass.done() };
}
