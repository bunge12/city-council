// A state as it was before version 34 (M4-12): no milestones reached. For
// the migration and snapshot tests, which check that a version 33 save
// loads to the same city with only those added. Every older `without...`
// helper takes them out too, through `withoutCharges`, since a state from
// before any earlier version is from before this one.

type Loose = Record<string, unknown>;

/** `state` with the field version 34 added taken out. Leaves a state that has none as it is. */
export function withoutMilestones<T extends object>(state: T): T {
  if (!("milestones" in state)) return state;
  const out: Loose = { ...(state as Loose) };
  delete out["milestones"];
  return out as T;
}
