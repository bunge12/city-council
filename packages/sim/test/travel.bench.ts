// Timings for the travel times between zones (issue #177) on the M1 scale
// city, 30,000 segments. Run with `pnpm bench`, kept out of `pnpm test`.
// Vitest does the timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// Records the full build, as a load does; the steps of the rebuild after
// one BuildRoad, each held to the tick budget; the table's memory; and one
// query.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { TRAVEL_ZONES, planRoad, prepareDerived, step, submit, travelTimesReady, zoneTravelTime, type BuildRoadPayload } from "../src/index";
import { ROUTING_BALANCE } from "../src/roads/routing";
import { terrainOf } from "../src/terrain/cache";
import { rebuildTravelTimesNow, travelTimesBytes, travelZoneSources } from "../src/travel-times";
import { loadScaleCity } from "./scale-fixture";

const LINE = 96;
const SPAN = 6 * LINE;

const { state, grids } = loadScaleCity();
const net = state.roads;
const terrain = terrainOf(state.seed);
// Everything a host keeps current, the travel times among it.
prepareDerived(state);
// The generator leaves thousands of ticks of zoning cells to settle, and an
// Undo waits for them, so the city settles first, as a game left running does.
while (state.tick < state.cellsReadyAt) step(state);

/** A street a quarter of the way into a row of one of the city's grids, crossing several of its streets. */
function crossing(): BuildRoadPayload {
  for (const g of grids) {
    const z = g.z + 24;
    const payload = { from: { x: g.x - 24, z }, to: { x: g.x + SPAN, z }, type: "street" };
    if (planRoad(net, terrain, payload).ok) return payload;
  }
  throw new Error("no street fits across a grid");
}

const road = crossing();
let seq = 1;
const send = (type: string, payload: unknown): void => {
  const result = submit(state, { seq: seq++, playerId: "bench", type, payload });
  if (!result.ok) throw new Error(result.reason);
};

/** Takes the street back and lets the rebuild finish, so every run starts from the same city. */
function takeBack(): void {
  send("Undo", {});
  // It waits for the street's own cells to settle, a tick or two.
  for (let i = 0; state.pending.length > 0; i++) {
    const dropped = step(state);
    if (dropped.length > 0 || i > 100) throw new Error(`the undo did not apply: ${dropped[0]?.reason ?? "it waits"}`);
  }
  while (!travelTimesReady(state)) step(state);
}

/** Steps through a rebuild, counting its steps. */
function settleSteps(): number {
  let steps = 0;
  while (!travelTimesReady(state)) {
    step(state);
    steps++;
  }
  return steps;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

test("travel times between zones on the scale city", async ({ bench, annotate }) => {
  const sources = travelZoneSources(state);
  const zones = [...sources.keys()].filter((z) => (sources[z] ?? -1) >= 0);
  const bytes = travelTimesBytes(state);

  // How long a rebuild after one BuildRoad is given, and the memory while it runs.
  send("BuildRoad", road);
  step(state);
  const rebuildTicks = state.travelReadyAt - state.tick + 1;
  step(state);
  const steps = settleSteps() + 2;
  takeBack();
  expect(steps).toBe(rebuildTicks);

  let pair = 0;
  const cases: Record<string, { fn: () => void; beforeEach?: () => void; afterEach?: () => void }> = {
    "build the whole table, as a load does": { fn: () => rebuildTravelTimesNow(state) },
    "the step that applies one BuildRoad, the travel times left to rebuild": {
      beforeEach: () => send("BuildRoad", road),
      fn: () => void step(state),
      afterEach: takeBack,
    },
    "the first step of the rebuild after it, which compacts the graph": {
      beforeEach: () => {
        send("BuildRoad", road);
        step(state);
      },
      fn: () => void step(state),
      afterEach: takeBack,
    },
    "the second step, which builds the first rows": {
      beforeEach: () => {
        send("BuildRoad", road);
        step(state);
        step(state);
      },
      fn: () => void step(state),
      afterEach: takeBack,
    },
    "a step in the middle of the rebuild": {
      beforeEach: () => {
        send("BuildRoad", road);
        step(state);
        for (let i = Math.floor(rebuildTicks / 2); i > 0; i--) step(state);
      },
      fn: () => void step(state),
      afterEach: takeBack,
    },
    "the last step of the rebuild": {
      beforeEach: () => {
        send("BuildRoad", road);
        step(state);
        while (state.travelReadyAt - state.tick > 1) step(state);
      },
      fn: () => void step(state),
      afterEach: takeBack,
    },
    "one step with no rebuild under way, for comparison": { fn: () => void step(state) },
    "one travel time between two zones": {
      fn: () => {
        pair = (pair + 7) % (zones.length * zones.length);
        zoneTravelTime(state, zones[Math.floor(pair / zones.length)] ?? 0, zones[pair % zones.length] ?? 0);
      },
    },
  };
  const fixedRuns = (runs: number) => ({ iterations: runs, time: 0, warmupIterations: 1, warmupTime: 0 });
  const runsOf: Record<string, ReturnType<typeof fixedRuns> | undefined> = {
    "build the whole table, as a load does": fixedRuns(5),
    "the step that applies one BuildRoad, the travel times left to rebuild": fixedRuns(8),
    "the first step of the rebuild after it, which compacts the graph": fixedRuns(8),
    "the second step, which builds the first rows": fixedRuns(8),
    "a step in the middle of the rebuild": fixedRuns(8),
    "the last step of the rebuild": fixedRuns(8),
  };
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  for (const [name, { fn, ...hooks }] of Object.entries(cases)) {
    const file = `bench-results/travel-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const result = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run(runsOf[name]);
    meanMs[name] = result.latency.mean;
    maxMs[name] = result.latency.max;
  }
  expect(travelTimesReady(state)).toBe(true);

  const report = {
    zones: { all: TRAVEL_ZONES, withRoad: zones.length },
    rebuild: { ticks: rebuildTicks, settlesPerTick: ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick },
    memory: { tableBytes: bytes.table, rebuildBufferBytes: bytes.buffers },
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([k, v]) => [k, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "travel times");

  // The table is about 660 KB, two bytes a pair, rebuilt in place; the
  // compacted graph and the search's scratch are kept between rebuilds.
  expect(bytes.table).toBeLessThan(1 << 20);
  expect(bytes.table + bytes.buffers).toBeLessThan(3 << 20);
  for (const name of [
    "the step that applies one BuildRoad, the travel times left to rebuild",
    "the first step of the rebuild after it, which compacts the graph",
    "the second step, which builds the first rows",
    "a step in the middle of the rebuild",
    "the last step of the rebuild",
    "one step with no rebuild under way, for comparison",
  ]) {
    hold("scale.step", name, { mean: meanMs[name] });
  }
  hold("travel.query", "one travel time between two zones", { mean: meanMs["one travel time between two zones"] });
}, 600_000);
