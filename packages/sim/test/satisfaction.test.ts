import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  NO_LEAVING,
  NO_WORK,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  addPop,
  buildingJobs,
  checkDemandBalance,
  checkPopsBalance,
  connectionEnd,
  createState,
  dayDepartures,
  demandTargets,
  deserialize,
  hashState,
  jobFits,
  matchJobs,
  popWorkers,
  readPop,
  recountTotals,
  satisfactionTarget,
  segmentsReachingOutside,
  serialize,
  setPopSatisfaction,
  step,
  stepScore,
  workersFor,
  yearDays,
  type Command,
  type SimState,
} from "../src/index";
import { DAYS_LOW_LIMIT } from "../src/pops/balance";
import { popIndexOf } from "../src/pops/where";
import { submit } from "./seen-ends";
import { holdDemand } from "./demand-helper";
import { expectReplay, replayFixture, type ReplayFixture } from "./replay-helper";
import { withValue } from "./with-value";
import { enqueue } from "../src/commands";
import popsJson from "../balance/pops.json" with { type: "json" };
import demandJson from "../balance/demand.json" with { type: "json" };
import fixtureJson from "./fixtures/replay/leaving.json" with { type: "json" };

// M3-10: satisfaction and leaving. Each pop's score heads once a game day
// for a target set by its job. A pop whose score stays low for long enough
// moves out, and while the residential bar is below zero people leave at a
// rate that follows it, the least satisfied first.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const SAT = POPS_BALANCE.satisfaction;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** A street `places` cells long from the stub end of the first outside connection. */
function street(state: SimState, places: number): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const s = { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
  ok(state, "BuildRoad", { from: { x: s.x, z: s.z }, to: { x: s.x + dx * CELL * places, z: s.z + dz * CELL * places }, type: "street" });
  return s;
}

/** Zones `depth` cells deep from place `p0` for `width` places along `s`, on one side or the other. */
function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1 = 1): void {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  ok(state, "ZoneCells", {
    zone: zoneId,
    density,
    rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }],
  });
}

/** Steps `state` to the first tick of the next game day, unless it is on one. */
function toDayStart(state: SimState): void {
  while (state.tick % DAY !== 0) step(state);
}

/** Runs `days` game days, calling `each` at the end of each. */
function runDays(state: SimState, days: number, each?: (day: number) => void): void {
  for (let day = 0; day < days; day++) {
    const until = state.tick + DAY;
    while (state.tick < until) step(state);
    each?.(day + 1);
  }
}

function livePops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.pops.flags.length; id++) if (state.pops.flags[id]) out.push(id);
  return out;
}

function workplaces(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && buildingJobs(state.buildings, id) > 0) out.push(id);
  return out;
}

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
  // The people at each score, which the bar's departures read, match the rows too.
  const byScore = new Float64Array(101);
  for (const id of livePops(state)) {
    const score = state.pops.satisfaction[id] ?? 0;
    byScore[score] = (byScore[score] ?? 0) + (state.pops.size[id] ?? 0);
  }
  expect(Array.from(popIndexOf(state).peopleBySatisfaction)).toEqual(Array.from(byScore));
}

const population = (state: SimState): number => state.stats.totals["population"] ?? 0;

/** An R2 street, both sides six deep, joined to the outside, and nothing else: a city with no jobs. */
function homesOnly(): { state: SimState; s: Street } {
  const state = createState(SEED);
  const s = street(state, 24);
  zone(state, s, "residential", 2, 0, 24, 6, 1);
  zone(state, s, "residential", 2, 0, 24, 6, -1);
  toDayStart(state);
  return { state, s };
}

/** Homes and a retail podium on one street, filled with its bars held up until most pops work. */
function workingCity(): SimState {
  const state = createState(SEED);
  const s = street(state, 30);
  zone(state, s, "commercial", 3, 0, 4, 4, 1);
  zone(state, s, "commercial", 3, 0, 4, 4, -1);
  zone(state, s, "residential", 1, 6, 14, 6, 1);
  zone(state, s, "residential", 1, 6, 14, 6, -1);
  holdDemand({ residential: 60, commercial: 60 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
    toDayStart(state);
    runDays(state, 20);
  }));
  return state;
}

