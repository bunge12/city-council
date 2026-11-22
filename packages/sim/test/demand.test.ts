import { describe, expect, it } from "vitest";
import {
  DEMAND_BALANCE,
  DEMAND_BARS,
  DEMAND_PARTS,
  TIME_BALANCE,
  checkDemand,
  copyDemand,
  createDemand,
  createState,
  demandTargets,
  deserialize,
  hashState,
  moveDemand,
  replay,
  serialize,
  step,
  type DemandBar,
  type DemandState,
  type DemandTargets,
  type SimState,
} from "../src/index";
import { nextFloat, nextInt, seedRng } from "../src/rng";
import { zeroTotals, type StatTotals } from "../src/stats/stats";
import growthJson from "./fixtures/replay/growth.json";
import type { ReplayFixture } from "./replay-helper";
import { holdDemand, setBars } from "./demand-helper";

// M3-06: the four demand bars, from the running totals only.

const DAY = TIME_BALANCE.ticksPerDay;
const growth = growthJson as ReplayFixture;

/** Totals all 0 but `set`. */
function totals(set: Record<string, number>): StatTotals {
  const t = zeroTotals();
  for (const [name, value] of Object.entries(set)) {
    if (!(name in t)) throw new Error(`no total ${name}`);
    t[name] = value;
  }
  return t;
}

/** A city's totals: `residents` people, all low wealth and split by education as given, `workers` of them working, `unemployed` of those without a job. */
function city(residents: number, workers: number, unemployed: number, education: [number, number, number] = [0.5, 0.4, 0.1]): Record<string, number> {
  return {
    population: residents,
    residentsEducationLow: residents * education[0],
    residentsEducationMedium: residents * education[1],
    residentsEducationHigh: residents * education[2],
    residentsWealthMedium: residents,
    workersEmployed: workers - unemployed,
    workersUnemployed: unemployed,
  };
}

const sum = (parts: Record<string, number>): number => Object.values(parts).reduce((a, b) => a + b, 0);
const target = (t: DemandTargets, bar: DemandBar): number => sum(t[bar]);
/** Where the totals put each bar, with a road out unless `outside` is 0. */
const bars = (set: Record<string, number>, outside = 10): Record<DemandBar, number> => {
  const t = demandTargets({ totals: totals(set), segmentsOutside: outside });
  return Object.fromEntries(DEMAND_BARS.map((bar) => [bar, target(t, bar)])) as Record<DemandBar, number>;
};

/** Sets `state`'s totals and steps it through `days` first ticks of a day. */
function runDays(state: SimState, set: Record<string, number>, days: number): void {
  for (let d = 0; d < days; d++) {
    state.stats.totals = totals(set);
    do step(state);
    while (state.tick % DAY !== 0);
  }
}

