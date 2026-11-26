import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  NO_WORK,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  addPop,
  buildingJobs,
  checkPopsBalance,
  connectionEnd,
  createState,
  dayChances,
  deserialize,
  hashState,
  homeRoomLeft,
  homesWithRoom,
  isYearStart,
  leastNewcomers,
  newcomerRoomLeft,
  openJobsFor,
  reachableRoom,
  readPop,
  recountTotals,
  removePop,
  seedRng,
  serialize,
  setPopHousehold,
  setPopWork,
  step,
  turnOver,
  turnoverEvent,
  workersFor,
  yearDays,
  type Command,
  type SimState,
} from "../src/index";
import { popIndexOf } from "../src/pops/where";
import { enqueue } from "../src/commands";
import { submit } from "./seen-ends";
import { holdDemand } from "./demand-helper";
import { expectReplay, replayFixture, type ReplayFixture } from "./replay-helper";
import { withValue } from "./with-value";
import popsJson from "../balance/pops.json" with { type: "json" };
import fixtureJson from "./fixtures/replay/turnover.json" with { type: "json" };

// M3-11: turnover. Every pop gets one draw a game day, which gives it at
// most one of four events: its household is replaced, someone dies, a child
// grows up and leaves, or a baby is born. A street of houses filled with
// families loses people as the children leave and then holds; a whole city
// held at steady demand keeps its population for fifty game years.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const YEAR = yearDays() * DAY;
const TURNOVER = POPS_BALANCE.turnover;

/** Writes a line for a person reading the run. Vitest keeps console output quiet here. */
function note(line: string): void {
  if (process.env["TURNOVER_NOTES"]) appendFileSync(process.env["TURNOVER_NOTES"], line + "\n");
}

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

/** Zones `depth` cells deep from place `p0` for `width` places along `s`, on one side or the other. A rectangle's side is at most 256 m, so `width` is at most 30. */
function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): void {
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

function runTicks(state: SimState, ticks: number): void {
  const until = state.tick + ticks;
  while (state.tick < until) step(state);
}

function toDayStart(state: SimState): void {
  while (state.tick % DAY !== 0) step(state);
}

function livePops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.pops.flags.length; id++) if (state.pops.flags[id]) out.push(id);
  return out;
}

function buildingsOf(state: SimState, typeId: string): number[] {
  const out: number[] = [];
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) if (b.flags[id] && BUILDING_TYPES[b.type[id] ?? 0]?.id === typeId) out.push(id);
  return out;
}

function workplaces(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && buildingJobs(state.buildings, id) > 0) out.push(id);
  return out;
}

const population = (state: SimState): number => state.stats.totals["population"] ?? 0;

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
  // The pop index kept as pops change equals one built afresh from the rows.
  const kept = popIndexOf(state);
  const fresh = popIndexOf(deserialize(serialize(state)).state);
  for (const key of ["people", "filled", "filledByEducation", "peopleBySatisfaction"] as const) expect(Array.from(kept[key]), key).toEqual(Array.from(fresh[key]));
  // No workplace holds more workers than it has jobs.
  const filled = popIndexOf(state).filled;
  for (const id of workplaces(state)) expect(filled[id] ?? 0).toBeLessThanOrEqual(buildingJobs(state.buildings, id));
}

/** Runs the turnover system alone over one whole game day from a day's first tick, every pop in the sweep. */
function turnoverDay(state: SimState): void {
  toDayStart(state);
  state.pops.sweep = state.pops.flags.length;
  const start = state.tick;
  for (let k = 0; k < DAY; k++) {
    state.tick = start + k;
    turnOver(state);
  }
  state.tick = start + DAY;
}

/** Runs `body` with every turnover rate at 0 but those in `rates`. */
function withRates<R>(rates: Partial<typeof TURNOVER>, body: () => R): R {
  const was = { ...TURNOVER };
  Object.assign(TURNOVER, { birthsPerPersonYear: 0, deathsPerPersonYear: 0, childrenLeaveYears: 1e12, replacementsPerPopYear: 0 }, rates);
  try {
    return body();
  } finally {
    Object.assign(TURNOVER, was);
  }
}

