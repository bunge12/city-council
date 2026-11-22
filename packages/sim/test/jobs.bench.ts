// Job matching on the M2 scale town (M3-09): the M1 scale city with every
// cell zoned and grown out, every workplace on a road newcomers can reach.
// Run with `pnpm bench`, kept out of `pnpm test`. Vitest does the timing;
// nothing here reads the clock (CLAUDE.md rule 3).
//
// The town's homes hold 150,000 pops, the top of a full city's range, cut
// as pops.bench.ts cuts them, and none has a job: all of them look at
// once. The day's sweep gives each tick a hundredth of them, 1,500 pops.
// The system's worst tick is the day's first, when every workplace's jobs
// are open, so each pop's draw weighs every zone with jobs. Its cost is one
// pass over the buildings for the openings, then pops in the slice times
// zones with open jobs.
//
// Reports the first tick's time, which the budget holds, the time to build
// the openings (openings.ts) and the pop index from nothing, as a load does,
// the time of every tick of the day, the pops that found work, how many
// were split, and the employment the day leaves.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import {
  TIME_BALANCE,
  buildingCount,
  buildingIdLimit,
  buildingJobs,
  cellsSettled,
  cutPeople,
  matchJobs,
  popCount,
  popIdLimit,
  prepareDerived,
  prepareTravelTimes,
  step,
  type PopState,
} from "../src/index";
import { addPop, createPops, removePop } from "../src/pops/pops";
import { openingsOf } from "../src/pops/openings";
import { popIndexOf } from "../src/pops/where";
import { isNode, nodeIdLimit } from "../src/roads/network";
import { loadScaleTown } from "./scale-fixture";

const TARGET = 150_000;

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);
prepareTravelTimes(state);

// Every road node counts as an outside connection, so every workplace in
// the town is offered: the most the pass can find.
{
  const net = state.roads;
  const nodes: number[] = [];
  for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n)) nodes.push(n);
  state.connections = Int32Array.from(nodes);
}

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

/** The pops as they stand before any job is found, to put back before each run. */
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
    free: p.free.slice(),
    sweep: p.sweep,
    owed: p.owed,
  };
}

const DAY = TIME_BALANCE.ticksPerDay;
const firstTick = Math.ceil(state.tick / DAY) * DAY;
state.pops.sweep = popIdLimit(state.pops);
const unemployed = copyPops(state.pops);
const stats = structuredClone(state.stats);
const rng = state.rng.slice();

/** Puts the pops and the generator back as they were, the index built, on the day's first tick. */
function reset(): void {
  state.pops = copyPops(unemployed);
  state.stats = structuredClone(stats);
  state.rng.set(rng);
  state.tick = firstTick;
  // The pop index and the openings, as a city that has been running has
  // them: a load builds both (`prepareDerived`), timed on their own below.
  openingsOf(state);
  // And room to grow, as a running city's arrays have: the first pop added
  // after a load doubles the pop arrays and the index, which the first
  // newcomer pays as often as the first split, and is not this system's.
  removePop(state, addPop(state, { home: homes[homes.length - 1]?.home ?? 0, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 50 }));
}

test("job matching on the M2 scale town", async ({ bench, annotate }) => {
  expect(popCount(state.pops)).toBe(TARGET);
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, hooks: { beforeEach?: () => void } = {}, iterations = 20) => {
    const file = `bench-results/jobs-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run({ iterations, time: 0, warmupIterations: 2, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  const first = "the job matching system on the day's first tick, 150,000 pops looking and every job open";
  await run(first, () => matchJobs(state), { beforeEach: reset });
  const matchedFirst = countEmployed(state.pops);

  const load = "the openings built from nothing with the pop index, as a load builds them";
  await run(load, () => void openingsOf(state), {
    beforeEach: () => {
      state.pops = copyPops(unemployed);
    },
  }, 10);

  // Every tick of the day in turn, from the same start: the worst is the one to watch.
  reset();
  let tick = 0;
  const day = "the job matching system on each tick of the day, in turn";
  await run(
    day,
    () => matchJobs(state),
    {
      beforeEach: () => {
        state.tick = firstTick + (tick++ % DAY);
      },
    },
    DAY,
  );

  let jobs = 0;
  let filled = 0;
  const index = popIndexOf(state);
  for (let id = 0; id < buildingIdLimit(state.buildings); id++) {
    jobs += buildingJobs(state.buildings, id);
    filled += index.filled[id] ?? 0;
  }
  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingCount(state.buildings),
    homes: homes.length,
    town: town.buildings,
    pops: TARGET,
    popsLookingPerTick: TARGET / DAY,
    popsWithWorkAfterFirstTick: matchedFirst,
    popsAfterTheDay: popCount(state.pops),
    popsSplitOnTheDay: popCount(state.pops) - TARGET,
    jobsInTown: jobs,
    jobsFilledAfterTheDay: filled,
    workersEmployed: state.stats.totals["workersEmployed"],
    workersUnemployed: state.stats.totals["workersUnemployed"],
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-09 job matching");

  hold("jobs.tick", first, { mean: meanMs[first] });
}, 600_000);

function countEmployed(p: PopState): number {
  let count = 0;
  for (let id = 0; id < p.flags.length; id++) if (p.flags[id] && p.work[id] !== -1) count++;
  return count;
}
