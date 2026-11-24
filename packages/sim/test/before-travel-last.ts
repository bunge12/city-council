// A state as it was before version 27 (#313): no last whole travel-time
// table held while a rebuild runs. For the migration and snapshot tests,
// which check that a version 26 save loads to the same city with only that
// added.

type Loose = Record<string, unknown>;

/** `state` with the field version 27 added taken out. Leaves a state that has none as it is. */
export function withoutTravelLast<T extends object>(state: T): T {
  const out: Loose = { ...(state as Loose) };
  delete out["travelLast"];
  return out as T;
}
