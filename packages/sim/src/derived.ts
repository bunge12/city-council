// Derived data: structures rebuilt from state that are never saved or
// hashed: the terrain, the road spatial index, the routing graph, the
// blocks, where the zoning cells are, which building stands on each, the
// grower's candidates, who lives and works in each building, and the
// travel times between zones. See "Derived data" in the PRD.
//
// The terrain is cached by seed (terrain/cache.ts). Each other one is cached
// by the state object it comes from and built from its
// arrays on first use, so a city loaded from a save, cloned or replayed
// rebuilds its own and nothing about a host's history can leak into it.

import { candidateCount, candidatesBuilt, prepareCandidates } from "./buildings/candidates";
import { pollutionGrid, prepareBuildingIndex, segmentBuildings } from "./buildings/where";
import { blockIndexOf, existingBlockIndex, listBlocks, settleBlocks } from "./roads/blocks";
import { popIndexOf } from "./pops/where";
import { routingGraphOf } from "./roads/routing";
import { roadIndexOf } from "./roads/spatial";
import type { SimState } from "./state";
import { prepareTravelTimes } from "./travel-times";
import { terrainOf } from "./terrain/cache";
import { prepareWaterMap } from "./landvalue/water";
import { cellsLaidOut, syncCells } from "./zoning/cell-index";

/**
 * Builds every piece of derived data `state` does not have yet. Optional: a
 * query builds what it needs anyway. A host calls this after it creates or
 * loads a city, so the cost lands at load and not inside the first tick that
 * asks.
 */
export function prepareDerived(state: SimState): void {
  terrainOf(state.seed);
  roadIndexOf(state.roads);
  routingGraphOf(state.roads);
  listBlocks(blockIndexOf(state.roads));
  const index = syncCells(state);
  prepareBuildingIndex(state);
  prepareWaterMap(terrainOf(state.seed));
  pollutionGrid(state);
  prepareCandidates(state, index, () => segmentBuildings(state));
  popIndexOf(state);
  prepareTravelTimes(state);
}

/**
 * Brings the blocks and the grower's candidates up to date with the
 * changes the step made so far, once a step, after the commands and the
 * slice of cells (step.ts). Without it each waits for its next read, and
 * the grower's next lot query paid for every change since: a street
 * through a grid's blocks walked thousands of half-edges of block faces in
 * a grower step, and a stroke of zoning refreshed its front cells in one
 * (issue #210). Now the step that made the change pays for it.
 *
 * Only what is built already: a city that has never asked for blocks or
 * candidates builds them on first use, as before. The candidates catch up
 * only while the cells in state are laid out for the roads as they are
 * (`cellsLaidOut`): reading them otherwise would lay the cells out, or walk
 * a change still settling, in state, and a city loaded from a save, with
 * no candidates built, would do that later and hash differently meanwhile.
 * So after a change of roads they wait for the grower's next read, as
 * before; after zoning or a bulldozed building they catch up here. Neither
 * is state, and both follow from state alone, so when they catch up
 * changes nothing the sim decides.
 */
export function catchUpDerived(state: SimState): void {
  const blocks = existingBlockIndex(state.roads);
  if (blocks) settleBlocks(blocks);
  if (candidatesBuilt(state) && cellsLaidOut(state)) candidateCount(state, syncCells(state), () => segmentBuildings(state));
}