describe("the balance", () => {
  it("checks the satisfaction numbers in pops.json and demand.json", () => {
    expect(checkPopsBalance(popsJson)).toEqual([]);
    expect(checkDemandBalance(demandJson)).toEqual([]);
    const sat = { ...popsJson.satisfaction };
    const pops = (over: Record<string, unknown>) => checkPopsBalance({ ...popsJson, satisfaction: { ...sat, ...over } }).join();
    expect(pops({ leaveAfterDays: DAYS_LOW_LIMIT + 1 })).toMatch(/leaveAfterDays/);
    expect(pops({ leaveAfterDays: 0 })).toMatch(/leaveAfterDays/);
    expect(pops({ dailyShare: 0 })).toMatch(/dailyShare/);
    expect(pops({ leaveBelow: 101 })).toMatch(/leaveBelow/);
    expect(pops({ target: { ...sat.target, noJob: 120 } })).toMatch(/satisfaction.target.noJob/);
    expect(pops({ extra: 1 })).toMatch(/extra/);
    const { satisfaction, ...noSat } = popsJson;
    void satisfaction;
    expect(checkPopsBalance(noSat).join()).toMatch(/satisfaction is missing/);
    expect(checkDemandBalance({ ...demandJson, residential: { ...demandJson.residential, satisfaction: -1 } }).join()).toMatch(/residential.satisfaction/);
    expect(checkDemandBalance({ ...demandJson, satisfactionNeutral: 120 }).join()).toMatch(/satisfactionNeutral/);
  });

  it("makes a pop with no job wait longer than a day's matching before it leaves, and about a game month", () => {
    // From a newcomer's score, or a worker's, to below the threshold, then the days it must stay there.
    const daysToLeave = (from: number) => {
      let score = from;
      let days = 0;
      while (score >= SAT.leaveBelow) {
        score = stepScore(score, SAT.target.noJob);
        days++;
      }
      return days + SAT.leaveAfterDays - 1;
    };
    expect(daysToLeave(POPS_BALANCE.newcomer.satisfaction)).toBeGreaterThanOrEqual(25);
    expect(daysToLeave(SAT.target.fittingJob)).toBeGreaterThanOrEqual(30);
    expect(daysToLeave(SAT.target.fittingJob)).toBeLessThanOrEqual(40);
  });
});

describe("a pop's score", () => {
  it("moves part of the way to its target each day, at least a point, never past it", () => {
    expect(stepScore(50, 50)).toBe(50);
    expect(stepScore(50, 0)).toBe(45);
    expect(stepScore(50, 70)).toBe(52);
    expect(stepScore(1, 0)).toBe(0);
    expect(stepScore(69, 70)).toBe(70);
    expect(stepScore(70, 69)).toBe(69);
    let score = 100;
    for (let day = 0; day < 200; day++) score = stepScore(score, 0);
    expect(score).toBe(0);
  });

  it("heads for the target its job sets: none for a pop with nobody who works, and less for a job below its education", () => {
    const state = workingCity();
    const p = state.pops;
    const shop = workplaces(state)[0] ?? -1;
    expect(shop).toBeGreaterThanOrEqual(0);
    // A shop's jobs are low and medium.
    expect(jobFits(state, shop, 0)).toBe(true);
    expect(jobFits(state, shop, 1)).toBe(true);
    expect(jobFits(state, shop, 2)).toBe(false);
    const target = SAT.target;
    let seen = 0;
    for (const id of livePops(state)) {
      const pop = readPop(p, id);
      const want =
        workersFor(pop.size, pop.children) === 0 ? target.noWorkers : pop.work === NO_WORK ? target.noJob : jobFits(state, pop.work, pop.education) ? target.fittingJob : target.otherJob;
      expect(satisfactionTarget(state, id)).toBe(want);
      seen++;
    }
    expect(seen).toBeGreaterThan(10);
    // A high education pop in a shop has a job, and a lower target than one whose job fits.
    const high = livePops(state).find((id) => p.work[id] === shop && p.education[id] === 2);
    if (high !== undefined) expect(satisfactionTarget(state, high)).toBe(target.otherJob);
    expect(target.otherJob).toBeLessThan(target.fittingJob);
    expect(target.otherJob).toBeGreaterThan(target.noJob);
    expectRecount(state);
  });

  it("keeps the summed satisfaction and the people at each score with the rows as scores change", () => {
    const state = workingCity();
    const ids = livePops(state);
    ids.forEach((id, i) => setPopSatisfaction(state, id, (i * 37) % 101));
    expectRecount(state);
    runDays(state, 3);
    expectRecount(state);
  });
});

