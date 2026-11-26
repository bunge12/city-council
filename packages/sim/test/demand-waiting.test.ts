import { describe, expect, it } from "vitest";
import {
  DEMAND_BALANCE,
  DEMAND_BARS,
  DEMAND_PARTS,
  TIME_BALANCE,
  WAITING_PART,
  ZONING_BALANCE,
  createDemand,
  createState,
  demandPull,
  demandTargets,
  holdsHomes,
  moveDemand,
  reachableRoom,
  step,
  waitingShares,
  workplacesHeldBy,
  zoneBar,
  zoneJobs,
  type DemandBar,
  type DemandState,
} from "../src/index";
import { zeroTotals, type StatTotals } from "../src/stats/stats";
import jobsJson from "./fixtures/replay/jobs.json";
import { replayFixture, type ReplayFixture } from "./replay-helper";
import { withValue } from "./with-value";

// #420: each bar's last part takes away what is already waiting, so a bar
// reads 0 while the grower holds its zone back, and the systems that act on
// demand read the bar without it.

const DAY = TIME_BALANCE.ticksPerDay;
const jobs = jobsJson as ReplayFixture;

/** Totals all 0 but `set`. */
function totals(set: Record<string, number>): StatTotals {
  const t = zeroTotals();
  for (const [name, value] of Object.entries(set)) t[name] = value;
  return t;
}

/** A city whose residential, commercial, office and industrial bars all pull above zero: open jobs everywhere, educated workers, spending. */
const PULLING = totals({
  population: 10_000,
  residentsEducationLow: 3_000,
  residentsEducationMedium: 5_000,
  residentsEducationHigh: 2_000,
  residentsWealthMedium: 10_000,
  residentSatisfaction: 10_000 * DEMAND_BALANCE.satisfactionNeutral,
  workersEmployed: 5_450,
  workersUnemployed: 50,
  jobsCommercial: 400,
  filledCommercial: 300,
  jobsOffice: 300,
  filledOffice: 200,
  jobsIndustrial: 200,
  filledIndustrial: 150,
  highestPopulation: 10_000,
});

const sum = (parts: Record<string, number>): number => Object.values(parts).reduce((a, b) => a + b, 0);
const others = (parts: Record<string, number>, bar: DemandBar): number => sum(parts) - (parts[WAITING_PART[bar]] ?? 0);
const all = (share: number): Record<DemandBar, number> => ({ residential: share, commercial: share, office: share, industrial: share });

