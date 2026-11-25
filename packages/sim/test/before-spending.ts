// A state as it was before version 31 (M4-03): no money kept beside the log
// entries, and none on the undo records. For the migration and snapshot
// tests, which check that a version 30 save loads to the same city with
// only those added. Every older `without...` helper takes them out too,
// through `withoutMoney`, since a state from before any earlier version is
// from before this one.

type Loose = Record<string, unknown>;

/** `state` with the fields version 31 added taken out. Leaves a state that has none as it is. */
export function withoutSpending<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  delete out["logSpent"];
  if (Array.isArray(out["undo"])) {
    out["undo"] = (out["undo"] as Loose[]).map((record) => {
      const rest: Loose = { ...record };
      delete rest["spent"];
      return rest;
    });
  }
  return out as T;
}
