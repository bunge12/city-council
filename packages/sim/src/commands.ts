import {
  buildGridOnOpenGround,
  bulldozeBuildings,
  chargeClears,
  planBulldozeBuildings,
  previewBuildRoad,
  previewBuildRoadGrid,
  previewBulldozeRoad,
  previewUpgradeRoad,
} from "./buildings/bulldoze";
import { moveMoney } from "./economy/budget";
import { keepBuildings } from "./buildings/upkeep";
import { LOG_PAGE_SIZE, logLength, recordEntry } from "./log";
import { buildRoad } from "./roads/build";
import { gridProblemReason, planRoadGrid } from "./roads/grid";
import { spendingRefusal } from "./economy/spend";
import { bulldozeRoad, upgradeRoad } from "./roads/edit";
import { endJournal, startJournal, type NetworkOp } from "./roads/network";
import { SPEEDS, type SimState, type Speed } from "./state";
import { terrainOf } from "./terrain/cache";
import { applyUndo, hasUndo, planUndo, recordUndo, undoLine, undoReadsCells } from "./undo";
import { ZONING_BALANCE } from "./zoning/balance";
import { endTravelWatch, startTravelWatch } from "./travel-times";
import { cellsSettled, stepCells } from "./zoning/cell-index";
import { checkZoneCells, checkZoneCellsPayload, strokeOf, zoneCellsIfValid } from "./zoning/zone";
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
 * road it took away for good and the money it moved. The cells are still
 * laid out for the roads before the command: the step lays them out again
 * after it.
 */
function recordRoadUndo(state: SimState, command: Command, ops: NetworkOp[], spent: number, took: number): void {
  const zones = journalLostZones(state.roads, state.cells, ops);
  recordUndo(state, { playerId: command.playerId, entry: logLength(state), type: command.type, ops, zones, spent, took });
}

/**
 * Applies a road command with the network's journal open, charges its
 * price on its ledger line (`undoLine`), and keeps what it wrote and what
 * it charged (`recordRoadUndo`). The price is the one its plan worked out,
 * the number the tools show, so the readout and the charge cannot
 * disagree (M4-03).
 *
 * A road command that clears buildings charges their compensation too,
 * from the same preview (M4-09), on the tick it applies and before the
 * road changes, while the buildings and their pops are as the preview saw
 * them, though a new road's buildings go only once the cells settle
 * (buildings/upkeep.ts). The record keeps how many buildings it took
 * (`took`), and undo refuses a command that took any: buildings never come
 * back, so neither does the road that took them.
 */
function undoable(state: SimState, command: Command, price: number, took: number, run: () => void): void {
  startJournal(state.roads);
  let built = false;
  try {
    run();
    built = true;
  } finally {
    recordRoadUndo(state, command, endJournal(state.roads), built ? price : 0, built ? took : 0);
  }
  // Only reached once the roads are built and their record kept.
  if (price !== 0) moveMoney(state, undoLine(command.type), price);
}

/**
 * A road from `payload.from` to `payload.to` of road type `payload.type`,
 * straight or, with `payload.control`, one quadratic curve through it. See
 * roads/build.ts for the checks. The terrain comes from the seed, so a
 * worker, a server and a replay check against the same ground. Its plan's
 * cost goes on the construction line and the compensation for the
 * buildings it clears on the compensation line, and it is refused when the
 * treasury cannot pay both (`previewBuildRoad`, economy/spend.ts).
 */
const BuildRoad: CommandDef = {
  validate: (state, command) => {
    const preview = previewBuildRoad(state, command.payload);
    return preview.ok ? preview.refusal : preview.reason;
  },
  apply: (state, command) => {
    const terrain = terrainOf(state.seed);
    const preview = previewBuildRoad(state, command.payload);
    if (!preview.ok) return;
    chargeClears(state, command.playerId, preview.clears);
    undoable(state, command, preview.plan.cost, preview.clears.ids.length, () => buildRoad(state.roads, terrain, preview.plan));
  },
};

