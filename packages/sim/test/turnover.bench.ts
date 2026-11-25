// Turnover on the M2 scale town (M3-11): the M1 scale city with every cell
// zoned and grown out. Run with `pnpm bench`, kept out of `pnpm test`.
// Vitest does the timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// The town's homes hold 150,000 pops, cut as satisfaction.bench.ts cuts
// them, none with a job. The day's sweep gives each tick a hundredth of
// them, 1,500 pops. Two days are timed. On an ordinary one each pop in the
// slice takes its one draw at the rates in pops.json, so a tick sees an
// event or none. The worst is every pop in the slice replaced: each
// household moves out, frees its home and a newcomer is drawn for it. No
// city meets that, as replacement is a few percent of pops a year, but it
// bounds the system's tick. The budget holds the worst day's mean tick.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import { POPS_BALANCE, TIME_BALANCE, cellsSettled, cutPeople, popCount, popIdLimit, prepareDerived, step, turnOver, yearDays, type PopState } from "../src/index";
import { buildingIdLimit } from "../src/buildings/buildings";
import { addPop, createPops } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { loadScaleTown } from "./scale-fixture";

const TARGET = 150_000;

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);

// The town's homes cut into TARGET pops, as satisfaction.bench.ts does, none with a job.
const homes: { home: number; room: number; density: number }[] = [];
for (let id = 0; id < buildingIdLimit(state.buildings); id++) {
  const room = state.buildings.residents[id] ?? 0;
  if (state.buildings.flags[id] && room > 0) homes.push({ home: id, room, density: state.buildings.density[id] ?? 1 });
}
const totalRoom = homes.reduce((sum, h) => sum + h.room, 0);
const size = Math.max(1, Math.floor(totalRoom / TARGET));
state.pops = createPops();
let n = 0;
for (const h of homes) {
  if (n >= TARGET) break;
  const count = Math.max(cutPeople(h.room, h.density).length, Math.floor((h.room + size - 1) / size));
  for (let i = 0; i < count && n < TARGET; i++) {
    const people = Math.floor(h.room / count) + (i < h.room % count ? 1 : 0);
    addPop(state, { home: h.home, size: people, education: n % 3, wealth: (n >> 2) % 3, children: (n >> 4) & 1, satisfaction: 50 });
    n++;
  }
}

/** The pops as they stand, to put back before each run. */
function copyPops(p: PopState): PopState {
  return {
    flags: p.flags.slice(),
    home: p.home.slice(),
    work: p.work.slice(),
    size: p.size.slice(),
    education: p.education.slice(),
    wealth: p.wealth.slice(),
    children: p.children.slice(),
    satisfaction: p.satisfaction.slice(),
    daysLow: p.daysLow.slice(),
    graceDays: p.graceDays.slice(),
    free: p.free.slice(),
    sweep: p.sweep,
    owed: p.owed,
    leaveScore: p.leaveScore,
    leaveAtScore: p.leaveAtScore,
    displaced: p.displaced.slice(),
  };
}

const DAY = TIME_BALANCE.ticksPerDay;
const firstTick = Math.ceil(state.tick / DAY) * DAY;
state.pops.sweep = popIdLimit(state.pops);
const pops = copyPops(state.pops);
const stats = structuredClone(state.stats);
const rng = state.rng.slice();

/** Puts the pops back, the index built, on the day's tick `k`. */
function reset(k: number): void {
  state.pops = copyPops(pops);
  state.stats = structuredClone(stats);
  state.rng = rng.slice();
  state.tick = firstTick + k;
  popIndexOf(state);
}

test("turnover on the M2 scale town", async ({ bench, annotate }) => {
  expect(popCount(state.pops)).toBe(TARGET);
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, beforeEach: () => void, iterations: number) => {
    const file = `bench-results/turnover-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, beforeEach }, fn).run({ iterations, time: 0, warmupIterations: 2, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  let tick = 0;
  const day = "the turnover system on each tick of an ordinary day, in turn";
  await run(day, () => turnOver(state), () => reset(tick++ % DAY), DAY);
  const ordinaryEvents = Object.values(state.stats.year).reduce((a, b) => a + b, 0) - Object.values(stats.year).reduce((a, b) => a + b, 0);

  tick = 0;
  const worst = "the turnover system on each tick of a day with every pop in the slice replaced, in turn";
  // Set and put back around the await: withValue would put it back before the runs.
  const rate = POPS_BALANCE.turnover.replacementsPerPopYear;
  POPS_BALANCE.turnover.replacementsPerPopYear = yearDays();
  try {
    await run(worst, () => turnOver(state), () => reset(tick++ % DAY), DAY);
  } finally {
    POPS_BALANCE.turnover.replacementsPerPopYear = rate;
  }
  const replacedOnLastTick = state.stats.year.departures - stats.year.departures;

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingIdLimit(state.buildings),
    homes: homes.length,
    town: town.buildings,
    pops: TARGET,
    popsPerTick: TARGET / DAY,
    peopleCountedOnTheLastOrdinaryTick: ordinaryEvents,
    peopleReplacedOnTheLastWorstTick: replacedOnLastTick,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-11 turnover");

  hold("turnover.tick", worst, { mean: meanMs[worst] ?? 0, max: maxMs[worst] ?? 0 });
}, 600_000);
