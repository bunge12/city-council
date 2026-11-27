// The statistics panel's series reader and axis (issue M3-16).
import { describe, expect, it } from "vitest";
import { HISTORY_LENGTH, LINE, MONEY_SERIES, STAT_TOTALS, formatMoneyFull, TIME_BALANCE, createState, createStats, historyOf, sampleCount, step, yearDays, type StatsState } from "@city-council/sim";
import { STAT_RANGES, STAT_SERIES, axisNumber, lastSamples, moneyTicks, newestMonth, niceTicks, rangeMonths, sampleDate, seriesById } from "../src/ui/stat-series";

/** Statistics whose population history holds `months` samples, sample m being 1000 + m, written as the sim writes them. */
function statsAfter(months: number): StatsState {
  const stats = createStats();
  const length = Math.min(months, HISTORY_LENGTH);
  for (const name of STAT_TOTALS) stats.history[name] = new Int32Array(length);
  const population = stats.history["population"];
  if (!population) throw new Error("no population history");
  let next = 0;
  for (let m = 0; m < months; m++) {
    population[next] = 1000 + m;
    next = (next + 1) % HISTORY_LENGTH;
  }
  stats.next = next;
  return stats;
}

const population = seriesById("population");
/** A new city's budget, made once: making a state generates its terrain. */
const BUDGET = createState(1).budget;

function samples(stats: StatsState, months: number): number[] {
  const ring = population.history({ stats, budget: BUDGET });
  if (!ring) throw new Error("no ring");
  return lastSamples(ring, months);
}

/** The samples a range should show: the last `months` written, oldest first. */
function expected(written: number, months: number): number[] {
  const n = Math.min(written, months, HISTORY_LENGTH);
  return Array.from({ length: n }, (_, k) => 1000 + written - n + k);
}

describe("the series reader", () => {
  it.each(STAT_RANGES)("gives the last months of a history that has wrapped, oldest first, for %d years", (years) => {
    // 137 years of samples: the ring has gone round once and 37 years more, so `next` is mid-array.
    const written = 137 * 12;
    const stats = statsAfter(written);
    expect(stats.next).toBe(written % HISTORY_LENGTH);
    expect(stats.next).toBeGreaterThan(0);
    const got = samples(stats, rangeMonths(years));
    expect(got).toEqual(expected(written, rangeMonths(years)));
    // The same as the sim's own reading of the whole ring, cut to the range.
    expect(got).toEqual(historyOf(stats, "population").slice(-rangeMonths(years)));
  });

  it.each(STAT_RANGES)("gives what there is of a history that has not filled, for %d years", (years) => {
    const written = 50 * 12;
    const got = samples(statsAfter(written), rangeMonths(years));
    expect(got).toEqual(expected(written, rangeMonths(years)));
    expect(got.at(-1)).toBe(1000 + written - 1);
  });

  it("reads a ring that wrapped exactly to its start, and one a sample past it", () => {
    for (const written of [HISTORY_LENGTH, HISTORY_LENGTH + 1, 2 * HISTORY_LENGTH - 1]) {
      const stats = statsAfter(written);
      expect(samples(stats, rangeMonths(100)), `${written} samples`).toEqual(historyOf(stats, "population"));
      expect(samples(stats, rangeMonths(1)), `${written} samples`).toEqual(expected(written, 12));
    }
  });

  it("gives nothing for a city with no history yet", () => {
    expect(samples(createStats(), rangeMonths(10))).toEqual([]);
  });

  it("covers 12, 120 and 1,200 months, the whole history at 100 years", () => {
    expect(STAT_RANGES.map(rangeMonths)).toEqual([12, 120, HISTORY_LENGTH]);
  });
});