/**
 * A whole street grid: the rectangle from `payload.origin` along to
 * `payload.along` and across to `payload.across`, blocks `payload.depth` by
 * `payload.width` metres between road edges, of road type `payload.type`.
 * See roads/grid.ts. A grid is built whole or refused whole, with the
 * street the refusal came from. It never demolishes: one whose streets
 * would cover a building's ground is refused, so it is drawn on open ground
 * and may cross or join streets only where no building stands (M4-09). Its
 * price, its cost alone, is checked first, before any street.
 */
const BuildRoadGrid: CommandDef = {
  validate: (state, command) => {
    const preview = previewBuildRoadGrid(state, command.payload);
    if (!preview.ok) return preview.reason;
    if (preview.problem !== null) return gridProblemReason(preview.plan, preview.problem);
    return preview.refusal;
  },
  apply: (state, command) => void buildGrid(state, command),
  // The step builds the grid once with the journal open, and takes it back
  // if a street is refused or it would clear a building, rather than
  // running `validate`'s rehearsal and building it again.
  applyIfValid: (state, command) => buildGrid(state, command),
};

/** Checks, builds and charges a `BuildRoadGrid` in one build: null once applied, or the reason, with the network as it was. */
function buildGrid(state: SimState, command: Command): string | null {
  const result = planRoadGrid(state.roads, terrainOf(state.seed), command.payload);
  if (!result.ok) return result.reason;
  const price = result.plan.cost;
  const refusal = spendingRefusal(state, price);
  if (refusal !== null) return refusal;
  const built = buildGridOnOpenGround(state, result.plan);
  if (!built.ok) return built.reason;
  if (price !== 0) moveMoney(state, undoLine(command.type), price);
  recordRoadUndo(state, command, built.ops, price, 0);
  return null;
}

/**
 * Removes the segments in `payload.segments`, or the stretch of each that
 * `payload.sections` names, and every node they leave with no segments.
 * See roads/edit.ts. Its plan's demolition less its refund goes on the
 * demolition line; a bulldoze whose refund is the larger pays in. The
 * buildings on the road's cells go with it, at their compensation.
 */
const BulldozeRoad: CommandDef = {
  validate: (state, command) => {
    const preview = previewBulldozeRoad(state, command.payload);
    return preview.ok ? preview.refusal : preview.reason;
  },
  apply: (state, command) => {
    const preview = previewBulldozeRoad(state, command.payload);
    if (!preview.ok) return;
    chargeClears(state, command.playerId, preview.clears);
    undoable(state, command, preview.plan.cost, preview.clears.ids.length, () => bulldozeRoad(state.roads, terrainOf(state.seed), preview.plan));
  },
};

/**
 * Changes the segments in `payload.segments` to road type `payload.type` in
 * place, or reverses one-ways given their own type. See roads/edit.ts. Its
 * plan's cost goes on the construction line, and the compensation for the
 * buildings a wider road takes on the compensation line.
 */
const UpgradeRoad: CommandDef = {
  validate: (state, command) => {
    const preview = previewUpgradeRoad(state, command.payload);
    return preview.ok ? preview.refusal : preview.reason;
  },
  apply: (state, command) => {
    const terrain = terrainOf(state.seed);
    const preview = previewUpgradeRoad(state, command.payload);
    if (!preview.ok) return;
    chargeClears(state, command.playerId, preview.clears);
    undoable(state, command, preview.plan.cost, preview.clears.ids.length, () => upgradeRoad(state.roads, terrain, preview.plan));
  },
};

/**
 * Takes back the sender's newest road or zoning command that has not been
 * undone, and the money it moved. It carries no target, so the payload is
 * ignored. See undo.ts.
 */
