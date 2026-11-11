// Gradient noise on an integer lattice. Gradients are picked by an integer
// hash, and everything after that is add, subtract, multiply, divide and
// Math.floor, which IEEE 754 rounds the same way in every engine
// (CLAUDE.md rule 6). Lint bans the other Math functions in this folder.

/** Mixes a 32-bit seed with a salt into a new 32-bit seed. */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of a lattice point to an unsigned 32-bit integer. */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const DIAGONAL = Math.sqrt(0.5);
/** Eight unit gradients, picked per lattice point by its hash. */
const GRAD_X = [1, DIAGONAL, 0, -DIAGONAL, -1, -DIAGONAL, 0, DIAGONAL];
const GRAD_Z = [0, DIAGONAL, 1, DIAGONAL, 0, -DIAGONAL, -1, -DIAGONAL];

/** Dot product of a lattice point's gradient with the offset (dx, dz) from it. */
function corner(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  const g = hash2(ix, iz, seed) & 7;
  return (GRAD_X[g] ?? 0) * dx + (GRAD_Z[g] ?? 0) * dz;
}

/** Smoothstep, 3t^2 - 2t^3. */
export function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Quintic fade, 6t^5 - 15t^4 + 10t^3. Its second derivative is continuous
 * too, so slopes and hillshading show no creases along lattice lines.
 */
function fade5(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Each octave turns the lattice by the angle of a 3-4-5 triangle (about 37
// degrees) and shifts it, so the octaves' lattice lines never line up into
// visible seams. It is plain multiply and add, so every engine agrees.
const ROT_COS = 0.8;
const ROT_SIN = 0.6;
const OCTAVE_SHIFT = 37.29;

/**
 * Gradient (Perlin) noise at a point given in lattice units, shifted and
 * scaled into [0, 1] with 0.5 as its mean. Unlike value noise its slope is
 * not zero across lattice lines, so hills show no straight seams.
 */
export function gradientNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const dx = x - ix;
  const dz = z - iz;
  const fx = fade5(dx);
  const fz = fade5(dz);
  const a = corner(ix, iz, seed, dx, dz);
  const b = corner(ix + 1, iz, seed, dx - 1, dz);
  const c = corner(ix, iz + 1, seed, dx, dz - 1);
  const d = corner(ix + 1, iz + 1, seed, dx - 1, dz - 1);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  // With unit gradients the raw value lies within +-sqrt(1/2).
  return 0.5 + (top + (bottom - top) * fz) * DIAGONAL;
}

/**
 * Fractal sum of `octaves` layers of gradient noise, normalised to [0, 1].
 * Each layer doubles the frequency, turns and shifts the lattice, and
 * multiplies the amplitude by `gain`.
 */
export function fbm(x: number, z: number, seed: number, octaves: number, gain: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let px = x;
  let pz = z;
  for (let o = 0; o < octaves; o++) {
    sum += amp * gradientNoise(px, pz, mixSeed(seed, o + 1));
    norm += amp;
    amp *= gain;
    const nx = 2 * (px * ROT_COS - pz * ROT_SIN) + OCTAVE_SHIFT;
    pz = 2 * (px * ROT_SIN + pz * ROT_COS) + OCTAVE_SHIFT;
    px = nx;
  }
  return sum / norm;
}

/**
 * Ridged fractal noise in [0, 1]: each layer is folded at its midpoint and
 * squared, which gives sharp crests and wide valleys.
 */
export function ridged(x: number, z: number, seed: number, octaves: number, gain: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let px = x;
  let pz = z;
  for (let o = 0; o < octaves; o++) {
    const n = gradientNoise(px, pz, mixSeed(seed, o + 101));
    const fold = 2 * n - 1;
    const r = 1 - (fold < 0 ? -fold : fold);
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    const nx = 2 * (px * ROT_COS - pz * ROT_SIN) + OCTAVE_SHIFT;
    pz = 2 * (px * ROT_SIN + pz * ROT_COS) + OCTAVE_SHIFT;
    px = nx;
  }
  return sum / norm;
}
