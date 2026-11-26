// A state as it was before version 33 (M4-09): no list of expropriations,
// no mark on the buildings the city has paid to clear, and no count on the
// undo records of the buildings each command took. For the
// migration and snapshot tests, which check that a version 32 save loads to
// the same city with only those added. Every older `without...` helper
// takes them out too, through `withoutWaiting`, since a state from before
// any earlier version is from before this one.

type Loose = Record<string, unknown>;

/** `state` with the fields version 33 added taken out. Leaves a state that has none as it is. */
export function withoutExpropriations<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  delete out["expropriations"];
  if (out["buildings"] && typeof out["buildings"] === "object") {
    const buildings: Loose = { ...(out["buildings"] as Loose) };
    delete buildings["paid"];
    out["buildings"] = buildings;
  }
  if (Array.isArray(out["undo"])) {
    out["undo"] = (out["undo"] as Loose[]).map((record) => {
      const rest: Loose = { ...record };
      delete rest["took"];
      return rest;
    });
  }
  return out as T;
}