describe("leaving for lack of work", () => {
  it("finds a city with no jobs losing population (PRD, scenario test)", () => {
    const { state } = homesOnly();
    // Filled past the pull from outside with the residential bar held up.
    holdDemand({ residential: 100 }, () => runDays(state, 20));
    const filled = population(state);
    expect(filled).toBeGreaterThan(DEMAND_BALANCE.outsidePull.untilResidents);
    expect(state.stats.year.departures).toBe(0);
    // Then let go: nobody has work, the bar falls below zero and the pops leave.
    let lowest = 0;
    runDays(state, 60, () => (lowest = Math.min(lowest, state.demand.residential.value)));
    expect(lowest).toBeLessThan(0);
    expect(population(state)).toBeLessThan(filled);
    expect(state.stats.year.departures).toBeGreaterThan(0);
    expectRecount(state);
  });

  it("finds an all-residential city grows, stalls and then holds or shrinks, and never passes a set population", () => {
    const { state } = homesOnly();
    let highest = 0;
    let atDay60 = 0;
    runDays(state, 200, (day) => {
      highest = Math.max(highest, population(state));
      if (day === 60) atDay60 = population(state);
      // Never far past the residents the pull from outside holds the bar up for. Since M3-21 the bar
      // takes about 20 game days to fall (dailyShare 0.05) and the day's arrivals follow the empty
      // room, so a few households more come while it falls.
      expect(population(state)).toBeLessThanOrEqual(1.1 * DEMAND_BALANCE.outsidePull.untilResidents);
    });
    expect(atDay60).toBeGreaterThan(100);
    // It stalled: no higher at the end than it was at two months, give or take a household.
    expect(population(state)).toBeLessThanOrEqual(Math.max(atDay60, highest) + 20);
    // People have come and gone.
    expect(state.stats.year.departures).toBeGreaterThan(state.stats.year.arrivals / 2);
    expectRecount(state);
  });

  it("finds pops leaving after about a game month once every workplace is removed, not before", () => {
    const state = workingCity();
    const working = livePops(state).filter((id) => state.pops.work[id] !== NO_WORK);
    expect(working.length).toBeGreaterThan(5);
    const people = new Map(working.map((id) => [id, readPop(state.pops, id)]));
    // Their scores have reached the target a fitting or other job sets.
    for (const id of working) expect(state.pops.satisfaction[id]).toBeGreaterThanOrEqual(SAT.leaveBelow);
    const shops = workplaces(state);
    const b = state.buildings;
    ok(state, "BulldozeBuilding", {
      buildings: shops.map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] })),
    });
    for (const id of working) expect(state.pops.work[id]).toBe(NO_WORK);
    expect(workplaces(state)).toEqual([]);
    // The bar is held at zero, so the only way out is a low score for long enough.
    const left = new Map<number, number>();
    holdDemand({ residential: 0, commercial: 0 }, () =>
      runDays(state, 50, (day) => {
        for (const id of working) {
          const was = people.get(id);
          const gone = !state.pops.flags[id] || state.pops.home[id] !== was?.home || state.pops.size[id] !== was?.size;
          if (gone && !left.has(id)) left.set(id, day);
        }
      }),
    );
    const days = [...left.values()];
    expect(days.length).toBe(working.length);
    // Not before about a game month, and every one of them by fifty days.
    expect(Math.min(...days)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...days)).toBeLessThanOrEqual(45);
    expect(state.stats.year.departures).toBeGreaterThan(0);
    expectRecount(state);
  });

  it("lets a pop that finds work late in its wait keep it, though its score is still low", () => {
    const state = workingCity();
    const worker = livePops(state).find((id) => state.pops.work[id] !== NO_WORK && popWorkers(state.pops, id) > 0);
    expect(worker).toBeDefined();
    const id = worker as number;
    // A day from leaving, at the bottom, but with a job: its target is above the threshold.
    setPopSatisfaction(state, id, 0);
    state.pops.daysLow[id] = SAT.leaveAfterDays - 1;
    expect(satisfactionTarget(state, id)).toBeGreaterThanOrEqual(SAT.leaveBelow);
    holdDemand({ residential: 0, commercial: 0 }, () => runDays(state, 10));
    expect(state.pops.flags[id]).toBe(1);
    expect(state.pops.daysLow[id]).toBe(0);
    expect(state.pops.satisfaction[id]).toBeGreaterThan(0);
    expectRecount(state);
  });

  it("frees a leaving pop's home and puts its people on the year's departures", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 50 }, () => runDays(state, 5));
    // Only pops with someone who works: one with nobody heads for a score above the threshold, so its days low start again.
    const ids = livePops(state).filter((id) => popWorkers(state.pops, id) > 0);
    expect(ids.length).toBeGreaterThan(0);
    const before = population(state);
    const departed = state.stats.year.departures;
    // Every pop with workers is about to run out of patience.
    for (const id of livePops(state)) {
      setPopSatisfaction(state, id, 0);
      state.pops.daysLow[id] = SAT.leaveAfterDays - 1;
    }
    const leaving = ids.reduce((sum, id) => sum + (state.pops.size[id] ?? 0), 0);
    holdDemand({ residential: 0 }, () => runDays(state, 1));
    expect(state.stats.year.departures - departed).toBe(leaving);
    expect(population(state)).toBe(before - leaving);
    for (const id of ids) expect(state.pops.flags[id]).toBe(0);
    expectRecount(state);
  });
});

