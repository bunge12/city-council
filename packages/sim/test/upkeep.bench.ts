// Road upkeep on the scale city of 500,000 residents (M4-04). Run with
// `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3).
//
// The upkeep system reads the yearly total the road network keeps as a
// running sum, so a tick that charges does no more than one that does not.
// Timed: the system on each tick of a day, in turn, and on the day's first
// tick alone, the one that charges, which the budget holds. The running sum
// built from the segments, as a load builds it, is timed for comparison and
// not held: no tick pays it.

import { expect, test } from "vitest";
import { LINE, TIME_BALANCE, chargeUpkeep, prepareDerived, recountRoadUpkeep, roadUpkeepPerYear } from "../src/index";
import { segmentCount } from "../src/roads/network";
import { collect, hold } from "./budget";
import { generate } from "./scale-cities";

const RESIDENTS = 500_000;
const DAY = TIME_BALANCE.ticksPerDay;

test("road upkeep on the scale city of 500,000 residents", async ({ bench, annotate }) => {
  const { state } = generate(RESIDENTS);
  prepareDerived(state);
  const yearly = roadUpkeepPerYear(state.roads);
  expect(yearly).toBe(recountRoadUpkeep(state.roads));
  expect(yearly).toBeGreaterThan(0);
  const firstDay = Math.ceil(state.tick / DAY) * DAY;
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, beforeEach: () => void, iterations: number) => {
    const file = `bench-results/upkeep-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, beforeEach }, fn).run({ iterations, time: 0, warmupIterations: 5, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  let k = 0;
  const eachTick = "the upkeep system on each tick of a day, in turn";
  await run(eachTick, () => chargeUpkeep(state), () => void (state.tick = firstDay + (k++ % DAY)), DAY);

  let day = 0;
  const charging = "the upkeep system on a day's first tick, which charges the day's share";
  const before = state.budget.month[LINE.roadUpkeep] as number;
  await run(charging, () => chargeUpkeep(state), () => void (state.tick = firstDay + DAY * (day++ % 365)), 200);
  expect(state.budget.month[LINE.roadUpkeep]).toBeGreaterThan(before);

  let rebuilt = 0;
  const recount = "the yearly total counted from the segments, as a load builds it, for comparison";
  await run(recount, () => void (rebuilt = recountRoadUpkeep(state.roads)), () => undefined, 20);
  expect(rebuilt).toBe(yearly);

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    residents: RESIDENTS,
    segments: segmentCount(state.roads),
    yearlyRoadUpkeep: yearly,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M4-04 upkeep");
  console.log(JSON.stringify(report, null, 2));

  hold("upkeep.tick", charging, { mean: meanMs[charging] ?? 0, max: maxMs[charging] ?? 0 });
}, 600_000);
