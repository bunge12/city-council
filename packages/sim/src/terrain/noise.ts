// Value noise on an integer lattice. Lattice values come from an integer hash,
// and everything after that is add, subtract, multiply, divide and
// Math.floor, which IEEE 754 rounds the same way in every engine
// (CLAUDE.md rule 6). Lint bans the other Math functions in this folder.

const TWO_POW_32 = 4294967296;

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

function lattice(ix: number, iz: number, seed: number): number {
  return hash2(ix, iz, seed) / TWO_POW_32;
}

/** Smoothstep, 3t^2 - 2t^3. */
export function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1) at a point given in lattice units. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const a = lattice(ix, iz, seed);
  const b = lattice(ix + 1, iz, seed);
  const c = lattice(ix, iz + 1, seed);
  const d = lattice(ix + 1, iz + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fz;
}

/**
 * Fractal sum of `octaves` layers of value noise, normalised to [0, 1).
 * Each layer doubles the frequency and multiplies the amplitude by `gain`.
 */
export function fbm(x: number, z: number, seed: number, octaves: number, gain: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq, mixSeed(seed, o + 1));
    norm += amp;
    amp *= gain;
    freq *= 2;
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
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(x * freq, z * freq, mixSeed(seed, o + 101));
    const fold = 2 * n - 1;
    const r = 1 - (fold < 0 ? -fold : fold);
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}
