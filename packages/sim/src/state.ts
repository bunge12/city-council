import { BALANCE_STAMP } from "./balance-stamp";
import { createBuildings, type BuildingState } from "./buildings/buildings";
import type { Command } from "./commands";
import { createCentre, type CentreState } from "./landvalue/centre";
import { createDemand, type DemandState } from "./demand/demand";
import { createBudget, type BudgetState } from "./economy/budget";
import type { LogEntry } from "./log";
import { createPops, type PopState } from "./pops/pops";
import { createStats, type StatsState } from "./stats/stats";
import { seedRng } from "./rng";
import { placeConnections } from "./roads/connections";
import { createRoadNetwork, type RoadNetwork } from "./roads/network";
import { terrainOf } from "./terrain/cache";
import type { TravelLast } from "./travel-times";
import type { UndoRecord } from "./undo";
import { unzonedCells, type CellState } from "./zoning/cells";

/**
 * Shape version of SimState. Any change to the shape bumps this and ships a
 * migration with a test (CLAUDE.md rule 11).
 */
export const SNAPSHOT_VERSION = 32;

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
  /**
   * How many commands that read the cells (`readsCells` in commands.ts)
   * applied on this tick while the game ran. At `cellCommandsPerTick` the
   * rest wait for the next tick (M2 review, #147). In state, and reset when
   * the tick advances, so a replay, which applies a tick's log in one step,
   * agrees with a host that applied it over several paused steps.
   */
  cellReads: number;
  /**
   * Every building, in flat arrays by id (buildings/buildings.ts). Which
   * building stands on each cell is derived (buildings/where.ts).
   */
  buildings: BuildingState;
  /**
   * Every pop, in flat arrays by id, and the daily sweep's cursor
   * (pops/pops.ts, M3-03). Who lives and works where is derived
   * (pops/where.ts).
   */
  pops: PopState;
  /**
   * The city centre land value measures from, and when it is worked out
   * again (landvalue/land-value.ts, M3-13). Land value itself is derived.
   */
  centre: CentreState;
  /**
   * The running totals, the highest population, the yearly counts and the
   * monthly history (stats/stats.ts, M3-04). Adjusted where pops and
   * buildings change, never recounted in a tick.
   */
  stats: StatsState;
  /**
   * The tick from which the sim may read the travel times between zones. A
   * change of roads gives the table the ticks up to this one to be rebuilt
   * in (travel-times.ts). At or below `tick` when nothing is being rebuilt.
   */
  travelReadyAt: number;
  /**
   * The four demand bars and their parts (demand/demand.ts, M3-06),
   * recomputed from the running totals on each game day's first tick.
   */
  demand: DemandState;
  /**
   * Buildings redevelopment has replaced or cleared since the game day's
   * first tick (buildings/redevelop.ts, M3-14), held to `perDayMax` in
   * demand.json. Set to 0 on each day's first tick.
   */
  redevelopedToday: number;
  /**
   * The last whole travel-time table, held from a change of roads until the
   * rebuild it starts is ready, so job matching can read it meanwhile
   * (travel-times.ts, #313). Null at other times.
   */
  travelLast: TravelLast | null;
  /**
   * The treasury, the month's ledger and the month before's, the four tax
   * rates (economy/budget.ts, M4-02), and the five development charges
   * (M4-08). Only `moveMoney` writes the
   * treasury or the ledger. A new city starts with the starting grant on
   * the grants line.
   */
  budget: BudgetState;
  /**
   * Whole dollars each live log entry's command took from the treasury,
   * below zero for one that paid in: `logSpent[i]` belongs to `log[i]`, and
   * pages out with it (log.ts, M4-03). Beside the log and not in its
   * entries, since the log is the replay input and this is a result.
   */
  logSpent: number[];
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
    buildings: createBuildings(),
    // Last, where the version 15 migration puts it: the key order is the order a snapshot writes and the hash reads.
    cellReads: 0,
    // After it, where the version 16 migration puts it.
    pops: createPops(),
    // After the pops, where the version 17 migration puts it.
    centre: createCentre(),
    // After the centre, where the version 18 migration puts it.
    stats: createStats(),
    // After the statistics, where the version 19 migration puts it.
    travelReadyAt: 0,
    // After it, where the version 20 migration puts it.
    demand: createDemand(),
    redevelopedToday: 0,
    // After it, where the version 27 migration puts it.
    travelLast: null,
    // After it, where the version 30 migration puts it.
    budget: createBudget(),
    // After it, where the version 31 migration puts it.
    logSpent: [],
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
export function captureState(state: SimState, keep?: CaptureBuffers): SimState {
  // The spread keeps the keys in the order `state` has them, which is the
  // order a snapshot writes them in.
  const rest = cloneValue({ ...state, log: [], undo: [], logSpent: [] }, "", keep) as SimState;
  return { ...rest, log: state.log.slice(), undo: state.undo, logSpent: state.logSpent.slice() };
}

/**
 * Buffers a host keeps between captures (issue #158), so that a capture of
 * a large city copies its typed arrays into memory it already has instead
 * of making megabytes of garbage each autosave. One buffer per place in
 * the state, by its path. Not state: the sim never reads it.
 *
 * A capture made into these buffers is overwritten by the next one, so the
 * host must be done with it, its save written, before it captures again.
 */
export interface CaptureBuffers {
  readonly arrays: Map<string, ArrayBuffer>;
}

export function createCaptureBuffers(): CaptureBuffers {
  return { arrays: new Map() };
}

type TypedArrayConstructor = new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView & {
  set(source: ArrayLike<number>): void;
};

/** A copy of typed array `value` in the buffer `keep` holds for `path`, grown by a quarter when it is too small. */
function copyInto(value: ArrayBufferView, path: string, keep: CaptureBuffers): ArrayBufferView {
  const Type = value.constructor as TypedArrayConstructor;
  let buffer = keep.arrays.get(path);
  if (!buffer || buffer.byteLength < value.byteLength) {
    buffer = new ArrayBuffer(Math.ceil((value.byteLength * 1.25) / 8) * 8 + 64);
    keep.arrays.set(path, buffer);
  }
  const length = value.byteLength / ((value as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT);
  const copy = new Type(buffer, 0, length);
  copy.set(value as unknown as ArrayLike<number>);
  return copy;
}

function cloneValue(value: unknown, path = "", keep?: CaptureBuffers): unknown {
  if (ArrayBuffer.isView(value)) {
    if (keep && !(value instanceof DataView)) return copyInto(value, path, keep);
    // slice() copies only the view, not spare capacity behind it.
    return (value as Uint8Array).slice();
  }
  if (Array.isArray(value)) return value.map((item, i) => cloneValue(item, `${path}.${i}`, keep));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child, path === "" ? key : `${path}.${key}`, keep);
    return out;
  }
  return value;
}