describe("the series list", () => {
  it("offers every total the sim keeps a history of, but the satisfaction sum and the unemployed newcomers, each once", () => {
    const ids = STAT_SERIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The unemployed newcomers are the residential bar's bookkeeping (#361), already among the unemployed workers.
    const internal = ["residentSatisfaction", "workersUnemployedNew"];
    // And the money (M4-15): the treasury, income and expenses, one entry each. Tax income is the credit limit's, already in income.
    const money = ["treasury", "income", "expenses"];
    expect([...ids].sort()).toEqual([...STAT_TOTALS.filter((t) => !internal.includes(t)), ...money].sort());
    expect(money.every((m) => (MONEY_SERIES as readonly string[]).includes(m))).toBe(true);
  });

  it("reads the money series' history from the sim's money samples, and their value now from the budget", () => {
    const stats = statsAfter(3);
    stats.money = { treasury: Float64Array.of(10, 20, 30), income: Float64Array.of(1, 2, 3), expenses: Float64Array.of(4, 5, 6), taxIncome: Float64Array.of(0, 0, 0) };
    const budget = { ...BUDGET, lastMonth: BUDGET.lastMonth.slice() };
    budget.treasury = 1_234_567;
    budget.lastMonth.fill(0);
    budget.lastMonth[LINE.taxResidential] = 500;
    budget.lastMonth[LINE.grants] = 250;
    budget.lastMonth[LINE.roadUpkeep] = 300;
    const source = { stats, budget };
    expect(seriesById("treasury").now(source)).toBe(1_234_567);
    expect(seriesById("income").now(source)).toBe(750);
    expect(seriesById("expenses").now(source)).toBe(300);
    const ring = seriesById("expenses").history(source);
    expect(ring && lastSamples(ring, 12)).toEqual([4, 5, 6]);
    expect(seriesById("treasury").group).toBe("Money");
    expect(seriesById("treasury").short?.(1_234_567)).toBe("$1.2M");
    expect(seriesById("treasury").format(1_234_567)).toBe(formatMoneyFull(1_234_567));
  });

  it("reads each series' value now and its history from the totals of the same name", () => {
    const stats = statsAfter(3);
    stats.totals["workersUnemployed"] = 42;
    const unemployed = seriesById("workersUnemployed");
    const budget = BUDGET;
    expect(unemployed.now({ stats, budget })).toBe(42);
    expect(unemployed.history({ stats, budget })?.values).toBe(stats.history["workersUnemployed"]);
    expect(unemployed.format(1)).toBe("1 worker");
    expect(population.format(12_345)).toBe("12,345 people");
  });

  it("falls back to population for an id it does not know", () => {
    expect(seriesById("no such series").id).toBe("population");
  });
});

describe("the graph's axis", () => {
  it.each([
    [0, 0, [0, 1]],
    [0, 660, [0, 200, 400, 600, 800]],
    [-120, 660, [-200, 0, 200, 400, 600, 800]],
    [-3_000, -1_000, [-3_000, -2_000, -1_000, 0]],
  ])("ticks money from %d to %d in clean steps through 0", (min, max, ticks) => {
    expect(moneyTicks(min, max)).toEqual(ticks);
  });

  it.each([
    [0, [0, 1]],
    [3, [0, 1, 2, 3]],
    [660, [0, 200, 400, 600, 800]],
    [600, [0, 200, 400, 600]],
    [47_000, [0, 20_000, 40_000, 60_000]],
  ])("ticks from 0 to at least %d in clean steps", (max, ticks) => {
    expect(niceTicks(max)).toEqual(ticks);
  });

  it.each([
    [0, "0"],
    [9_999, "9,999"],
    [10_000, "10K"],
    [15_000, "15K"],
    [1_500_000, "1.5M"],
  ])("writes %d as %s", (value, text) => {
    expect(axisNumber(value)).toBe(text);
  });
});

describe("the date of the newest sample", () => {
  const DAY = TIME_BALANCE.ticksPerDay;
  const YEAR = yearDays() * DAY;

  it.each([
    // A copy at a month's first tick has not taken that month's sample yet.
    [0, "1 Jan, Year 1"],
    [1, "1 Jan, Year 1"],
    [31 * DAY, "1 Jan, Year 1"],
    [31 * DAY + 1, "1 Feb, Year 1"],
    [50 * YEAR, "1 Dec, Year 50"],
    [50 * YEAR + 1, "1 Jan, Year 51"],
    [50 * YEAR + 100 * DAY, "1 Apr, Year 51"],
  ])("at tick %d is %s", (tick, date) => {
    expect(sampleDate(newestMonth(tick))).toBe(date);
  });

  it("counts one sample for every month up to and including the newest, as the sim takes them", () => {
    const state = createState(7);
    for (const until of [1, 31 * DAY, 31 * DAY + 1, 59 * DAY + 1]) {
      while (state.tick < until) step(state);
      expect(sampleCount(state.stats), `tick ${until}`).toBe(newestMonth(state.tick) + 1);
    }
  });
});
