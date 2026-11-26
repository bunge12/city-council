// A state as it was before version 35 (M4-10): no mark on the pops of
// their last displacement. For the migration and snapshot tests, which
// check that a version 34 save loads to the same city with only that
// added. Every older `without...` helper takes it out too, through
// `withoutExpropriations`, since a state from before any earlier version is
// from before this one.

type Loose = Record<string, unknown>;

/** `state` with the fields version 35 added taken out. Leaves a state that has none as it is. */
export function withoutDisplacedMarks<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  if (out["pops"] && typeof out["pops"] === "object") {
    const pops: Loose = { ...(out["pops"] as Loose) };
    delete pops["displacedBy"];
    delete pops["displacedTick"];
    delete pops["displacedWith"];
    out["pops"] = pops;
  }
  return out as T;
}
