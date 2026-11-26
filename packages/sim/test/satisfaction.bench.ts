// Satisfaction on the M2 scale town (M3-10): the M1 scale city with every
// cell zoned and grown out. Run with `pnpm bench`, kept out of `pnpm test`.
// Vitest does the timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// The town's homes hold 150,000 pops, cut as jobs.bench.ts cuts them, none
// with a job. The day's sweep gives each tick a hundredth of them, 1,500
// pops. Two days are timed. On an ordinary one every pop in the slice
// takes a step toward its target. The worst is an exodus: every pop one day
// from running out of patience and the residential bar at -100, so every
// pop in the slice moves out, freeing its home, on top of the bar's plan.
// The budget holds the exodus's mean tick: its worst is the mean with a
// collection of the freed rows on top.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import {
  POPS_BALANCE,
  TIME_BALANCE,
  WAITING_PART,
  cellsSettled,
  cutPeople,
  popCount,
  popIdLimit,
  prepareDerived,
  step,
  updateSatisfaction,
  type PopState,
} from "../src/index";
import { buildingIdLimit } from "../src/buildings/buildings";
import { addPop, createPops } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { loadScaleTown } from "./scale-fixture";

const TARGET = 150_000;

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);


// The town's homes cut into TARGET pops, as pops.bench.ts does, none with a job.
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
const ordinary = copyPops(state.pops);
// Every pop at the bottom and a day from leaving.
const leaving = copyPops(state.pops);
leaving.satisfaction.fill(0);
leaving.daysLow.fill(POPS_BALANCE.satisfaction.leaveAfterDays - 1);
const stats = structuredClone(state.stats);
const demand = structuredClone(state.demand);

/**
 * Puts the pops back as `pops` has them, the index built, on the day's tick
 * `k`, with the residential bar at `bar`. On a later tick than the first
 * the bar's plan is as a new day would leave it before its first tick, so
 * the pops leave on their own patience, which is every one in an exodus.
 */
function reset(pops: PopState, k: number, bar: number): void {
  state.pops = copyPops(pops);
  state.stats = structuredClone(stats);
  state.demand = structuredClone(demand);
  state.demand.residential.value = bar;
  // With no waiting part, so departures read the bar as set (#420, `demandPull`).
  state.demand.residential.parts[WAITING_PART.residential] = 0;
  state.tick = firstTick + k;
  popIndexOf(state);
}

test("satisfaction on the M2 scale town", async ({ bench, annotate }) => {
  expect(popCount(state.pops)).toBe(TARGET);
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, beforeEach: () => void, iterations: number) => {
    const file = `bench-results/satisfaction-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, beforeEach }, fn).run({ iterations, time: 0, warmupIterations: 2, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  let tick = 0;
  const day = "the satisfaction system on each tick of an ordinary day, in turn";
  await run(day, () => updateSatisfaction(state), () => reset(ordinary, tick++ % DAY, 0), DAY);

  tick = 0;
  const exodus = "the satisfaction system on each tick of an exodus, every pop in the slice moving out, in turn";
  await run(exodus, () => updateSatisfaction(state), () => reset(leaving, tick++ % DAY, -100), DAY);
  const departedOnLastTick = TARGET - popCount(state.pops);

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingIdLimit(state.buildings),
    homes: homes.length,
    town: town.buildings,
    pops: TARGET,
    popsPerTick: TARGET / DAY,
    popsMovedOutOnTheLastTickTimed: departedOnLastTick,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-10 satisfaction");

  hold("satisfaction.tick", exodus, { mean: meanMs[exodus] ?? 0, max: maxMs[exodus] ?? 0 });
}, 600_000);
