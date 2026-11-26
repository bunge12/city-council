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

/**
 * Appends an applied command, with the whole dollars it took from the
 * treasury (`SimState.logSpent`), and pages out the oldest entries past the
 * cap, their amounts with them.
 */
export function recordEntry(state: SimState, entry: LogEntry, spent = 0): void {
  if (!Number.isSafeInteger(spent)) throw new RangeError(`a command moves whole dollars, not ${spent}`);
  state.log.push(entry);
  state.logSpent.push(spent);
  if (state.log.length > LOG_LIVE_LIMIT) {
    state.log.splice(0, LOG_PAGE_SIZE);
    state.logSpent.splice(0, LOG_PAGE_SIZE);
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
  checkFrom(state, from);
  return state.log.slice(from - state.logOffset);
}

function checkFrom(state: SimState, from: number): void {
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new RangeError(`from must be a non-negative integer, got ${from}`);
  }
  if (from < state.logOffset) {
    throw new RangeError(
      `log entries ${from} to ${state.logOffset - 1} have left live state; read them from the save`,
    );
  }
}

/**
 * The whole dollars each entry from absolute index `from` to the end of the
 * live log took from the treasury, as `readLog` gives the entries: below
 * zero for one that paid in. Throws if `from` points at entries already
 * paged out.
 */
export function readLogSpent(state: SimState, from: number): number[] {
  checkFrom(state, from);
  return state.logSpent.slice(from - state.logOffset);
}

/** Why `spent` is not one whole dollar amount for each of the `count` entries of a live log, or null. For loading a save. */
export function checkLogSpent(spent: unknown, count: number): string | null {
  if (!Array.isArray(spent) || spent.length !== count) return `it is not one amount for each of the ${count} live entries`;
  for (const value of spent) if (!Number.isSafeInteger(value)) return "an amount is not whole dollars";
  return null;
}

/**
 * Whether `value` has the shape of a log entry. For a host that keeps
 * paged-out entries in its own storage and reads them back.
 */
export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(entry["tick"]) &&
    Number.isSafeInteger(entry["seq"]) &&
    typeof entry["playerId"] === "string" &&
    typeof entry["type"] === "string"
  );
}
