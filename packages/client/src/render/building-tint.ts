// A building's colours (issue M2-12, PRD "Art direction"): one wall, one
// roof and one trim colour from its type's palette, picked by its id and
// nothing else. Two players, and the same player after a reload, see the
// same building in the same colours. Nothing here may draw a random number:
// Math.random would give every page its own street.
//
// Ids are reused, so a new building on an old id takes the old colours.

import type { Palette } from "../theme/theme";

/** A well-mixed 32-bit hash of a whole number, the same on every machine. */
export function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The wall, roof and trim colours of building `id`, as sRGB hex, from `palette`. */
export function tintFor(id: number, palette: Palette): { wall: number; roof: number; trim: number } {
  const h = hashId(id);
  // Each surface takes its pick from other bits, so the three do not move together.
  const wall = palette.wall[h % palette.wall.length] ?? 0;
  const roof = palette.roof[(h >>> 11) % palette.roof.length] ?? 0;
  const trim = palette.trim[(h >>> 21) % palette.trim.length] ?? 0;
  return { wall, roof, trim };
}

/** How many window styles a facade comes in, and how many glass seeds each: a building's look is one of `STYLES * SEEDS`. */
export const STYLES = 4;
export const SEEDS = 7;
/** Looks a building can have. A look fits in a byte beside the facade's kind (building-lod.ts, `mergeModels`). */
export const LOOKS = STYLES * SEEDS;

/**
 * Building `id`'s look (issue #137): the shape of its windows, `look %
 * STYLES`, and the seed its panes vary by and its glass tint is picked
 * with, `floor(look / STYLES)`. From the id alone, as its colours are, but
 * hashed apart from them, so a look does not go with a wall colour.
 */
export function lookFor(id: number): number {
  return hashId(id ^ 0x5bd1e995) % LOOKS;
}
