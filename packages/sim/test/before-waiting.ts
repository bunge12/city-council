// A state as it was before version 32 (#420): no demand bar has its part for
// what is already waiting. For the migration and snapshot tests, which check
// that a version 31 save loads to the same city with only those added. Every
// older `without...` helper takes them out too, through `withoutSpending`,
// since a state from before any earlier version is from before this one. It
// takes out what version 33 added too.

import { DEMAND_BARS, WAITING_PART } from "../src/index";
import { withoutCharges } from "./before-charges";

type Loose = Record<string, unknown>;
type Bar = { value: number; parts: Record<string, number> };

/** `state` with the parts version 32 added taken out of its demand bars, and what version 33 added. Leaves a state that has none, or no bars, as it is. */
export function withoutWaiting<T extends object>(state: T): T {
  const out: Loose = { ...(withoutCharges(state) as Loose) };
  const demand = out["demand"] as Record<string, Bar> | undefined;
  if (!demand || typeof demand !== "object") return out as T;
  const bars: Record<string, Bar> = {};
  for (const bar of DEMAND_BARS) {
    const was = demand[bar];
    if (!was) return out as T;
    const parts = Object.fromEntries(Object.entries(was.parts).filter(([name]) => name !== WAITING_PART[bar]));
    bars[bar] = { value: was.value, parts };
  }
  out["demand"] = bars;
  return out as T;
}