describe("the waiting part's target", () => {
  it("is each bar's last part, and 0 while nothing waits", () => {
    for (const bar of DEMAND_BARS) expect(DEMAND_PARTS[bar].at(-1)).toBe(WAITING_PART[bar]);
    const t = demandTargets({ totals: PULLING, segmentsOutside: 10 });
    for (const bar of DEMAND_BARS) {
      expect(others(t[bar], bar)).toBeGreaterThan(0);
      expect(t[bar][WAITING_PART[bar]]).toBe(0);
    }
  });

  it("takes its share of what the other parts add above zero, and all of it from a share of 1 up", () => {
    const free = demandTargets({ totals: PULLING, segmentsOutside: 10 });
    for (const share of [0.25, 0.5, 1, 3]) {
      const t = demandTargets({ totals: PULLING, segmentsOutside: 10, waiting: all(share) });
      for (const bar of DEMAND_BARS) {
        const above = others(free[bar], bar);
        expect(others(t[bar], bar)).toBe(above);
        expect(t[bar][WAITING_PART[bar]]).toBeCloseTo(-above * Math.min(1, share), 9);
        expect(sum(t[bar])).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("takes nothing from a bar at or below zero, so it never sends people away or empties a building", () => {
    // Homes and no jobs: the residential bar falls below zero from unemployment, and nothing else pulls.
    const jobless = totals({ population: 1_000, residentsEducationLow: 1_000, residentsWealthLow: 1_000, workersUnemployed: 600, highestPopulation: 1_000 });
    const t = demandTargets({ totals: jobless, segmentsOutside: 0, waiting: all(1) });
    expect(sum(t.residential)).toBeLessThan(0);
    for (const bar of DEMAND_BARS) {
      if (others(t[bar], bar) <= 0) expect(t[bar][WAITING_PART[bar]]).toBe(0);
      expect(Object.is(t[bar][WAITING_PART[bar]], -0)).toBe(false);
    }
  });
});

describe("the waiting part day by day", () => {
  it("moves dailyShare a day like the others, and the bar reads 0 once its zone has been held for long enough", () => {
    const demand = createDemand();
    const held = demandTargets({ totals: PULLING, segmentsOutside: 10, waiting: all(1) });
    moveDemand(demand, held, DEMAND_BALANCE.dailyShare);
    for (const bar of DEMAND_BARS) {
      // Both moved the same share of the way, so the bar is still 0 and its pull is a day's step.
      expect(demand[bar].value).toBeCloseTo(0, 9);
      expect(demandPull(demand, bar)).toBeCloseTo(others(held[bar], bar) * DEMAND_BALANCE.dailyShare, 9);
    }
    for (let d = 0; d < 200; d++) moveDemand(demand, held, DEMAND_BALANCE.dailyShare);
    for (const bar of DEMAND_BARS) {
      // 0.95 to the power 201 is about 3e-5 of the way still to go.
      expect(demand[bar].value).toBeCloseTo(0, 2);
      expect(demandPull(demand, bar)).toBeCloseTo(others(held[bar], bar), 2);
    }
  });

  it("lets go as what waits fills, and is never more than what the others add above zero, nor above 0", () => {
    const demand = createDemand();
    const held = demandTargets({ totals: PULLING, segmentsOutside: 10, waiting: all(1) });
    for (let d = 0; d < 100; d++) moveDemand(demand, held, DEMAND_BALANCE.dailyShare);
    // Nothing waits any more, and the city stops pulling all at once: the others fall faster than the waiting part lets go.
    const still = demandTargets({ totals: totals({}), segmentsOutside: 10 });
    for (let d = 0; d < 100; d++) {
      moveDemand(demand, still, 0.5);
      for (const bar of DEMAND_BARS) {
        const part = demand[bar].parts[WAITING_PART[bar]] ?? 0;
        expect(part).toBeLessThanOrEqual(0);
        expect(part).toBeGreaterThanOrEqual(-Math.max(0, others(demand[bar].parts, bar)) - 1e-9);
        expect(demand[bar].value).toBeCloseTo(sum(demand[bar].parts), 9);
      }
    }
  });

  it("is not read by the systems that act on demand: the grower's bar is the pull", () => {
    const demand: DemandState = createDemand();
    demand.office = { value: 5, parts: { educatedWorkers: 30, serviceBuyers: 0, jobsOpen: -25 } };
    demand.residential = { value: 0, parts: { openJobs: 40, unemployment: 0, satisfaction: 0, outsidePull: 0, homesFilling: -40 } };
    demand.commercial = { value: 20, parts: { spendingPower: 20, availableWorkers: 0, shopSurplus: 0, jobsOpen: 0 } };
    expect(zoneBar(demand, "office")).toBe(30);
    expect(zoneBar(demand, "residential")).toBe(40);
    // Mixed reads the lower of the two pulls.
    expect(zoneBar(demand, "mixed")).toBe(20);
  });
});

describe("what waits, counted on a real city", () => {
  /** The job matching fixture's city: homes filling, shops, offices and factories open, its bars no longer held. */
  const grown = () => replayFixture(jobs);

  it("reads each share from the same counts the grower holds by: 1 while held, else how near the hold is", () => {
    const state = grown();
    const shares = waitingShares(state);
    const room = reachableRoom(state);
    expect(shares.residential).toBe(holdsHomes(room) ? 1 : room.unfilled / DEMAND_BALANCE.unfilledHomesMax);
    const counts = zoneJobs(state);
    for (const bar of ["commercial", "office", "industrial"] as const) {
      const zone = ZONING_BALANCE.zones.findIndex((z) => z.id === bar) + 1;
      const share = shares[bar];
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
      if (workplacesHeldBy(counts, zone)) expect(share).toBe(1);
      else expect(share).toBe((counts.open[zone] ?? 0) / Math.max(DEMAND_BALANCE.openJobsMin, DEMAND_BALANCE.openJobsShareMax * (counts.jobs[zone] ?? 0)));
    }
  });

  it("brings a held zone's bar down to 0 over the days, while its pull stays above zero", () => {
    const state = grown();
    // Every workplace zone is held, open jobs or not: with thresholds below zero the hold never lifts as the
    // jobs fill. Since M4-08's charges this town's office zone fills its last open jobs in about 20 days,
    // and a hold that lifts lets the bar climb back before the test can read where it ends.
    withValue(DEMAND_BALANCE, "openJobsMin", -1, () =>
      withValue(DEMAND_BALANCE, "openJobsShareMax", -1, () => {
        const counts = zoneJobs(state);
        const office = ZONING_BALANCE.zones.findIndex((z) => z.id === "office") + 1;
        expect(counts.open[office]).toBeGreaterThan(0);
        expect(waitingShares(state).office).toBe(1);
        // The office bar's waiting part takes all of what pulls it, and the bar falls as the part follows.
        const end = state.tick + 120 * DAY;
        let lowest = Infinity;
        while (state.tick < end) {
          step(state);
          if (state.tick % DAY !== 1) continue;
          const bar = state.demand.office;
          expect(bar.value).toBeGreaterThanOrEqual(0);
          expect(bar.parts["jobsOpen"]).toBeLessThanOrEqual(0);
          if (waitingShares(state).office === 1 && demandPull(state.demand, "office") > 1) lowest = Math.min(lowest, bar.value / demandPull(state.demand, "office"));
        }
        // Held the whole time, the bar ends a small share of its pull.
        expect(lowest).toBeLessThan(0.1);
      }),
    );
  });

  it("leaves each waiting part where it is while a change of roads settles", () => {
    const state = createState(2026);
    for (const bar of DEMAND_BARS) state.demand[bar].parts[WAITING_PART[bar]] = -3;
    for (const bar of DEMAND_BARS) state.demand[bar].parts[DEMAND_PARTS[bar][0]] = 10;
    for (const bar of DEMAND_BARS) state.demand[bar].value = 7;
    state.cellsReadyAt = state.tick + 10;
    step(state);
    for (const bar of DEMAND_BARS) expect(state.demand[bar].parts[WAITING_PART[bar]]).toBeLessThanOrEqual(0);
    // Held where it was, then held within what the rest add above zero.
    for (const bar of DEMAND_BARS) expect(state.demand[bar].parts[WAITING_PART[bar]]).toBeCloseTo(Math.max(-3, -Math.max(0, others(state.demand[bar].parts, bar))), 9);
  });
});
