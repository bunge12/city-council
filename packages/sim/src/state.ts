import type { Command } from "./commands";
import type { LogEntry } from "./log";
import { seedRng } from "./rng";
import { createRoadNetwork, type RoadNetwork } from "./roads/network";
import type { UndoRecord } from "./undo";

/**
 * Shape version of SimState. Any change to the shape bumps this and ships a
 * migration with a test (CLAUDE.md rule 11).
 */
export const SNAPSHOT_VERSION = 4;

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
  /**
   * Activity log: every applied command, oldest first. Capped at
   * LOG_LIVE_LIMIT entries; older ones leave live state a page at a time.
   */
  log: LogEntry[];
  /** How many entries have left live state. `log[0]` is entry `logOffset`. */
  logOffset: number;
  /** The road graph: road, rail and path nodes and segments. */
  roads: RoadNetwork;
  /**
   * Every player's undo records, oldest first, the players interleaved in
   * the order their commands applied. Replaced, never changed in place.
   */
  undo: UndoRecord[];
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
    log: [],
    logOffset: 0,
    roads: createRoadNetwork(),
    undo: [],
  };
}

/**
 * A deep copy of `state`. State holds only plain objects, arrays, typed
 * arrays and primitives (CLAUDE.md rule 7), so that is all this copies.
 */
export function cloneState(state: SimState): SimState {
  return cloneValue(state) as SimState;
}

function cloneValue(value: unknown): unknown {
  // slice() copies only the view, not spare capacity behind it.
  if (ArrayBuffer.isView(value)) return (value as Uint8Array).slice();
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child);
    return out;
  }
  return value;
}
