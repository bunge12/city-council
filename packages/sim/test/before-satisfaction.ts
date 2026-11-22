// A state as it was before version 23 (M3-10): the pops without their days
// low and the plan of departures, the statistics without the residents'
// summed satisfaction, and the residential bar without its satisfaction
// part. For the migration and snapshot tests, which check that a version 22
// save loads to the same city with only these added.

type Loose = Record<string, unknown>;

function without(record: Loose, ...keys: string[]): Loose {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/** `state` with the fields version 23 added taken out. Leaves a state that has none of them as it is. */
export function withoutSatisfaction<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  const pops = out["pops"];
  if (typeof pops === "object" && pops !== null) out["pops"] = without(pops as Loose, "daysLow", "leaveScore", "leaveAtScore");
  const stats = out["stats"] as Loose | undefined;
  if (typeof stats === "object" && stats !== null) {
    out["stats"] = { ...stats, totals: without(stats["totals"] as Loose, "residentSatisfaction"), history: without(stats["history"] as Loose, "residentSatisfaction") };
  }
  const demand = out["demand"] as Loose | undefined;
  if (typeof demand === "object" && demand !== null) {
    const residential = demand["residential"] as Loose;
    out["demand"] = { ...demand, residential: { ...residential, parts: without(residential["parts"] as Loose, "satisfaction") } };
  }
  return out as T;
}
