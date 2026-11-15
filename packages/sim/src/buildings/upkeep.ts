// What a change of roads does to the buildings on it (M2-11, PRD "Roads
// and buildings").
//
// A building stands while every cell of its lot is there and open. Its
// zoning does not count: a rezoned building stands until it is cleared
// (PRD, "Rezoning").
//
// Two things follow a change of roads, each on a tick fixed by state:
// - At once, on the command's own tick, every building filed near the
//   change moves its row onto the ground it stood on, and a building whose
//   ground has no segment any more, or whose lot the strip no longer holds,
//   is removed (where.ts). That follows from the road shapes alone. It
//   covers a bulldozed road and the undo of a build.
// - Once the cells have settled (`cellsSettled`), each of those buildings,
//   and any building on a segment where a cell stopped being open, is
//   checked, and removed if a cell of its lot is blocked. That covers a new
//   road across zoned ground, a grid and the undo of a bulldoze. A small
//   change settles on its own tick; a big one on the tick `cellsReadyAt`
//   names, the same on every machine (CLAUDE.md rule 5).
//
// The second list is derived, not saved. A building index built afresh, as
// after a load, looks at every building as it is built, with the cells
// settled, and lists the ones whose lot does not stand. Outside the list no
// building ever stands on a blocked cell once the cells settle, so that
// finds exactly what the list held, and a city saved and loaded mid-settle
// removes the same buildings on the same tick as one that never stopped.
//
// Removals go in ascending id order, so every machine frees the same ids in
// the same order.

import type { SimState } from "../state";
import { cellsSettled } from "../zoning/cell-index";
import { isBuilding, removeBuilding } from "./buildings";
import { buildingWorkDue, lotStands, takeBuildingsToCheck, takeLostBuildings } from "./where";

/**
 * Brings the buildings up to date with the roads: called after every
 * command, once the cells are laid out for it (commands.ts), and at the
 * start of every step.
 */
export function keepBuildings(state: SimState): void {
  if (!buildingWorkDue(state)) return;
  for (const id of takeLostBuildings(state)) if (isBuilding(state.buildings, id)) removeBuilding(state, id);
  if (!cellsSettled(state)) return;
  for (const id of takeBuildingsToCheck(state)) {
    if (isBuilding(state.buildings, id) && !lotStands(state, id)) removeBuilding(state, id);
  }
}
