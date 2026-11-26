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
// - no cell with a lot: the first tick tries every one and sets it aside
//   (M3-25), as a load or a change of roads makes it do, and a tick after
//   tries none;
// - every cell C3, so each draw also looks across its block for a
//   through-lot (M2-14), and the same with no two strips meeting, so every
//   look fails;
// - the first growing tick after the same street once tens of thousands of
//   buildings stand. The building index (where.ts) files again only the
//   buildings near the segments the street laid out again (M2-11), so this
//   is held to the budget like the rest;
// - the busiest tick of a day with every demand bar at 100 (M3-07), on the
//   mixed zoning and on C3 throughout, and of a day at `growthPerDayMax`,
//   the most the zones' quotas can add up to, with the balance's rates
//   raised to reach it, its mean held to the grower's share of the budget;
// - the buildings' upkeep after a grid at the cap over the grown city, as a
//   command pays it (buildings/upkeep.ts).

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { budgetFigure } from "../src/budgets";
import {
  BUILDINGS_BALANCE,
  DEMAND_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  dayQuotas,
  growthOnTick,
  planRoad,
  planRoadGrid,
  prepareDerived,
  type BuildRoadGridPayload,
} from "../src/index";
import { loadScaleCity } from "./scale-fixture";
import { buildingCount, removeBuilding } from "../src/buildings/buildings";
import { forgetCandidates, setAsideCount } from "../src/buildings/candidates";
import { grow, growOne } from "../src/buildings/grower";
import { keepBuildings } from "../src/buildings/upkeep";
import { ROAD_BUILD } from "../src/roads/balance";
import { buildRoad, type RoadPlan } from "../src/roads/build";
import { buildRoadGrid, checkRoadGrid } from "../src/roads/grid";
import { endJournal, reverseOps, startJournal, type NetworkOp } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import { syncCells } from "../src/zoning/cell-index";
import { setBars, type HeldBars } from "./demand-helper";

// The grower's share of the tick at `growthPerDayMax` (`grower.share` in
// balance/budgets.json) is a quarter, as `settleCellsPerTick` takes, so it,
// a slice of cells and a command fit in one tick. Held on the mean, since a
// single run's worst is mostly a garbage collection landing in it; the
// median is held to the whole budget (`grower.tick`, issue #231).
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const ZONES = ZONING_BALANCE.zones.length;

const { state, counts, grids } = loadScaleCity();
prepareDerived(state);
// No development charges (M4-08), so the quotas the cases time are the bars' whole wants, as dayQuotas reads them.
state.budget.chargeRates.fill(0);
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

/**
 * A grid at the cap over one of the city's grids, offset so its streets
 * cross the city's: 5 by 6 lines, each section splitting a street (issue
 * 88). Rehearsed, so the sim would build it rather than refuse a link.
 */
