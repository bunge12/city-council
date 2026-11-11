import { LOG_PAGE_SIZE, recordEntry } from "./log";
import { SPEEDS, type SimState, type Speed } from "./state";

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

/** Every command type the sim accepts, by name. */
export const COMMANDS: Readonly<Record<string, CommandDef>> = Object.freeze({
  NoOp,
  SetSpeed,
});

/** Checks a command against the current state without changing anything. */
export function validateCommand(state: SimState, command: Command): CommandResult {
  if (!Number.isSafeInteger(command.seq) || command.seq < 0) {
    return { ok: false, reason: "seq must be a non-negative integer" };
  }
  if (typeof command.playerId !== "string" || command.playerId === "") {
    return { ok: false, reason: "playerId is required" };
  }
  const def = Object.hasOwn(COMMANDS, command.type) ? COMMANDS[command.type] : undefined;
  if (!def) {
    return { ok: false, reason: `unknown command type "${String(command.type)}"` };
  }
  const reason = def.validate(state, command);
  return reason === null ? { ok: true } : { ok: false, reason };
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
 * not recorded.
 */
export function applyPending(state: SimState): void {
  const queue = state.pending;
  state.pending = [];
  for (const command of queue) {
    const def = COMMANDS[command.type];
    if (def && validateCommand(state, command).ok) {
      def.apply(state, command);
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