/** A sure event a day: the yearly rate that makes the daily chance 1 for a pop of one. */
const SURE = yearDays();

/**
 * Shops by the connection and single family homes along both sides of a
 * 64 place street, filled with the bars held up and the newcomers'
 * children share at `childrenShare`. Steps to a day's first tick.
 */
function housesStreet(childrenShare = POPS_BALANCE.newcomer.childrenShare, seed?: number): { state: SimState; s: Street } {
  const state = createState(SEED);
  // A generator of its own, for a test that averages over streets filled with different households.
  if (seed !== undefined) state.rng = seedRng(seed);
  const s = street(state, 64);
  zone(state, s, "commercial", 3, 0, 6, 4, 1);
  zone(state, s, "commercial", 3, 0, 6, 4, -1);
  for (const side of [1, -1] as const) {
    // Two cells deep is too shallow for anything but a house.
    zone(state, s, "residential", 1, 8, 28, 2, side);
    zone(state, s, "residential", 1, 36, 28, 2, side);
  }
  holdDemand({ residential: 60, commercial: 60 }, () =>
    withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => withValue(POPS_BALANCE.newcomer, "childrenShare", childrenShare, () => runTicks(state, 30 * DAY))),
  );
  toDayStart(state);
  return { state, s };
}

describe("the balance", () => {
  it("checks the turnover rates in pops.json", () => {
    expect(checkPopsBalance(popsJson)).toEqual([]);
    const t = popsJson.turnover;
    const pops = (over: Record<string, unknown>) => checkPopsBalance({ ...popsJson, turnover: { ...t, ...over } }).join();
    expect(pops({ childrenLeaveYears: 0 })).toMatch(/childrenLeaveYears/);
    expect(pops({ replacementsPerPopYear: 1.5 })).toMatch(/replacementsPerPopYear/);
    expect(pops({ birthsPerPersonYear: -0.1 })).toMatch(/birthsPerPersonYear/);
    expect(pops({ extra: 1 })).toMatch(/extra/);
  });

  it("turns each yearly rate into a daily chance by dividing by the days in a year", () => {
    const c = dayChances();
    expect(c.replace).toBe(TURNOVER.replacementsPerPopYear / yearDays());
    expect(c.deathPerPerson).toBe(TURNOVER.deathsPerPersonYear / yearDays());
    expect(c.birthPerPerson).toBe(TURNOVER.birthsPerPersonYear / yearDays());
    expect(c.childLeaves).toBe(1 / (TURNOVER.childrenLeaveYears * yearDays()));
    // A tower pop at the largest size cap still has well under an even chance of anything in a day.
    const cap = Math.max(...POPS_BALANCE.popSizeCap);
    expect(c.replace + (c.deathPerPerson + c.birthPerPerson) * cap + c.childLeaves).toBeLessThan(0.05);
  });

  it("lays the four chances end to end on one draw, replacement first, and skips children leaving for a pop with none", () => {
    // Powers of two, so the edges add up exactly. Size 4: replaced below
    // 1/8, a death to 1/4, a child leaves to 1/2, a birth to 3/4.
    const c = { replace: 0.125, deathPerPerson: 0.03125, childLeaves: 0.25, birthPerPerson: 0.0625 };
    const just = (edge: number) => edge - 2 ** -20;
    expect(turnoverEvent(c, 0, 4, 1)).toBe("replaced");
    expect(turnoverEvent(c, just(0.125), 4, 1)).toBe("replaced");
    expect(turnoverEvent(c, 0.125, 4, 1)).toBe("death");
    expect(turnoverEvent(c, just(0.25), 4, 1)).toBe("death");
    expect(turnoverEvent(c, 0.25, 4, 1)).toBe("childLeaves");
    expect(turnoverEvent(c, just(0.5), 4, 1)).toBe("childLeaves");
    expect(turnoverEvent(c, 0.5, 4, 1)).toBe("birth");
    expect(turnoverEvent(c, just(0.75), 4, 1)).toBe("birth");
    expect(turnoverEvent(c, 0.75, 4, 1)).toBe("none");
    // No children: the birth band follows the deaths.
    expect(turnoverEvent(c, 0.25, 4, 0)).toBe("birth");
    expect(turnoverEvent(c, 0.5, 4, 0)).toBe("none");
  });
});

