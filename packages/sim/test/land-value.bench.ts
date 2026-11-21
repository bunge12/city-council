// Land value on the M2 scale town (M3-13): the M1 scale city with every cell
// zoned and grown out, about 57,000 buildings. Run with `pnpm bench`, kept
// out of `pnpm test`. Vitest does the timing; nothing here reads the clock
// (CLAUDE.md rule 3).
//
// Land value is derived (landvalue/land-value.ts): the only work in a tick
// is the city centre, worked out on the first tick of each game month, so
// that tick is the system's worst. Every other tick costs it nothing, and a
// change of buildings reaches the values on the tick it is made, so there
// is no pass over the map to finish. This times:
// - the land value system on a month's first tick, held to its share;
// - one cell's value, as a pointer readout or the grower asks for it;
// - what a factory adds to the step that builds it: stamping its pollution;
// - what a load pays: the water map for the seed and the pollution grid;
// - for reference, the value of every zoning cell in the town, once.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import {
  CHUNKS_PER_SIDE,
  LAND_VALUE_BALANCE,
  buildingCount,
  cellAt,
  cellShapesInChunk,
  cellsSettled,
  landValueAt,
  landValueAtPoint,
  nextMonth,
  prepareDerived,
  step,
  type CellInfo,
} from "../src/index";
import { updateCentre } from "../src/landvalue/land-value";
import { createPollutionGrid, stampPollution } from "../src/landvalue/pollution";
import { prepareWaterMap } from "../src/landvalue/water";
import { pollutionSets } from "../src/buildings/where";
import { nextFloat, seedRng } from "../src/rng";
import { generateTerrain } from "../src/terrain/terrain";
import { loadScaleTown } from "./scale-fixture";

const LINE = 96;
const SPAN = 6 * LINE;

const { city, town } = loadScaleTown();
const { state, grids } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);

const POINTS = 4096;
const cells: CellInfo[] = [];
{
  const rng = seedRng(23);
  while (cells.length < POINTS) {
    const g = grids[Math.floor(nextFloat(rng) * grids.length)] ?? { x: 0, z: 0 };
    const cell = cellAt(state, g.x + nextFloat(rng) * SPAN, g.z + nextFloat(rng) * SPAN);
    if (cell) cells.push(cell);
  }
}
let next = 0;
const cell = (): CellInfo => cells[(next = (next + 1) % cells.length)] ?? (cells[0] as CellInfo);

test("land value on the M2 scale town", async ({ bench, annotate }) => {
  expect(buildingCount(state.buildings)).toBe(town.buildings);

  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, hooks: { beforeEach?: () => void } = {}, iterations = 50) => {
    const file = `bench-results/landvalue-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run({ iterations, time: 0, warmupIterations: 1, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  const tick = "the land value system on a month's first tick, working out the centre";
  await run(tick, () => updateCentre(state), { beforeEach: () => void (state.centre = { ...state.centre, due: state.tick }) });
  expect(state.centre.weight).toBeGreaterThan(0);
  expect(state.centre.due).toBe(nextMonth(state.tick));
  const idle = "the land value system on any other tick";
  await run(idle, () => updateCentre(state), {}, 1000);

  const query = "landValueAt, one cell's value and its parts";
  await run(query, () => void landValueAt(state, cell()), {}, 4096);

  const grid = createPollutionGrid();
  const heavy = LAND_VALUE_BALANCE.industry.length;
  const stamp = `stamping one density ${heavy} factory's pollution on and off, as a step that builds or clears one does`;
  await run(stamp, () => {
    stampPollution(grid, 6000, 6000, heavy, 1);
    stampPollution(grid, 6000, 6000, heavy, -1);
  }, {}, 1000);

  const terrain = generateTerrain(state.seed);
  await run("the water map for a seed, once a load", () => prepareWaterMap({ ...terrain }), {}, 5);
  await run("a building index built afresh with its pollution grid and sums, once a load", () => void pollutionSets(state), {}, 5);

  // Every zoning cell's value once, for the overlay and the grower's order to come.
  let valued = 0;
  await run(
    "the value of every zoning cell in the town, for reference",
    () => {
      valued = 0;
      for (let c = 0; c < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; c++) {
        const { corners, slots } = cellShapesInChunk(state, c);
        for (let k = 0; k < slots.length; k++) {
          const x = ((corners[k * 8] ?? 0) + (corners[k * 8 + 2] ?? 0) + (corners[k * 8 + 4] ?? 0) + (corners[k * 8 + 6] ?? 0)) / 4;
          const z = ((corners[k * 8 + 1] ?? 0) + (corners[k * 8 + 3] ?? 0) + (corners[k * 8 + 5] ?? 0) + (corners[k * 8 + 7] ?? 0)) / 4;
          landValueAtPoint(state, x, z, 0);
          valued++;
        }
      }
    },
    {},
    2,
  );

  const round = (v: number): number => Math.round(v * 1000) / 1000;
  const report = {
    buildings: buildingCount(state.buildings),
    cellsValued: valued,
    centre: state.centre,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([k, v]) => [k, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-13 land value");

  hold("landvalue.tick", tick, { mean: meanMs[tick] });
  hold("landvalue.query", query, { mean: meanMs[query] });
}, 600_000);
