// Timings on the M1 scale network (issue M1-17): the city `buildScaleCity`
// makes through commands on seed 2026, 30,000 segments of street grids,
// curves and bridges on real terrain. Run with `pnpm bench`, kept out of
// `pnpm test`. Vitest does the timing; nothing here reads the clock
// (CLAUDE.md rule 3).
//
// The other benches time one thing each on a flat synthetic grid. This one
// takes the measurements M1's close-out asks for on one generated city and
// reports them together, for the pull request and the PRD.

import { expect, test } from "vitest";
import {
  NETWORKS_ROAD,
  buildScaleCity,
  deserialize,
  findRouteBetween,
  planRoad,
  planRoadGrid,
  prepareDerived,
  routingGraphOf,
  serialize,
  step,
  type BuildRoadPayload,
  type BuildRoadGridPayload,
} from "../src/index";
import { blockById, blockIndexOf, buildBlockIndex, listBlocks } from "../src/roads/blocks";
import { buildRoad, type RoadPlan } from "../src/roads/build";
import { buildRoadGrid, checkRoadGrid } from "../src/roads/grid";
import { endJournal, reverseOps, segmentCount, startJournal, type NetworkOp, type RoadNetwork } from "../src/roads/network";
import { roadIndexOf } from "../src/roads/spatial";
import { ROAD_BUILD } from "../src/roads/balance";
import { terrainOf } from "../src/terrain/cache";

/** What one tick may spend, in milliseconds. */
const TICK_BUDGET_MS = 20;
const LINE = 96;
const SPAN = 6 * LINE;

const { state, counts, grids } = buildScaleCity();
const net = state.roads;
const terrain = terrainOf(state.seed);
// Everything a host keeps current, so each change pays for all of it.
prepareDerived(state);

/** A straight street a quarter of the way into a row of blocks that splits exactly `n` segments. */
function roadCrossing(n: number): { payload: BuildRoadPayload; plan: RoadPlan } {
  for (const g of grids) {
    for (let row = 0; row < 6; row++) {
      const z = g.z + row * LINE + 24;
      for (let end = g.x + 24; end <= g.x + SPAN + 2 * LINE; end += 24) {
        const payload = { from: { x: g.x - 24, z }, to: { x: end, z }, type: "street" };
        const result = planRoad(net, terrain, payload);
        if (!result.ok) continue;
        const splits = result.plan.stops.reduce((sum, s) => sum + s.splits.length, 0);
        if (splits === n) return { payload, plan: result.plan };
        if (splits > n) break;
      }
    }
  }
  throw new Error(`no road splits ${n} segments`);
}

/** A grid at the cap laid over one of the city's own grids, offset so its streets cross the city's. */
function gridOverStreets(): BuildRoadGridPayload {
  for (const g of grids) {
    for (const off of [24, 72]) {
      const o = { x: g.x + off, z: g.z + off };
      const payload = { origin: o, along: { x: o.x + SPAN, z: o.z }, across: { x: o.x, z: o.z + SPAN }, depth: 86, width: 86, type: "street" };
      const result = planRoadGrid(net, terrain, payload);
      if (!result.ok || result.plan.lines !== ROAD_BUILD.gridMaxStreets) continue;
      if (checkRoadGrid(net, terrain, result.plan) === null) return payload;
    }
  }
  throw new Error("no grid at the cap fits over the city's streets");
}

/** Builds `plan` on `on` with the journal open, as the step does. */
function buildOn(on: RoadNetwork, plan: RoadPlan): NetworkOp[] {
  startJournal(on);
  buildRoad(on, terrain, plan);
  return endJournal(on);
}
const build = (plan: RoadPlan): NetworkOp[] => buildOn(net, plan);
const round = (v: number): number => Math.round(v * 1000) / 1000;

function applyGrid(payload: BuildRoadGridPayload): NetworkOp[] {
  const result = planRoadGrid(net, terrain, payload);
  if (!result.ok) throw new Error(result.reason);
  startJournal(net);
  const problem = buildRoadGrid(net, terrain, result.plan);
  const ops = endJournal(net);
  if (problem) throw new Error(problem.reason);
  return ops;
}

const crossing = roadCrossing(10);
const grid = gridOverStreets();
// A street through one block, for the block update on its own.
const blockStreet = roadCrossing(1);
// The same city with the spatial index and the routing graph but no blocks.
const bare = deserialize(serialize(state)).state.roads;
roadIndexOf(bare);
routingGraphOf(bare);
const first = grids[0];
const last = grids.at(-1);

