// Issue M2-18: the homes the city has built, for the top bar. M2 has no
// pops, so this stands in for population until M3. It is counted from the
// client's read-only copy: in full when a snapshot replaces the copy, and
// after that by what each building delta takes away and adds, so nothing
// walks every building on every update. Display only: nothing here feeds
// back into state, and the sim keeps no running total of its own.

import { BUILDING_ALIVE, ZONING_BALANCE, type BuildingDelta, type BuildingState } from "@city-council/sim";

/** The zone number a residential building stores, as a cell stores it. */
const RESIDENTIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;

/** Residential buildings standing, and the residents they hold room for between them. */
export interface Homes {
  readonly count: number;
  readonly capacity: number;
}

type Rows = Readonly<Pick<BuildingState, "flags" | "zone" | "residents">>;

/** Whether building `id` of `b` is a home: alive and built under residential zoning, whatever its type. */
function isHome(b: Rows, id: number): boolean {
  return ((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0 && b.zone[id] === RESIDENTIAL;
}

/** Every home in `b`, counted from scratch. */
export function countHomes(b: Rows): Homes {
  let count = 0;
  let capacity = 0;
  for (let id = 0; id < b.flags.length; id++) {
    if (!isHome(b, id)) continue;
    count++;
    capacity += b.residents[id] ?? 0;
  }
  return { count, capacity };
}

/** What the rows a delta is about to overwrite, or cut off past its new limit, hold now. */
export function homesBefore(b: Rows, delta: Pick<BuildingDelta, "ids" | "limit">): Homes {
  let count = 0;
  let capacity = 0;
  const take = (id: number) => {
    if (!isHome(b, id)) return;
    count++;
    capacity += b.residents[id] ?? 0;
  };
  for (const id of delta.ids) if (id < b.flags.length) take(id);
  // Ids past a shrunk limit go whether or not the delta lists them.
  if (delta.limit < b.flags.length) {
    const listed = new Set(delta.ids);
    for (let id = delta.limit; id < b.flags.length; id++) if (!listed.has(id)) take(id);
  }
  return { count, capacity };
}

/** What a delta's ids hold once its rows are in. */
export function homesAfter(b: Rows, delta: Pick<BuildingDelta, "ids">): Homes {
  let count = 0;
  let capacity = 0;
  for (const id of delta.ids) {
    if (!isHome(b, id)) continue;
    count++;
    capacity += b.residents[id] ?? 0;
  }
  return { count, capacity };
}

/** `homes` with `before` taken away and `after` added. */
export function adjustHomes(homes: Homes, before: Homes, after: Homes): Homes {
  return { count: homes.count - before.count + after.count, capacity: homes.capacity - before.capacity + after.capacity };
}
