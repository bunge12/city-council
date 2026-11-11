// Terrain from a seed: height, water level and resource masks.
//
// Terrain is derived data. It is not part of SimState and is never saved; a
// loaded city rebuilds it from `state.seed`. So the output must be identical
// on every engine, and this folder uses only add, subtract, multiply, divide,
// Math.sqrt, Math.floor and integer operations (CLAUDE.md rule 6). Lint bans
// the rest of Math here.

import balance from "../../balance/terrain.json";
import { hashState } from "../hash";
import { fade, fbm, mixSeed, ridged } from "./noise";

/** Terrain generation parameters, as stored in `balance/terrain.json`. */
export type TerrainBalance = typeof balance;

/** The parameters the game uses. */
export const TERRAIN_BALANCE: TerrainBalance = balance;

/**
 * A generated map. Plain data and typed arrays. Sample `(i, j)` sits at world
 * `x = i * spacing`, `z = j * spacing` and is stored at index `j * samples + i`.
 */
export interface Terrain {
  /** The seed the map was generated from. */
  seed: number;
  /** Samples along each side. */
  samples: number;
  /** Distance between neighbouring samples, in metres. */
  spacing: number;
  /** Height of each sample above the lowest point of the map, in metres. */
  heights: Float32Array;
  /** Height of the water surface, in metres. A sample is water if its height is at or below this. */
  waterLevel: number;
  /** 1 where the land suits farming. */
  fertile: Uint8Array;
  /** 1 where the land is forested. */
  forest: Uint8Array;
  /** 1 where there is ore. */
  ore: Uint8Array;
  /** Share of samples that are dry and no steeper than the buildable slope. */
  buildableShare: number;
  /** Generation passes it took to reach the buildable share, from 1. */
  attempts: number;
}

// Salts that give each noise field its own stream from the one seed.
const SALT_LOWLAND = 1;
const SALT_MASK = 2;
const SALT_RIDGE = 3;
const SALT_COAST = 4;
const SALT_FERTILE = 5;
const SALT_FOREST = 6;
const SALT_ORE = 7;

const DIAGONAL = Math.sqrt(0.5);
/** The eight directions the sea can lie in, as unit vectors (x, z). */
const COAST_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [DIAGONAL, DIAGONAL],
  [0, 1],
  [-DIAGONAL, DIAGONAL],
  [-1, 0],
  [-DIAGONAL, -DIAGONAL],
  [0, -1],
  [DIAGONAL, -DIAGONAL],
];

function smoothRange(v: number, from: number, to: number): number {
  if (v <= from) return 0;
  if (v >= to) return 1;
  return fade((v - from) / (to - from));
}

/** Slope (rise over run) at a sample, by central differences. */
function sampleSlope(h: ArrayLike<number>, n: number, spacing: number, i: number, j: number): number {
  const i0 = i > 0 ? i - 1 : i;
  const i1 = i < n - 1 ? i + 1 : i;
  const j0 = j > 0 ? j - 1 : j;
  const j1 = j < n - 1 ? j + 1 : j;
  const row = j * n;
  const dx = ((h[row + i1] ?? 0) - (h[row + i0] ?? 0)) / ((i1 - i0) * spacing);
  const dz = ((h[j1 * n + i] ?? 0) - (h[j0 * n + i] ?? 0)) / ((j1 - j0) * spacing);
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Thermal erosion: where a sample stands above its lowest neighbour by more
 * than the talus height, part of the excess slides down. Runs in place, in
 * a fixed order, so the result does not depend on the machine.
 */
function erode(h: Float64Array, n: number, talus: number, rate: number, iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const here = h[k] ?? 0;
        let low = k;
        let lowH = here;
        if (i > 0 && (h[k - 1] ?? 0) < lowH) {
          low = k - 1;
          lowH = h[low] ?? 0;
        }
        if (i < n - 1 && (h[k + 1] ?? 0) < lowH) {
          low = k + 1;
          lowH = h[low] ?? 0;
        }
        if (j > 0 && (h[k - n] ?? 0) < lowH) {
          low = k - n;
          lowH = h[low] ?? 0;
        }
        if (j < n - 1 && (h[k + n] ?? 0) < lowH) {
          low = k + n;
          lowH = h[low] ?? 0;
        }
        const excess = here - lowH - talus;
        if (excess > 0) {
          const move = (excess * rate) / 2;
          h[k] = here - move;
          h[low] = lowH + move;
        }
      }
    }
  }
}

