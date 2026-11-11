// The messages between a sim host and a client. Today the host is a Web
// Worker; with multiplayer it becomes a server and these same shapes go over
// a WebSocket. Keep them plain JSON data plus typed arrays, and bump
// PROTOCOL_VERSION on any change to a shape.

import type { Command, CommandResult } from "./commands";
import type { LogEntry } from "./log";
import type { SimState, Speed } from "./state";

/** Version of the message shapes below. Every message carries it as `v`. */
export const PROTOCOL_VERSION = 1;

// ---- Client to sim ----

/** Asks the sim to validate and queue a command. */
export interface CommandMessage {
  v: typeof PROTOCOL_VERSION;
  type: "command";
  command: Command;
}

/** Asks for a full copy of the current state. */
export interface RequestSnapshotMessage {
  v: typeof PROTOCOL_VERSION;
  type: "requestSnapshot";
}

export type ToSimMessage = CommandMessage | RequestSnapshotMessage;

// ---- Sim to client ----

/**
 * The whole state at one tick. A client replaces its copy with this. `logFrom`
 * is the absolute log index the next delta's entries start at.
 */
export interface SnapshotMessage {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  state: SimState;
  logFrom: number;
}

/**
 * Wall time one system took on the host, in milliseconds. Host measurement
 * for the debug panel, not game state: two hosts will report different
 * numbers for the same city.
 */
export interface SystemTiming {
  system: string;
  ms: number;
}

/**
 * What changed since the previous delta or snapshot. In M0 that is the tick,
 * the speed and new log entries. `logFrom` is the absolute log index of
 * `log[0]`, so a client can spot a gap and ask for a snapshot.
 */
export interface DeltaMessage {
  v: typeof PROTOCOL_VERSION;
  type: "delta";
  tick: number;
  speed: Speed;
  logFrom: number;
  log: LogEntry[];
  /** Steps the host ran since the previous delta, paused steps included. */
  steps: number;
  /** Per-system time of the most recent step, in `step` order. */
  timings: SystemTiming[];
}

/**
 * Whether a command was accepted into the queue. Accepted commands apply at
 * the next step and then appear in a delta's log.
 */
export interface CommandResultMessage {
  v: typeof PROTOCOL_VERSION;
  type: "commandResult";
  seq: number;
  playerId: string;
  result: CommandResult;
}

export type FromSimMessage = SnapshotMessage | DeltaMessage | CommandResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the outer shape of a message arriving at the sim, so a host can
 * hand anything from a worker port or a socket to it. Returns the message,
 * or the reason it was refused. The command inside is checked later by
 * `submit`, like any other command.
 */
export function parseToSimMessage(raw: unknown): ToSimMessage | string {
  if (!isRecord(raw)) return "message must be an object";
  if (raw.v !== PROTOCOL_VERSION) {
    return `protocol version ${String(raw.v)} is not supported, expected ${PROTOCOL_VERSION}`;
  }
  switch (raw.type) {
    case "requestSnapshot":
      return { v: PROTOCOL_VERSION, type: "requestSnapshot" };
    case "command": {
      const command = raw.command;
      if (!isRecord(command)) return "command message must carry a command object";
      return {
        v: PROTOCOL_VERSION,
        type: "command",
        command: {
          seq: command.seq as number,
          playerId: command.playerId as string,
          type: command.type as string,
          payload: command.payload,
        },
      };
    }
    default:
      return `unknown message type "${String(raw.type)}"`;
  }
}
