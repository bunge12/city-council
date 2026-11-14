import { placeConnections } from "./roads/connections";
import { createRoadNetwork, isNode, isSegment, type RoadNetwork } from "./roads/network";
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
  // Version 7 has each undo op say which road it means, not only its id:
  // a removed segment where its end nodes stood, a restyle the ends the
  // segment had (M1 review, issue 80). See `opsWithEnds`.
  6: (old) => ({ ...old, version: 7, undo: opsWithEnds(old) }),
};

type OldOp = Record<string, unknown> & { op: string; id: number; row?: { a: number; b: number } };

/**
 * The undo history with the fields version 7 adds, filled in from what the
 * save holds.
 *
 * A removed segment's end nodes are where the network has them now or, for
 * a node that is gone, where the newest record that removed it says it
 * stood. A restyle's ends are found by walking the history backwards from
 * the segment as it is now. Where the save cannot say, as when the id has
 * since gone to another road, the ends are left as ones no road has, and
 * the undo is refused as it should have been.
 */
function opsWithEnds(old: Record<string, unknown>): unknown[] {
  const net = old["roads"] as RoadNetwork;
  const history = (old["undo"] ?? []) as { ops: OldOp[] }[];
  // Where each node that is gone last stood.
  const gone = new Map<number, { x: number; z: number }>();
  for (const record of history) {
    for (const op of record.ops) {
      if (op.op === "removeNode") gone.set(op.id, { x: op["x"] as number, z: op["z"] as number });
    }
  }
  const nodeAt = (id: number): { x: number; z: number } => {
    if (isNode(net, id)) return { x: net.nodeX[id] ?? 0, z: net.nodeZ[id] ?? 0 };
    return gone.get(id) ?? { x: 0, z: 0 };
  };
  // The ends each segment id has at the point the walk has reached, newest
  // change first. Null once the walk passes the change that made the id's
  // current road, since what the id named before that is not in the save.
  const ends = new Map<number, { a: number; b: number } | null>();
  const endsOf = (id: number): { a: number; b: number } | null => {
    if (!ends.has(id)) ends.set(id, isSegment(net, id) ? { a: net.segA[id] ?? 0, b: net.segB[id] ?? 0 } : null);
    return ends.get(id) ?? null;
  };
  const out: unknown[] = new Array<unknown>(history.length);
  for (let r = history.length - 1; r >= 0; r--) {
    const record = history[r] as { ops: OldOp[] };
    const ops: unknown[] = new Array<unknown>(record.ops.length);
    for (let i = record.ops.length - 1; i >= 0; i--) {
      const op = record.ops[i] as OldOp;
      ops[i] = op;
      if (op.op === "removeSeg" && op.row) {
        const a = nodeAt(op.row.a);
        const b = nodeAt(op.row.b);
        ops[i] = { ...op, ax: a.x, az: a.z, bx: b.x, bz: b.z };
        ends.set(op.id, { a: op.row.a, b: op.row.b });
      } else if (op.op === "addSeg") {
        ends.set(op.id, null);
      } else if (op.op === "restyle") {
        const after = endsOf(op.id);
        const before = after === null ? { a: 0, b: 0 } : op["reverse"] ? { a: after.b, b: after.a } : after;
        ops[i] = { ...op, a: before.a, b: before.b };
        if (after !== null) ends.set(op.id, before);
      }
    }
    out[r] = { ...record, ops };
  }
  return out;
}

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
