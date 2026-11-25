// A state as it was before version 29 (#361): no days of grace on the pops,
// and no running total of the unemployed workers still in them. For the
// migration and snapshot tests, which check that a version 28 save loads to
// the same city with only those added.

type Loose = Record<string, unknown>;

/** `state` with the fields version 29 added taken out. Leaves a state that has none as it is. */
export function withoutGrace<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  if (out["pops"] && typeof out["pops"] === "object") {
    const pops: Loose = { ...(out["pops"] as Loose) };
    delete pops["graceDays"];
    out["pops"] = pops;
  }
  if (out["stats"] && typeof out["stats"] === "object") {
    const stats = out["stats"] as Loose;
    const totals: Loose = { ...(stats["totals"] as Loose) };
    const history: Loose = { ...(stats["history"] as Loose) };
    delete totals["workersUnemployedNew"];
    delete history["workersUnemployedNew"];
    out["stats"] = { ...stats, totals, history };
  }
  return out as T;
}
