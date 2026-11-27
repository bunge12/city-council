// A state as it was before version 36 (M4-10): no mark on the pops of
// their last displacement. For the migration and snapshot tests, which
// check that a version 35 save loads to the same city with only that
// added. Every older `without...` helper takes it out too, through
// `withoutTax`, since a state from before any earlier version is
// from before this one. It takes out version 37's milestones as well.

import { withoutMilestones } from "./before-milestones";

type Loose = Record<string, unknown>;

/** `state` with the fields version 36 added taken out. Leaves a state that has none as it is. */
export function withoutDisplacedMarks<T extends object>(state: T): T {
  const out: Loose = { ...(withoutMilestones(state) as Loose) };
  if (out["pops"] && typeof out["pops"] === "object") {
    const pops: Loose = { ...(out["pops"] as Loose) };
    delete pops["displacedBy"];
    delete pops["displacedTick"];
    delete pops["displacedWith"];
    out["pops"] = pops;
  }
  return out as T;
}
