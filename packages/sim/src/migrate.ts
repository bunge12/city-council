import { SNAPSHOT_VERSION, type SimState } from "./state";

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/** Upgrades state from the version it is keyed by to the next one. */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // Version 2 adds the activity log.
  1: (old) => ({ ...old, version: 2, log: [], logOffset: 0 }),
};

/**
 * Brings state from any older snapshot version up to `SNAPSHOT_VERSION`.
 * Refuses versions it does not know, including newer ones.
 */
export function migrateState(old: { version: unknown } & Record<string, unknown>): SimState {
  let state: Record<string, unknown> = old;
  const from = state.version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
    throw new RangeError(`unknown snapshot version ${String(from)}`);
  }
  if (from > SNAPSHOT_VERSION) {
    throw new RangeError(
      `snapshot version ${from} is newer than this build, which reads up to ${SNAPSHOT_VERSION}`,
    );
  }
  while ((state.version as number) < SNAPSHOT_VERSION) {
    const migrate = MIGRATIONS[state.version as number];
    if (!migrate) throw new RangeError(`no migration from snapshot version ${String(state.version)}`);
    state = migrate(state);
  }
  return state as unknown as SimState;
}