describe("leaving while the residential bar is below zero", () => {
  it("sends away people a day that follow the bar, none at or above zero", () => {
    const perDay = DEMAND_BALANCE.departuresPerYearAtFullDemand / yearDays();
    expect(dayDepartures(0)).toBe(0);
    expect(dayDepartures(40)).toBe(0);
    expect(dayDepartures(-100)).toBe(Math.ceil(perDay));
    expect(dayDepartures(-0.01)).toBe(1);
    expect(dayDepartures(-50)).toBeLessThan(dayDepartures(-100));
  });

  it("sends the least satisfied away first, about the day's number of people", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 100 }, () => runDays(state, 10));
    const ids = livePops(state);
    expect(ids.length).toBeGreaterThan(20);
    // Each pop a different score, so who goes first is plain; none low long enough to leave on its own.
    ids.forEach((id, i) => setPopSatisfaction(state, id, 30 + ((i * 7) % 70)));
    const scores = new Map(ids.map((id) => [id, state.pops.satisfaction[id] ?? 0]));
    const before = population(state);
    const due = dayDepartures(-100);
    holdDemand({ residential: -100 }, () => runDays(state, 1));
    const gone = ids.filter((id) => !state.pops.flags[id]);
    const stayed = ids.filter((id) => state.pops.flags[id]);
    expect(gone.length).toBeGreaterThan(0);
    const worstStayed = Math.min(...stayed.map((id) => scores.get(id) ?? 0));
    const bestGone = Math.max(...gone.map((id) => scores.get(id) ?? 0));
    expect(bestGone).toBeLessThanOrEqual(worstStayed);
    // The day's number, give or take the last household.
    const left = before - population(state);
    expect(left).toBeGreaterThanOrEqual(due);
    expect(left).toBeLessThan(due + 100);
    expect(state.stats.year.departures).toBe(left);
    expectRecount(state);
  });

  it("pays back what a large pop took past the plan on later days, so a city of towers loses people at the bar's rate", () => {
    const state = createState(SEED);
    const s = street(state, 24);
    zone(state, s, "residential", 3, 0, 8, 4, 1);
    zone(state, s, "residential", 3, 10, 8, 4, 1);
    toDayStart(state);
    holdDemand({ residential: 100 }, () => runDays(state, 20));
    const before = population(state);
    expect(before).toBeGreaterThan(400);
    const days = 20;
    // A bar of -5 sends a few people a day, far fewer than one tower pop holds.
    const due = dayDepartures(-5);
    expect(due).toBeLessThan(POPS_BALANCE.newcomer.size[2]?.[0] ?? 0);
    withValue(SAT, "leaveAfterDays", DAYS_LOW_LIMIT, () => holdDemand({ residential: -5 }, () => runDays(state, days)));
    const left = before - population(state);
    expect(left).toBeGreaterThan(0);
    // The days' people, give or take one tower household, and not a household a day.
    expect(left).toBeLessThanOrEqual(due * days + (POPS_BALANCE.popSizeCap[2] ?? 100));
    expect(state.pops.leaveAtScore).toBeLessThanOrEqual(0);
    expectRecount(state);
  });

  it("drops what was taken past the plan once the bar is back at or above zero", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 100 }, () => runDays(state, 5));
    state.pops.leaveAtScore = -30;
    holdDemand({ residential: 0 }, () => runDays(state, 1));
    expect(state.pops.leaveAtScore).toBe(0);
    expect(state.pops.leaveScore).toBe(NO_LEAVING);
  });

  it("sends nobody away while the bar is at or above zero", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 100 }, () => runDays(state, 8));
    holdDemand({ residential: 0 }, () => runDays(state, 5));
    expect(state.pops.leaveScore).toBe(NO_LEAVING);
    expect(state.stats.year.departures).toBe(0);
  });
});