describe("each event", () => {
  it("takes a person from every pop on a day everyone is sure to lose one, removing those left with nobody", () => {
    const { state } = housesStreet();
    const before = new Map(livePops(state).map((id) => [id, readPop(state.pops, id)]));
    expect(before.size).toBeGreaterThan(40);
    const deaths = state.stats.year.deaths;
    withRates({ deathsPerPersonYear: SURE }, () => turnoverDay(state));
    for (const [id, was] of before) {
      if (was.size === 1) expect(state.pops.flags[id]).toBe(0);
      else expect(readPop(state.pops, id)).toMatchObject({ size: was.size - 1, children: was.children, home: was.home });
    }
    expect(state.stats.year.deaths - deaths).toBe(before.size);
    expectRecount(state);
  });

  it("adds a baby to every pop whose home has room, and marks it as having children", () => {
    const { state } = housesStreet(0);
    const before = new Map(livePops(state).map((id) => [id, readPop(state.pops, id)]));
    const births = state.stats.year.births;
    withRates({ birthsPerPersonYear: SURE }, () => turnoverDay(state));
    let born = 0;
    for (const [id, was] of before) {
      const now = readPop(state.pops, id);
      const room = state.buildings.residents[was.home] ?? 0;
      if (was.size < room) {
        expect(now).toMatchObject({ size: was.size + 1, children: 1 });
        born++;
      } else expect(now).toMatchObject({ size: was.size, children: 0 });
    }
    expect(born).toBeGreaterThan(10);
    expect(state.stats.year.births - births).toBe(born);
    expectRecount(state);
  });

  it("lets a child grow up and leave every pop with children, a person gone from each but a pop of one", () => {
    const { state } = housesStreet(0.5);
    const before = new Map(livePops(state).map((id) => [id, readPop(state.pops, id)]));
    const departures = state.stats.year.departures;
    withRates({ childrenLeaveYears: 1 / SURE }, () => turnoverDay(state));
    let left = 0;
    for (const [id, was] of before) {
      const now = readPop(state.pops, id);
      if (!was.children) expect(now).toMatchObject({ size: was.size, children: 0 });
      else if (was.size === 1) expect(now).toMatchObject({ size: 1, children: 0 });
      else {
        expect(now).toMatchObject({ size: was.size - 1, children: 0 });
        left++;
      }
    }
    expect(left).toBeGreaterThan(5);
    expect(state.stats.year.departures - departures).toBe(left);
    expectRecount(state);
  });

  it("replaces every household with a newcomer on the same id, its job freed, and counts both", () => {
    const { state } = housesStreet();
    const before = new Map(livePops(state).map((id) => [id, readPop(state.pops, id)]));
    expect([...before.values()].some((p) => p.work !== NO_WORK)).toBe(true);
    const year = { ...state.stats.year };
    // Low enough to be seen to reset.
    for (const id of before.keys()) state.pops.daysLow[id] = 3;
    withRates({ replacementsPerPopYear: SURE }, () => turnoverDay(state));
    let gone = 0;
    let came = 0;
    let changed = 0;
    for (const [id, was] of before) {
      const now = readPop(state.pops, id);
      expect(now.home).toBe(was.home);
      expect(now.work).toBe(NO_WORK);
      expect(now.satisfaction).toBe(POPS_BALANCE.newcomer.satisfaction);
      expect(now.daysLow).toBe(0);
      gone += was.size;
      came += now.size;
      if (now.size !== was.size || now.education !== was.education || now.wealth !== was.wealth || now.children !== was.children) changed++;
    }
    // Drawn again, so most households differ from the one before.
    expect(changed).toBeGreaterThan(before.size / 2);
    expect(state.stats.year.departures - year.departures).toBe(gone);
    expect(state.stats.year.arrivals - year.arrivals).toBe(came);
    expectRecount(state);
    // The newcomers look for work as the step runs.
    holdDemand({ residential: 0, commercial: 0 }, () => runTicks(state, DAY));
    expect(livePops(state).some((id) => state.pops.work[id] !== NO_WORK)).toBe(true);
    expectRecount(state);
  });

  it("leaves a home on a street joined to nothing empty when its household moves out", () => {
    const state = createState(SEED);
    const s = street(state, 30);
    // A second street to the side of the first, joined to nothing.
    const off = 200;
    const from = { x: s.x - s.dz * off, z: s.z + s.dx * off };
    ok(state, "BuildRoad", { from, to: { x: from.x + s.dx * CELL * 20, z: from.z + s.dz * CELL * 20 }, type: "street" });
    const cut = { x: from.x, z: from.z, dx: s.dx, dz: s.dz };
    zone(state, cut, "residential", 1, 2, 16, 2, 1);
    holdDemand({ residential: 60 }, () => runTicks(state, 10 * DAY));
    const houses = buildingsOf(state, "single-family-home");
    expect(houses.length).toBeGreaterThan(0);
    // Nobody arrives there, so put a household in by hand.
    const id = addPop(state, { home: houses[0] ?? -1, size: 2, education: 1, wealth: 1, children: 0, satisfaction: 60 });
    const year = { ...state.stats.year };
    withRates({ replacementsPerPopYear: SURE }, () => turnoverDay(state));
    expect(state.pops.flags[id]).toBe(0);
    expect(state.stats.year.departures - year.departures).toBe(2);
    expect(state.stats.year.arrivals - year.arrivals).toBe(0);
    expectRecount(state);
  });

  it("gives up a job whose workplace has none for the worker a birth adds, keeping the birth", () => {
    const { state } = housesStreet();
    for (const id of livePops(state)) removePop(state, id);
    const houses = buildingsOf(state, "single-family-home");
    // The shop with the fewest low-education jobs, so a worker from each house can fill them.
    const shop = workplaces(state).reduce((best, id) => (best < 0 || openJobsFor(state, id, 0) < openJobsFor(state, best, 0) ? id : best), -1);
    expect(shop).toBeGreaterThanOrEqual(0);
    expect(openJobsFor(state, shop, 0)).toBeLessThan(houses.length);
    // Three people with children have one worker; four have two.
    expect(workersFor(3, 1)).toBe(1);
    expect(workersFor(4, 1)).toBe(2);
    const parent = addPop(state, { home: houses[0] ?? -1, size: 3, education: 0, wealth: 0, children: 1, satisfaction: 70 });
    setPopWork(state, parent, shop);
    // Every other job at the shop that low education may take is filled, a worker from each house.
    for (let i = 1; i < houses.length && openJobsFor(state, shop, 0) > 0; i++) {
      const id = addPop(state, { home: houses[i] ?? -1, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 70 });
      setPopWork(state, id, shop);
    }
    expect(openJobsFor(state, shop, 0)).toBe(0);
    expect(() => setPopHousehold(state, parent, 4, 1)).toThrow(/jobs/);
    withRates({ birthsPerPersonYear: SURE }, () => turnoverDay(state));
    expect(readPop(state.pops, parent)).toMatchObject({ size: 4, children: 1, work: NO_WORK });
    expectRecount(state);
  });
});