describe("each bar's sign", () => {
  it("wants homes in an empty city, from the pull from outside alone", () => {
    const b = bars({});
    expect(b.residential).toBe(DEMAND_BALANCE.outsidePull.bar);
    expect(b.commercial).toBe(0);
    expect(b.office).toBe(0);
    expect(b.industrial).toBe(0);
    // And in a city stepped through its first day.
    const state = createState(2026);
    step(state);
    expect(state.demand.residential.value).toBeGreaterThan(0);
    expect(state.demand.residential.parts["outsidePull"]).toBeGreaterThan(0);
  });

  it("does not want homes in a city of homes with no jobs", () => {
    const b = bars(city(2000, 1000, 1000));
    expect(b.residential).toBeLessThan(0);
    // Still true while the city is small enough for the pull, which only lifts it to `outsidePull.bar` and never adds to it.
    expect(bars(city(100, 50, 50)).residential).toBeLessThanOrEqual(DEMAND_BALANCE.outsidePull.bar);
    const state = createState(2026);
    runDays(state, city(2000, 1000, 1000), 10);
    expect(state.demand.residential.value).toBeLessThan(0);
    expect(state.demand.residential.parts["unemployment"]).toBeLessThan(0);
  });

  it("wants homes where jobs are open", () => {
    const b = bars({ ...city(2000, 1000, 0), jobsCommercial: 1500, filledCommercial: 600, jobsIndustrial: 400, filledIndustrial: 400 });
    expect(b.residential).toBeGreaterThan(0);
  });

  it("wants industry and shops in a city with unemployed workers", () => {
    const set = { ...city(2000, 1000, 400), jobsCommercial: 100, filledCommercial: 100, jobsIndustrial: 300, filledIndustrial: 300, jobsOffice: 200, filledOffice: 200 };
    const b = bars(set);
    expect(b.industrial).toBeGreaterThan(0);
    expect(b.commercial).toBeGreaterThan(0);
    const t = demandTargets({ totals: totals(set), segmentsOutside: 10 });
    expect(t.industrial["unemployedWorkers"]).toBeGreaterThan(0);
    expect(t.commercial["availableWorkers"]).toBeGreaterThan(0);
  });

  it("does not want shops in a city with more shop jobs than workers", () => {
    const set = { ...city(1000, 500, 0), jobsCommercial: 800, filledCommercial: 500 };
    const b = bars(set);
    expect(b.commercial).toBeLessThan(0);
    const t = demandTargets({ totals: totals(set), segmentsOutside: 10 });
    expect(t.commercial["shopSurplus"]).toBeLessThan(0);
    expect(t.commercial["spendingPower"]).toBe(0);
  });

  it("wants small offices as soon as newcomers with some education arrive", () => {
    expect(bars(city(300, 150, 0)).office).toBeGreaterThan(0);
    // But not where every educated worker already has an office job and every buyer is served.
    expect(bars({ ...city(1000, 500, 0, [0.5, 0.5, 0]), jobsOffice: 400, filledOffice: 250 }).office).toBe(0);
  });

  it("wants no industry while nothing the city built has a road out, whatever else it says", () => {
    const set = { ...city(2000, 1000, 400), jobsCommercial: 300, filledCommercial: 300 };
    expect(bars(set, 10).industrial).toBeGreaterThan(0);
    const cut = demandTargets({ totals: totals(set), segmentsOutside: 0 });
    expect(target(cut, "industrial")).toBeCloseTo(0, 9);
    expect(cut.industrial["outsideRoute"]).toBeLessThan(0);
    // A bar already below 0 is left there: the route only takes away what pushes it up.
    const office = { ...city(2000, 1000, 0), jobsOffice: 800, filledOffice: 100 };
    expect(bars(office, 0).industrial).toBeLessThan(0);
    expect(demandTargets({ totals: totals(office), segmentsOutside: 0 }).industrial["outsideRoute"]).toBe(0);
  });

  it("lets open office jobs hold industry down, so a dense city leans on offices", () => {
    const base = { ...city(4000, 2000, 300), jobsCommercial: 400, filledCommercial: 400 };
    const without = bars(base).industrial;
    const withOffices = bars({ ...base, jobsOffice: 1200, filledOffice: 600 }).industrial;
    expect(withOffices).toBeLessThan(without);
  });

  it("drops the pull from outside once the city has its set number of residents", () => {
    const until = DEMAND_BALANCE.outsidePull.untilResidents;
    const below = demandTargets({ totals: totals(city(until - 1, 0, 0)), segmentsOutside: 0 });
    const at = demandTargets({ totals: totals(city(until, 0, 0)), segmentsOutside: 0 });
    expect(below.residential["outsidePull"]).toBe(DEMAND_BALANCE.outsidePull.bar);
    expect(at.residential["outsidePull"]).toBe(0);
  });
});

