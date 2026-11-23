import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  NO_WORK,
  ROUTING_BALANCE,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingJobs,
  buildingTravelZone,
  checkDemandBalance,
  connectionEnd,
  createState,
  deserialize,
  hashState,
  jobWeight,
  jobsFilled,
  jobsUpToLevel,
  openJobsFor,
  partThatFits,
  prepareDerived,
  popsAtWork,
  readPop,
  recountTotals,
  serialize,
  setPopWork,
  step,
  workersFor,
  workplacesHeld,
  workplacesHeldBy,
  zoneJobs,
  type Command,
  type SimState,
} from "../src/index";
import { GROWER } from "../src/buildings/grower";
import { openingsOf, openingsProblem } from "../src/pops/openings";
import { enqueue } from "../src/commands";
import { submit } from "./seen-ends";
import { holdDemand, type HeldBars } from "./demand-helper";
import { expectReplay, replayFixture, type ReplayFixture } from "./replay-helper";
import fixtureJson from "./fixtures/replay/jobs.json" with { type: "json" };
import { withValue } from "./with-value";

// M3-09: job matching. Pops without work look for it a slice a tick, and
// take open jobs their education allows, nearer ones likelier. The grower
// holds new workplaces back while a zone's open jobs are above a share of
// its jobs.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const COMMERCIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
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

/** Runs `days` game days, calling `each` after every step. */
function runDays(state: SimState, days: number, each?: () => void): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) {
    step(state);
    each?.();
  }
}


function live(state: SimState, keep: (id: number) => boolean): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && keep(id)) out.push(id);
  return out;
}

const workplaces = (state: SimState) => live(state, (id) => buildingJobs(state.buildings, id) > 0);
const typeId = (state: SimState, id: number) => BUILDING_TYPES[state.buildings.type[id] ?? 0]?.id;

function pops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.pops.flags.length; id++) if (state.pops.flags[id]) out.push(id);
  return out;
}

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
}

/**
 * Every workplace's jobs filled, in all and at each education level and
 * below, within the jobs it offers there, and the index's counts equal to
 * a count from the pop rows.
 */
function expectJobsWithinOffers(state: SimState): void {
  const p = state.pops;
  const filled = new Map<number, number[]>();
  for (const id of pops(state)) {
    const work = p.work[id] ?? NO_WORK;
    if (work === NO_WORK) continue;
    const row = filled.get(work) ?? [0, 0, 0];
    row[p.education[id] ?? 0] = (row[p.education[id] ?? 0] ?? 0) + workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
    filled.set(work, row);
  }
  for (const [work, byLevel] of filled) {
    const jobs = buildingJobs(state.buildings, work);
    const upTo = jobsUpToLevel(state.buildings.type[work] ?? 0, jobs);
    let running = 0;
    byLevel.forEach((n, level) => {
      running += n;
      if (running > (upTo[level] ?? 0)) expect.fail(`building ${work} has ${running} workers up to education ${level} for ${upTo[level]} jobs, tick ${state.tick}`);
    });
    if (running !== jobsFilled(state, work)) expect.fail(`building ${work}'s jobs filled ${jobsFilled(state, work)} are not its ${running} workers`);
  }
}

const NEAR_FAR_BARS: HeldBars = { residential: 100, commercial: 100 };

/**
 * Houses on an R1 strip between two C3 lots three wide and four deep, which
 * take a retail podium of 48 jobs each: one beside the houses, the other
 * at the far end of the street, in the next travel zone. Grown with the
 * open jobs share out of the way, so both podiums stand before the houses
 * fill.
 *
 * The street can run only 800 m before the ground is too steep, so the far
 * podium is about a minute's drive away, as long as `sameZoneSeconds`. The
 * scenarios run with the times scaled to the street: ten seconds within a
 * zone and half the weight at thirty (`scaledTimes`).
 */
function nearAndFar(): { state: SimState; near: number; far: number } {
  const state = createState(SEED);
  const s = street(state, 99);
  zone(state, s, "commercial", 3, 0, 3, 4, 1);
  zone(state, s, "residential", 1, 6, 14, 6, 1);
  zone(state, s, "residential", 1, 6, 14, 6, -1);
  zone(state, s, "commercial", 3, 95, 3, 4, 1);
  return holdDemand(NEAR_FAR_BARS, () =>
    withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
      runDays(state, 1);
      const shops = workplaces(state);
      expect(shops.map((id) => typeId(state, id))).toEqual(["retail-podium", "retail-podium"]);
      const [a, b] = shops as [number, number];
      const home = live(state, (id) => (state.buildings.residents[id] ?? 0) > 0)[0] ?? 0;
      const nearIsA = buildingTravelZone(state, a) === buildingTravelZone(state, home);
      return { state, near: nearIsA ? a : b, far: nearIsA ? b : a };
    }),
  );
}

