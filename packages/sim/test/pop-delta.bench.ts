// The size of a day's people and statistics deltas on the M2 scale town
// with 150,000 pops under turnover (M3-05). Run with `pnpm bench`, kept out
// of `pnpm test`. Nothing here is timed or held to a budget; the numbers go
// in the pull request.
//
// Turnover arrives in M3-11. Until then the bench plays it: each tick of
// one game day a share of the pops leave, as many arrive in homes with
// room, and a share change jobs, spread evenly over the day's ticks as the
// daily sweep spreads its systems. The host sends a delta a step at most,
// so each tick's drain is one delta. Each is measured as the bytes of its
// typed arrays plus the JSON of the rest, which is about what a structured
// clone or a socket carries. Pop rows, if they travelled, are measured
// beside it: `POP_ROW_BYTES` for each pop the day changed, plus its id.

import { expect, test } from "vitest";
import {
  NO_WORK,
  POP_ROW_BYTES,
  TIME_BALANCE,
  buildingIdLimit,
  buildingJobs,
  buildingPeople,
  encodeStatsDelta,
  isPop,
  jobsFilled,
  popCount,
  popIdLimit,
  popWorkers,
  prepareDerived,
} from "../src/index";
import { addPop, createPops, removePop, setPopWork } from "../src/pops/pops";
import { drainPopDelta, recordPopChanges } from "../src/pops/delta";
import { nextInt, seedRng } from "../src/rng";
import { loadScaleTown } from "./scale-fixture";

const TARGET = 150_000;
const PER_DAY = TIME_BALANCE.ticksPerDay;

/** Bytes of the typed arrays in `value` plus the JSON of everything else. */
function messageBytes(value: unknown): number {
  let typed = 0;
  const json = JSON.stringify(value, (_key, v: unknown) => {
    if (ArrayBuffer.isView(v)) {
      typed += v.byteLength;
      return 0;
    }
    return v;
  });
  return typed + json.length;
}

test("a day's people and statistics deltas with 150,000 pops under turnover", async ({ annotate }) => {
  const { city } = loadScaleTown();
  const { state } = city;
  prepareDerived(state);
  const b = state.buildings;
  const homes: number[] = [];
  const workplaces: number[] = [];
  for (let id = 0; id < buildingIdLimit(b); id++) {
    if (!b.flags[id]) continue;
    if ((b.residents[id] ?? 0) > 0) homes.push(id);
    if (buildingJobs(b, id) > 0) workplaces.push(id);
  }
  const room = homes.reduce((sum, h) => sum + (b.residents[h] ?? 0), 0);
  // Pops a little smaller than the town's room shared out over TARGET, so arrivals find room.
  const size = Math.max(1, Math.floor((room * 0.9) / TARGET));
  const rng = seedRng(2026);

  const randomProfile = () => ({ education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2), satisfaction: 50 });
  const findJob = (pop: number): void => {
    if (popWorkers(state.pops, pop) === 0) return;
    for (let tries = 0; tries < 8; tries++) {
      const work = workplaces[nextInt(rng, workplaces.length)] ?? 0;
      if (jobsFilled(state, work) + popWorkers(state.pops, pop) > buildingJobs(b, work)) continue;
      setPopWork(state, pop, work);
      return;
    }
  };
  /** A newcomer in a home with room, with a job if one is found. Its id, or -1 if no home had room. */
  const arrive = (): number => {
    for (let tries = 0; tries < 16; tries++) {
      const home = homes[nextInt(rng, homes.length)] ?? 0;
      if (buildingPeople(state, home) + size > (b.residents[home] ?? 0)) continue;
      const pop = addPop(state, { home, size, ...randomProfile() });
      findJob(pop);
      return pop;
    }
    return -1;
  };
  const randomPop = (): number => {
    for (;;) {
      const id = nextInt(rng, popIdLimit(state.pops));
      if (isPop(state.pops, id)) return id;
    }
  };

  state.pops = createPops();
  for (const home of homes) {
    for (let n = Math.floor((b.residents[home] ?? 0) / size); n > 0 && popCount(state.pops) < TARGET; n--) findJob(addPop(state, { home, size, ...randomProfile() }));
  }
  expect(popCount(state.pops)).toBe(TARGET);
  const employed = Array.from({ length: popIdLimit(state.pops) }, (_, id) => id).filter((id) => (state.pops.work[id] ?? NO_WORK) !== NO_WORK).length;

  const runs: Record<string, unknown>[] = [];
  // A share of the pops leaving a day, as many arriving, and twice as many changing jobs.
  for (const share of [0.01, 0.05]) {
    recordPopChanges(state);
    drainPopDelta(state);
    let sentTotals = { ...state.stats.totals };
    const leaving = Math.round(TARGET * share);
    const changingJobs = 2 * leaving;
    const touched = new Set<number>();
    let bytes = 0;
    let largest = 0;
    let peopleRows = 0;
    let totalsSent = 0;
    let peopleBytes = 0;
    for (let k = 0; k < PER_DAY; k++) {
      const n = (total: number) => Math.floor((total * (k + 1)) / PER_DAY) - Math.floor((total * k) / PER_DAY);
      for (let i = n(leaving); i > 0; i--) {
        const pop = randomPop();
        removePop(state, pop);
        touched.add(pop);
      }
      for (let i = n(leaving); i > 0; i--) {
        const pop = arrive();
        if (pop >= 0) touched.add(pop);
      }
      for (let i = n(changingJobs); i > 0; i--) {
        const pop = randomPop();
        if ((state.pops.work[pop] ?? NO_WORK) !== NO_WORK) setPopWork(state, pop, NO_WORK);
        findJob(pop);
        touched.add(pop);
      }
      const people = drainPopDelta(state);
      const stats = encodeStatsDelta(state.stats, state.stats.next, sentTotals);
      sentTotals = { ...state.stats.totals };
      peopleBytes += people ? messageBytes(people) : 0;
      const delta = messageBytes({ people, stats });
      bytes += delta;
      largest = Math.max(largest, delta);
      peopleRows += people?.ids.length ?? 0;
      totalsSent += Object.keys(stats.totals).length;
    }
    runs.push({
      leavingPerDay: leaving,
      arrivingPerDay: leaving,
      changingJobsPerDay: changingJobs,
      popIdsTouched: touched.size,
      deltas: PER_DAY,
      buildingRowsSent: peopleRows,
      totalsSent,
      peopleAndStatsBytesPerDay: bytes,
      peopleBytesPerDay: peopleBytes,
      statsBytesPerDay: bytes - peopleBytes,
      meanBytesPerDelta: Math.round(bytes / PER_DAY),
      largestDeltaBytes: largest,
      popRowsInsteadBytesPerDay: touched.size * (POP_ROW_BYTES + 4),
    });
    expect(popCount(state.pops)).toBeGreaterThan(TARGET * 0.95);
  }

  const report = { pops: TARGET, popSize: size, employedPops: employed, homes: homes.length, workplaces: workplaces.length, runs };
  await annotate(JSON.stringify(report, null, 2), "M3-05 a day's deltas with 150,000 pops");
}, 600_000);
