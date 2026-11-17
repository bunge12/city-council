import { bulldozeBuildings, planBulldozeBuildings } from "./buildings/bulldoze";
import { keepBuildings } from "./buildings/upkeep";
import { LOG_PAGE_SIZE, logLength, recordEntry } from "./log";
import { buildRoad, planRoad } from "./roads/build";
import { buildRoadGrid, checkRoadGrid, gridProblemReason, planRoadGrid, type GridProblem } from "./roads/grid";
import { bulldozeRoad, planBulldoze, planUpgrade, upgradeRoad } from "./roads/edit";
import { endJournal, reverseOps, startJournal, type NetworkOp } from "./roads/network";
import { SPEEDS, type SimState, type Speed } from "./state";
import { terrainOf } from "./terrain/cache";
import { applyUndo, planUndo, recordUndo } from "./undo";
import { cellsSettled, stepCells } from "./zoning/cell-index";
import { checkZoneCellsPayload, planZoneCells, strokeOf, zoneCellsIfValid } from "./zoning/zone";
import { NO_JOURNALS, journalLostZones, journalPaint } from "./zoning/zone-undo";

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

/**
 * A command `submit` accepted that the step then refused, because an
 * earlier command in the same tick made it invalid. Not recorded in the
 * log, so this is the only word the sender gets (issue 94).
 */
export interface DroppedCommand {
  seq: number;
  playerId: string;
  type: string;
  reason: string;
}

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
 * Keeps a road command's journal as the sender's newest undo record, tied
 * to the log entry the command is about to get, with the zoning of any
 * road it took away for good. The cells are still laid out for the roads
 * before the command: the step lays them out again after it.
 */
function recordRoadUndo(state: SimState, command: Command, ops: NetworkOp[]): void {
  const zones = journalLostZones(state.roads, state.cells, ops);
  recordUndo(state, { playerId: command.playerId, entry: logLength(state), type: command.type, ops, zones });
}

/** Applies a road command with the network's journal open, and keeps what it wrote (`recordRoadUndo`). */
function undoable(state: SimState, command: Command, run: () => void): void {
  startJournal(state.roads);
  try {
    run();
  } finally {
    recordRoadUndo(state, command, endJournal(state.roads));
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
    recordRoadUndo(state, command, ops);
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
 * Takes back the sender's newest road or zoning command that has not been undone. It
 * carries no target, so the payload is ignored. See undo.ts.
 */
const Undo: CommandDef = {
  validate: (state, command) => {
    const result = planUndo(state, command.playerId);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planUndo(state, command.playerId);
    if (result.ok) applyUndo(state, result.indices);
  },
};

/**
 * Paints zone `payload.zone` at density `payload.density` on every open
 * cell whose centre lies in one of `payload.rects`, or clears them when the
 * zone is "none". Free and instant, and it leaves whatever stands on the
 * cells alone (PRD, "Rezoning"). See zoning/zone.ts. Its undo record holds
 * what each cell held before (zoning/zone-undo.ts).
 */
const ZoneCells: CommandDef = {
  validate: (state, command) => {
    // A command the step will hold is checked in full when it applies.
    // Checking the cells now would walk the rest of the change in one go.
    if (waitsForCells(state, command)) return checkZoneCellsPayload(command.payload);
    const result = planZoneCells(state, command.payload);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => void zoneCells(state, command),
  // Finding the cells is the whole cost, so the step does it once.
  applyIfValid: (state, command) => zoneCells(state, command),
};

/** Paints as `zoneCellsIfValid` does and keeps the sender's undo record. */
function zoneCells(state: SimState, command: Command): string | null {
  let zones: Int32Array = NO_JOURNALS;
  let painted = { zone: 0, density: 0 };
  const reason = zoneCellsIfValid(state, command.payload, (slots, zone, density) => {
    zones = journalPaint(state.roads, state.cells, slots);
    painted = { zone, density };
  });
  if (reason === null) {
    const stroke = strokeOf(command.payload);
    const record = { playerId: command.playerId, entry: logLength(state), type: command.type, ops: [], zones, painted };
    recordUndo(state, stroke === undefined ? record : { ...record, stroke });
  }
  return reason;
}

/**
 * Clears the buildings in `payload.buildings`, each named by its id and its
 * lot's first cell as the player saw them, and refuses the whole command if
 * any changed since. See buildings/bulldoze.ts. Free until M4. No undo
 * record: the grower owns buildings, and undo never brings one back.
 */
const BulldozeBuilding: CommandDef = {
  validate: (state, command) => {
    const result = planBulldozeBuildings(state, command.payload);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planBulldozeBuildings(state, command.payload);
    if (result.ok) bulldozeBuildings(state, result.ids);
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
  ZoneCells,
  BulldozeBuilding,
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
 * Commands that read which cells are open, and so would walk the whole of a
 * change of roads still settling in one go, far past the tick budget (M2
 * review, #147): painting zoning reads the open cells, and clearing a
 * building reads its lot's columns.
 */
const CELL_READERS: ReadonlySet<string> = new Set(["ZoneCells", "BulldozeBuilding"]);

/**
 * Whether the step holds `command`, with every command queued behind it,
 * until the cells settle on `state.cellsReadyAt`. From state alone, so a
 * replay applies it on the tick it was logged. A paused game has no tick to
 * wait for and applies it at once, walking whatever is left: nothing moves
 * while paused, so the walk holds nothing up.
 */
export function waitsForCells(state: SimState, command: Pick<Command, "type">): boolean {
  return CELL_READERS.has(command.type) && state.speed !== 0 && !cellsSettled(state);
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
 * command in the same tick may have made it invalid. Those are dropped, not
 * recorded, and returned with the reason, so the host can tell their
 * senders. A command with `applyIfValid` is checked and applied in one
 * pass.
 *
 * The zoning cells are brought up to date with the roads before the first
 * command and after each one (zoning/cell-index.ts), so the cells of a
 * removed road are read before it goes. A big change settles over the next
 * few ticks (`stepCells`). A command that reads the cells while one does
 * waits for it, and the commands behind it wait too, in order
 * (`waitsForCells`): they stay queued for a later step. The buildings follow each time
 * (buildings/upkeep.ts): the ones whose ground went are removed on the
 * command's tick, and the ones a new road blocks once the cells settle.
 */
export function applyPending(state: SimState): DroppedCommand[] {
  const queue = state.pending;
  state.pending = [];
  const dropped: DroppedCommand[] = [];
  if (queue.length > 0) {
    stepCells(state);
    keepBuildings(state);
  }
  for (let at = 0; at < queue.length; at++) {
    const command = queue[at] as Command;
    if (waitsForCells(state, command)) {
      state.pending = queue.slice(at);
      break;
    }
    const def = commandDef(command);
    let reason: string | null;
    if (typeof def === "string") reason = def;
    else if (def.applyIfValid) reason = def.applyIfValid(state, command);
    else {
      reason = def.validate(state, command);
      if (reason === null) def.apply(state, command);
    }
    if (reason !== null) {
      dropped.push({ seq: command.seq, playerId: command.playerId, type: command.type, reason });
    } else {
      stepCells(state);
      keepBuildings(state);
      recordEntry(state, {
        tick: state.tick,
        seq: command.seq,
        playerId: command.playerId,
        type: command.type,
        payload: command.payload,
      });
    }
  }
  return dropped;
}