/** Runs `body` with travel times scaled to the 800 m street of `nearAndFar`. */
function scaledTimes<R>(body: () => R): R {
  return withValue(ROUTING_BALANCE.travelTimes, "sameZoneSeconds", 10, () =>
    withValue(DEMAND_BALANCE.jobMatching, "halfWeightSeconds", 30, body),
  );
}

describe("which jobs a pop may take", () => {
  it("counts a job at the pop's education or below, so low education never works in an office", () => {
    const state = createState(SEED);
    const office = BUILDING_TYPES.findIndex((t) => t.id === "low-office-block");
    const shop = BUILDING_TYPES.findIndex((t) => t.id === "shop-row");
    // An office's jobs are half medium and half high; a shop's 60% low and 40% medium.
    expect(Array.from(jobsUpToLevel(office, 36))).toEqual([0, 18, 36]);
    expect(Array.from(jobsUpToLevel(shop, 10))).toEqual([6, 10, 10]);
    expect(openJobsFor(state, 0, 0)).toBe(0);
  });

  it("weights a job by travel time, half at halfWeightSeconds and falling faster with a larger power", () => {
    const half = DEMAND_BALANCE.jobMatching.halfWeightSeconds;
    expect(jobWeight(0)).toBe(1);
    expect(jobWeight(half)).toBe(0.5);
    expect(jobWeight(2 * half)).toBeCloseTo(1 / (1 + 2 ** DEMAND_BALANCE.jobMatching.falloffPower), 12);
    expect(jobWeight(60)).toBeGreaterThan(jobWeight(600));
  });

  it("checks the matching numbers in demand.json", () => {
    const bad = JSON.parse(JSON.stringify(DEMAND_BALANCE)) as Record<string, unknown>;
    bad["jobMatching"] = { halfWeightSeconds: 0, falloffPower: 1.5 };
    bad["openJobsShareMax"] = 2;
    const problems = checkDemandBalance(bad);
    expect(problems.some((p) => p.includes("halfWeightSeconds"))).toBe(true);
    expect(problems.some((p) => p.includes("falloffPower"))).toBe(true);
    expect(problems.some((p) => p.includes("openJobsShareMax"))).toBe(true);
    expect(checkDemandBalance(JSON.parse(JSON.stringify(DEMAND_BALANCE)))).toEqual([]);
  });

  it("splits a pop: the largest part with a worker that fits takes the jobs, keeping the pop's workers where a part can", () => {
    // Without children 60% work: 10 people are 6 workers, 5 are 3.
    expect(partThatFits(10, 0, 3)).toBe(5);
    expect(workersFor(5, 0)).toBe(3);
    expect(partThatFits(100, 0, 59)).toBe(99);
    // 8 people are 5 workers. 4 + 4 would be 2 + 2; 3 + 5 keeps all 5.
    expect(workersFor(8, 0)).toBe(5);
    expect(partThatFits(8, 0, 2)).toBe(3);
    // 4 with children are 2 workers; 2 + 2 keeps both, where 3 + 1 would lose one.
    expect(partThatFits(4, 1, 1)).toBe(2);
    // No part fits no job.
    expect(partThatFits(4, 1, 0)).toBe(0);
    for (let size = 2; size <= 100; size++) {
      for (const children of [0, 1]) {
        for (let open = 1; open < workersFor(size, children); open++) {
          const part = partThatFits(size, children, open);
          if (part === 0) continue;
          expect(workersFor(part, children)).toBeGreaterThan(0);
          expect(workersFor(part, children)).toBeLessThanOrEqual(open);
        }
      }
    }
  });
});

