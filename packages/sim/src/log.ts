import type { SimState } from "./state";

/**
 * One applied command. `tick` is the tick it was applied on: the value of
 * `state.tick` during the `step` that applied it.
 */
export interface LogEntry {
  tick: number;
  seq: number;
  playerId: string;
  type: string;
  payload: unknown;
}

/**
 * Most entries live state holds. Past this the oldest `LOG_PAGE_SIZE`
 * entries leave live state together, so trimming happens once per page
 * rather than once per command.
 */
export const LOG_LIVE_LIMIT = 4096;
export const LOG_PAGE_SIZE = 1024;

/** Appends an applied command and pages out the oldest entries past the cap. */
export function recordEntry(state: SimState, entry: LogEntry): void {
  state.log.push(entry);
  if (state.log.length > LOG_LIVE_LIMIT) {
    state.log.splice(0, LOG_PAGE_SIZE);
    state.logOffset += LOG_PAGE_SIZE;
  }
}

/** Total entries ever recorded, live or paged out. */
export function logLength(state: SimState): number {
  return state.logOffset + state.log.length;
}

/**
 * Entries from absolute index `from` to the end of the live log, without
 * changing state. A host keeps a cursor, calls this after each step and
 * stores what it gets, so entries that later leave live state are kept in
 * the save. Throws if `from` points at entries already paged out.
 */
export function readLog(state: SimState, from: number): LogEntry[] {
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new RangeError(`from must be a non-negative integer, got ${from}`);
  }
  if (from < state.logOffset) {
    throw new RangeError(
      `log entries ${from} to ${state.logOffset - 1} have left live state; read them from the save`,
    );
  }
  return state.log.slice(from - state.logOffset);
}