describe("a tower pop whose child leaves", () => {
  it("splits when its workplace has no job for the workers it gains: the part that fits keeps the job", () => {
    const state = createState(SEED);
    const s = street(state, 30);
    zone(state, s, "residential", 3, 4, 4, 4, 1);
    zone(state, s, "commercial", 1, 12, 6, 2, -1);
    holdDemand({ residential: 100, commercial: 100 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runTicks(state, 10 * DAY)));
    const tower = buildingsOf(state, "low-tower")[0] ?? buildingsOf(state, "high-tower")[0] ?? -1;
    expect(tower).toBeGreaterThanOrEqual(0);
    // On a day's first tick, so the day of turnover alone below steps nothing else.
    toDayStart(state);
    for (const id of livePops(state)) removePop(state, id);
    // The shop with the most jobs, and a pop whose workers fill all but a few of them.
    const shop = workplaces(state).reduce((a, b) => (buildingJobs(state.buildings, b) > buildingJobs(state.buildings, a) ? b : a));
    let size = 2;
    while (workersFor(size + 1, 1) <= openJobsFor(state, shop, 0)) size++;
    expect(workersFor(size - 1, 0)).toBeGreaterThan(workersFor(size, 1));
    const mark = { by: 1, tick: state.tick, with: 40 };
    const id = addPop(state, { home: tower, size, education: 0, wealth: 1, children: 1, satisfaction: 66, daysLow: 0, graceDays: 7, displaced: mark });
    setPopWork(state, id, shop);
    const open = openJobsFor(state, shop, 0);
    expect(workersFor(size - 1, 0) - workersFor(size, 1)).toBeGreaterThan(open);
    withRates({ childrenLeaveYears: 1 / SURE }, () => turnoverDay(state));
    const household = livePops(state).filter((p) => state.pops.home[p] === tower);
    expect(household.length).toBe(2);
    expect(household.reduce((sum, p) => sum + (state.pops.size[p] ?? 0), 0)).toBe(size - 1);
    expect(state.pops.work[id]).toBe(shop);
    const rest = household.find((p) => p !== id) ?? -1;
    // The rest keeps the household's grace too (#361), so it is among the unemployed newcomers.
    // And the mark of the household's displacement (M4-10), so both parts carry its hit.
    expect(readPop(state.pops, rest)).toMatchObject({ work: NO_WORK, children: 0, satisfaction: 66, education: 0, wealth: 1, graceDays: 7, displaced: mark });
    expect(readPop(state.pops, id).displaced).toEqual(mark);
    expect(state.stats.totals["workersUnemployedNew"]).toBe(workersFor(state.pops.size[rest] ?? 0, 0));
    expect(state.pops.children[id]).toBe(0);
    expectRecount(state);
  });
});

