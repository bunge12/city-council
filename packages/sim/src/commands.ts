import { LOG_PAGE_SIZE, logLength, recordEntry } from "./log";
import { buildRoad, planRoad } from "./roads/build";
import { buildRoadGrid, checkRoadGrid, gridProblemReason, planRoadGrid, type GridProblem } from "./roads/grid";
import { bulldozeRoad, planBulldoze, planUpgrade, upgradeRoad } from "./roads/edit";
import { endJournal, reverseOps, startJournal, type NetworkOp } from "./roads/network";
import { SPEEDS, type SimState, type Speed } from "./state";
import { terrainOf } from "./terrain/cache";
import { applyUndo, planUndo, recordUndo } from "./undo";

/**
 * A request to change the city. `payload` is plain JSON data, so a command
 * can cross a worker or socket boundary and be recorded as is.
 */
export interface Command {
  /** Sequence number assigned by the sender. */
  seq: number;
  /** Who sent it. Every command carries one (CLAUDE.md rule 2). */
  playerId: string;
  type: string;
  payload: unknown;
}

/** Outcome of validating or submitting a command. */
export type CommandResult = { ok: true } | { ok: false; reason: string };

export interface CommandDef {
  /** Returns null when the command is valid, or the reason it is not. */
  validate(state: SimState, command: Command): string | null;
  /** Changes state. Only called after `validate` returned null. */
  apply(state: SimState, command: Command): void;
  /**
   * Optional. Checks and applies in one pass, for a command whose check
   * costs as much as applying it: returns null once applied, or the reason
   * and leaves state exactly as it was. When present, the step calls this
   * instead of `validate` and then `apply`. It must refuse exactly what
   * `validate` refuses.
   */
  applyIfValid?(state: SimState, command: Command): string | null;
}

const NoOp: CommandDef = {
  validate: () => null,
  apply: () => undefined,
};

function speedOf(payload: unknown): Speed | null {
  if (typeof payload !== "object" || payload === null) return null;
  const speed = (payload as { speed?: unknown }).speed;
  return (SPEEDS as readonly unknown[]).includes(speed) ? (speed as Speed) : null;
}

const SetSpeed: CommandDef = {
  validate: (_state, command) =>
    speedOf(command.payload) === null
      ? `SetSpeed payload.speed must be one of ${SPEEDS.join(", ")}`
      : null,
  apply: (state, command) => {
    const speed = speedOf(command.payload);
    if (speed !== null) state.speed = speed;
  },
};

/**
 * Applies a road command with the network's journal open, and keeps what it
 * wrote as the sender's newest undo record, tied to the log entry the
 * command is about to get.
 */
function undoable(state: SimState, command: Command, run: () => void): void {
  startJournal(state.roads);
  try {
    run();
  } finally {
    const ops = endJournal(state.roads);
    recordUndo(state, { playerId: command.playerId, entry: logLength(state), type: command.type, ops });
  }
}

/**
 * A road from `payload.from` to `payload.to` of road type `payload.type`,
 * straight or, with `payload.control`, one quadratic curve through it. See roads/build.ts for the checks. The terrain comes from
 * the seed, so a worker, a server and a replay check against the same ground.
 */
const BuildRoad: CommandDef = {
  validate: (state, command) => {
    const result = planRoad(state.roads, terrainOf(state.seed), command.payload);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const terrain = terrainOf(state.seed);
    const result = planRoad(state.roads, terrain, command.payload);
    if (result.ok) undoable(state, command, () => buildRoad(state.roads, terrain, result.plan));
  },
};

/**
 * A whole street grid: the rectangle from `payload.origin` along to
 * `payload.along` and across to `payload.across`, blocks `payload.depth` by
 * `payload.width` metres between road edges, of road type `payload.type`.
 * See roads/grid.ts. Validation rehearses the whole grid on the network and
 * takes it back, so a grid is built whole or refused whole, with the street
 * the refusal came from.
 */
const BuildRoadGrid: CommandDef = {
  validate: (state, command) => {
    const terrain = terrainOf(state.seed);
    const result = planRoadGrid(state.roads, terrain, command.payload);
    if (!result.ok) return result.reason;
    const problem = checkRoadGrid(state.roads, terrain, result.plan);
    return problem === null ? null : gridProblemReason(result.plan, problem);
  },
  apply: (state, command) => {
    const terrain = terrainOf(state.seed);
    const result = planRoadGrid(state.roads, terrain, command.payload);
    if (result.ok) undoable(state, command, () => buildRoadGrid(state.roads, terrain, result.plan));
  },
  // The step builds the grid once with the journal open, and takes it back
  // if a street is refused, rather than rehearsing it and building it again.
  applyIfValid: (state, command) => {
    const terrain = terrainOf(state.seed);
    const result = planRoadGrid(state.roads, terrain, command.payload);
    if (!result.ok) return result.reason;
    startJournal(state.roads);
    let problem: GridProblem | null = null;
    let ops: NetworkOp[];
    try {
      problem = buildRoadGrid(state.roads, terrain, result.plan);
    } finally {
      ops = endJournal(state.roads);
      if (problem !== null) reverseOps(state.roads, ops);
    }
    if (problem !== null) return gridProblemReason(result.plan, problem);
    recordUndo(state, { playerId: command.playerId, entry: logLength(state), type: command.type, ops });
    return null;
  },
};

