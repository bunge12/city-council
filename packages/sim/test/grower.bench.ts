// The grower's tick on the M1 scale network with every zoning cell zoned
// (M2-10). Run with `pnpm bench`, kept out of `pnpm test`. Vitest does the
// timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// Each case is one grower tick that adds a building, which the case takes
// away again so every run starts from the same city:
// - its candidates built from scratch, as a load does (`prepareDerived`),
//   for comparison: no tick pays this;
// - its candidates kept current, as on most growing ticks;
// - the first growing tick after a street through a grid, and after a grid
//   at the cap over existing streets, which look again at the segments the
//   change laid out and those a lot could reach from them;
// - every draw landing on a cell with no lot, so the grower tries
//   `growthTries` cells and adds nothing: the most lot finder calls a tick
//   can make;
// - every cell C3, so each draw also looks across its block for a
//   through-lot (M2-14), and the same with no two strips meeting, so every
//   look fails;
// - the first growing tick after the same street once tens of thousands of
//   buildings stand. The building index (where.ts) files again only the
//   buildings near the segments the street laid out again (M2-11), so this
//   is held to the budget like the rest;
// - the buildings' upkeep after a grid at the cap over the grown city, as a
//   command pays it (buildings/upkeep.ts).

import { expect, test } from "vitest";
import {
  BUILDINGS_BALANCE,
  ZONING_BALANCE,
  buildScaleCity,
  growthOnTick,
  planRoad,
  planRoadGrid,
  prepareDerived,
  type BuildRoadGridPayload,
} from "../src/index";
import { buildingCount, removeBuilding } from "../src/buildings/buildings";
import { forgetCandidates } from "../src/buildings/candidates";
import { grow, growOne } from "../src/buildings/grower";
import { keepBuildings } from "../src/buildings/upkeep";
import { ROAD_BUILD } from "../src/roads/balance";
import { buildRoad, type RoadPlan } from "../src/roads/build";
import { buildRoadGrid } from "../src/roads/grid";
import { endJournal, reverseOps, startJournal, type NetworkOp } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import { syncCells } from "../src/zoning/cell-index";

const TICK_BUDGET_MS = 20;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const ZONES = ZONING_BALANCE.zones.length;

const { state, counts, grids } = buildScaleCity();
prepareDerived(state);
const net = state.roads;
const terrain = terrainOf(state.seed);
const LINE = 96;
const SPAN = 6 * LINE;

/** A street across the first grid that plans, a quarter of the way into a row of blocks. */
function streetAcross(): RoadPlan {
  for (const g of grids) {
    for (let row = 0; row < 6; row++) {
      const z = g.z + row * LINE + 24;
      const result = planRoad(net, terrain, { from: { x: g.x - 24, z }, to: { x: g.x + SPAN + 24, z }, type: "street" });
      if (result.ok) return result.plan;
    }
  }
  throw new Error("no street plans");
}

/** A grid at the cap over one of the city's grids, offset so its streets cross the city's. */
function gridOver(): BuildRoadGridPayload {
  for (const g of grids) {
    for (const off of [24, 72]) {
      const o = { x: g.x + off, z: g.z + off };
      const payload = { origin: o, along: { x: o.x + SPAN, z: o.z }, across: { x: o.x, z: o.z + SPAN }, depth: 86, width: 86, type: "street" };
      const result = planRoadGrid(net, terrain, payload);
      if (result.ok && result.plan.lines === ROAD_BUILD.gridMaxStreets) return payload;
    }
  }
  throw new Error("no grid at the cap plans");
}

let ops: NetworkOp[] = [];
function buildStreet(plan: RoadPlan): void {
  startJournal(net);
  buildRoad(net, terrain, plan);
  ops = endJournal(net);
  syncCells(state);
}
function buildGrid(payload: BuildRoadGridPayload): void {
  const result = planRoadGrid(net, terrain, payload);
  if (!result.ok) throw new Error(result.reason);
  startJournal(net);
  const problem = buildRoadGrid(net, terrain, result.plan);
  ops = endJournal(net);
  if (problem) throw new Error(problem.reason);
  syncCells(state);
}
function takeBackRoads(): void {
  reverseOps(net, ops);
  ops = [];
  syncCells(state);
}

/** Zones every cell of the city, the zone and density changing from segment to segment. Bench only: no command paints this much. */
function zoneEverything(front: (zone: number, density: number) => [number, number]): void {
  const { offset, zone, density } = state.cells;
  for (let seg = 0; seg < offset.length - 1; seg++) {
    const z = 1 + (seg % ZONES);
    const d = 1 + (Math.floor(seg / ZONES) % 3);
    for (let slot = offset[seg] ?? 0; slot < (offset[seg + 1] ?? 0); slot++) {
      const [fz, fd] = slot % DEPTH === 0 ? front(z, d) : [z, d];
      zone[slot] = fz;
      density[slot] = fd;
    }
  }
  forgetCandidates(state);
}

// A tick the grower adds a building on, with nothing settling.
let tick = 0;
while (growthOnTick(tick) === 0) tick++;

