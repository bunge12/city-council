// The tax sweep on the scale city of 500,000 residents (M4-05, with business tax from M4-06). Run with
// `pnpm bench`, kept out of `pnpm test`. Vitest does the timing; nothing
// here reads the clock (CLAUDE.md rule 3).
//
// The sweep visits a hundredth of the buildings a tick and charges each
// occupied home its day of property tax and each workplace people work in
// its day of business tax, so every tick of a day does about
// the same work. Timed: the system on each tick of a day, in turn, which
// the budget holds by its mean. The worst tick is reported beside it.

import { expect, test } from "vitest";
import { LINE, TIME_BALANCE, buildingCount, collectTax, prepareDerived } from "../src/index";
import { collect, hold } from "./budget";
import { generate } from "./scale-cities";

const RESIDENTS = 500_000;
const DAY = TIME_BALANCE.ticksPerDay;

test("the tax sweep on the scale city of 500,000 residents", async ({ bench, annotate }) => {
  const { state } = generate(RESIDENTS);
  prepareDerived(state);
  const firstDay = Math.ceil(state.tick / DAY) * DAY;
  const lines = [LINE.taxResidential, LINE.taxCommercial, LINE.taxOffice, LINE.taxIndustrial];
  const before = lines.map((line) => state.budget.month[line] as number);

  let k = 0;
  const name = "the tax sweep on each tick of a day, in turn";
  collect();
  const r = await bench(name, { writeResult: "bench-results/tax-each-tick.json", async: false, beforeEach: () => void (state.tick = firstDay + (k++ % DAY)) }, () => collectTax(state)).run({
    iterations: 2 * DAY,
    time: 0,
    warmupIterations: 5,
    warmupTime: 0,
  });
  const collected = lines.map((line, i) => (state.budget.month[line] as number) - (before[i] as number));
  for (const amount of collected) expect(amount).toBeGreaterThan(0);

  const round = (x: number): number => Math.round(x * 10000) / 10000;
  const report = {
    residents: RESIDENTS,
    buildings: buildingCount(state.buildings),
    meanMs: round(r.latency.mean),
    maxMs: round(r.latency.max),
    collectedOverTwoDays: { residential: collected[0], commercial: collected[1], office: collected[2], industrial: collected[3] },
  };
  await annotate(JSON.stringify(report, null, 2), "M4-05 and M4-06 tax sweep");
  console.log(JSON.stringify(report, null, 2));

  hold("tax.tick", name, { mean: r.latency.mean, max: r.latency.max });
}, 600_000);
