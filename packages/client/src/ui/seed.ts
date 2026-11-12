// Seeds for new cities, as the city menu takes them.

const MAX_SEED = 0xffffffff;

/** A random 32-bit seed. The page's own randomness; the sim only sees the number. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
}

/** The seed typed in the box, or null if it is not a whole number from 0 to 2^32 - 1. */
export function parseSeed(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seed = Number(trimmed);
  return Number.isSafeInteger(seed) && seed <= MAX_SEED ? seed : null;
}
