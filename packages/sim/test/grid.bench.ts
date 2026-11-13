// Timing for BuildRoadGrid on the M1 scale network: 30,000 segments. Run
// with `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3). Issue 20 asks for the step that
// applies a grid at the cap to be measured against the 20 ms tick budget,
// and the cap lowered if it does not fit.
//
// The cost is about one BuildRoad per link, and a link that splits an
// existing street costs several times one on open ground. On the
// development container a grid of 40 streets over existing streets took
// about 50 ms and one of 20 about 25 ms, so the cap is 14: a 6 by 6 block
// grid, about 11 ms laid over existing streets and 3 ms on open ground.

import { expect, test } from "vitest";
import { ROAD_BUILD } from "../src/roads/balance";
import { blockIndexOf, listBlocks } from "../src/roads/blocks";
import { buildRoadGrid, planRoadGrid } from "../src/roads/grid";
import {
  addNode,
  addSegment,
  createRoadNetwork,
  endJournal,
  reverseOps,
  segmentCount,
  startJournal,
  type NetworkOp,
  type RoadNetwork,
} from "../src/roads/network";
import { routingGraphOf } from "../src/roads/routing";
import { roadIndexOf } from "../src/roads/spatial";
import type { Terrain } from "../src/terrain/terrain";

/** What one tick may spend, in milliseconds. */
const TICK_BUDGET_MS = 20;

// Street grids 96 m apart, as in the blocks bench. The one the grid is laid
// over is 123 by 123 nodes, 30,012 segments. The open one is 126 by 126
// with no roads from node 40 to node 70 each way, 29,640 segments, so the
// grid lands on open ground in a city of the same size.
const STEP = 96;
const HOLE_FROM = 40;
const HOLE_TO = 70;

function network(side: number, hole: boolean): RoadNetwork {
  const inHole = (i: number, j: number) => hole && i >= HOLE_FROM && i <= HOLE_TO && j >= HOLE_FROM && j <= HOLE_TO;
  const net = createRoadNetwork();
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) addNode(net, i * STEP, j * STEP, 10);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const id = j * side + i;
      if (i + 1 < side && !(inHole(i, j) && inHole(i + 1, j))) addSegment(net, id, id + 1, { type: 0 });
      if (j + 1 < side && !(inHole(i, j) && inHole(i, j + 1))) addSegment(net, id, id + side, { type: 0 });
    }
  }
  // Everything a host keeps current, so each change pays for all of it.
  roadIndexOf(net);
  routingGraphOf(net);
  listBlocks(blockIndexOf(net));
  return net;
}

/** Flat dry ground 10 m up over a 12,800 m map, so every street is allowed. */
function flat(): Terrain {
  const samples = 800;
  const empty = new Uint8Array(samples * samples);
  return {
    seed: 0,
    samples,
    spacing: 16,
    heights: new Float32Array(samples * samples).fill(10),
    waterLevel: 0,
    fertile: empty,
    forest: empty,
    ore: empty,
    buildableShare: 1,
    attempts: 1,
  };
}

const terrain = flat();
const over = network(123, false);
const open = network(126, true);

// A grid at the cap, `gridMaxStreets / 2` lines each way. Blocks 86 m
// between edges put the lines 96 m apart, as the networks' are. It starts
// half a block off the network's lines, so over the full network every
// link crosses one existing street square in its middle and splits it.
const PER_SIDE = ROAD_BUILD.gridMaxStreets / 2;
const LINKS = 2 * PER_SIDE * (PER_SIDE - 1);
const START = (HOLE_FROM + 2) * STEP + STEP / 2;
const SPAN = (PER_SIDE - 1) * STEP;
const payload = {
  origin: { x: START, z: START },
  along: { x: START + SPAN, z: START },
  across: { x: START, z: START + SPAN },
  depth: 86,
  width: 86,
  type: "street",
};

/**
 * What the step does with one BuildRoadGrid (`applyIfValid` in
 * commands.ts): plans it, then builds it with the journal open.
 */
function applyGrid(net: RoadNetwork): NetworkOp[] {
  const result = planRoadGrid(net, terrain, payload);
  if (!result.ok) throw new Error(result.reason);
  startJournal(net);
  const problem = buildRoadGrid(net, terrain, result.plan);
  const ops = endJournal(net);
  if (problem) throw new Error(problem.reason);
  return ops;
}

test("BuildRoadGrid at the cap on 30,000 segments", async ({ bench }) => {
  expect(segmentCount(over)).toBe(30_012);
  expect(segmentCount(open)).toBe(29_640);
  const plan = planRoadGrid(over, terrain, payload);
  expect(plan.ok && plan.plan.lines).toBe(ROAD_BUILD.gridMaxStreets);
  // Over the network each link adds its own two pieces and the two the
  // street it splits becomes. On open ground it adds one.
  const overOps = applyGrid(over);
  expect(segmentCount(over)).toBe(30_012 + 3 * LINKS);
  reverseOps(over, overOps);
  const openOps = applyGrid(open);
  expect(segmentCount(open)).toBe(29_640 + LINKS);
  reverseOps(open, openOps);

  // Each run lays the grid and takes it back, so every run starts from the
  // same network. Taking it back costs a few milliseconds, so the times are
  // a little over what the step itself costs.
  const cases: Record<string, () => void> = {
    "the step that applies a grid at the cap, on open ground, and taking it back": () => reverseOps(open, applyGrid(open)),
    "the step that applies a grid at the cap, over existing streets, and taking it back": () => reverseOps(over, applyGrid(over)),
  };
  const meanMs: Record<string, number> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const file = `bench-results/grid-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const result = await bench(name, { writeResult: file }, fn).run();
    meanMs[name] = result.latency.mean;
  }
  expect(segmentCount(over)).toBe(30_012);
  expect(segmentCount(open)).toBe(29_640);
  // The tick budget is 20 ms, and each step must fit inside it.
  for (const ms of Object.values(meanMs)) expect(ms).toBeLessThan(TICK_BUDGET_MS);
}, 300_000);
