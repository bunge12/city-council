// Timing for the crossing check of issue 22 on the M1 scale network: 30,000
// segments. Run with `pnpm bench`, kept out of `pnpm test`. Vitest does the
// timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// A road on another level meets every segment it passes over or under, and
// each meeting compares the two heights there. The worst case in M1 is a
// long raised road over a dense street grid, so this times one 5 km long
// over 52 streets, beside the ground road on the same line, which splits
// all 52 instead. On the development container the raised road plans in
// about 0.2 ms (p99 0.5 ms), and the step that builds it and takes it back
// in about 0.26 ms; the ground road on the same line takes about 2.6 ms.
//
// The check costs almost nothing on a city mostly on one level: it asks the
// index once per road for segments on other levels, and the grid bench
// (grid.bench.ts) shows no more than noise from it.

import { expect, test } from "vitest";
import { blockIndexOf, listBlocks } from "../src/roads/blocks";
import { buildRoad, planRoad } from "../src/roads/build";
import {
  addNode,
  addSegment,
  createRoadNetwork,
  endJournal,
  reverseOps,
  segmentCount,
  startJournal,
  type RoadNetwork,
} from "../src/roads/network";
import { routingGraphOf } from "../src/roads/routing";
import { roadIndexOf } from "../src/roads/spatial";
import type { Terrain } from "../src/terrain/terrain";

/** What one tick may spend, in milliseconds. */
const TICK_BUDGET_MS = 20;

// A street grid 96 m apart, 123 by 123 nodes: 30,012 segments, as the
// grid and blocks benches use.
const STEP = 96;
const SIDE = 123;

function network(): RoadNetwork {
  const net = createRoadNetwork();
  for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) addNode(net, i * STEP, j * STEP, 10);
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const id = j * SIDE + i;
      if (i + 1 < SIDE) addSegment(net, id, id + 1, { type: 0 });
      if (j + 1 < SIDE) addSegment(net, id, id + SIDE, { type: 0 });
    }
  }
  // Everything a host keeps current, so each change pays for all of it.
  roadIndexOf(net);
  routingGraphOf(net);
  listBlocks(blockIndexOf(net));
  return net;
}

/** Flat dry ground 10 m up over a 12,800 m map. */
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
const net = network();

// Halfway between two rows of the grid, from just past column 10 to just
// past column 62: it crosses 52 north-south streets in their middles.
const Z = 60 * STEP + STEP / 2;
const road = (level?: string) => ({
  from: { x: 10 * STEP + STEP / 2, z: Z },
  to: { x: 62 * STEP + STEP / 2, z: Z },
  type: "street",
  ...(level ? { level } : {}),
});
const CROSSED = 52;

/** What the step does with one BuildRoad: plans it and builds it with the journal open, then takes it back. */
function applyAndUndo(payload: unknown): void {
  const result = planRoad(net, terrain, payload);
  if (!result.ok) throw new Error(result.reason);
  startJournal(net);
  buildRoad(net, terrain, result.plan);
  reverseOps(net, endJournal(net));
}

test("the crossing check on 30,000 segments", async ({ bench }) => {
  expect(segmentCount(net)).toBe(30_012);
  const raised = planRoad(net, terrain, road("elevated1"));
  expect(raised.ok && raised.plan.stops.length).toBe(2);
  const ground = planRoad(net, terrain, road());
  expect(ground.ok && ground.plan.stops.length).toBe(CROSSED + 2);

  const cases: Record<string, () => void> = {
    "planRoad, an elevated road over 52 streets": () => planRoad(net, terrain, road("elevated1")),
    "planRoad, the same road on the ground, splitting 52 streets": () => planRoad(net, terrain, road()),
    "the step that builds the elevated road, and taking it back": () => applyAndUndo(road("elevated1")),
  };
  const meanMs: Record<string, number> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const file = `bench-results/levels-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    const result = await bench(name, { writeResult: file }, fn).run();
    meanMs[name] = result.latency.mean;
  }
  expect(segmentCount(net)).toBe(30_012);
  for (const ms of Object.values(meanMs)) expect(ms).toBeLessThan(TICK_BUDGET_MS);
}, 300_000);
