// A state as it was before version 37 (M4-12): no milestones reached. For
// the migration and snapshot tests, which check that a version 36 save
// loads to the same city with only those added. Every older `without...`
// helper takes them out too, through `withoutDisplacedMarks`, since a state from
// before any earlier version is from before this one. It takes out version
// 38's loans as well.

import { withoutLoans } from "./before-loans";

type Loose = Record<string, unknown>;

/** `state` with the field version 37 added taken out. Leaves a state that has none as it is. */
export function withoutMilestones<T extends object>(state: T): T {
  const out: Loose = { ...(withoutLoans(state) as Loose) };
  if (!("milestones" in out)) return out as T;
  delete out["milestones"];
  return out as T;
}