function growOnce(): void {
  state.tick = tick;
  state.cellsReadyAt = 0;
  grow(state);
}

function takeBack(): void {
  const last = state.buildings.flags.length - 1;
  if (last >= 0 && state.buildings.flags[last]) removeBuilding(state, last);
}

test("the grower on the M1 scale network with every cell zoned", async ({ bench, annotate }) => {
  const runs = { iterations: 30, time: 0, warmupIterations: 2, warmupTime: 0 };
  const results: Record<string, { mean: number; p99: number; max: number }> = {};
  const time = async (name: string, hooks: { beforeEach?: () => void; afterEach?: () => void }) => {
    const file = `bench-results/grower-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, growOnce).run(runs);
    results[name] = { mean: r.latency.mean, p99: r.latency.p99 ?? 0, max: r.latency.max };
  };

  zoneEverything((z, d) => [z, d]);
  await time("a grower tick with its candidates built from scratch, as a load does, for comparison", {
    beforeEach: () => forgetCandidates(state),
    afterEach: takeBack,
  });
  await time("a grower tick with its candidates kept current", { afterEach: takeBack });
  const street = streetAcross();
  await time("the first grower tick after a street across a grid", {
    beforeEach: () => buildStreet(street),
    afterEach: () => {
      takeBack();
      takeBackRoads();
    },
  });
  const grid = gridOver();
  await time("the first grower tick after a grid at the cap over existing streets", {
    beforeEach: () => buildGrid(grid),
    afterEach: () => {
      takeBack();
      takeBackRoads();
    },
  });
  expect(buildingCount(state.buildings)).toBe(0);

  // Every front cell R3 with the cells behind it C1: no R3 lot is deep
  // enough, so every draw fails.
  const r3 = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;
  const c1 = ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1;
  zoneEverything(() => [r3, 3]);
  for (let slot = 0; slot < state.cells.zone.length; slot++) {
    if (slot % DEPTH !== 0) {
      state.cells.zone[slot] = c1;
      state.cells.density[slot] = 1;
    }
  }
  await time(`a grower tick whose ${BUILDINGS_BALANCE.growthTries} draws all find no lot`, {});
  expect(buildingCount(state.buildings)).toBe(0);

  // Every cell C3, so each draw looks for a through-lot across its block
  // (M2-14) as well as the lots on its own strip.
  const c3 = ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1;
  state.cells.zone.fill(c3);
  state.cells.density.fill(3);
  forgetCandidates(state);
  await time("a grower tick on a city zoned C3 throughout, each draw looking for a through-lot", { afterEach: takeBack });
  expect(buildingCount(state.buildings)).toBe(0);

  // The same with the back row of every strip C2, so every front strip is
  // C3 five deep with a gap of a cell to the strip behind: each draw looks
  // across its block at every width and finds no through-lot.
  for (let slot = DEPTH - 1; slot < state.cells.zone.length; slot += DEPTH) state.cells.density[slot] = 2;
  forgetCandidates(state);
  await time("a grower tick on a city zoned C3 throughout with no strip meeting another", { afterEach: takeBack });
  expect(buildingCount(state.buildings)).toBe(0);

  // Grown out: the zoning of the first cases again, with buildings on it.
  zoneEverything((z, d) => [z, d]);
  for (let i = 0; i < 40_000; i++) growOne(state);
  const standing = buildingCount(state.buildings);
  await time(`the first grower tick after a street across a grid, with ${standing} buildings standing`, {
    beforeEach: () => buildStreet(street),
    afterEach: () => {
      takeBack();
      takeBackRoads();
    },
  });

  // What a command pays after a grid at the cap over the built city: the
  // building index filed again near it, and once the cells settle, the
  // check that removes the buildings under its streets (upkeep.ts). The
  // first run removes them, so later runs measure the filing and the check.
  const upkeep = `the buildings' upkeep after a grid at the cap over existing streets, with ${standing} buildings standing`;
  {
    const r = await bench(
      upkeep,
      {
        writeResult: `bench-results/grower-upkeep.json`,
        async: false,
        beforeEach: () => {
          buildGrid(grid);
          state.tick = tick;
          state.cellsReadyAt = 0;
        },
        afterEach: takeBackRoads,
      },
      () => keepBuildings(state),
    ).run(runs);
    results[upkeep] = { mean: r.latency.mean, p99: r.latency.p99 ?? 0, max: r.latency.max };
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  const report = {
    city: { segments: counts.segments, cells: state.cells.zone.length, frontCells: state.cells.zone.length / DEPTH },
    ms: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { mean: round(v.mean), p99: round(v.p99), max: round(v.max) }])),
    budgetMs: TICK_BUDGET_MS,
  };
  await annotate(JSON.stringify(report, null, 2), "grower");
  for (const [name, r] of Object.entries(results)) {
    if (name.includes("from scratch")) continue;
    expect(r.max, name).toBeLessThan(TICK_BUDGET_MS);
  }
}, 600_000);