describe("job matching", () => {
  it("finds more pops working at the nearer of two workplaces with equal jobs, and some at the farther", () => {
    const { state, near, far } = nearAndFar();
    expect(buildingJobs(state.buildings, near)).toBe(buildingJobs(state.buildings, far));
    expect(buildingTravelZone(state, near)).not.toBe(buildingTravelZone(state, far));
    scaledTimes(() => holdDemand(NEAR_FAR_BARS, () => runDays(state, 12, () => expectJobsWithinOffers(state))));
    const atNear = jobsFilled(state, near);
    const atFar = jobsFilled(state, far);
    expect(atNear).toBeGreaterThan(atFar);
    expect(atFar).toBeGreaterThan(0);
    expect(atNear).toBeLessThan(buildingJobs(state.buildings, near));
    expect(state.stats.totals["workersEmployed"]).toBe(atNear + atFar);
    expectRecount(state);
  });

  it("leaves low education pops unemployed when only office jobs are offered", () => {
    const state = createState(SEED);
    const s = street(state, 40);
    zone(state, s, "residential", 1, 0, 14, 6, 1);
    zone(state, s, "office", 1, 0, 14, 6, -1);
    const lowOnly = { low: 1, medium: 0, high: 0 };
    withValue(POPS_BALANCE.newcomer, "education", lowOnly, () =>
      holdDemand({ residential: 100, office: 100 }, () => runDays(state, 8, () => expectJobsWithinOffers(state))),
    );
    expect(workplaces(state).length).toBeGreaterThan(0);
    expect(pops(state).length).toBeGreaterThan(5);
    expect(state.stats.totals["workersEmployed"]).toBe(0);
    expect(state.stats.totals["workersUnemployed"]).toBeGreaterThan(0);
    const office = workplaces(state)[0] ?? 0;
    const looker = pops(state).find((id) => workersFor(state.pops.size[id] ?? 0, state.pops.children[id] ?? 0) > 0) ?? 0;
    expect(openJobsFor(state, office, 0)).toBe(0);
    expect(openJobsFor(state, office, 1)).toBeGreaterThan(0);
    expect(() => setPopWork(state, looker, office)).toThrow(/up to education 0/);
    expectRecount(state);
  });

  it("stops building shops while open shop jobs are above the share, and starts again as they fill", () => {
    const state = createState(SEED);
    const s = street(state, 40);
    zone(state, s, "residential", 1, 0, 30, 6, 1);
    zone(state, s, "residential", 1, 0, 30, 6, -1);
    // Houses first, so there are people to take the jobs.
    holdDemand({ residential: 100 }, () => runDays(state, 10));
    expect(pops(state).length).toBeGreaterThan(10);
    zone(state, s, "commercial", 1, 31, 8, 6, 1);
    zone(state, s, "commercial", 1, 31, 8, 6, -1);
    const shops = () => workplaces(state).length;
    // Watch the grower itself: whether the shops were held as it ran, and whether it built one.
    let heldTicks = 0;
    let grewAfterHeld = false;
    const original = GROWER.run;
    GROWER.run = (st: SimState) => {
      const held = workplacesHeld(st, COMMERCIAL);
      const before = shops();
      original(st);
      if (held && shops() > before) expect.fail(`built a shop while held, tick ${st.tick}`);
      if (held) heldTicks++;
      else if (heldTicks > 0 && shops() > before) grewAfterHeld = true;
    };
    try {
      // The share alone: a strip of corner shops never has more open jobs than the floor (M3-21).
      withValue(DEMAND_BALANCE, "openJobsMin", 0, () => holdDemand({ residential: 100, commercial: 100 }, () => runDays(state, 10)));
    } finally {
      GROWER.run = original;
    }
    expect(heldTicks).toBeGreaterThan(0);
    expect(grewAfterHeld).toBe(true);
    expect(shops()).toBeGreaterThan(1);
    const jobs = zoneJobs(state);
    expect(jobs.open[COMMERCIAL]).toBeLessThanOrEqual((jobs.jobs[COMMERCIAL] ?? 0) * DEMAND_BALANCE.openJobsShareMax + 48);
    expectRecount(state);
  });

  it("holds no zone while its open jobs are at most openJobsMin, whatever their share (M3-21)", () => {
    const least = DEMAND_BALANCE.openJobsMin;
    const share = DEMAND_BALANCE.openJobsShareMax;
    const jobs = (offered: number, open: number) => ({ jobs: Float64Array.of(0, offered, 0, 0, 0, 0), open: Float64Array.of(0, open, 0, 0, 0, 0) });
    // A zone starting again from nothing: its first workshop's jobs all open.
    expect(workplacesHeldBy(jobs(6, 6), 1)).toBe(false);
    expect(workplacesHeldBy(jobs(least, least), 1)).toBe(false);
    // Past the floor, the share holds it as before.
    expect(workplacesHeldBy(jobs(10 * least, least + 1), 1)).toBe(share * 10 * least < least + 1);
    expect(workplacesHeldBy(jobs(1000 * least, 1000 * least), 1)).toBe(true);
  });

  it("leaves a bulldozed workplace's pops unemployed, then working elsewhere", () => {
    const { state, near, far } = nearAndFar();
    scaledTimes(() => holdDemand(NEAR_FAR_BARS, () => runDays(state, 8)));
    const workers = popsAtWork(state, near);
    expect(workers.length).toBeGreaterThan(0);
    const b = state.buildings;
    holdDemand(NEAR_FAR_BARS, () =>
      ok(state, "BulldozeBuilding", { buildings: [{ id: near, segment: b.firstSeg[near], side: b.firstSide[near], place: b.firstPlace[near], builtAt: b.builtAt[near] }] }),
    );
    for (const id of workers) expect(readPop(state.pops, id).work).toBe(NO_WORK);
    expectRecount(state);
    // The far podium has room for them: no shop grows back on the near lot while its jobs are open.
    withValue(DEMAND_BALANCE, "openJobsShareMax", 0, () => holdDemand({ residential: 0, commercial: -10 }, () => runDays(state, 2, () => expectJobsWithinOffers(state))));
    // Each works at the far podium now, unless it has no open job left that the pop's education allows.
    let moved = 0;
    for (const id of workers) {
      const pop = readPop(state.pops, id);
      if (pop.work === far) moved++;
      else expect(openJobsFor(state, far, pop.education), `pop ${id}`).toBeLessThan(workersFor(pop.size, pop.children));
    }
    expect(moved).toBeGreaterThan(0);
    expectRecount(state);
  });

  it("splits a tower's pops by where they work, and never puts a building over its jobs", () => {
    const state = createState(SEED);
    const s = street(state, 40);
    zone(state, s, "residential", 3, 4, 4, 4, 1);
    zone(state, s, "commercial", 3, 4, 3, 4, -1);
    zone(state, s, "commercial", 1, 12, 20, 2, -1);
    const before = new Set<number>();
    withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () =>
      holdDemand({ residential: 100, commercial: 100 }, () =>
        runDays(state, 20, () => {
          expectJobsWithinOffers(state);
          for (const id of pops(state)) before.add(id);
        }),
      ),
    );
    const tower = live(state, (id) => (BUILDING_TYPES[state.buildings.type[id] ?? 0]?.density ?? 0) === 3 && (state.buildings.residents[id] ?? 0) > 0)[0];
    expect(tower).toBeDefined();
    const inTower = pops(state).filter((id) => state.pops.home[id] === tower);
    const sizes = inTower.map((id) => state.pops.size[id] ?? 0);
    // Some tower pops came out smaller than any newcomer to a tower: split by where they work.
    expect(Math.min(...sizes)).toBeLessThan(POPS_BALANCE.newcomer.size[2]?.[0] ?? 0);
    const works = new Set(inTower.map((id) => state.pops.work[id]).filter((w) => w !== NO_WORK));
    expect(works.size).toBeGreaterThan(1);
    expectRecount(state);
  });

  it("builds its openings again after a change of roads made while paused on a loaded city, whatever tick the travel times say", () => {
    const { state } = nearAndFar();
    const end = connectionEnd(state.roads, state.connections[0] ?? NONE);
    const x = state.roads.nodeX[end] ?? 0;
    const z = state.roads.nodeZ[end] ?? 0;
    // Short streets off the main one: small changes, so the travel times are ready again on the tick they apply.
    const side = (at: number): Command => ({ seq: ++seq, playerId: "p1", type: "BuildRoad", payload: { from: { x: x + CELL * at, z }, to: { x: x + CELL * at, z: z + 60 }, type: "street" } });
    ok(state, "SetSpeed", { speed: 0 });
    expect(submit(state, side(50))).toEqual({ ok: true });
    step(state);
    const tick = state.tick;
    expect(state.travelReadyAt).toBe(tick);
    // Saved paused, loaded, and the derived data built as a host builds it.
    const loaded = deserialize(serialize(state)).state;
    prepareDerived(loaded);
    const before = openingsOf(loaded);
    expect(submit(loaded, side(70))).toEqual({ ok: true });
    step(loaded);
    // The same tick and the same ready tick, yet the roads changed.
    expect(loaded.tick).toBe(tick);
    expect(loaded.travelReadyAt).toBe(tick);
    expect(openingsOf(loaded)).not.toBe(before);
    expect(openingsProblem(loaded)).toBeNull();
  });

  it("does nothing while the travel times are still being rebuilt", () => {
    const { state } = nearAndFar();
    // Since M3-21 houses fill faster, and a pop or two may have found work on the first day, before the rebuild.
    const employed = state.stats.totals["workersEmployed"] ?? 0;
    state.travelReadyAt = state.tick + 10 * DAY;
    holdDemand(NEAR_FAR_BARS, () => runDays(state, 3));
    expect(state.stats.totals["workersEmployed"]).toBeLessThanOrEqual(employed);
    expect(state.stats.totals["workersUnemployed"]).toBeGreaterThan(0);
  });
});

