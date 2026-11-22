// The demand bars on the M2 scale town (M3-06): the M1 scale city with every
// cell zoned and grown out. Run with `pnpm bench`, kept out of `pnpm test`.
// Vitest does the timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// The bars read the running totals and one count of roads that reach
// outside, so the system's worst tick, a day's first, costs the same in any
// city. The count is derived: the step that changes roads works it out again
// (derived.ts, `catchUpDerived`), and that rebuild is timed here too, on the
// town's 30,000 segments, with what a load pays for it.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { TIME_BALANCE, buildingCount, cellsSettled, prepareDerived, segmentsReachingOutside, step } from "../src/index";
import { updateDemand } from "../src/demand/demand";
import { catchUpOutside, prepareOutside } from "../src/roads/outside";
import { cloneState } from "../src/state";
import { addNode, addSegment } from "../src/roads/network";
import { loadScaleTown } from "./scale-fixture";

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);

test("demand on the M2 scale town", async ({ bench, annotate }) => {
  expect(buildingCount(state.buildings)).toBe(town.buildings);
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, hooks: { beforeEach?: () => void } = {}, iterations = 1000) => {
    const file = `bench-results/demand-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run({ iterations, time: 0, warmupIterations: 1, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  const day = TIME_BALANCE.ticksPerDay;
  const tick = "the demand system on a day's first tick";
  const at = Math.ceil(state.tick / day) * day;
  await run(tick, () => updateDemand(state), { beforeEach: () => void (state.tick = at) });

  // A new segment on a node of the town marks the answer stale, as a change of roads does.
  const net = state.roads;
  const rebuild = "working out which roads reach outside again, after a change of roads";
  await run(rebuild, () => catchUpOutside(net), {
    beforeEach: () => {
      const a = addNode(net, 100, 100, 0);
      addSegment(net, a, addNode(net, 120, 100, 0), { type: 0 });
    },
  }, 30);
  await run("the same on a load, from nothing", () => prepareOutside(cloneState(state)), {}, 5);

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingCount(state.buildings),
    segmentsReachingOutside: segmentsReachingOutside(state),
    demand: Object.fromEntries(Object.entries(state.demand).map(([bar, b]) => [bar, round(b.value)])),
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([k, v]) => [k, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-06 demand");

  hold("demand.tick", tick, { mean: meanMs[tick] });
  hold("demand.outside", rebuild, { mean: meanMs[rebuild] });
}, 600_000);