interface Fields {
  lowland: Float64Array;
  mountain: Float64Array;
}

function noiseFields(seed: number, b: TerrainBalance): Fields {
  const n = b.samples;
  const lowland = new Float64Array(n * n);
  const mountain = new Float64Array(n * n);
  const lowSeed = mixSeed(seed, SALT_LOWLAND);
  const maskSeed = mixSeed(seed, SALT_MASK);
  const ridgeSeed = mixSeed(seed, SALT_RIDGE);
  const coast = COAST_DIRECTIONS[mixSeed(seed, SALT_COAST) % COAST_DIRECTIONS.length] ?? [1, 0];
  const lw = b.lowland.wavelength / b.spacing;
  const mw = b.mountains.maskWavelength / b.spacing;
  const rw = b.mountains.ridgeWavelength / b.spacing;
  const m = b.mountains;
  for (let j = 0; j < n; j++) {
    const v = (2 * j) / (n - 1) - 1;
    for (let i = 0; i < n; i++) {
      const u = (2 * i) / (n - 1) - 1;
      const k = j * n + i;
      const toward = u * coast[0] + v * coast[1];
      lowland[k] = fbm(i / lw, j / lw, lowSeed, b.lowland.octaves, b.lowland.gain) - b.coastTilt * toward;
      const mask = smoothRange(fbm(i / mw, j / mw, maskSeed, m.maskOctaves, 0.5), m.maskFrom, m.maskTo);
      mountain[k] = mask === 0 ? 0 : mask * ridged(i / rw, j / rw, ridgeSeed, m.ridgeOctaves, m.ridgeGain);
    }
  }
  return { lowland, mountain };
}

interface Shaped {
  heights: Float32Array;
  waterLevel: number;
  buildableShare: number;
}

function shape(fields: Fields, reliefScale: number, b: TerrainBalance): Shaped {
  const n = b.samples;
  const count = n * n;
  const h = new Float64Array(count);
  const lowRelief = b.lowland.relief * reliefScale;
  const mountainRelief = b.mountains.relief * reliefScale;
  for (let k = 0; k < count; k++) {
    h[k] = (fields.lowland[k] ?? 0) * lowRelief + (fields.mountain[k] ?? 0) * mountainRelief;
  }
  erode(h, n, b.erosion.talusSlope * b.spacing, b.erosion.rate, b.erosion.iterations);

  let min = Infinity;
  for (let k = 0; k < count; k++) min = (h[k] ?? 0) < min ? (h[k] ?? 0) : min;
  const heights = new Float32Array(count);
  for (let k = 0; k < count; k++) heights[k] = (h[k] ?? 0) - min;

  // The water surface sits at the height below which `waterShare` of the
  // map lies, so every map has the same amount of water.
  const sorted = heights.slice().sort();
  const waterLevel = sorted[Math.floor(b.waterShare * count)] ?? 0;

  let buildable = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if ((heights[k] ?? 0) <= waterLevel) continue;
      if (sampleSlope(heights, n, b.spacing, i, j) <= b.buildable.maxSlope) buildable++;
    }
  }
  return { heights, waterLevel, buildableShare: buildable / count };
}

function resourceMasks(
  seed: number,
  shaped: Shaped,
  mountain: Float64Array,
  b: TerrainBalance,
): Pick<Terrain, "fertile" | "forest" | "ore"> {
  const n = b.samples;
  const r = b.resources;
  const rw = r.wavelength / b.spacing;
  const fertileSeed = mixSeed(seed, SALT_FERTILE);
  const forestSeed = mixSeed(seed, SALT_FOREST);
  const oreSeed = mixSeed(seed, SALT_ORE);
  const fertile = new Uint8Array(n * n);
  const forest = new Uint8Array(n * n);
  const ore = new Uint8Array(n * n);
  const { heights, waterLevel } = shaped;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const above = (heights[k] ?? 0) - waterLevel;
      if (above <= 0) continue;
      const slope = sampleSlope(heights, n, b.spacing, i, j);
      const x = i / rw;
      const z = j / rw;
      if (
        slope <= r.fertile.maxSlope &&
        above <= r.fertile.maxHeightAboveWater &&
        fbm(x, z, fertileSeed, r.octaves, 0.5) > r.fertile.threshold
      ) {
        fertile[k] = 1;
      }
      if (
        slope <= r.forest.maxSlope &&
        above <= r.forest.maxHeightAboveWater &&
        fbm(x, z, forestSeed, r.octaves, 0.5) > r.forest.threshold
      ) {
        forest[k] = 1;
      }
      if ((mountain[k] ?? 0) >= r.ore.minMountain && fbm(x, z, oreSeed, r.octaves, 0.5) > r.ore.threshold) {
        ore[k] = 1;
      }
    }
  }
  return { fertile, forest, ore };
}

