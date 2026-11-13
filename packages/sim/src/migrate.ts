import { placeConnections } from "./roads/connections";
import { createRoadNetwork, type RoadNetwork } from "./roads/network";
import { terrainOf } from "./terrain/cache";
import { SNAPSHOT_VERSION, type SimState } from "./state";

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/** Upgrades state from the version it is keyed by to the next one. */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // Version 2 adds the activity log.
  1: (old) => ({ ...old, version: 2, log: [], logOffset: 0 }),
  // Version 3 adds the road graph, empty.
  2: (old) => ({ ...old, version: 3, roads: createRoadNetwork() }),
  // Version 4 adds every player's undo history, empty. Ids a version 3
  // network removed are all on its free lists, so none is held.
  3: (old) => ({ ...old, version: 4, undo: [] }),
  // Version 5 adds the outside connections, placed as a new city of the
  // seed places them but clear of the roads the save already has. They go
  // into its network under new ids and nothing is journalled, so undo
  // never takes them back.
  //
  // Placing them runs today's road code, so the network takes today's level
  // fields first (see version 6).
  4: (old) => {
    old = levelsAtBothEnds(old);
    const roads = old["roads"] as RoadNetwork;
    const connections = placeConnections(roads, terrainOf(old["seed"] as number), old["seed"] as number);
    return { ...old, version: 5, roads, connections };
  },
  // Version 6 stores a level at each end of a segment, so a ramp can change
  // level along its length (issue 22). See `levelsAtBothEnds`.
  5: (old) => ({ ...levelsAtBothEnds(old), version: 6 }),
};

/**
 * The state with each segment's one level made the level at both its ends:
 * `segLevel` becomes `segLevelA` and `segLevelB`, in the network and in every
 * segment row the undo history holds. A state already in that shape, as one
 * an earlier migration built with today's code, is returned as it is.
 */
function levelsAtBothEnds(old: Record<string, unknown>): Record<string, unknown> {
  const net = old["roads"] as Record<string, unknown> & { segLevel?: Uint8Array };
  if (!net.segLevel) return old;
  const { segLevel, ...rest } = net;
  const fields: Record<string, unknown> = { ...rest, segLevelA: segLevel, segLevelB: Uint8Array.from(segLevel) };
  // In the order a new network has its fields, so it saves the same way.
  const roads = Object.fromEntries(Object.keys(createRoadNetwork()).map((key) => [key, fields[key]]));
  const undo = ((old["undo"] ?? []) as { ops: { row?: Record<string, unknown> }[] }[]).map((record) => ({
    ...record,
    ops: record.ops.map((op) => {
      if (!op.row || !("level" in op.row)) return op;
      const { level, ...row } = op.row;
      return { ...op, row: { ...row, levelA: level, levelB: level } };
    }),
  }));
  return { ...old, roads, undo };
}

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