describe("satisfaction and the residential bar", () => {
  it("reads the bar lower in a city of dissatisfied pops than in the same city satisfied", () => {
    // A city with work, so unemployment does not hold both bars at the bottom.
    const state = workingCity();
    const unhappy = deserialize(serialize(state)).state;
    const happy = deserialize(serialize(state)).state;
    for (const id of livePops(unhappy)) setPopSatisfaction(unhappy, id, 10);
    for (const id of livePops(happy)) setPopSatisfaction(happy, id, 90);
    const target = (s: SimState) => demandTargets({ totals: s.stats.totals, segmentsOutside: segmentsReachingOutside(s) }).residential;
    // Past the pull from outside, which would hold both up to the same bar,
    // and with open jobs weighed lightly, so this small city's many open
    // jobs do not hold both at the top.
    withValue(DEMAND_BALANCE.outsidePull, "untilResidents", 0, () => withValue(DEMAND_BALANCE.residential, "openJobs", 20, () => {
      expect(target(unhappy)["satisfaction"]).toBeLessThan(0);
      expect(target(happy)["satisfaction"]).toBeGreaterThan(0);
      const sum = (parts: Record<string, number>) => Object.values(parts).reduce((a, b) => a + b, 0);
      expect(sum(target(unhappy))).toBeLessThan(sum(target(happy)));
      // And the bars themselves, a day on.
      runDays(unhappy, 1);
      runDays(happy, 1);
    }));
    expect(unhappy.demand.residential.value).toBeLessThan(happy.demand.residential.value);
    expectRecount(unhappy);
    expectRecount(happy);
  });

  it("reads 0 for a city with nobody in it", () => {
    const state = createState(SEED);
    expect(demandTargets({ totals: state.stats.totals, segmentsOutside: 0 }).residential["satisfaction"]).toBe(0);
  });
});

describe("saving mid-exodus", () => {
  /** Steps `state` and a saved and loaded copy of it `ticks` ticks on, under `bars`, and checks they hash the same. */
  function resumes(state: SimState, ticks: number, bars: Parameters<typeof holdDemand>[0]): void {
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(hashState(state));
    holdDemand(bars, () => {
      for (let i = 0; i < ticks; i++) {
        step(state);
        step(loaded);
      }
    });
    expect(hashState(loaded)).toBe(hashState(state));
    expectRecount(loaded);
  }

  it("resumes to the same hash while the bar sends people away, saved mid-day", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 100 }, () => runDays(state, 10));
    holdDemand({ residential: -100 }, () => {
      do step(state);
      while (state.tick % DAY !== 37);
    });
    expect(state.pops.leaveScore).not.toBe(NO_LEAVING);
    const departed = state.stats.year.departures;
    resumes(state, 3 * DAY, { residential: -100 });
    expect(state.stats.year.departures).toBeGreaterThan(departed);
  });

  it("resumes to the same hash while jobless pops run out of patience, saved mid-day", () => {
    const { state } = homesOnly();
    holdDemand({ residential: 100 }, () => runDays(state, 8));
    holdDemand({ residential: 0 }, () => {
      runDays(state, 28);
      while (state.tick % DAY !== 61) step(state);
    });
    const departed = state.stats.year.departures;
    resumes(state, 10 * DAY, { residential: 0 });
    expect(state.stats.year.departures).toBeGreaterThan(departed);
  });
});

