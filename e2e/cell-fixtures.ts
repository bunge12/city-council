// Zoned fixture cities for the zoning overlay walkthrough (issue M2-06),
// built in Node with the sim and handed to the page as city files.
//
// The zones are written straight into the cell arrays, the way the road
// fixtures write roads straight into the graph. Only open cells are zoned,
// as `ZoneCells` would leave them.

import { CELL_OPEN, ZONING_BALANCE, cellStatuses, serialize, syncCells, type SimState } from "../packages/sim/src/index";
import { fixtureCity, scaleCityState } from "./road-fixtures";

const ZONES = ZONING_BALANCE.zones.length;
const DENSITIES = ZONING_BALANCE.densities.length;
/** Every zone at every density, then one unzoned. */
const COMBOS = ZONES * DENSITIES + 1;
const DEPTH = ZONING_BALANCE.zoneDepthCells;

/**
 * Zones the open cells of `state` in runs: each side of each segment takes
 * the next of the fifteen zone and density pairs, or stays unzoned every
 * sixteenth. On every third side the back `DEPTH - back` rows stay unzoned,
 * so outlines show beside colour. Returns how many cells each pair got.
 */
export function zoneEverySide(state: SimState, back = 4): number[] {
  syncCells(state);
  const status = cellStatuses(state);
  const { offset, zone, density } = state.cells;
  const counts = new Array<number>(COMBOS).fill(0);
  let side = 0;
  for (let seg = 0; seg + 1 < offset.length; seg++) {
    const start = offset[seg] ?? 0;
    const end = offset[seg + 1] ?? 0;
    if (end === start) continue;
    for (const s of [0, 1]) {
      const combo = side % COMBOS;
      const shallow = side % 3 === 2;
      side++;
      for (let i = start; i < end; i++) {
        const local = i - start;
        const depth = local % DEPTH;
        if ((Math.floor(local / DEPTH) & 1) !== s || status[i] !== CELL_OPEN) continue;
        if (combo === COMBOS - 1 || (shallow && depth >= back)) continue;
        zone[i] = 1 + Math.floor(combo / DENSITIES);
        density[i] = 1 + (combo % DENSITIES);
        counts[combo] = (counts[combo] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** The road fixture city with every zone at every density painted along its streets. */
export function zonedFixtureCity(): { bytes: Buffer; state: SimState; counts: number[] } {
  const { state } = fixtureCity();
  const counts = zoneEverySide(state);
  return { bytes: Buffer.from(serialize(state)), state, counts };
}

/** The 30,000 segment scale city with every open cell zoned, cycling through the fifteen pairs. */
export function zonedScaleCity(segments: number): { bytes: Buffer; zoned: number } {
  const state = scaleCityState(segments);
  syncCells(state);
  const status = cellStatuses(state);
  const { offset, zone, density } = state.cells;
  let zoned = 0;
  for (let seg = 0; seg + 1 < offset.length; seg++) {
    const combo = seg % (ZONES * DENSITIES);
    for (let i = offset[seg] ?? 0; i < (offset[seg + 1] ?? 0); i++) {
      if (status[i] !== CELL_OPEN) continue;
      zone[i] = 1 + Math.floor(combo / DENSITIES);
      density[i] = 1 + (combo % DENSITIES);
      zoned++;
    }
  }
  return { bytes: Buffer.from(serialize(state)), zoned };
}