/**
 * Generates the map for a 32-bit seed. The same seed gives the same map,
 * bit for bit, on every engine.
 *
 * If less than `buildable.minShare` of the map is dry and gentle enough to
 * build on, the relief is scaled down and the map shaped again, up to
 * `buildable.maxAttempts` passes. The last pass drops the mountains, so a
 * map that still falls short is as flat as the coast allows.
 */
export function generateTerrain(seed: number, b: TerrainBalance = TERRAIN_BALANCE): Terrain {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer from 0 to 2^32 - 1, got ${seed}`);
  }
  const fields = noiseFields(seed, b);
  const max = b.buildable.maxAttempts;
  let shaped = shape(fields, 1, b);
  let attempts = 1;
  let scale = 1;
  while (shaped.buildableShare < b.buildable.minShare && attempts < max) {
    attempts++;
    scale *= b.buildable.reliefScalePerAttempt;
    if (attempts === max) fields.mountain.fill(0);
    shaped = shape(fields, scale, b);
  }
  return {
    seed,
    samples: b.samples,
    spacing: b.spacing,
    heights: shaped.heights,
    waterLevel: shaped.waterLevel,
    ...resourceMasks(seed, shaped, fields.mountain, b),
    buildableShare: shaped.buildableShare,
    attempts,
  };
}

/** Width of the map in metres. Samples run from 0 to `mapSize - spacing`. */
export function mapSize(t: Pick<Terrain, "samples" | "spacing">): number {
  return t.samples * t.spacing;
}

interface Cell {
  k00: number;
  fx: number;
  fz: number;
  di: number;
  dj: number;
}

function locate(t: Terrain, x: number, z: number): Cell {
  const last = t.samples - 1;
  const gx = x / t.spacing;
  const gz = z / t.spacing;
  const cx = gx < 0 ? 0 : gx > last ? last : gx;
  const cz = gz < 0 ? 0 : gz > last ? last : gz;
  // On the last row or column use the cell before it, at fraction 1.
  const i = cx >= last ? last - 1 : Math.floor(cx);
  const j = cz >= last ? last - 1 : Math.floor(cz);
  return { k00: j * t.samples + i, fx: cx - i, fz: cz - j, di: 1, dj: t.samples };
}

/**
 * Height in metres at world point (x, z), interpolated bilinearly between
 * the four nearest samples. Points off the map take the height at the edge.
 */
export function heightAt(t: Terrain, x: number, z: number): number {
  const c = locate(t, x, z);
  const h = t.heights;
  const h00 = h[c.k00] ?? 0;
  const h10 = h[c.k00 + c.di] ?? 0;
  const h01 = h[c.k00 + c.dj] ?? 0;
  const h11 = h[c.k00 + c.dj + c.di] ?? 0;
  const top = h00 + (h10 - h00) * c.fx;
  const bottom = h01 + (h11 - h01) * c.fx;
  return top + (bottom - top) * c.fz;
}

/**
 * Slope at world point (x, z) as rise over run: the length of the gradient
 * of the same bilinear surface `heightAt` reads. 0.1 is a 10 percent grade.
 */
export function slopeAt(t: Terrain, x: number, z: number): number {
  const c = locate(t, x, z);
  const h = t.heights;
  const h00 = h[c.k00] ?? 0;
  const h10 = h[c.k00 + c.di] ?? 0;
  const h01 = h[c.k00 + c.dj] ?? 0;
  const h11 = h[c.k00 + c.dj + c.di] ?? 0;
  const dx = ((h10 - h00) * (1 - c.fz) + (h11 - h01) * c.fz) / t.spacing;
  const dz = ((h01 - h00) * (1 - c.fx) + (h11 - h10) * c.fx) / t.spacing;
  return Math.sqrt(dx * dx + dz * dz);
}

/** True where (x, z) is at or below the water surface. */
export function isWaterAt(t: Terrain, x: number, z: number): boolean {
  return heightAt(t, x, z) <= t.waterLevel;
}

/** Hash of every field of the terrain, as 16 hex digits. */
export function hashTerrain(t: Terrain): string {
  return hashState(t);
}
