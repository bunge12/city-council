// Timing for the pathfinder on the M1 scale network: 30,000 segments. Run
// with `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3). The target from issue 15 is under
// 20 ms for one route across the network.

import { expect, test } from "vitest";
import { nextFloat, seedRng } from "../src/rng";
import { addNode, addSegment, createRoadNetwork, segmentCount } from "../src/roads/network";
import { buildRoutingGraph, findRoute, findRouteBetween } from "../src/roads/routing";
import { buildRoadIndex } from "../src/roads/spatial";
import { growNetwork } from "./road-network-helper";

/** Milliseconds, from issue 15. */
const ROUTE_TARGET_MS = 20;

// A street grid of 123 by 123 nodes, 30,012 segments about 98 m apart over
// the 12 km map. Corner to corner is the worst case: the search settles
// nearly every node before it reaches the far one.
const SIDE = 123;
const STEP = 12_000 / (SIDE - 1);
const grid = createRoadNetwork();
for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) addNode(grid, i * STEP, j * STEP, 0);
for (let j = 0; j < SIDE; j++) {
  for (let i = 0; i < SIDE; i++) {
    const id = j * SIDE + i;
    // Every seventh row is avenue, so routes are not all ties.
    const type = j % 7 === 0 ? 1 : 0;
    if (i + 1 < SIDE) addSegment(grid, id, id + 1, { type });
    if (j + 1 < SIDE) addSegment(grid, id, id + SIDE, { type: i % 7 === 0 ? 1 : 0 });
  }
}
const gridGraph = buildRoutingGraph(grid);
buildRoadIndex(grid);

// The random network the spatial index bench uses.
const random = createRoadNetwork();
growNetwork(random, 30_000, 30_000);
const randomGraph = buildRoutingGraph(random);

const POINTS = 256;
const xs = new Float64Array(POINTS * 2);
const zs = new Float64Array(POINTS * 2);
const rng = seedRng(77);
for (let i = 0; i < POINTS * 2; i++) {
  xs[i] = nextFloat(rng) * 12_000;
  zs[i] = nextFloat(rng) * 12_000;
}
let next = 0;

test("pathfinder on 30,000 segments", async ({ bench }) => {
  expect(segmentCount(grid)).toBe(30_012);
  expect(segmentCount(random)).toBe(30_000);
  const far = SIDE * SIDE - 1;
  expect(findRoute(gridGraph, 0, far).ok).toBe(true);
  const cases: Record<string, () => void> = {
    "grid, corner to corner": () => {
      findRoute(gridGraph, 0, far);
    },
    "grid, between random points": () => {
      next = (next + 2) % (POINTS * 2);
      findRouteBetween(gridGraph, xs[next] ?? 0, zs[next] ?? 0, xs[next + 1] ?? 0, zs[next + 1] ?? 0);
    },
    "random network, between random points": () => {
      next = (next + 2) % (POINTS * 2);
      findRouteBetween(randomGraph, xs[next] ?? 0, zs[next] ?? 0, xs[next + 1] ?? 0, zs[next + 1] ?? 0);
    },
    "rebuild the grid's routing graph": () => {
      buildRoutingGraph(grid);
    },
  };
  const meanMs: Record<string, number> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const file = `bench-results/route-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const result = await bench(name, { writeResult: file }, fn).run();
    meanMs[name] = result.latency.mean;
  }
  expect(meanMs["grid, corner to corner"]).toBeLessThan(ROUTE_TARGET_MS);
  expect(meanMs["grid, between random points"]).toBeLessThan(ROUTE_TARGET_MS);
}, 180_000);
