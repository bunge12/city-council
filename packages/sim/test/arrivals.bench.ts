// Arrivals on the M2 scale town (M3-08): the M1 scale city with every cell
// zoned and grown out, every home one newcomers can reach. Run with `pnpm bench`, kept out of `pnpm test`. Vitest
// does the timing; nothing here reads the clock (CLAUDE.md rule 3).
//
// The arrivals system's work on a tick people are due is one pass over the
// buildings for the homes with room (pops/room.ts) and a household or two
// moving in. Its worst tick is one at the arrivals cap, the residential bar
// at 100, with every home in the town empty, so the pass finds them all.
// The grower asks the same pass before each home it adds (`homesHeld`),
// timed here too. The pass grows with the buildings, not the pops.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import {
  TIME_BALANCE,
  buildingCount,
  cellsSettled,
  dayArrivals,
  growthOnTick,
  homesHeld,
  homesWithRoom,
  popCount,
  prepareDerived,
  reachableRoom,
  step,
} from "../src/index";
import { arrive } from "../src/pops/arrivals";
import { createPops } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { isNode, nodeIdLimit } from "../src/roads/network";
import { segmentsReachingOutside } from "../src/roads/outside";
import { setBars } from "./demand-helper";
import { loadScaleTown } from "./scale-fixture";

const { city, town } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);

// Every road node counts as an outside connection, so every home in the
// town is one newcomers can reach: the most the pass can find.
{
  const net = state.roads;
  const nodes: number[] = [];
  for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n)) nodes.push(n);
  state.connections = Int32Array.from(nodes);
}

test("arrivals on the M2 scale town", async ({ bench, annotate }) => {
  expect(buildingCount(state.buildings)).toBe(town.buildings);
  expect(segmentsReachingOutside(state)).toBeGreaterThan(0);
  setBars(state, { residential: 100 });
  const day = TIME_BALANCE.ticksPerDay;
  const quota = dayArrivals(100);
  // A tick of the day on which people are due at the cap.
  let k = 0;
  while (growthOnTick(k, quota) === 0) k++;
  const dueTick = Math.ceil(state.tick / day) * day + k;
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, hooks: { beforeEach?: () => void } = {}, iterations = 200) => {
    const file = `bench-results/arrivals-${name.replace(/[^a-z0-9]+/gi, "-")}.json`;
    collect();
    const r = await bench(name, { writeResult: file, async: false, ...hooks }, fn).run({ iterations, time: 0, warmupIterations: 2, warmupTime: 0 });
    meanMs[name] = r.latency.mean;
    maxMs[name] = r.latency.max;
  };

  const homes = homesWithRoom(state).length;
  const tick = "the arrivals system on a tick people are due, at the cap, every home empty";
  // Each run starts from an empty town, nobody owed, on a tick people are due.
  await run(tick, () => arrive(state), {
    beforeEach: () => {
      state.pops = createPops();
      state.tick = dueTick;
      // The pop index, as a city that has been running has it: built on
      // first use, which a new pop table would otherwise pay inside the run.
      popIndexOf(state);
    },
  });
  const arrived = popCount(state.pops);
  const quiet = "the arrivals system on a tick paying back a household that came early";
  await run(quiet, () => arrive(state), {
    beforeEach: () => {
      state.pops.owed = -1000;
      state.tick = dueTick;
    },
  }, 1000);
  const held = "the grower's check for room before it adds a home";
  await run(held, () => void homesHeld(state));

  const round = (v: number): number => Math.round(v * 10000) / 10000;
  const report = {
    buildings: buildingCount(state.buildings),
    homesWithRoom: homes,
    room: reachableRoom(state),
    peopleDuePerDayAtCap: quota,
    popsAfterOneDueTick: arrived,
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([key, v]) => [key, round(v)])),
    maxMs: Object.fromEntries(Object.entries(maxMs).map(([key, v]) => [key, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-08 arrivals");

  hold("arrivals.tick", tick, { mean: meanMs[tick] });
}, 600_000);
