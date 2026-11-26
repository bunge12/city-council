// A state as it was before version 30 (M4-02): no treasury or ledger, and
// no money series in the statistics' history. For the migration and
// snapshot tests, which check that a version 29 save loads to the same city
// with only those added. Every older `without...` helper takes them out too,
// since a state from before any earlier version is from before this one.

import { withoutSpending } from "./before-spending";

type Loose = Record<string, unknown>;

/** `state` with the fields version 30 added taken out. Leaves a state that has none as it is. */
export function withoutMoney<T extends object>(state: T): T {
  const out: Loose = { ...(withoutSpending(state) as Loose) };
  delete out["budget"];
  if (out["stats"] && typeof out["stats"] === "object") {
    const stats: Loose = { ...(out["stats"] as Loose) };
    delete stats["money"];
    out["stats"] = stats;
  }
  return out as T;
}