describe("a long session", () => {
  it("never has a building with more jobs filled than it offers, after any step, its openings equal ones built afresh, and its totals equal the recount", () => {
    const state = createState(SEED);
    const s = street(state, 60);
    zone(state, s, "residential", 1, 0, 20, 6, 1);
    zone(state, s, "residential", 2, 20, 10, 6, 1);
    zone(state, s, "residential", 3, 30, 6, 6, 1);
    zone(state, s, "commercial", 1, 0, 12, 6, -1);
    zone(state, s, "office", 1, 12, 10, 6, -1);
    zone(state, s, "industrial", 1, 22, 10, 6, -1);
    zone(state, s, "mixed", 2, 36, 12, 6, 1);
    const bars: HeldBars = { residential: 100, commercial: 80, office: 60, industrial: 60 };
    const check = () => {
      expectJobsWithinOffers(state);
      // The openings kept current by notes, checked against a fresh build twice a game day.
      if (state.tick % 50 === 0) expect(openingsProblem(state)).toBeNull();
    };
    holdDemand(bars, () => {
      runDays(state, 20, check);
      // A street across the strips, which moves the zones and the reach of
      // what stands by it, then the workplaces with the most workers bulldozed.
      ok(state, "BuildRoad", { from: { x: s.x + s.dx * CELL * 18.5 - s.dz * 60, z: s.z + s.dz * CELL * 18.5 + s.dx * 60 }, to: { x: s.x + s.dx * CELL * 18.5 + s.dz * 60, z: s.z + s.dz * CELL * 18.5 - s.dx * 60 }, type: "street" });
      check();
      const busy = workplaces(state)
        .sort((a, b) => jobsFilled(state, b) - jobsFilled(state, a))
        .slice(0, 3);
      const b = state.buildings;
      ok(state, "BulldozeBuilding", { buildings: busy.map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] })) });
      check();
      runDays(state, 10, check);
    });
    expect(openingsProblem(state)).toBeNull();
    expect(state.stats.totals["workersEmployed"]).toBeGreaterThan(0);
    expectRecount(state);
  });
});

