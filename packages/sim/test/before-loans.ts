// A state as it was before version 38 (M4-11): no loans in the budget. For
// the migration and snapshot tests, which check that a version 37 save
// loads to the same city with only those added. Every older `without...`
// helper takes them out too, through `withoutMilestones`, since a state
// from before any earlier version is from before this one.

type Loose = Record<string, unknown>;

/** `state` with the fields version 38 added taken out. Leaves a state that has none as it is. */
export function withoutLoans<T extends object>(state: T): T {
  const budget = (state as Loose)["budget"];
  if (!budget || typeof budget !== "object" || !("loans" in budget)) return state;
  const rest: Loose = { ...(budget as Loose) };
  delete rest["loans"];
  delete rest["nextLoan"];
  return { ...(state as Loose), budget: rest } as T;
}