describe("setPopHousehold", () => {
  it("sets size and children together and refuses a row the home or workplace cannot hold", () => {
    const { state } = housesStreet();
    const id = livePops(state).find((p) => (state.pops.size[p] ?? 0) < 4) ?? -1;
    const room = state.buildings.residents[state.pops.home[id] ?? 0] ?? 0;
    expect(() => setPopHousehold(state, id, room + 1, 0)).toThrow(/room|holds/);
    expect(() => setPopHousehold(state, id, 1, 2)).toThrow(/children/);
    expect(() => setPopHousehold(state, -1, 1, 0)).toThrow(/does not exist/);
    setPopHousehold(state, id, 1, 1);
    expect(readPop(state.pops, id)).toMatchObject({ size: 1, children: 1 });
    expectRecount(state);
  });
});

describe("room for newcomers", () => {
  it("offers a home to newcomers only while its room left fits the least household for its density", () => {
    const state = createState(SEED);
    const s = street(state, 30);
    zone(state, s, "residential", 3, 4, 4, 4, 1);
    holdDemand({ residential: 100 }, () => runTicks(state, 10 * DAY));
    const tower = buildingsOf(state, "low-tower")[0] ?? buildingsOf(state, "high-tower")[0] ?? -1;
    expect(tower).toBeGreaterThanOrEqual(0);
    for (const id of livePops(state)) removePop(state, id);
    const least = leastNewcomers(3);
    expect(least).toBe(POPS_BALANCE.newcomer.size[2]?.[0]);
    expect(least).toBeGreaterThan(1);
    // Fill it to one short of the least household.
    let people = (state.buildings.residents[tower] ?? 0) - (least - 1);
    while (people > 0) {
      const size = Math.min(people, POPS_BALANCE.popSizeCap[2] ?? 100);
      addPop(state, { home: tower, size, education: 1, wealth: 1, children: 0, satisfaction: 60 });
      people -= size;
    }
    expect(homeRoomLeft(state, tower)).toBe(least - 1);
    expect(newcomerRoomLeft(state, tower)).toBe(0);
    expect(homesWithRoom(state)).not.toContain(tower);
    expect(reachableRoom(state).empty).toBe(0);
    // One more place freed, and it takes newcomers again.
    const someone = livePops(state)[0] ?? -1;
    setPopHousehold(state, someone, (state.pops.size[someone] ?? 0) - 1, 0);
    expect(newcomerRoomLeft(state, tower)).toBe(least);
    expect(homesWithRoom(state)).toContain(tower);
    expect(reachableRoom(state).empty).toBe(least);
    // A house is a household, so its least is one.
    expect(leastNewcomers(1)).toBe(1);
  });
});

