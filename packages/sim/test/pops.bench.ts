// Pops on the M2 scale town (M3-03). Run with `pnpm bench`, kept out of
// `pnpm test`. Vitest does the timing; nothing here reads the clock
// (CLAUDE.md rule 3).
//
// Fills the town's homes with 150,000 pops, the top of a full city's range,
// cutting each home into pops by the rule in pops.ts until the count is
// reached, and reports:
// - the time to add them all, the pop index built from nothing on the way;
// - the time to build the index from the rows, as a loaded city does on
//   first use;
// - the time to remove the pops of 5,000 homes, a BulldozeBuilding at its
//   cap, which now pays for them;
// - a step with them in state, the day's first, which sets the sweep;
// - the snapshot's size before and after, and the bytes per pop.
//
// Nothing here is held to a budget yet: pops do nothing in play until
// M3-08. The numbers go in the pull request.

import { expect, test } from "vitest";
import { collect } from "./budget";
import { POP_ROW_BYTES, TIME_BALANCE, buildingIdLimit, cutPeople, popCount, prepareDerived, serialize, step } from "../src/index";
import { addPop, createPops, displaceBuildingPops } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { loadScaleTown } from "./scale-fixture";

const TARGET = 150_000;

const { city } = loadScaleTown();
const { state } = city;
prepareDerived(state);

/**
 * Every home and the sizes of the pops it is cut into, in id order, until
 * they reach TARGET. The rule in pops.ts cuts the full town into fewer pops
 * than that (`popsByTheRule`), so the bench cuts each home into pops of at
 * most `size` people, the town's room shared out over TARGET pops: the most
 * pops the town could hold of a size the rule would also allow.
 */
const homes: { home: number; room: number; density: number }[] = [];
for (let id = 0; id < buildingIdLimit(state.buildings); id++) {
  const room = state.buildings.residents[id] ?? 0;
  if (state.buildings.flags[id] && room > 0) homes.push({ home: id, room, density: state.buildings.density[id] ?? 1 });
}
const totalRoom = homes.reduce((sum, h) => sum + h.room, 0);
const popsByTheRule = homes.reduce((sum, h) => sum + cutPeople(h.room, h.density).length, 0);
const size = Math.max(1, Math.floor(totalRoom / TARGET));
const plan: { home: number; sizes: number[] }[] = [];
let planned = 0;
for (const h of homes) {
  if (planned >= TARGET) break;
  const count = Math.max(cutPeople(h.room, h.density).length, Math.floor((h.room + size - 1) / size));
  const sizes = Array.from({ length: count }, (_, i) => Math.floor(h.room / count) + (i < h.room % count ? 1 : 0)).slice(0, TARGET - planned);
  plan.push({ home: h.home, sizes });
  planned += sizes.length;
}

function fill(): void {
  state.pops = createPops();
  let n = 0;
  for (const { home, sizes } of plan) {
    for (const size of sizes) {
      addPop(state, { home, size, education: n % 3, wealth: (n >> 2) % 3, children: (n >> 4) & 1, satisfaction: 50 });
      n++;
    }
  }
}

test("pops on the M2 scale town", async ({ bench, annotate }) => {
  expect(planned, "the town has room for the pops").toBe(TARGET);
  const before = serialize(state).byteLength;

  const meanMs: Record<string, number> = {};
  const run = async (name: string, fn: () => void, hooks: { beforeEach?: () => void } = {}, iterations = 5) => {
    collect();
    const r = await bench(name, { writeResult: `bench-results/pops-${name.replace(/[^a-z0-9]+/gi, "-")}.json`, async: false, ...hooks }, fn).run({
      iterations,
      time: 0,
      warmupIterations: 1,
      warmupTime: 0,
    });
    meanMs[name] = r.latency.mean;
  };

  await run("add 150,000 pops to the town's homes", fill);
  expect(popCount(state.pops)).toBe(TARGET);
  const after = serialize(state).byteLength;

  await run("build the pop index from the rows", () => {
    // A copy of the rows in a new object, so the index is built afresh.
    state.pops = { ...state.pops };
    popIndexOf(state);
  });

  const cleared = plan.slice(0, 5000).map((p) => p.home);
  await run("displace the pops of 5,000 homes", () => displaceBuildingPops(state, cleared), { beforeEach: fill });

  fill();
  const perDay = TIME_BALANCE.ticksPerDay;
  await run(
    "a step on the day's first tick, which sets the sweep",
    () => void step(state),
    {
      beforeEach: () => {
        state.tick = Math.ceil(state.tick / perDay) * perDay;
      },
    },
    20,
  );
  expect(state.pops.sweep).toBe(TARGET);

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const report = {
    pops: TARGET,
    homesFilled: plan.length,
    residentsInPops: plan.reduce((sum, p) => sum + p.sizes.reduce((a, b) => a + b, 0), 0),
    townRoom: totalRoom,
    homes: homes.length,
    popsByTheRule,
    largestPopInBench: size,
    popRowBytes: POP_ROW_BYTES,
    snapshotBytesBefore: before,
    snapshotBytesAfter: after,
    snapshotGrowthBytes: after - before,
    snapshotBytesPerPop: round((after - before) / TARGET),
    meanMs: Object.fromEntries(Object.entries(meanMs).map(([k, v]) => [k, round(v)])),
  };
  await annotate(JSON.stringify(report, null, 2), "M3-03 pops on the scale town");
}, 600_000);
