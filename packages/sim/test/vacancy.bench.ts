// Vacancy and abandonment on the M2 scale town (M3-24): the M1 scale city
// with every cell zoned and grown out. Run with `pnpm bench`, kept out of
// `pnpm test`. Vitest does the timing; nothing here reads the clock
// (CLAUDE.md rule 3).
//
// The town has no pops, so every building is empty. The vacancy check
// visits a hundredth of the buildings a tick. Three days are timed. On an
// ordinary one every building is in use and too new to go vacant, so each
// visit only finds it empty. The worst two change every building in the
// slice: every one vacant for three months, so each is abandoned, or every
// one abandoned with the bars at 100, so each looks at its ground and comes
// back. The budget holds the worse of those two days' mean tick.
//
// The grower asks how many abandoned buildings may come back on a tick it
// would add one: a pass over the buildings' flags, timed with every
// building in the town abandoned.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_VACANT, DEMAND_BALANCE, TIME_BALANCE, abandonedWaiting, cellsSettled, checkVacancy, prepareDerived, step, type BuildingState } from "../src/index";
import { buildingIdLimit } from "../src/buildings/buildings";
import { createPops } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { recountTotals } from "../src/stats/stats";
import { loadScaleTown } from "./scale-fixture";

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);
state.pops = createPops();
state.stats.totals = recountTotals(state);
popIndexOf(state);

const DAY = TIME_BALANCE.ticksPerDay;
const firstTick = Math.ceil((state.tick + DAY * DEMAND_BALANCE.vacancy.abandonDays) / DAY) * DAY;
const b = state.buildings;
const flags = b.flags.slice();
const since = b.statusSince.slice();
const totals = { ...state.stats.totals };
let live = 0;
for (const f of flags) if (f & BUILDING_ALIVE) live++;

/** Puts every live building in `status` since `at`, on the day's tick `k`, with every bar at `bar`. */
function reset(status: number, at: number, k: number, bar: number): void {
  const out: Pick<BuildingState, "flags" | "statusSince"> = { flags: flags.slice(), statusSince: since.slice() };
  for (let id = 0; id < out.flags.length; id++) {
    if (!(out.flags[id] ?? 0)) continue;
    out.flags[id] = BUILDING_ALIVE | status;
    out.statusSince[id] = at;
  }
  b.flags = out.flags;
  b.statusSince = out.statusSince;
  state.stats.totals = status === BUILDING_ABANDONED ? recountTotals(state) : { ...totals };
  for (const name of ["residential", "commercial", "office", "industrial"] as const) state.demand[name].value = bar;
  state.tick = firstTick + k;
}

test("vacancy and abandonment on the M2 scale town", async ({ bench, annotate }) => {
  expect(live).toBeGreaterThan(50_000);
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, beforeEach: () => void, iterations: number) => {
    const file = `bench-results/vacancy-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, beforeEach }, fn).run({ iterations, time: 0, warmupIterations: 2, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  let tick = 0;
  const ordinary = "the vacancy check on each tick of an ordinary day, every building in use and new, in turn";
  await run(ordinary, () => checkVacancy(state), () => reset(0, firstTick, tick++ % DAY, -50), DAY);

  tick = 0;
  const abandon = "the vacancy check on each tick of a day every building is abandoned, in turn";
  await run(abandon, () => checkVacancy(state), () => reset(BUILDING_VACANT, 0, tick++ % DAY, -50), DAY);
  let abandoned = 0;
  for (const f of b.flags) if (f & BUILDING_ABANDONED) abandoned++;

  tick = 0;
  const comeBack = "the vacancy check on each tick of a day every abandoned building comes back, in turn";
  await run(comeBack, () => checkVacancy(state), () => reset(BUILDING_ABANDONED, 0, tick++ % DAY, 100), DAY);
  let back = 0;
  for (const f of b.flags) if (f === BUILDING_ALIVE) back++;

  const waiting = "the grower's count of abandoned buildings that may come back, every building abandoned";
  let counted = 0;
  await run(waiting, () => void (counted = abandonedWaiting(state).reduce((sum, n) => sum + n, 0)), () => reset(BUILDING_ABANDONED, 0, 0, 100), 20);

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingIdLimit(b),
    live,
    town: town.buildings,
    buildingsPerTick: Math.ceil(buildingIdLimit(b) / DAY),
    abandonedOnTheLastTickTimed: abandoned,
    backInUseOnTheLastTickTimed: back,
    waitingToComeBack: counted,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-24 vacancy");

  // Both worst days, each under its own name. Holding only the slower of
  // the two named the case by which one won, and a change measured against
  // the commit before it then found no figure there when the other had
  // (issue #319).
  for (const day of [abandon, comeBack]) hold("vacancy.tick", day, { mean: meanMs[day] ?? 0, max: maxMs[day] ?? 0 });
  hold("vacancy.waiting", waiting, { mean: meanMs[waiting] ?? 0, max: maxMs[waiting] ?? 0 });
}, 600_000);
