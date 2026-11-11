import type { Command } from "./commands";
import { seedRng } from "./rng";

/**
 * Shape version of SimState. Any change to the shape bumps this and ships a
 * migration with a test (CLAUDE.md rule 11).
 */
export const SNAPSHOT_VERSION = 1;

/** Game speeds. The number is how many ticks run per 100 ms of real time. */
export const SPEEDS = [0, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * The whole city. Plain fields and typed arrays only, so it serialises at
 * every tick (CLAUDE.md rule 7).
 */
export interface SimState {
  /** Snapshot shape version. */
  version: number;
  /** Ticks advanced since the city was created. */
  tick: number;
  /** The 32-bit seed the city was created from. */
  seed: number;
  /** xoshiro128** state, advanced in place by the functions in rng.ts. */
  rng: Uint32Array;
  /** Current game speed: 0 is paused, otherwise 1x, 2x or 4x. */
  speed: Speed;
  /** Commands accepted by `submit`, applied in order at the next `step`. */
  pending: Command[];
}

/** A new city from a 32-bit unsigned integer seed. */
export function createState(seed: number): SimState {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer from 0 to 2^32 - 1, got ${seed}`);
  }
  return {
    version: SNAPSHOT_VERSION,
    tick: 0,
    seed,
    rng: seedRng(seed),
    speed: 1,
    pending: [],
  };
}
