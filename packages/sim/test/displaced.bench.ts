// Displaced pops on the M2 scale town (M3-12). Run with `pnpm bench`, kept
// out of `pnpm test`. Vitest does the timing; nothing here reads the clock
// (CLAUDE.md rule 3).
//
// The town's homes are filled by the rule in pops.ts, one home after
// another, until half the town's room is taken, so the other half is free
// for displaced pops to move into. Every road node counts as an outside
// connection, as in jobs.bench.ts, so every home is one a pop can move to.
// Every third pop with workers has a job, so both ways a pop is placed are
// taken: near its job, and anywhere a newcomer could go.
//
// Each run applies one BulldozeBuilding of `bulldozeMaxBuildings` occupied
// homes, which displaces every pop in them and places the first
// `displacedPerTick` in the same step. The step is held to the tick. The
// ticks after it drain the queue; the worst of them is held to the tick
// too. Between runs, outside the timing, the queue is drained and the
// grower builds the town back up to the count it had.
//
// Reports the pops each run displaced, the ticks the queue took to drain
// counting the bulldoze's own, the people who left the city for want of
// room, and the step's and the drain's times.

import { expect, test } from "vitest";
import { collect, hold } from "./budget";
import {
  BUILDINGS_BALANCE,
  POPS_BALANCE,
  buildingCount,
  buildingIdLimit,
  buildingJobs,
  cellsSettled,
  cutPeople,
  popCount,
  prepareDerived,
  seeBuilding,
  step,
  type BuildingSeen,
} from "../src/index";
import { growOne } from "../src/buildings/grower";
import { addPop, createPops, popWorkers, setPopWork } from "../src/pops/pops";
import { buildingPeople, popsAtHome } from "../src/pops/where";
import { isNode, nodeIdLimit } from "../src/roads/network";
import { loadScaleTown } from "./scale-fixture";
import { submit } from "./seen-ends";

const { city } = loadScaleTown();
const { state } = city;
prepareDerived(state);
while (!cellsSettled(state)) step(state);

{
  const net = state.roads;
  const nodes: number[] = [];
  for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n)) nodes.push(n);
  state.connections = Int32Array.from(nodes);
}

// Half the town's room filled, home by home, by the rule.
const homes: number[] = [];
let totalRoom = 0;
for (let id = 0; id < buildingIdLimit(state.buildings); id++) {
  const room = state.buildings.residents[id] ?? 0;
  if (state.buildings.flags[id] && room > 0) {
    homes.push(id);
    totalRoom += room;
  }
}
state.pops = createPops();
let people = 0;
for (const home of homes) {
  if (people >= totalRoom / 2) break;
  const room = state.buildings.residents[home] ?? 0;
  for (const [i, size] of cutPeople(room, state.buildings.density[home] ?? 1).entries()) {
    addPop(state, { home, size, education: i % 3, wealth: (i >> 1) % 3, children: i & 1, satisfaction: 60 });
  }
  people += room;
}

// Every third pop with workers takes a job where there is room for it.
const workplaces: number[] = [];
for (let id = 0; id < buildingIdLimit(state.buildings); id++) if (state.buildings.flags[id] && buildingJobs(state.buildings, id) > 0) workplaces.push(id);
let at = 0;
for (let id = 0; id < state.pops.flags.length && workplaces.length > 0; id += 3) {
  if (popWorkers(state.pops, id) === 0) continue;
  for (let tries = 0; tries < 4; tries++) {
    try {
      setPopWork(state, id, workplaces[at % workplaces.length] as number);
      break;
    } catch {
      at++;
    }
  }
}

let seq = 0;
let year = { departures: state.stats.year.departures };

/** The next `bulldozeMaxBuildings` homes with someone living in them, as the bulldozer names them. */
function occupiedHomes(): BuildingSeen[] {
  const out: BuildingSeen[] = [];
  for (let id = 0; id < buildingIdLimit(state.buildings) && out.length < BUILDINGS_BALANCE.bulldozeMaxBuildings; id++) {
    if (buildingPeople(state, id) <= 0) continue;
    const seen = seeBuilding(state.buildings, id);
    if (seen) out.push(seen);
  }
  return out;
}

test("displaced pops on the M2 scale town", async ({ bench, annotate }) => {
  expect(popCount(state.pops)).toBeGreaterThan(30_000);
  const standing = buildingCount(state.buildings);
  const runs: { displaced: number; drainTicks: number; left: number }[] = [];
  const meanMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};

  const drain = (): number => {
    let ticks = 0;
    while (state.pops.displaced.length > 0) {
      step(state);
      ticks++;
    }
    return ticks;
  };

  const stepName = `the step that applies one BulldozeBuilding of ${BUILDINGS_BALANCE.bulldozeMaxBuildings} occupied homes`;
  collect();
  let displaced = 0;
  const r = await bench(stepName, {
    writeResult: "bench-results/displaced-bulldoze-step.json",
    async: false,
    beforeEach: () => {
      const payload = { buildings: occupiedHomes() };
      year = { departures: state.stats.year.departures };
      displaced = payload.buildings.reduce((n, b) => n + popsAtHome(state, b.id).length, 0);
      expect(submit(state, { seq: ++seq, playerId: "p1", type: "BulldozeBuilding", payload })).toEqual({ ok: true });
    },
    afterEach: () => {
      const drainTicks = drain();
      const left = state.stats.year.departures - year.departures;
      runs.push({ displaced, drainTicks: drainTicks + 1, left });
      for (let misses = 0; buildingCount(state.buildings) < standing && misses < 100; ) if (growOne(state) < 0) misses++;
      collect();
    },
  }, () => void step(state)).run({ iterations: 10, time: 0, warmupIterations: 1, warmupTime: 0 });
  meanMs[stepName] = r.latency.mean;
  maxMs[stepName] = r.latency.max;

  // The ticks that drain a queue as long as one such bulldoze leaves.
  const drainName = "a tick that places a slice of the queue of displaced pops";
  collect();
  const d = await bench(drainName, {
    writeResult: "bench-results/displaced-drain-tick.json",
    async: false,
    beforeEach: () => {
      if (state.pops.displaced.length > 0) return;
      const payload = { buildings: occupiedHomes() };
      expect(submit(state, { seq: ++seq, playerId: "p1", type: "BulldozeBuilding", payload })).toEqual({ ok: true });
      step(state);
    },
  }, () => void step(state)).run({ iterations: 20, time: 0, warmupIterations: 1, warmupTime: 0 });
  meanMs[drainName] = d.latency.mean;
  maxMs[drainName] = d.latency.max;

  const round = (x: number) => Math.round(x * 1000) / 1000;
  await annotate(
    JSON.stringify(
      {
        homes: homes.length,
        townRoom: totalRoom,
        pops: popCount(state.pops),
        displacedPerTick: POPS_BALANCE.displacedPerTick,
        runs: runs.slice(1),
        meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
        maxMs: Object.fromEntries(Object.entries(maxMs).map(([k, v]) => [k, round(v)])),
      },
      null,
      2,
    ),
    "M3-12 displaced pops on the scale town",
  );
  // After the report, so a miss still leaves the numbers in it.
  hold("displaced.bulldoze-step", stepName, { mean: meanMs[stepName] });
  hold("displaced.drain-tick", drainName, { mean: meanMs[drainName] });
}, 900_000);