describe("over game decades", () => {
  it("finds a street of houses filled with families dips as the children leave, then climbs back toward a steady level (PRD, scenario test)", () => {
    // Four streets, each filled from its own generator, averaged: one street
    // is a few dozen households, too few to read a shape from. Each street
    // fills with households of its own sizes too, so the fill is averaged
    // with the rest (M4-08: one street's fill swung from 150 to 139 with the
    // generator's draws, and the level it settles to stayed near 137).
    const runs: number[][] = [];
    const fills: number[] = [];
    for (let k = 0; k < 4; k++) {
      const copy = housesStreet(1, SEED + 1 + k).state;
      fills.push(population(copy));
      expect(fills[k]).toBeGreaterThan(100);
      expect(copy.stats.totals["popsWithChildren"]).toBe(copy.stats.totals["pops"]);
      const years: number[] = [];
      holdDemand({ residential: 30, commercial: 0 }, () => {
        for (let y = 0; y < 36; y++) {
          runTicks(copy, YEAR);
          years.push(population(copy));
        }
      });
      expectRecount(copy);
      runs.push(years);
    }
    const filled = fills.reduce((sum, f) => sum + f, 0) / fills.length;
    const mean = (runs[0] ?? []).map((_, y) => runs.reduce((sum, r) => sum + (r[y] ?? 0), 0) / runs.length);
    const trough = Math.min(...mean);
    const troughYear = mean.indexOf(trough) + 1;
    const average = (ys: number[]) => ys.reduce((x, y) => x + y, 0) / ys.length;
    // The dip: about a twelfth of the street gone as the children leave, its lowest over the first two decades or so.
    // Averaged over four streets (M4-08) the dip reads 0.92 of the fill, and 0.905 on the build before; the
    // tenth or more the test asked before held on one street that happened to fill to 150.
    expect(trough).toBeLessThan(0.94 * filled);
    expect(troughYear).toBeGreaterThanOrEqual(5);
    expect(troughYear).toBeLessThanOrEqual(25);
    expect(mean[19] ?? 0).toBeLessThan(0.95 * filled);
    // Then the climb back: the last ten years sit above the ten around the
    // trough. The climb is small, the replacement rate against the children
    // leaving: about 2% of the street since M3-21. A street that dips and
    // stays flat fails.
    const around = average(mean.slice(Math.max(0, troughYear - 6), troughYear + 4));
    const late = average(mean.slice(-10));
    expect(mean.length - 10).toBeGreaterThanOrEqual(troughYear + 4);
    expect(late).toBeGreaterThan(1.01 * around);
    // And it settles below where it filled: 0.967 of the fill over four
    // streets (M4-08), 0.985 on the build before. One street's 0.92 in the M3
    // review was that street's high fill.
    expect(late).toBeLessThan(filled);
  }, 180_000);

  it("finds a city held at steady demand keeps its population for fifty game years, and each year's counts add up to its change (scenario test)", () => {
    const state = createState(SEED);
    const s = street(state, 64);
    zone(state, s, "commercial", 3, 0, 14, 4, 1);
    zone(state, s, "commercial", 3, 0, 14, 4, -1);
    zone(state, s, "residential", 1, 16, 24, 2, 1);
    zone(state, s, "residential", 1, 40, 24, 2, 1);
    zone(state, s, "residential", 2, 16, 24, 6, -1);
    holdDemand({ residential: 60, commercial: 60 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runTicks(state, 90 * DAY)));
    holdDemand({ residential: 30, commercial: 0 }, () => {
      while (!isYearStart(state.tick)) step(state);
      const start = population(state);
      expect(start).toBeGreaterThan(500);
      expect(state.stats.totals["residentsDensity2"]).toBeGreaterThan(0);
      const years: number[] = [];
      let births = 0;
      let deaths = 0;
      for (let y = 0; y < 50; y++) {
        const before = population(state);
        runTicks(state, YEAR);
        const { births: b, deaths: d, arrivals, departures } = state.stats.year;
        expect(b - d + arrivals - departures, `year ${y + 1}`).toBe(population(state) - before);
        births += b;
        deaths += d;
        years.push(population(state));
      }
      // Within a few percent of where it started, every year: no wave.
      note(`started ${start}, pops ${state.stats.totals["pops"]}, by year ${years.join(" ")}`);
      for (const p of years) expect(Math.abs(p - start) / start).toBeLessThan(0.04);
      // And it ends where it began: about 1% off in the M3 review. M3-25 had
      // loosened this to 4% when the last year read 3.4%, the same bound as
      // every year above, which left it checking nothing of its own.
      expect(Math.abs((years.at(-1) ?? 0) - start) / start).toBeLessThan(0.03);
      // Turnover did its work: people were born and died along the way.
      expect(births).toBeGreaterThan(20);
      expect(deaths).toBeGreaterThan(50);
      // Pops stay households, not single people: the room a death frees in an apartment waits for a household.
      expect(population(state) / (state.stats.totals["pops"] ?? 1)).toBeGreaterThan(2);
    });
    expectRecount(state);
  }, 120_000);
});

