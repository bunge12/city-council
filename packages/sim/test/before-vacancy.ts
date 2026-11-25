// A state as it was before version 24 (M3-24): the buildings without the
// tick each became what it is. For the migration and snapshot tests, which
// check that a version 23 save loads to the same city with only that added.

import { withoutMoney } from "./before-money";

import { withoutDisplaced } from "./before-displaced";

type Loose = Record<string, unknown>;

/** `state` with the field version 24 added taken out, and so that of version 25 too (before-displaced.ts). Leaves a state that has none as it is. */
export function withoutVacancy<T extends object>(state: T): T {
  return withoutVacancyOnly(withoutMoney(state));
}

function withoutVacancyOnly<T extends object>(state: T): T {
  const out: Loose = { ...(withoutDisplaced(state) as Loose) };
  const buildings = out["buildings"];
  if (typeof buildings === "object" && buildings !== null && "statusSince" in buildings) {
    out["buildings"] = Object.fromEntries(Object.entries(buildings as Loose).filter(([key]) => key !== "statusSince"));
  }
  return out as T;
}