const Undo: CommandDef = {
  validate: (state, command) => {
    // A command the step will hold is checked in full when it applies.
    if (waitsForCells(state, command)) return hasUndo(state, command.playerId) ? null : "Nothing to undo";
    const result = planUndo(state, command.playerId);
    return result.ok ? null : result.reason;
  },
  apply: (state, command) => {
    const result = planUndo(state, command.playerId);
    if (result.ok) applyUndo(state, result.indices);
  },
  // Checking an undo that puts roads back costs about what applying it
  // does, so the step plans it once.
  applyIfValid: (state, command) => {
    const result = planUndo(state, command.playerId);
    if (!result.ok) return result.reason;
    applyUndo(state, result.indices);
    return null;
  },
};

/**
 * Paints zone `payload.zone` at density `payload.density` on every open
 * cell whose centre lies in one of `payload.rects`, or clears them when the
 * zone is "none". Free and instant, and it leaves whatever stands on the
 * cells alone (PRD, "Rezoning"). See zoning/zone.ts. Its undo record holds
 * what each cell held before (zoning/zone-undo.ts). Never refused for
 * money: a city past its overdraft can still zone, and recovers by growing
 * (M4-03).
 */
const ZoneCells: CommandDef = {
  validate: (state, command) => {
    // A command the step will hold is checked in full when it applies.
    // Checking the cells now would walk the rest of the change in one go.
    if (waitsForCells(state, command)) return checkZoneCellsPayload(command.payload);
    return checkZoneCells(state, command.payload);
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
    // Free, so it moved nothing. Last, where the version 31 migration puts it.
    const record = { playerId: command.playerId, entry: logLength(state), type: command.type, ops: [], zones, painted };
    recordUndo(state, stroke === undefined ? { ...record, spent: 0, took: 0 } : { ...record, stroke, spent: 0, took: 0 });
  }
  return reason;
}

/**
 * Clears the buildings in `payload.buildings`, each named by its id and its
 * lot's first cell as the player saw them, and refuses the whole command if
 * any changed since. See buildings/bulldoze.ts. Charged at the eminent
 * domain price on the compensation line, and refused when the treasury
 * cannot pay it (M4-09). No undo record: the grower owns buildings, and
 * undo never brings one back.
 */
const BulldozeBuilding: CommandDef = {
  validate: (state, command) => {
    const result = planBulldozeBuildings(state, command.payload);
    return result.ok ? result.refusal : result.reason;
  },
  apply: (state, command) => void clearBuildings(state, command),
  // Checking 1,000 buildings costs as much as clearing them, so the step does it once (issue #162).
  applyIfValid: (state, command) => clearBuildings(state, command),
};

/** Checks, charges and clears a `BulldozeBuilding` in one pass: null once applied, or the reason, with state as it was. */
function clearBuildings(state: SimState, command: Command): string | null {
  const result = planBulldozeBuildings(state, command.payload);
  if (!result.ok) return result.reason;
  if (result.refusal !== null) return result.refusal;
  chargeClears(state, command.playerId, result);
  bulldozeBuildings(state, result.ids);
  return null;
}

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

/**
 * The definition of a command's type, or why the command is malformed
 * whatever the state. `checkPayload` false skips proving the payload is
 * plain JSON, for a queued command: `enqueue` made its payload by a JSON
 * round trip, and a save's queue decodes to a plain tree. The proof writes
 * the whole payload out, 2 ms for a `BulldozeBuilding` at its cap, which
 * the step need not pay again (issue #162).
 */
