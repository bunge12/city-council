// A state as it was before version 26 (M3-14): no count of the buildings
// redevelopment replaced today. For the migration and snapshot tests, which
// check that a version 25 save loads to the same city with only that added.

import { withoutMoney } from "./before-money";

type Loose = Record<string, unknown>;

/** `state` with the field version 26 added taken out. Leaves a state that has none as it is. */
export function withoutRedevelopment<T extends object>(state: T): T {
  return withoutRedevelopmentOnly(withoutMoney(state));
}

function withoutRedevelopmentOnly<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  delete out["redevelopedToday"];
  return out as T;
}
