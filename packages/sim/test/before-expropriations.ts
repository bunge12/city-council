// A state as it was before version 32 (M4-09): no list of expropriations,
// and no mark on the buildings the city has paid to clear. For the
// migration and snapshot tests, which check that a version 31 save loads to
// the same city with only those added. Every older `without...` helper
// takes them out too, through `withoutSpending`, since a state from before
// any earlier version is from before this one.

type Loose = Record<string, unknown>;

/** `state` with the fields version 32 added taken out. Leaves a state that has none as it is. */
export function withoutExpropriations<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  delete out["expropriations"];
  if (out["buildings"] && typeof out["buildings"] === "object") {
    const buildings: Loose = { ...(out["buildings"] as Loose) };
    delete buildings["paid"];
    out["buildings"] = buildings;
  }
  return out as T;
}
