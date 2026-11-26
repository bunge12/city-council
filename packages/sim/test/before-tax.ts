// A state as it was before version 35 (M4-07): no demand bar has its part
// for its zone's tax rate. For the migration and snapshot tests, which check
// that a version 34 save loads to the same city with only those added.
// Every older `without...` helper takes them out too, through
// `withoutExpropriations`, since a state from before any earlier version is from
// before this one.

type Loose = Record<string, unknown>;
type Bar = { value: number; parts: Record<string, number> };

/** `state` with the tax part version 35 added taken out of each demand bar. Leaves a state that has none, or no bars, as it is. */
export function withoutTax<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  const demand = out["demand"] as Record<string, Bar> | undefined;
  if (!demand || typeof demand !== "object") return out as T;
  const bars: Record<string, Bar> = {};
  for (const [bar, was] of Object.entries(demand)) {
    if (!was || typeof was !== "object" || !was.parts) return out as T;
    if ("tax" in was.parts && was.parts["tax"] !== 0) throw new Error("a city from before version 35 had no tax part on its bars");
    const parts = Object.fromEntries(Object.entries(was.parts).filter(([name]) => name !== "tax"));
    bars[bar] = { value: was.value, parts };
  }
  out["demand"] = bars;
  return out as T;
}
