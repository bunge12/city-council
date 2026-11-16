// A fixture city with every building type on a lot on one strip (issue
// M2-12), built in Node with the sim and handed to the page as a city file.
//
// It is the zoned road fixture (cell-fixtures.ts), with buildings added
// straight into state the way the grower adds them: each zoned side of a
// street takes the types of its zone and density in turn, each on its
// largest lot that fits, until the side is full. Variants count up, so
// neighbouring buildings of one type use different models.

import { BUILDING_TYPES, CELL_OPEN, ZONING_BALANCE, buildingCount, cellStatuses, serialize, syncCells, typesFor, type SimState } from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { lotProblem } from "../packages/sim/src/buildings/where";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { fixtureCity } from "./road-fixtures";

const DEPTH = ZONING_BALANCE.zoneDepthCells;
const DENSITIES = ZONING_BALANCE.densities.length;
const PAIRS = ZONING_BALANCE.zones.length * DENSITIES;

/**
 * Zones every open cell of `state`, each side of each segment to its full
 * depth with the next of the fifteen zone and density pairs, starting at
 * pair `from`.
 */
export function zoneSides(state: SimState, from = 0): void {
  syncCells(state);
  const status = cellStatuses(state);
  const { offset, zone, density } = state.cells;
  let pair = from;
  for (let seg = 0; seg + 1 < offset.length; seg++) {
    const start = offset[seg] ?? 0;
    const end = offset[seg + 1] ?? 0;
    if (end === start) continue;
    for (const s of [0, 1]) {
      const p = pair++ % PAIRS;
      for (let i = start; i < end; i++) {
        if ((Math.floor((i - start) / DEPTH) & 1) !== s || status[i] !== CELL_OPEN) continue;
        zone[i] = 1 + Math.floor(p / DENSITIES);
        density[i] = 1 + (p % DENSITIES);
      }
    }
  }
}

/** Adds buildings along every zoned side of `state`. Returns how many of each type, by type index. */
export function buildEverySide(state: SimState): number[] {
  syncCells(state);
  const { offset, zone, density } = state.cells;
  const counts = new Array<number>(BUILDING_TYPES.length).fill(0);
  let variant = 0;
  for (let seg = 0; seg + 1 < offset.length; seg++) {
    const start = offset[seg] ?? 0;
    const places = ((offset[seg + 1] ?? 0) - start) / (2 * DEPTH);
    for (const side of [0, 1]) {
      for (let place = 0; place < places; place++) {
        const slot = start + (place * 2 + side) * DEPTH;
        const z = zone[slot] ?? 0;
        const d = density[slot] ?? 0;
        if (z === 0 || d === 0) continue;
        const types = typesFor(z, d);
        // Each type in turn, the least placed first and then the largest, on its largest lot that fits here.
        const area = (t: (typeof types)[number]) => t.width[1] * t.depth[1];
        const order = [...types].sort((a, b) => (counts[a.index] ?? 0) - (counts[b.index] ?? 0) || area(b) - area(a));
        done: for (const type of order) {
          // A through-lot needs a second strip behind this one; through-lots.spec.ts draws those.
          if (type.throughLot) continue;
          for (let w = type.width[1]; w >= type.width[0]; w--) {
            for (let dep = type.depth[1]; dep >= type.depth[0]; dep--) {
              const shape = { first: { seg, side, place, dir: 0 }, width: w, depth: dep, back: null };
              if (lotProblem(state, shape, type.zoneNumber, type.density) !== null) continue;
              const residents = type.residents[0];
              const lot = { firstSeg: seg, firstSide: side, firstPlace: place, dir: 0, width: w, depth: dep, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 };
              addBuilding(state, { ...lot, type: type.index, residents, variant: variant++ % 256 });
              counts[type.index] = (counts[type.index] ?? 0) + 1;
              break done;
            }
          }
        }
      }
    }
  }
  return counts;
}

/**
 * Moves `state` on past the construction animation (issue 136), so the
 * buildings a fixture put in straight are drawn finished when it opens.
 * The tick alone moves: nothing steps.
 */
export function finishConstruction(state: SimState): void {
  state.tick += CONSTRUCTION.ticks;
}

/** Where the pairs start, picked so every type finds a lot on the fixture's streets. */
const PAIRS_FROM = 0;

/** The zoned road fixture with buildings of every type along its streets. */
export function builtFixtureCity(): { bytes: Buffer; state: SimState; counts: number[]; buildings: number } {
  const { state } = fixtureCity();
  zoneSides(state, PAIRS_FROM);
  const counts = buildEverySide(state);
  finishConstruction(state);
  // Saved paused: a building the grower adds during a test would change the counts and the screenshots.
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), state, counts, buildings: buildingCount(state.buildings) };
}
