// A state as it was before version 33 (M4-08): no development charges in
// the budget, and no ledger line for the mixed charge. For the migration and
// snapshot tests, which check that a version 32 save loads to the same city
// with only those added. Every older `without...` helper takes them out too,
// through `withoutWaiting`, since a state from before any earlier version
// is from before this one.

type Loose = Record<string, unknown>;

/** `ledger` without the mixed charge line, which must hold 0. */
function withoutMixedLine(ledger: unknown): unknown {
  if (!(ledger instanceof Float64Array) || ledger.length !== 19) return ledger;
  // Version 33's place for the mixed charge line, as migrate.ts fixes it.
  const at = 8;
  if (ledger[at] !== 0) throw new Error("a city from before version 33 paid no mixed development charge");
  return Float64Array.from([...ledger.subarray(0, at), ...ledger.subarray(at + 1)]);
}

/** `state` with the fields version 33 added taken out. Leaves a state that has none as it is. */
export function withoutCharges<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  const budget = out["budget"];
  if (budget && typeof budget === "object" && "chargeRates" in budget) {
    const rest: Loose = { ...(budget as Loose) };
    delete rest["chargeRates"];
    rest["month"] = withoutMixedLine(rest["month"]);
    rest["lastMonth"] = withoutMixedLine(rest["lastMonth"]);
    out["budget"] = rest;
  }
  return out as T;
}