describe("replay fixture jobs", () => {
  const fixture = fixtureJson as unknown as ReplayFixture;

  it("replays to its recorded hash, with pops at work", () => {
    const state = expectReplay(fixture);
    expect(state.stats.totals["workersEmployed"]).toBeGreaterThan(0);
    expectRecount(state);
  });

  it("gives the same workplaces on every run", () => {
    const a = replayFixture(fixture);
    const b = replayFixture(fixture);
    expect(Array.from(b.pops.work)).toEqual(Array.from(a.pops.work));
    expect(hashState(b)).toBe(hashState(a));
  });

  /** Replays the fixture with its bars held, saving and loading the city at `at` and stepping on from the copy. */
  function replaySavedAt(at: number): SimState {
    const v = fixture.heldDemand ?? 0;
    return holdDemand({ residential: v, commercial: v, office: v, industrial: v }, () => {
      let state = createState(fixture.seed);
      let next = 0;
      while (state.tick < fixture.untilTick) {
        if (state.tick === at && state.log.length === next) {
          state = deserialize(serialize(state)).state;
          at = -1;
        }
        for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
        step(state);
      }
      return state;
    });
  }

  it.each([350, 777, 1234])("hashes the same saved and loaded at tick %d, mid-day", (tick) => {
    expect(hashState(replaySavedAt(tick))).toBe(fixture.hash);
  });
});
