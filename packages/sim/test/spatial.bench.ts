// Timing for the road spatial index on the M1 scale network: 30,000
// segments. Run with `pnpm bench`, kept out of `pnpm test`. Vitest does the
// timing; nothing here reads the clock (CLAUDE.md rule 3). The target from
// issue 02 is under 0.1 ms for one nearest-segment query, on average
// (`spatial.nearest-segment` in balance/budgets.json).

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { nextFloat, seedRng } from "../src/rng";
import { createRoadNetwork, segmentCount } from "../src/roads/network";
import { buildRoadIndex, nearestNode, nearestPointOnSegment, segmentsInBox } from "../src/roads/spatial";
import { growNetwork } from "./road-network-helper";

const net = createRoadNetwork();
growNetwork(net, 30_000, 30_000);
const index = buildRoadIndex(net);

// A fixed set of query points, so every run asks the same questions.
const POINTS = 4096;
const xs = new Float64Array(POINTS);
const zs = new Float64Array(POINTS);
const rng = seedRng(99);
for (let i = 0; i < POINTS; i++) {
  xs[i] = nextFloat(rng) * 12_000;
  zs[i] = nextFloat(rng) * 12_000;
}
let next = 0;
function point(): number {
  next = (next + 1) % POINTS;
  return next;
}

test("road spatial index on 30,000 segments", async ({ bench }) => {
  expect(segmentCount(net)).toBe(30_000);
  const cases: Record<string, () => void> = {
    "nearest point on a segment, 50 m": () => {
      const i = point();
      nearestPointOnSegment(index, xs[i] ?? 0, zs[i] ?? 0, 50);
    },
    "nearest point on a segment, 250 m": () => {
      const i = point();
      nearestPointOnSegment(index, xs[i] ?? 0, zs[i] ?? 0, 250);
    },
    "nearest node, 50 m": () => {
      const i = point();
      nearestNode(index, xs[i] ?? 0, zs[i] ?? 0, 50);
    },
    "segments in a 200 m box": () => {
      const i = point();
      segmentsInBox(index, xs[i] ?? 0, zs[i] ?? 0, (xs[i] ?? 0) + 200, (zs[i] ?? 0) + 200);
    },
    "rebuild the whole index": () => {
      buildRoadIndex(net);
    },
  };
  const latency: Record<string, { mean: number }> = {};
  for (const [name, fn] of Object.entries(cases)) {
    // Vitest writes each result under bench-results/ and prints the table.
    const file = `bench-results/${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const result = await bench(name, { writeResult: file }, fn).run();
    latency[name] = result.latency;
  }
  for (const name of ["nearest point on a segment, 50 m", "nearest point on a segment, 250 m"]) hold("spatial.nearest-segment", name, latency[name] ?? {});
}, 120_000);