function gridOver(): BuildRoadGridPayload {
  for (const g of grids) {
    for (const off of [24, 72]) {
      const o = { x: g.x + off, z: g.z + off };
      const payload = { origin: o, along: { x: o.x + 4 * LINE, z: o.z }, across: { x: o.x, z: o.z + 5 * LINE }, depth: 86, width: 86, type: "street" };
      const result = planRoadGrid(net, terrain, payload);
      if (result.ok && result.plan.work * 1.1 > ROAD_BUILD.gridMaxSections && checkRoadGrid(net, terrain, result.plan) === null) return payload;
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

// The bars the grower reads: the residential bar at the least that asks
// for one house a day for certain, since M4-08 builds the whole part of a
// zone's want and only a chance of the rest, for the cases that time one
// building; every bar at 100 for the busiest tick demand can ask for.
const oneADay = (zone: string): number => 100 / (DEMAND_BALANCE.buildingsPerDayAtFullDemand[zone] ?? 1);
const ONE_HOUSE: HeldBars = { residential: oneADay("residential"), commercial: -1, office: -1, industrial: -1 };
const ONE_SHOP: HeldBars = { residential: -1, commercial: oneADay("commercial"), office: -1, industrial: -1 };
const EVERY_BAR_AT_100: HeldBars = { residential: 100, commercial: 100, office: 100, industrial: 100 };
let bars = ONE_HOUSE;
/** A tick of day 1 on which the grower adds the most buildings the bars give a tick, every zone together. */
function busiestTick(): number {
  setBars(state, bars);
  const quotas = dayQuotas(state.demand);
  const on = (t: number) => quotas.reduce((sum, q) => sum + growthOnTick(t, q), 0);
  const T = TIME_BALANCE.ticksPerDay;
  let best = T;
  for (let t = T; t < 2 * T; t++) if (on(t) > on(best)) best = t;
  return best;
}
/** How many buildings `busiestTick` asks for. */
function busiest(): number {
  const tick = busiestTick();
  const quotas = dayQuotas(state.demand);
  return quotas.reduce((sum, q) => sum + growthOnTick(tick, q), 0);
}

/**
 * Runs `body` with every zone's full-demand rate set so the zones together
 * ask for `growthPerDayMax`, the cap: in zone order, the first takes it all,
 * so `first` names the zone that should.
 */
function atTheCap<T>(first: string, body: () => T): T {
  const rates = DEMAND_BALANCE.buildingsPerDayAtFullDemand;
  const was = { ...rates };
  for (const id of Object.keys(rates)) rates[id] = id === first ? BUILDINGS_BALANCE.growthPerDayMax : 0;
  try {
    return body();
  } finally {
    Object.assign(rates, was);
  }
}

/** Buildings standing before a case, so `takeBack` removes only what it added. */
let standingBefore = new Set<number>();
function liveIds(): Set<number> {
  const ids = new Set<number>();
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id]) ids.add(id);
  return ids;
}

function growOnce(): void {
  state.tick = busiestTick();
  state.cellsReadyAt = 0;
  setBars(state, bars);
  grow(state);
}

function takeBack(): void {
  for (const id of liveIds()) if (!standingBefore.has(id)) removeBuilding(state, id);
}

test("the grower on the M1 scale network with every cell zoned", async ({ bench, annotate }) => {
  const runs = { iterations: 30, time: 0, warmupIterations: 2, warmupTime: 0 };
  const results: Record<string, { mean: number; p50: number; p99: number; max: number }> = {};
  const time = async (name: string, hooks: { beforeEach?: () => void; afterEach?: () => void }, how = runs) => {
    const file = `bench-results/grower-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(
      name,
      {
        writeResult: file,
        async: false,
        ...hooks,
        beforeEach: () => {
          standingBefore = liveIds();
          hooks.beforeEach?.();
        },
      },
      growOnce,
    ).run(how);
    results[name] = { mean: r.latency.mean, p50: r.latency.p50, p99: r.latency.p99 ?? 0, max: r.latency.max };
  };

  zoneEverything((z, d) => [z, d]);
  await time("a grower tick with its candidates built from scratch, as a load does, for comparison", {
    beforeEach: () => forgetCandidates(state),
    afterEach: takeBack,
  });
  await time("a grower tick with its candidates kept current", { afterEach: takeBack });
  bars = EVERY_BAR_AT_100;
  await time(`a grower tick with every bar at 100, ${busiest()} buildings`, { afterEach: takeBack });
  await atTheCap("residential", () => time(`a grower tick at growthPerDayMax, ${busiest()} buildings`, { afterEach: takeBack }));
  bars = ONE_HOUSE;
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
  // The first tick tries every cell once and sets it aside (M3-25), as a
  // load or a change of roads makes it do; a tick after finds none to try.
  await time("the first grower tick on a city where no cell has a lot, trying each once", { beforeEach: () => forgetCandidates(state) }, { iterations: 3, time: 0, warmupIterations: 0, warmupTime: 0 });
  expect(setAsideCount(state)).toBeGreaterThan(50_000);
  await time("a grower tick once every cell with no lot is set aside", {});
  expect(buildingCount(state.buildings)).toBe(0);

  // Every cell C3, so each draw looks for a through-lot across its block
  // (M2-14) as well as the lots on its own strip.
  const c3 = ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1;
  state.cells.zone.fill(c3);
  state.cells.density.fill(3);
  forgetCandidates(state);
  bars = ONE_SHOP;
  await time("a grower tick on a city zoned C3 throughout, each draw looking for a through-lot", { afterEach: takeBack });
  bars = EVERY_BAR_AT_100;
  await time(`a grower tick with every bar at 100 on a city zoned C3 throughout, ${busiest()} buildings`, { afterEach: takeBack });
  await atTheCap("commercial", () => time(`a grower tick at growthPerDayMax on a city zoned C3 throughout, ${busiest()} buildings`, { afterEach: takeBack }));
  bars = ONE_SHOP;
  expect(buildingCount(state.buildings)).toBe(0);

  // The same with the back row of every strip C2, so every front strip is
  // C3 five deep with a gap of a cell to the strip behind: each draw looks
  // across its block at every width and finds no through-lot.
  for (let slot = DEPTH - 1; slot < state.cells.zone.length; slot += DEPTH) state.cells.density[slot] = 2;
  forgetCandidates(state);
  await time("a grower tick on a city zoned C3 throughout with no strip meeting another", { afterEach: takeBack });
  expect(buildingCount(state.buildings)).toBe(0);

  // Grown out: the zoning of the first cases again, with buildings on it.
  bars = ONE_HOUSE;
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
    collect();
    const r = await bench(
      upkeep,
      {
        writeResult: `bench-results/grower-upkeep.json`,
        async: false,
        beforeEach: () => {
          buildGrid(grid);
          state.tick = busiestTick();
          state.cellsReadyAt = 0;
        },
        afterEach: takeBackRoads,
      },
      () => keepBuildings(state),
    ).run(runs);
    results[upkeep] = { mean: r.latency.mean, p50: r.latency.p50, p99: r.latency.p99 ?? 0, max: r.latency.max };
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  const report = {
    city: { segments: counts.segments, cells: state.cells.zone.length, frontCells: state.cells.zone.length / DEPTH },
    ms: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { mean: round(v.mean), p50: round(v.p50), p99: round(v.p99), max: round(v.max) }])),
    budgetMs: budgetFigure("grower.tick").budget,
    growerShareMs: budgetFigure("grower.share").budget,
  };
  await annotate(JSON.stringify(report, null, 2), "grower");
  // The median of the 30 runs, not the worst: one run's worst is whatever
  // collection or pause of the runner landed in it (issue #231). A tick
  // that is slow every time moves the median with it.
  for (const [name, r] of Object.entries(results)) {
    // Neither is a tick's work in play: a load pays the one, and the other is a first pass over a whole city zoned at once, which no command can paint.
    if (name.includes("from scratch") || name.includes("trying each once")) continue;
    hold("grower.tick", `${name}, median`, r);
    if (name.includes("growthPerDayMax") || name.includes("every bar at 100")) hold("grower.share", `${name}, mean`, r);
  }
}, 600_000);