describe("a new pop's days low", () => {
  it("starts at 0, or at what the household had when it is the part of a split pop", () => {
    const state = createState(SEED);
    const s = street(state, 12);
    zone(state, s, "residential", 3, 4, 4, 4, 1);
    holdDemand({ residential: 100 }, () => runDays(state, 2));
    const tower = (() => {
      for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.density === 3) return id;
      return -1;
    })();
    expect(tower).toBeGreaterThanOrEqual(0);
    const id = addPop(state, { home: tower, size: 10, education: 0, wealth: 0, children: 0, satisfaction: 20, daysLow: 9 });
    expect(readPop(state.pops, id).daysLow).toBe(9);
    expect(() => addPop(state, { home: tower, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 20, daysLow: DAYS_LOW_LIMIT + 1 })).toThrow(/days low/);
    expect(readPop(state.pops, addPop(state, { home: tower, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 20 })).daysLow).toBe(0);
    expectRecount(state);
  });

  it("keeps a household's days low in both parts when job matching splits it", () => {
    const state = createState(SEED);
    const s = street(state, 30);
    zone(state, s, "residential", 3, 4, 4, 4, 1);
    zone(state, s, "commercial", 1, 12, 6, 2, -1);
    toDayStart(state);
    holdDemand({ residential: 0, commercial: 100 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runDays(state, 4)));
    const shops = workplaces(state);
    expect(shops.length).toBeGreaterThan(0);
    const tower = (() => {
      for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.density === 3) return id;
      return -1;
    })();
    expect(tower).toBeGreaterThanOrEqual(0);
    // Larger than any shop's jobs, so it must split to work.
    const big = Math.min(POPS_BALANCE.popSizeCap[2] ?? 100, state.buildings.residents[tower] ?? 0);
    const id = addPop(state, { home: tower, size: big, education: 0, wealth: 1, children: 0, satisfaction: 12, daysLow: 7 });
    expect(Math.max(...shops.map((w) => buildingJobs(state.buildings, w)))).toBeLessThan(workersFor(big, 0));
    // A day of matching alone, so nothing else moves the days low.
    const start = state.tick;
    state.pops.sweep = state.pops.flags.length;
    for (let k = 0; k < DAY; k++) {
      state.tick = start + k;
      matchJobs(state);
    }
    const parts = livePops(state).filter((p) => state.pops.home[p] === tower && state.pops.wealth[p] === 1 && state.pops.satisfaction[p] === 12);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts).toContain(id);
    for (const p of parts) expect(state.pops.daysLow[p]).toBe(7);
    expect(parts.reduce((sum, p) => sum + (state.pops.size[p] ?? 0), 0)).toBe(big);
  });
});

describe("replay fixture leaving", () => {
  const fixture = fixtureJson as unknown as ReplayFixture;

  it("replays to its recorded hash, with people gone", () => {
    const state = expectReplay(fixture);
    expect(state.stats.year.departures).toBeGreaterThan(0);
    expectRecount(state);
  });

  it.each([2950, 3333, 4321])("hashes the same saved and loaded at tick %d", (at) => {
    let state = createState(fixture.seed);
    let next = 0;
    while (state.tick < fixture.untilTick) {
      if (state.tick === at && state.log.length === next) state = deserialize(serialize(state)).state;
      for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
      step(state);
    }
    expect(hashState(state)).toBe(fixture.hash);
    expect(hashState(state)).toBe(hashState(replayFixture(fixture)));
  });
});