function commandDef(command: Command, checkPayload = true): CommandDef | string {
  if (!Number.isSafeInteger(command.seq) || command.seq < 0) return "seq must be a non-negative integer";
  if (typeof command.playerId !== "string" || command.playerId === "") return "playerId is required";
  // A host passes on whatever a port or socket delivered, so `type` may be
  // anything. Without this check a one-item array such as ["NoOp"] would be
  // looked up as "NoOp", applied and logged with a type no save can load.
  if (typeof command.type !== "string") return "type must be a string";
  const def = Object.hasOwn(COMMANDS, command.type) ? COMMANDS[command.type] : undefined;
  if (!def) return `unknown command type "${command.type}"`;
  if (checkPayload && !isJsonSafe(command.payload)) return "payload must be plain JSON data";
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
 * building reads its lot's columns. An `Undo` whose record puts roads back
 * reads what ground they would take, and waits too; any other undo does
 * not.
 */
const CELL_READERS: ReadonlySet<string> = new Set(["ZoneCells", "BulldozeBuilding"]);

/**
 * Commands that wait behind their sender's waiting command, so they keep
 * their order with it: a stroke after a stroke, a clear after a clear, and
 * an undo, which must take back the stroke the player just made and not the
 * change before it. Anything else goes on: a road command, since a stroke
 * names ground and paints whatever roads it finds when it applies, as it
 * would after another player's road, and `SetSpeed` and `NoOp`, so a player
 * can still pause. A backlog is then strokes, clears and undos, which apply
 * at most `cellCommandsPerTick` a tick, and not road commands piled up
 * behind them, which would all apply in one step (M2 review, #147).
 */
const WAIT_BEHIND: ReadonlySet<string> = new Set(["ZoneCells", "BulldozeBuilding", "Undo"]);

/**
 * Whether the step holds `command` until the cells settle on
 * `state.cellsReadyAt`, with its sender's later strokes, clears and undos
 * (`WAIT_BEHIND`). Other players' commands go on, so one player's stroke
 * holds up no one else. From state alone, so a
 * replay applies it on the tick it was logged. A paused game has no tick to
 * wait for and applies it at once, walking whatever is left: nothing moves
 * while paused, so the walk holds nothing up.
 */
export function waitsForCells(state: SimState, command: Pick<Command, "type" | "playerId">): boolean {
  if (state.speed === 0 || cellsSettled(state)) return false;
  return readsCells(state, command);
}

/**
 * Whether `command` reads which cells are open: a stroke, a clear of
 * buildings, or an undo that puts roads back. One step applies at most
 * `cellCommandsPerTick` of them, so a backlog that built up while a change
 * settled lands over several steps, not in one.
 */
function readsCells(state: SimState, command: Pick<Command, "type" | "playerId">): boolean {
  return CELL_READERS.has(command.type) || (command.type === "Undo" && undoReadsCells(state, command.playerId));
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
 * waits for it, and its sender's later strokes, clears and undos wait too,
 * in order (`waitsForCells`): they stay queued for a later step. The buildings follow each time
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
  // Players with a command waiting for the cells, whose later commands wait behind it.
  const waiting = new Set<string>();
  const held: Command[] = [];
  for (const command of queue) {
    // Past `cellCommandsPerTick` cell readers this tick, the rest wait for the next. Not while paused.
    const reads = readsCells(state, command);
    const counted = reads && state.speed !== 0;
    const full = counted && state.cellReads >= ZONING_BALANCE.cellCommandsPerTick;
    if ((waiting.has(command.playerId) && WAIT_BEHIND.has(command.type)) || full || waitsForCells(state, command)) {
      waiting.add(command.playerId);
      held.push(command);
      continue;
    }
    const def = commandDef(command, false);
    const treasury = state.budget.treasury;
    startTravelWatch(state);
    let reason: string | null;
    if (typeof def === "string") reason = def;
    else if (def.applyIfValid) reason = def.applyIfValid(state, command);
    else {
      reason = def.validate(state, command);
      if (reason === null) def.apply(state, command);
    }
    endTravelWatch(state, reason === null);
    if (reason !== null) {
      dropped.push({ seq: command.seq, playerId: command.playerId, type: command.type, reason });
    } else {
      // Counted once applied, so a replay, which never sees a dropped command, counts the same.
      if (counted) state.cellReads++;
      stepCells(state);
      keepBuildings(state);
      // Everything the command moved, the compensation for the buildings it took included (M4-09), so the log can name who spent it.
      recordEntry(
        state,
        { tick: state.tick, seq: command.seq, playerId: command.playerId, type: command.type, payload: command.payload },
        treasury - state.budget.treasury,
      );
    }
  }
  state.pending = held;
  return dropped;
}
