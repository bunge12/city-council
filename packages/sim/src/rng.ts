// Seeded 32-bit generator: xoshiro128** (Blackman and Vigna), seeded with
// splitmix32. The four state words live in a Uint32Array inside SimState, so
// the generator is plain data and survives a snapshot. Only integer
// operations and one exact division are used (CLAUDE.md rules 4 and 6).

/** Number of 32-bit words of generator state. */
export const RNG_WORDS = 4;

const TWO_POW_32 = 4294967296;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Fills a fresh generator state from a 32-bit seed. */
export function seedRng(seed: number): Uint32Array {
  const rng = new Uint32Array(RNG_WORDS);
  let s = seed >>> 0;
  for (let i = 0; i < RNG_WORDS; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    rng[i] = z ^ (z >>> 16);
  }
  // xoshiro must never hold all zeros. splitmix32 cannot produce four zero
  // words in a row, but guard anyway so the generator can never stall.
  if (rng.every((word) => word === 0)) rng[0] = 1;
  return rng;
}

/** Next unsigned 32-bit integer. Advances `rng` in place. */
export function nextU32(rng: Uint32Array): number {
  const s0 = rng[0] ?? 0;
  const s1 = rng[1] ?? 0;
  const s2 = rng[2] ?? 0;
  const s3 = rng[3] ?? 0;
  const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
  const t = s1 << 9;
  const n2 = s2 ^ s0;
  const n3 = s3 ^ s1;
  rng[1] = s1 ^ n2;
  rng[0] = s0 ^ n3;
  rng[2] = n2 ^ t;
  rng[3] = rotl(n3, 11);
  return result;
}

/** Next float in [0, 1). Exact: a 32-bit integer divided by 2^32. */
export function nextFloat(rng: Uint32Array): number {
  return nextU32(rng) / TWO_POW_32;
}

/** Next integer in [0, n) for a positive integer n up to 2^32. */
export function nextInt(rng: Uint32Array, n: number): number {
  return Math.floor(nextFloat(rng) * n);
}