describe("replay fixture turnover", () => {
  const fixture = fixtureJson as unknown as ReplayFixture;

  it("replays to its recorded hash, with deaths, arrivals and departures in it", () => {
    const state = expectReplay(fixture);
    const { lastYear, year } = state.stats;
    expect(lastYear.deaths + year.deaths).toBeGreaterThan(0);
    // No births: a birth needs room for one more, which a street of houses
    // rarely has, and since M3-25 moved the draws this replay has none. The
    // fifty-year scenario above counts them.
    expect(lastYear.departures + year.departures).toBeGreaterThan(0);
    expect(lastYear.arrivals + year.arrivals).toBeGreaterThan(0);
    expectRecount(state);
  });

  it.each([12_345, 40_050, 58_801])("hashes the same saved and loaded at tick %d, mid-year", (at) => {
    expect(isYearStart(at)).toBe(false);
    const held = fixture.heldDemand ?? 0;
    const state = holdDemand({ residential: held, commercial: held, office: held, industrial: held }, () => {
      let state = createState(fixture.seed);
      let next = 0;
      while (state.tick < fixture.untilTick) {
        if (state.tick === at && state.log.length === next) state = deserialize(serialize(state)).state;
        for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
        step(state);
      }
      return state;
    });
    expect(hashState(state)).toBe(fixture.hash);
    expect(hashState(state)).toBe(hashState(replayFixture(fixture)));
  });
});
