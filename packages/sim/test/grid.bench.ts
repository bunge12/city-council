// Timing for BuildRoadGrid on the M1 scale network: 30,000 segments. Run
// with `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3). Issue 20 asks for the step that
// applies a grid at the cap to be measured against the 20 ms tick budget,
// and the cap lowered if it does not fit.
//
// The cost is about one BuildRoad per link, and a link that splits an
// existing street costs several times one on open ground, so the cap counts
// street sections, with each meeting with an existing road counted as
// `gridMeetingSections` of them (issue 88). The two cases are the two ends
// of that: a grid at the cap on open ground, every section new, and one at
// the cap over existing streets, every section splitting one.

import { expect, test } from "vitest";
import { budget, collect } from "./budget";
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

// Grids near the cap, `along` by `across` lines. Blocks 86 m between edges
// put the lines 96 m apart, as the networks' are. They start half a block
// off the network's lines, so over the full network every link crosses one
// existing street square in its middle and splits it.
const START = (HOLE_FROM + 2) * STEP + STEP / 2;
const sectionsOf = (along: number, across: number): number => along * (across - 1) + across * (along - 1);

/**
 * The near-square grid, `along` by `along` or `along + 1` lines, with the
 * most sections whose work, each section meeting `meetings` roads, fits the
 * cap. Long thin grids fit more sections, but cost the same per section.
 */
function atCap(meetings: number): { along: number; across: number } {
  let best = { along: 2, across: 2 };
  for (let along = 2; along < 40; along++) {
    for (const across of [along, along + 1]) {
      const work = sectionsOf(along, across) * (1 + meetings * ROAD_BUILD.gridMeetingSections);
      if (work <= ROAD_BUILD.gridMaxSections && sectionsOf(along, across) > sectionsOf(best.along, best.across)) best = { along, across };
    }
  }
  return best;
}

function payloadOf(size: { along: number; across: number }) {
  return {
    origin: { x: START, z: START },
    along: { x: START + (size.along - 1) * STEP, z: START },
    across: { x: START, z: START + (size.across - 1) * STEP },
    depth: 86,
    width: 86,
    type: "street",
  };
}

// 13 by 14 lines on open ground, 337 sections; 5 by 6 over the streets, 49 sections and 49 meetings.
const openSize = atCap(0);
const overSize = atCap(1);
const openPayload = payloadOf(openSize);
const overPayload = payloadOf(overSize);

/**
 * What the step does with one BuildRoadGrid (`applyIfValid` in
 * commands.ts): plans it, then builds it with the journal open.
 */
function applyGrid(net: RoadNetwork, payload: ReturnType<typeof payloadOf>): NetworkOp[] {
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
  const overLinks = sectionsOf(overSize.along, overSize.across);
  const openLinks = sectionsOf(openSize.along, openSize.across);
  const overPlan = planRoadGrid(over, terrain, overPayload);
  const openPlan = planRoadGrid(open, terrain, openPayload);
  expect(overPlan.ok && overPlan.plan.meetings).toBe(overLinks);
  expect(openPlan.ok && openPlan.plan.meetings).toBe(0);
  // Near the cap: one more line along either side would be over it.
  for (const plan of [overPlan, openPlan]) {
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.work).toBeLessThanOrEqual(ROAD_BUILD.gridMaxSections);
    expect(plan.plan.work * 1.2).toBeGreaterThan(ROAD_BUILD.gridMaxSections);
  }
  // Over the network each link adds its own two pieces and the two the
  // street it splits becomes. On open ground it adds one.
  const overOps = applyGrid(over, overPayload);
  expect(segmentCount(over)).toBe(30_012 + 3 * overLinks);
  reverseOps(over, overOps);
  const openOps = applyGrid(open, openPayload);
  expect(segmentCount(open)).toBe(29_640 + openLinks);
  reverseOps(open, openOps);

  // Each run lays the grid and takes it back, so every run starts from the
  // same network. Taking it back costs a few milliseconds, so the times are
  // a little over what the step itself costs.
  const cases: Record<string, () => void> = {
    "the step that applies a grid at the cap, on open ground, and taking it back": () => reverseOps(open, applyGrid(open, openPayload)),
    "the step that applies a grid at the cap, over existing streets, and taking it back": () => reverseOps(over, applyGrid(over, overPayload)),
  };
  const meanMs: Record<string, number> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const file = `bench-results/grid-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const result = await bench(name, { writeResult: file }, fn).run();
    meanMs[name] = result.latency.mean;
  }
  expect(segmentCount(over)).toBe(30_012);
  expect(segmentCount(open)).toBe(29_640);
  // The tick budget is 20 ms, and each step must fit inside it.
  for (const [name, ms] of Object.entries(meanMs)) expect(ms, budget(name)).toBeLessThan(TICK_BUDGET_MS);
}, 300_000);
