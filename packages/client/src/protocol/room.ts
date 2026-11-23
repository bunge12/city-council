// Issue M3-15: the room the city's homes hold, for the population tooltip
// in the top bar ("people against room"). It replaces the homes count of
// M2-18. Population itself is a running total the sim keeps
// (`stats.totals.population`); room is not, so it is counted here from the
// client's read-only copy: in full when a snapshot replaces the copy, and
// after that by what each building delta takes away and adds, so nothing
// walks every building on every update. A building's room is the sim's
// `homeRoom`: its residents, or none while it is abandoned. Display only:
// nothing here feeds back into state.

import { homeRoom, type BuildingDelta, type BuildingState } from "@city-council/sim";

type Rows = Readonly<Pick<BuildingState, "flags" | "residents">>;

/** The room every building in `b` holds, counted from scratch. */
export function countRoom(b: Rows): number {
  let room = 0;
  for (let id = 0; id < b.flags.length; id++) room += homeRoom(b, id);
  return room;
}

/** The room the rows a delta is about to overwrite, or cut off past its new limit, hold now. */
export function roomBefore(b: Rows, delta: Pick<BuildingDelta, "ids" | "limit">): number {
  let room = 0;
  for (const id of delta.ids) if (id < b.flags.length) room += homeRoom(b, id);
  // Ids past a shrunk limit go whether or not the delta lists them.
  if (delta.limit < b.flags.length) {
    const listed = new Set(delta.ids);
    for (let id = delta.limit; id < b.flags.length; id++) if (!listed.has(id)) room += homeRoom(b, id);
  }
  return room;
}

/** The room a delta's ids hold once its rows are in. */
export function roomAfter(b: Rows, delta: Pick<BuildingDelta, "ids">): number {
  let room = 0;
  for (const id of delta.ids) room += homeRoom(b, id);
  return room;
}
