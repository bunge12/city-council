// Derived data: structures rebuilt from state that are never saved or
// hashed: the terrain, the road spatial index, the routing graph, the
// blocks, where the zoning cells are, which building stands on each, the
// grower's candidates and the cells it has set aside, who lives and works in each building, the
// travel times between zones, which pieces of road reach outside, the
// yearly road upkeep, and the grid of expropriation records. See "Derived data" in the PRD.
//
// The terrain is cached by seed (terrain/cache.ts). Each other one is cached
// by the state object it comes from and built from its
// arrays on first use, so a city loaded from a save, cloned or replayed
// rebuilds its own and nothing about a host's history can leak into it.

import { candidateCount, candidatesBuilt, prepareCandidates } from "./buildings/candidates";
import { setAsideCellsWithNoLot } from "./buildings/grower";
import { pollutionGrid, prepareBuildingIndex, segmentBuildings } from "./buildings/where";
import { reserveBuildingRoom } from "./buildings/buildings";
import { blockIndexOf, existingBlockIndex, listBlocks, settleBlocks } from "./roads/blocks";
import { popIndexOf } from "./pops/where";
import { prepareArrivals } from "./pops/arrivals";
import { reservePopRoom } from "./pops/pops";
import { expropriationGridOf } from "./pops/displacement";
import { openingsOf } from "./pops/openings";
import { catchUpOutside, prepareOutside } from "./roads/outside";
import { routingGraphOf } from "./roads/routing";
import { roadIndexOf } from "./roads/spatial";
import type { SimState } from "./state";
import { prepareTravelTimes } from "./travel-times";
import { terrainOf } from "./terrain/cache";
import { prepareWaterMap } from "./landvalue/water";
import { prepareLandValues } from "./landvalue/land-value";
import { cellsLaidOut, reserveCellSpare, syncCells } from "./zoning/cell-index";
import { reserveRoadRoom } from "./roads/network";
import { roadUpkeepPerYear } from "./economy/upkeep";

/**
 * The parts of `prepareDerived`, in the order it builds them. A host that
 * shows how far a load has got names each as it starts (the client's
 * loading screen, issue #327).
 */
export const DERIVED_STAGES = ["terrain", "roads", "cells", "buildings", "travel", "openings"] as const;
export type DerivedStage = (typeof DERIVED_STAGES)[number];

/**
 * Builds every piece of derived data `state` does not have yet. Optional: a
 * query builds what it needs anyway. A host calls this after it creates or
 * loads a city, so the cost lands at load and not inside the first tick that
 * asks. `onStage` is told each part of `DERIVED_STAGES` as it starts; it
 * reports progress and must not touch `state`. A second call builds
 * nothing and takes under a millisecond.
 */
export function prepareDerived(state: SimState, onStage: (stage: DerivedStage) => void = () => undefined): void {
  onStage("terrain");
  terrainOf(state.seed);
  onStage("roads");
  // Room for the first road, building and pop after a load, made before
  // anything is built from those arrays (issues #364, #372).
  reserveRoadRoom(state.roads);
  reserveBuildingRoom(state.buildings);
  reservePopRoom(state.pops);
  roadIndexOf(state.roads);
  routingGraphOf(state.roads);
  roadUpkeepPerYear(state.roads);
  prepareOutside(state);
  listBlocks(blockIndexOf(state.roads));
  onStage("cells");
  const index = syncCells(state);
  reserveCellSpare(state);
  onStage("buildings");
  prepareBuildingIndex(state);
  prepareWaterMap(terrainOf(state.seed));
  pollutionGrid(state);
  prepareLandValues(state);
  prepareCandidates(state, index, () => segmentBuildings(state));
  popIndexOf(state);
  expropriationGridOf(state);
  prepareArrivals(state);
  onStage("travel");
  prepareTravelTimes(state);
  onStage("openings");
  openingsOf(state);
  setAsideCellsWithNoLot(state);
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
  catchUpOutside(state.roads);
  if (candidatesBuilt(state) && cellsLaidOut(state)) candidateCount(state, syncCells(state), () => segmentBuildings(state));
}