test("the M1 scale network", async ({ bench, annotate }) => {
  if (!first || !last) throw new Error("no grids");
  const segments = segmentCount(net);
  expect(segments).toBeGreaterThanOrEqual(30_000);
  const blocks = blockIndexOf(net);
  const blockCount = listBlocks(blocks).length;
  const graph = routingGraphOf(net);
  const route = findRouteBetween(graph, first.x, first.z, last.x, last.z, { networks: NETWORKS_ROAD });
  if (!route.ok) throw new Error(route.reason);

  // Each run changes the network and takes the change back, so every run
  // starts from the same city. Taking back costs about what building does,
  // so the build times are up to twice what the step itself spends.
  const cases: Record<string, () => void> = {
    // Plan and build, with the spatial index, the routing graph and the
    // blocks kept current, then the take-back.
    "the step that applies one BuildRoad crossing ten segments, and taking it back": () => {
      const result = planRoad(net, terrain, crossing.payload);
      if (!result.ok) throw new Error(result.reason);
      const ops = build(result.plan);
      blockById(blocks, 0);
      reverseOps(net, ops);
      blockById(blocks, 0);
    },
    "the step that applies one BuildRoadGrid at the cap over existing streets, and taking it back": () => {
      const ops = applyGrid(grid);
      blockById(blocks, 0);
      reverseOps(net, ops);
      blockById(blocks, 0);
    },
    "a route across the map, north-west grid to south-east grid": () =>
      void findRouteBetween(graph, first.x, first.z, last.x, last.z, { networks: NETWORKS_ROAD }),
    // The blocks bring themselves up to date when read. The same street
    // through a block on the city and on a copy with no blocks, built and
    // taken back: the difference is two block updates.
    "one BuildRoad through a block, blocks brought up to date, and taking it back": () => {
      const ops = build(blockStreet.plan);
      blockById(blocks, 0);
      reverseOps(net, ops);
      blockById(blocks, 0);
    },
    "the same BuildRoad on a copy with no blocks": () => {
      const ops = buildOn(bare, blockStreet.plan);
      reverseOps(bare, ops);
    },
    "one tick with nothing queued": () => step(state),
    "rebuild every block, for comparison": () => void buildBlockIndex(net),
    "serialize the city, as an autosave does": () => void serialize(state),
  };
  const meanMs: Record<string, number> = {};
  const p99Ms: Record<string, number> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const file = `bench-results/scale-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const result = await bench(name, { writeResult: file }, fn).run();
    meanMs[name] = result.latency.mean;
    p99Ms[name] = result.latency.p99;
  }
  expect(segmentCount(net)).toBe(segments);
  expect(listBlocks(blockIndexOf(net))).toHaveLength(blockCount);

  const report = {
    city: { ...counts, blocks: blockCount, snapshotBytes: serialize(state).byteLength },
    road: { splits: 10, length: Math.round(crossing.payload.to.x - crossing.payload.from.x) },
    route: { metres: Math.round(route.route.distance), segments: route.route.segments.length },
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
    p99Ms: Object.fromEntries(Object.entries(p99Ms).map(([k, v]) => [k, round(v)])),
    blockUpdateMs: round(
      ((meanMs["one BuildRoad through a block, blocks brought up to date, and taking it back"] ?? 0) -
        (meanMs["the same BuildRoad on a copy with no blocks"] ?? 0)) /
        2,
    ),
    budgetMs: TICK_BUDGET_MS,
  };
  // The reporter prints the annotation; each case's own numbers are in
  // its file under bench-results/.
  await annotate(JSON.stringify(report, null, 2), "M1 scale network");

  // Each thing a tick does must fit inside the tick budget. These times
  // include the take-back, which costs about as much again, so a road
  // command gets twice the budget here. The soak run (`pnpm soak`) hosts
  // this city and times the step that applies each command on its own, and
  // holds every step to the budget itself.
  for (const name of [
    "the step that applies one BuildRoad crossing ten segments, and taking it back",
    "the step that applies one BuildRoadGrid at the cap over existing streets, and taking it back",
    "one BuildRoad through a block, blocks brought up to date, and taking it back",
  ]) {
    expect(meanMs[name], name).toBeLessThan(2 * TICK_BUDGET_MS);
  }
  expect(meanMs["one tick with nothing queued"]).toBeLessThan(TICK_BUDGET_MS);
}, 600_000);
