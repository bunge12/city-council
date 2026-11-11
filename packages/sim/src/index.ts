// Public entry for the sim package. Client and server import the sim only
// through this file. Lint enforces it.

/** Game time advanced by one sim tick at 1x, in milliseconds. */
export const TICK_MS = 100;

/** Name and version of the sim, shown by the placeholder page. */
export function simInfo(): { name: string; tickMs: number } {
  return { name: "city-council sim", tickMs: TICK_MS };
}

export { SNAPSHOT_VERSION, SPEEDS, createState } from "./state";
export type { SimState, Speed } from "./state";
export { COMMANDS, MAX_PENDING_COMMANDS, submit, validateCommand } from "./commands";
export type { Command, CommandDef, CommandResult } from "./commands";
export { COMMANDS_SYSTEM, SYSTEMS, step } from "./step";
export type { System, SystemTimer } from "./step";
export { RNG_WORDS, nextFloat, nextInt, nextU32, seedRng } from "./rng";
export { LOG_LIVE_LIMIT, LOG_PAGE_SIZE, logLength, readLog } from "./log";
export type { LogEntry } from "./log";
export { fnv1a64, hashState } from "./hash";
export { replay } from "./replay";
export { migrateState } from "./migrate";
export { PROTOCOL_VERSION, parseToSimMessage } from "./protocol";
export type {
  CommandMessage,
  CommandResultMessage,
  DeltaMessage,
  FromSimMessage,
  RequestSnapshotMessage,
  SnapshotMessage,
  SystemTiming,
  ToSimMessage,
} from "./protocol";