describe("the bars' range and parts", () => {
  /** Totals from 0 to 10^12, each drawn on its own, many of them inconsistent with each other on purpose. */
  function extreme(rng: Uint32Array): StatTotals {
    const t = zeroTotals();
    const sizes = [0, 1, 7, 1e3, 1e6, 1e9, 1e12];
    for (const name of Object.keys(t)) t[name] = sizes[nextInt(rng, sizes.length)] ?? 0;
    return t;
  }

  it("keeps every bar from -100 to 100, its target and every day after, for extreme totals", () => {
    const rng = seedRng(174);
    const demand = createDemand();
    for (let k = 0; k < 2000; k++) {
      const t = demandTargets({ totals: extreme(rng), segmentsOutside: nextInt(rng, 3) });
      for (const bar of DEMAND_BARS) {
        const s = target(t, bar);
        expect(s).toBeGreaterThanOrEqual(-100 - 1e-9);
        expect(s).toBeLessThanOrEqual(100 + 1e-9);
        for (const part of Object.values(t[bar])) expect(Number.isFinite(part)).toBe(true);
      }
      moveDemand(demand, t, nextFloat(rng) < 0.1 ? 1 : DEMAND_BALANCE.dailyShare);
      for (const bar of DEMAND_BARS) {
        expect(demand[bar].value).toBeGreaterThanOrEqual(-100);
        expect(demand[bar].value).toBeLessThanOrEqual(100);
      }
      expect(checkDemand(demand)).toBeNull();
    }
  });

  it("scales a bar's parts together when they add up past 100, so each keeps its share", () => {
    // No workers at all, and open jobs: per worker, the open jobs are counted over 1.
    const t = demandTargets({ totals: totals({ jobsCommercial: 5000, population: 1000 }), segmentsOutside: 1 });
    expect(target(t, "residential")).toBeCloseTo(100, 9);
    expect(t.residential["openJobs"]).toBeCloseTo(100, 9);
  });

  it("keeps each bar the sum of its parts, every day", () => {
    const rng = seedRng(6);
    const demand = createDemand();
    for (let k = 0; k < 500; k++) {
      const t = zeroTotals();
      for (const name of Object.keys(t)) t[name] = Math.floor(nextFloat(rng) * 5000);
      moveDemand(demand, demandTargets({ totals: t, segmentsOutside: nextInt(rng, 2) }), DEMAND_BALANCE.dailyShare);
      for (const bar of DEMAND_BARS) {
        expect(Object.keys(demand[bar].parts)).toEqual([...DEMAND_PARTS[bar]]);
        expect(sum(demand[bar].parts)).toBeCloseTo(demand[bar].value, 9);
      }
    }
  });

  it("moves each part dailyShare of the way to its target a day, so a bar does not jump", () => {
    const share = DEMAND_BALANCE.dailyShare;
    const demand = createDemand();
    const busy = demandTargets({ totals: totals({ ...city(2000, 1000, 0), jobsCommercial: 1500, filledCommercial: 600 }), segmentsOutside: 1 });
    const want = target(busy, "residential");
    expect(want).toBeGreaterThan(50);
    moveDemand(demand, busy, share);
    expect(demand.residential.value).toBeCloseTo(want * share, 9);
    moveDemand(demand, busy, share);
    expect(demand.residential.value).toBeCloseTo(want * (1 - (1 - share) * (1 - share)), 9);
    // From high to low it takes days, not one.
    for (let d = 0; d < 60; d++) moveDemand(demand, busy, share);
    expect(demand.residential.value).toBeCloseTo(want, 3);
    const idle = demandTargets({ totals: totals(city(2000, 1000, 1000)), segmentsOutside: 1 });
    moveDemand(demand, idle, share);
    expect(demand.residential.value).toBeGreaterThan(0);
  });
});