/**
 * Removes the segments in `payload.segments`, and every node they leave with
 * no segments. See roads/edit.ts.
 */
const BulldozeRoad: CommandDef = {
  validate: (state, command) => {
    const result = planBulldoze(state.roads, command.payload);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planBulldoze(state.roads, command.payload);
    if (result.ok) undoable(state, command, () => bulldozeRoad(state.roads, result.plan));
  },
};

/**
 * Changes the segments in `payload.segments` to road type `payload.type` in
 * place, or reverses one-ways given their own type. See roads/edit.ts.
 */
const UpgradeRoad: CommandDef = {
  validate: (state, command) => {
    const result = planUpgrade(state.roads, terrainOf(state.seed), command.payload);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planUpgrade(state.roads, terrainOf(state.seed), command.payload);
    if (result.ok) undoable(state, command, () => upgradeRoad(state.roads, result.plan));
  },
};

/**
 * Takes back the sender's newest road command that has not been undone. It
 * carries no target, so the payload is ignored. See undo.ts.
 */
const Undo: CommandDef = {
  validate: (state, command) => {
    const result = planUndo(state, command.playerId);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planUndo(state, command.playerId);
    if (result.ok) applyUndo(state, result.index);
  },
};

/** Every command type the sim accepts, by name. */
export const COMMANDS: Readonly<Record<string, CommandDef>> = Object.freeze({
  NoOp,
  SetSpeed,
  BuildRoad,
  BuildRoadGrid,
  BulldozeRoad,
  UpgradeRoad,
  Undo,
});

/** Checks a command against the current state without changing anything. */
export function validateCommand(state: SimState, command: Command): CommandResult {
  const def = commandDef(command);
  if (typeof def === "string") return { ok: false, reason: def };
  const reason = def.validate(state, command);
  return reason === null ? { ok: true } : { ok: false, reason };
}

/** The definition of a command's type, or why the command is malformed whatever the state. */
function commandDef(command: Command): CommandDef | string {
  if (!Number.isSafeInteger(command.seq) || command.seq < 0) return "seq must be a non-negative integer";
  if (typeof command.playerId !== "string" || command.playerId === "") return "playerId is required";
  // A host passes on whatever a port or socket delivered, so `type` may be
  // anything. Without this check a one-item array such as ["NoOp"] would be
  // looked up as "NoOp", applied and logged with a type no save can load.
  if (typeof command.type !== "string") return "type must be a string";
  const def = Object.hasOwn(COMMANDS, command.type) ? COMMANDS[command.type] : undefined;
  if (!def) return `unknown command type "${command.type}"`;
  if (!isJsonSafe(command.payload)) return "payload must be plain JSON data";
  return def;
}

/**
 * Whether `copyPayload` can copy the payload. A worker port can deliver a
 * BigInt or an object that contains itself, and JSON refuses both by
 * throwing, which would leave the sender without an answer.
 */
function isJsonSafe(payload: unknown): boolean {
  try {
    JSON.stringify(payload);
    return true;
  } catch {
    return false;
  }
}

// A JSON round trip, so the queued payload is plain data the sender can no
// longer change, and it records and replays exactly as it was applied.
function copyPayload(payload: unknown): unknown {
  return payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
}

/**
 * Most commands the queue holds before `submit` refuses more. One step must
 * not apply more than a log page, or entries would leave live state before
 * the host reads them after that step.
 */
export const MAX_PENDING_COMMANDS = LOG_PAGE_SIZE;

/**
 * Validates a command and queues it to apply at the next `step`. The only
 * way to change city state from outside the sim.
 */
export function submit(state: SimState, command: Command): CommandResult {
  if (state.pending.length >= MAX_PENDING_COMMANDS) {
    return { ok: false, reason: `too many commands this tick, at most ${MAX_PENDING_COMMANDS}` };
  }
  const result = validateCommand(state, command);
  if (result.ok) enqueue(state, command);
  return result;
}

/**
 * Queues a command without checking it. Internal to the sim: replay uses it
 * for log entries, which `applyPending` checks again anyway.
 */
export function enqueue(state: SimState, command: Command): void {
  state.pending.push({
    seq: command.seq,
    playerId: command.playerId,
    type: command.type,
    payload: copyPayload(command.payload),
  });
}

/**
 * Applies queued commands in the order they were submitted and records each
 * one in the activity log. Each is checked again first, because an earlier
 * command in the same tick may have made it invalid. Those are dropped and
 * not recorded. A command with `applyIfValid` is checked and applied in one
 * pass.
 */
export function applyPending(state: SimState): void {
  const queue = state.pending;
  state.pending = [];
  for (const command of queue) {
    const def = commandDef(command);
    if (typeof def === "string") continue;
    let applied: boolean;
    if (def.applyIfValid) applied = def.applyIfValid(state, command) === null;
    else {
      applied = def.validate(state, command) === null;
      if (applied) def.apply(state, command);
    }
    if (applied) {
      recordEntry(state, {
        tick: state.tick,
        seq: command.seq,
        playerId: command.playerId,
        type: command.type,
        payload: command.payload,
      });
    }
  }
}
