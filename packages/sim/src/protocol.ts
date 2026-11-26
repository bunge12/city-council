// The messages between a sim host and a client. Today the host is a Web
// Worker; with multiplayer it becomes a server and these same shapes go over
// a WebSocket. Keep them plain JSON data plus typed arrays, and bump
// PROTOCOL_VERSION on any change to a shape.

import type { BuildingDelta } from "./buildings/delta";
import type { Command, CommandResult, DroppedCommand } from "./commands";
import type { CentreState } from "./landvalue/centre";
import type { DemandState } from "./demand/demand";
import type { BudgetState } from "./economy/budget";
import type { LogEntry } from "./log";
import type { PopDelta } from "./pops/delta";
import type { StatsDelta } from "./stats/stats";
import type { RoadDelta } from "./roads/delta";
import type { SimState, Speed } from "./state";
import type { UndoDelta } from "./undo";
import type { CellDelta } from "./zoning/delta";

/** Version of the message shapes below. Every message carries it as `v`. */
export const PROTOCOL_VERSION = 28;

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

/**
 * Says the client has taken the delta numbered `seq`, applied or not. A host
 * sends the next delta only once the last is taken, so a client slower than
 * the sim gets fewer, larger deltas instead of a queue that grows without
 * end (issue #345).
 */
export interface DeltaAckMessage {
  v: typeof PROTOCOL_VERSION;
  type: "deltaAck";
  seq: number;
}

export type ToSimMessage = CommandMessage | RequestSnapshotMessage | DeltaAckMessage;

// ---- Sim to client ----

/**
 * The whole state at one tick, the whole road network, every zoning
 * cell's zone and density, every building and every pop included. A
 * client replaces its copy with this. It is the only message that carries
 * pop rows: a copy's pop table is as of its last snapshot (M3-05). `logFrom` is the absolute log index the next
 * delta's entries start at, and `deltaSeq` is the next delta's `seq`.
 */
export interface SnapshotMessage {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  state: SimState;
  logFrom: number;
  deltaSeq: number;
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
 * What changed since the previous delta or snapshot: the tick, the speed,
 * new log entries, changed road rows, changed zoning cells and the
 * buildings that came or went. `seq` counts deltas from 0 and
 * `logFrom` is the absolute log index of `log[0]`, so a client that misses
 * one can tell and ask for a snapshot.
 */
export interface DeltaMessage {
  v: typeof PROTOCOL_VERSION;
  type: "delta";
  seq: number;
  tick: number;
  speed: Speed;
  logFrom: number;
  log: LogEntry[];
  /** The whole dollars each entry of `log` took from the treasury, one per entry, as `SimState.logSpent` holds them (M4-03). */
  logSpent: number[];
  /** Road rows added, changed or removed. Left out when no road changed. */
  roads?: RoadDelta;
  /**
   * Zoning cells painted, and the cells of segments a road change laid out
   * again. Left out when no cell changed. Applied after `roads`.
   */
  cells?: CellDelta;
  /**
   * Buildings added, removed, or become vacant, abandoned or back in use
   * (M3-24, protocol version 20), as whole rows. Left out when none was.
   * Applied after `cells`.
   */
  buildings?: BuildingDelta;
  /**
   * The people and jobs filled of every building whose numbers changed,
   * read when the delta is built (M3-05, protocol version 16). Left out
   * when none did. Pop rows never travel in a delta; see `SnapshotMessage`.
   */
  people?: PopDelta;
  /**
   * How the undo history changed since the last delta or snapshot, when it
   * did: the records it kept and the ones added (undo.ts). Left out
   * otherwise.
   */
  undo?: UndoDelta;
  /**
   * Commands accepted into the queue that a step then dropped, with why,
   * for every player. Left out when none was. Together with `log` it
   * settles every command the steps covered: each was applied, and is in
   * `log`, or dropped, and is here.
   */
  dropped?: DroppedCommand[];
  /**
   * The generator's four words after the last step, a copy. Always sent:
   * the grower (M2-10) draws from it on growing ticks, and a copy whose
   * generator fell behind would hash differently from the sim.
   */
  rng: Uint32Array;
  /**
   * `cellReads` after the last step, always sent, like `rng`: a copy
   * without it would hash differently from the sim (M2 review, #147,
   * protocol version 12).
   */
  cellReads: number;
  /**
   * The city centre after the last step, a copy (M3-13, protocol version
   * 13). Always sent, like `rng`: land value measures from it, and a copy
   * whose centre fell behind would hash differently from the sim.
   */
  centre: CentreState;
  /**
   * The city statistics after the last step (M3-04, protocol version 14):
   * the totals that changed since the last delta (M3-05, version 16), the
   * yearly counts, copies, and any monthly samples taken since the last
   * delta. Always sent, like `centre`: a copy whose totals or history fell
   * behind would hash differently from the sim.
   */
  stats: StatsDelta;
  /**
   * `travelReadyAt` after the last step, always sent, like `cellReads`: a
   * copy without it would hash differently from the sim (issue #177,
   * protocol version 15).
   */
  travelReadyAt: number;
  /**
   * The four demand bars and their parts after the last step, a copy (M3-06,
   * protocol version 17; the residential bar's satisfaction part, M3-10,
   * version 19). Always sent, like `centre`: the bars move once a
   * day, the client shows what pushes them, and a copy whose bars fell
   * behind would hash differently from the sim.
   */
  demand: DemandState;
  /**
   * `redevelopedToday` after the last step, always sent, like `cellReads`:
   * a copy without it would hash differently from the sim (M3-14, protocol
   * version 21).
   */
  redevelopedToday: number;
  /**
   * The treasury, the ledger and the tax rates, a copy, when any changed
   * since the last delta (M4-02, protocol version 24); with the development
   * charges since protocol version 27 (M4-08).
   * Left out otherwise.
   */
  budget?: BudgetState;
  /**
   * The milestones reached, a copy, when one was reached or credited since
   * the last delta (M4-12, protocol version 28). Left out otherwise. A
   * client finds what a new one opens from `MILESTONES`.
   */
  milestones?: Int32Array;
  /**
   * The commands still queued, the ones waiting for the cells to settle,
   * when the queue changed since the last delta. Left out otherwise: a
   * stroke can wait through many deltas.
   */
  pending?: Command[];
  /** Steps the host ran since the previous delta, paused steps included. */
  steps: number;
  /** Per-system time of the most recent step, in `step` order. */
  timings: SystemTiming[];
}

/**
 * Whether a command was accepted into the queue. Accepted is not applied:
 * an accepted command applies at the next step and then appears in a
 * delta's `log`, or an earlier command in that step makes it invalid and it
 * appears in the delta's `dropped`.
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
    case "deltaAck":
      if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) return "deltaAck must carry the delta's seq";
      return { v: PROTOCOL_VERSION, type: "deltaAck", seq: raw.seq };
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