describe("the demand system", () => {
  it("moves the bars on a game day's first tick and on no other", () => {
    const state = createState(2026);
    state.stats.totals = totals(city(2000, 1000, 1000));
    step(state);
    const after = copyDemand(state.demand);
    expect(after.residential.value).toBeLessThan(0);
    while (state.tick < DAY) {
      step(state);
      expect(state.demand).toEqual(after);
    }
    step(state);
    expect(state.demand.residential.value).toBeLessThan(after.residential.value);
  });

  it("reads the outside route from the roads: a new city's stubs are not a route out", () => {
    const state = createState(2026);
    runDays(state, { ...city(2000, 1000, 400), jobsCommercial: 300, filledCommercial: 300 }, 3);
    expect(state.demand.industrial.value).toBeCloseTo(0, 9);
    expect(state.demand.industrial.parts["outsideRoute"]).toBeLessThan(0);
  });

  it("gives the same bars on the same ticks in a replay, and in a city saved and loaded mid-day", () => {
    // The growth fixture builds homes, and its residential bar climbs to the pull from outside.
    // Its C2 strip waits for commercial demand (M3-07), so no jobs open yet.
    const byDay: DemandState[] = [];
    for (let tick = DAY; tick <= growth.untilTick; tick += DAY) byDay.push(copyDemand(replay(growth.seed, growth.log, tick).demand));
    expect(byDay.at(-1)?.residential.parts["outsidePull"]).toBeGreaterThan(0);
    expect(new Set(byDay.map((d) => d.residential.value)).size).toBeGreaterThan(5);
    const again = replay(growth.seed, growth.log, growth.untilTick);
    expect(again.demand).toEqual(byDay.at(-1));

    const mid = replay(growth.seed, growth.log, 7 * DAY + 37);
    const loaded = deserialize(serialize(mid)).state;
    const rest = growth.log.filter((e) => e.tick >= loaded.tick);
    expect(rest).toEqual([]);
    while (loaded.tick < growth.untilTick) step(loaded);
    expect(loaded.demand).toEqual(byDay.at(-1));
    expect(hashState(loaded)).toBe(hashState(again));
  });
});

describe("the test helper that holds the bars", () => {
  it("holds the bars it is given through a run, lets the rest follow the totals, and lets go after", () => {
    const state = createState(2026);
    holdDemand({ residential: -40, office: 70 }, () => {
      for (let t = 0; t < 3 * DAY; t++) {
        step(state);
        expect(state.demand.residential.value).toBe(-40);
        expect(state.demand.office.value).toBe(70);
        expect(sum(state.demand.residential.parts)).toBe(-40);
      }
    });
    // Commercial was not held: an empty city's is 0.
    expect(state.demand.commercial.value).toBe(0);
    while (state.tick % DAY !== 0) step(state);
    step(state);
    // Let go, the residential bar heads back up to the pull from outside.
    expect(state.demand.residential.value).toBeGreaterThan(-40);
    expect(checkDemand(state.demand)).toBeNull();
  });

  it("refuses a value off the bar", () => {
    expect(() => setBars(createState(1), { commercial: 120 })).toThrow(RangeError);
  });
});

describe("review cases", () => {
  it("does not want shops with more shop jobs than workers, however rich the residents", () => {
    // 1,000 high wealth residents could keep 300 shop jobs busy, but only 200 work.
    const set = { population: 1000, residentsWealthHigh: 1000, residentsEducationMedium: 1000, workersEmployed: 200, jobsCommercial: 250, filledCommercial: 200 };
    expect(bars(set).commercial).toBeLessThan(0);
  });

  it("reads a bar whose parts sum to no number as 0, and refuses to load parts far off the bar", () => {
    const demand = createDemand();
    const parts = demand.industrial.parts;
    parts["unemployedWorkers"] = 1e308;
    parts["goodsNeeded"] = 1e308;
    parts["openOfficeJobs"] = -1e308;
    parts["outsideRoute"] = -1e308;
    expect(checkDemand(demand)).toMatch(/far off the bar/);
    moveDemand(demand, demandTargets({ totals: zeroTotals(), segmentsOutside: 0 }), 0.2);
    expect(demand.industrial.value).toBe(0);
  });

  it("refuses to hold the bars through a run that returns a promise", () => {
    expect(() => holdDemand({ residential: 10 }, () => Promise.resolve())).toThrow(TypeError);
    // And lets go: the system works the bars out again.
    const state = createState(2026);
    step(state);
    expect(state.demand.residential.value).not.toBe(10);
  });
});
