// A state as it was before version 25 (M3-12): the pops without the queue
// of displaced pops. For the migration and snapshot tests, which check that
// a version 24 save loads to the same city with only that added.

type Loose = Record<string, unknown>;

/** `state` with the field version 25 added taken out. Leaves a state that has none as it is. */
export function withoutDisplaced<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  const pops = out["pops"];
  if (typeof pops === "object" && pops !== null && "displaced" in pops) {
    out["pops"] = Object.fromEntries(Object.entries(pops as Loose).filter(([key]) => key !== "displaced"));
  }
  return out as T;
}
