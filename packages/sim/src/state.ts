import { BALANCE_STAMP } from "./balance-stamp";
import type { Command } from "./commands";
import type { LogEntry } from "./log";
import { seedRng } from "./rng";
import { placeConnections } from "./roads/connections";
import { createRoadNetwork, type RoadNetwork } from "./roads/network";
import { terrainOf } from "./terrain/cache";
import type { UndoRecord } from "./undo";
import { unzonedCells, type CellState } from "./zoning/cells";

/**
 * Shape version of SimState. Any change to the shape bumps this and ships a
 * migration with a test (CLAUDE.md rule 11).
 */
export const SNAPSHOT_VERSION = 10;

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
  /**
   * The outside connections' edge nodes, in the order they were placed
   * (roads/connections.ts). Each has one fixed highway stub; the stub's
   * other end is where the player builds from. Never changes after the
   * city is created.
   */
  connections: Int32Array;
  /**
   * The stamp of the balance files the city was created under
   * (balance-stamp.ts). Never changes. Empty for a city saved before
   * version 8, whose balance is not known.
   */
  balance: string;
  /**
   * The zone and density of every zoning cell, laid out by segment
   * (zoning/cells.ts). Where each cell is and whether it is blocked are
   * derived (zoning/cell-index.ts). The step lays these out again after
   * every command that changes the roads.
   */
  cells: CellState;
  /**
   * The tick from which the sim may read which cells are blocked. A change
   * of roads too big to walk in one tick settles over the ticks up to this
   * one (zoning/cell-index.ts). At or below `tick` when nothing is settling.
   */
  cellsReadyAt: number;
}

/**
 * A new city from a 32-bit unsigned integer seed: no roads but its outside
 * connections, placed from the seed. Generates the terrain for the seed, if
 * it is not cached, to place them.
 */
export function createState(seed: number): SimState {
  const state = createBareState(seed);
  state.connections = placeConnections(state.roads, terrainOf(seed), seed);
  state.cells = unzonedCells(state.roads);
  return state;
}

/**
 * A city with no roads at all, not even its outside connections. No game
 * starts from one. For tests that need an empty network, and the base
 * `createState` builds on.
 */
export function createBareState(seed: number): SimState {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer from 0 to 2^32 - 1, got ${seed}`);
  }
  const roads = createRoadNetwork();
  return {
    version: SNAPSHOT_VERSION,
    tick: 0,
    seed,
    rng: seedRng(seed),
    speed: 1,
    pending: [],
    log: [],
    logOffset: 0,
    roads,
    undo: [],
    connections: new Int32Array(0),
    balance: BALANCE_STAMP,
    cells: unzonedCells(roads),
    cellsReadyAt: 0,
  };
}

/**
 * A deep copy of `state`. State holds only plain objects, arrays, typed
 * arrays and primitives (CLAUDE.md rule 7), so that is all this copies.
 */
export function cloneState(state: SimState): SimState {
  return cloneValue(state) as SimState;
}

/**
 * A copy of `state` to write a save from while the sim steps on, for the
 * cost of copying the typed arrays. Log entries and undo records are shared
 * with `state`, not copied: each is made once and never changed (log.ts,
 * undo.ts). Everything else is copied as `cloneState` copies it.
 */
export function captureState(state: SimState): SimState {
  // The spread keeps the keys in the order `state` has them, which is the
  // order a snapshot writes them in.
  const rest = cloneValue({ ...state, log: [], undo: [] }) as SimState;
  return { ...rest, log: state.log.slice(), undo: state.undo };
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
