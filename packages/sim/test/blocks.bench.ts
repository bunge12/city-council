// Timing for the blocks on the M1 scale network: 30,000 segments. Run with
// `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3). Issue 18 asks for the cost of
// bringing the blocks up to date after one BuildRoad to be measured and
// recorded.

import { expect, test } from "vitest";
import { blockById, blockIndexOf, buildBlockIndex, listBlocks } from "../src/roads/blocks";
import { buildRoad, planRoad, type RoadPlan } from "../src/roads/build";
import {
  addNode,
  addSegment,
  createRoadNetwork,
  endJournal,
  restoreNode,
  restoreSegment,
  restyleSegment,
  segmentCount,
  startJournal,
  unaddNode,
  unaddSegment,
  type NetworkOp,
  type RoadNetwork,
} from "../src/roads/network";
import { roadIndexOf } from "../src/roads/spatial";
import type { Terrain } from "../src/terrain/terrain";

// A street grid of 123 by 123 nodes 96 m apart, 30,012 segments and 14,884
// blocks over the map, as in the routing bench but on the build grid.
const SIDE = 123;
const STEP = 96;

function grid(): RoadNetwork {
  const net = createRoadNetwork();
  for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) addNode(net, i * STEP, j * STEP, 10);
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const id = j * SIDE + i;
      if (i + 1 < SIDE) addSegment(net, id, id + 1, { type: 0 });
      if (j + 1 < SIDE) addSegment(net, id, id + SIDE, { type: 0 });
    }
  }
  return net;
}

/** Flat dry ground 10 m up over a 12,288 m map, so every street the bench draws is allowed. */
function flat(): Terrain {
  const samples = 768;
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

/** A street north to south through the middle of the block at column `i`, row `j`, splitting the streets either side. */
function crossStreet(net: RoadNetwork, i: number, j: number): RoadPlan {
  const x = i * STEP + STEP / 2;
  const result = planRoad(net, terrain, { from: { x, z: j * STEP }, to: { x, z: (j + 1) * STEP }, type: "street" });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.plan;
}

/** Builds `plan` while a journal is open and returns what it changed. */
function build(net: RoadNetwork, plan: RoadPlan): NetworkOp[] {
  startJournal(net);
  buildRoad(net, terrain, plan);
  return endJournal(net);
}

/** Reverses `ops` the way undo does, so the next round starts from the same grid. */
function reverse(net: RoadNetwork, ops: readonly NetworkOp[]): void {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as NetworkOp;
    if (op.op === "addNode") unaddNode(net, op.id, op.grown);
    else if (op.op === "removeNode") restoreNode(net, op.id, op.x, op.z, op.height, op.flags);
    else if (op.op === "addSeg") unaddSegment(net, op.id, op.grown);
    else if (op.op === "removeSeg") restoreSegment(net, op.id, op.row, op.atA, op.atB);
    else restyleSegment(net, op.id, op.from, op.reverse);
  }
}

// One grid with blocks kept current and one without, each with the spatial
// index BuildRoad uses, so the difference is what the blocks cost.
const withBlocks = grid();
roadIndexOf(withBlocks);
const blocks = blockIndexOf(withBlocks);
const without = grid();
roadIndexOf(without);

const MIDDLE = (SIDE - 1) / 2;
const planWith = crossStreet(withBlocks, MIDDLE, MIDDLE);
const planWithout = crossStreet(without, MIDDLE, MIDDLE);
let undoWith: NetworkOp[] = [];
let undoWithout: NetworkOp[] = [];

test("blocks on 30,000 segments", async ({ bench }) => {
  expect(segmentCount(withBlocks)).toBe(30_012);
  expect(listBlocks(blocks)).toHaveLength((SIDE - 1) * (SIDE - 1));
  // The street splits one block in two and nothing else.
  reverse(withBlocks, build(withBlocks, planWith));
  undoWith = build(withBlocks, planWith);
  expect(listBlocks(blocks)).toHaveLength((SIDE - 1) * (SIDE - 1) + 1);
  reverse(withBlocks, undoWith);
  expect(listBlocks(blocks)).toHaveLength((SIDE - 1) * (SIDE - 1));

  const cases: Record<string, [fn: () => void, after: () => void]> = {
    // A BuildRoad through a block with blocks kept current, and one read
    // after, which walks the faces it touched. A lookup by id is the
    // cheapest read; listing all 14,884 blocks costs a sort on top.
    "one BuildRoad through a block, blocks brought up to date": [
      () => {
        undoWith = build(withBlocks, planWith);
        blockById(blocks, 0);
      },
      () => {
        reverse(withBlocks, undoWith);
        blockById(blocks, 0);
      },
    ],
    // The same BuildRoad on a grid with no blocks, for the difference.
    "the same BuildRoad with no blocks": [
      () => {
        undoWithout = build(without, planWithout);
      },
      () => reverse(without, undoWithout),
    ],
    "list every block": [() => void listBlocks(blocks), () => undefined],
    "rebuild every block": [() => void blockById(buildBlockIndex(withBlocks), 0), () => undefined],
  };
  const meanMs: Record<string, number> = {};
  for (const [name, [fn, after]] of Object.entries(cases)) {
    const file = `bench-results/blocks-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const result = await bench(name, { writeResult: file, afterEach: after }, fn).run();
    meanMs[name] = result.latency.mean;
  }
  expect(listBlocks(blocks)).toEqual(listBlocks(buildBlockIndex(withBlocks)));
  // Bringing the blocks up to date is a small part of a BuildRoad, far
  // below a rebuild.
  expect(meanMs["one BuildRoad through a block, blocks brought up to date"]).toBeLessThan((meanMs["rebuild every block"] ?? 0) / 10);
}, 180_000);
