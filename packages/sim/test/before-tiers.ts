// A state as it was before version 28 (#341): no tiers on the segments'
// strips of zoning cells, in the network or the undo history. For the
// migration and snapshot tests, which check that a version 26 save loads to
// the same city with only those added.

type Loose = Record<string, unknown>;

/** `state` with the fields version 28 added taken out. Leaves a state that has none as it is. */
export function withoutTiers<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  if (out["roads"] && typeof out["roads"] === "object") {
    const roads: Loose = { ...(out["roads"] as Loose) };
    delete roads["segTierL"];
    delete roads["segTierR"];
    out["roads"] = roads;
  }
  if (Array.isArray(out["undo"])) {
    out["undo"] = (out["undo"] as Loose[]).map((record) => ({
      ...record,
      ops: ((record["ops"] ?? []) as Loose[]).map((op) => {
        if (!op["row"] || typeof op["row"] !== "object") return op;
        const row: Loose = { ...(op["row"] as Loose) };
        delete row["tierL"];
        delete row["tierR"];
        return { ...op, row };
      }),
    }));
  }
  return out as T;
}
