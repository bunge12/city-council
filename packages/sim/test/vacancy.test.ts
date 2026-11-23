import { describe, expect, it } from "vitest";
import {
  BUILDING_ABANDONED,
  BUILDING_ALIVE,
  BUILDING_UNZONED,
  BUILDING_VACANT,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  abandonedWaiting,
  applyBuildingDelta,
  buildingEmpty,
  buildingJobs,
  checkDemandBalance,
  connectionEnd,
  createState,
  deserialize,
  drainBuildingDelta,
  hashState,
  homeRoom,
  isAbandoned,
  isVacant,
  lotJobs,
  openJobsFor,
  readBuilding,
  recordBuildingChanges,
  recountTotals,
  serialize,
  step,
  whyNoNewcomers,
  type Command,
  type SimState,
} from "../src/index";
import { homesWithRoom, reachableRoom } from "../src/pops/room";
import { zoneJobs } from "../src/pops/open-jobs";
import { popIndexOf } from "../src/pops/where";
import { enqueue } from "../src/commands";
import { cloneState } from "../src/state";
import { submit } from "./seen-ends";
import { holdDemand } from "./demand-helper";
import { expectReplay, replayFixture, type ReplayFixture } from "./replay-helper";
import { withValue } from "./with-value";
import demandJson from "../balance/demand.json" with { type: "json" };
import fixtureJson from "./fixtures/replay/vacancy.json" with { type: "json" };

// M3-24: vacancy and abandonment. A building nobody uses stands vacant,
// then abandoned three game months later, offering no room or jobs, and
// comes back into use when its zone's bar is above zero, before the grower
// builds anything new in that zone.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const { newDays, abandonDays } = DEMAND_BALANCE.vacancy;

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

/** A street `places` cells long from the stub end of the first outside connection, or, `joined` false, the same street a few cells short of it. */
function street(state: SimState, places: number, joined = true): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const gap = joined ? 0 : 3 * CELL;
  const s = { x: (r.nodeX[inner] ?? 0) + dx * gap, z: (r.nodeZ[inner] ?? 0) + dz * gap, dx, dz };
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

function live(state: SimState, keep: (id: number) => boolean = () => true): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && keep(id)) out.push(id);
  return out;
}

const homes = (state: SimState): number[] => live(state, (id) => (state.buildings.residents[id] ?? 0) > 0);
const workplaces = (state: SimState): number[] => live(state, (id) => lotJobs(state.buildings, id) > 0);
const population = (state: SimState): number => state.stats.totals["population"] ?? 0;
const people = (state: SimState, id: number): number => popIndexOf(state).people[id] ?? 0;

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
}

/** Homes and a retail podium on one street, filled with their bars held up until most pops work, as satisfaction.test.ts has it. */
function workingCity(): { state: SimState; s: Street } {
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
  return { state, s };
}

/** Bulldozes every building in `ids`. */
function bulldoze(state: SimState, ids: number[]): void {
  const b = state.buildings;
  ok(state, "BulldozeBuilding", {
    buildings: ids.map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] })),
  });
}

describe("the balance", () => {
  it("checks the vacancy numbers in demand.json", () => {
    expect(checkDemandBalance(demandJson)).toEqual([]);
    const v = (over: Record<string, unknown>) => checkDemandBalance({ ...demandJson, vacancy: { ...demandJson.vacancy, ...over } }).join();
    expect(v({ abandonDays: 0 })).toMatch(/vacancy.abandonDays/);
    expect(v({ newDays: -1 })).toMatch(/vacancy.newDays/);
    expect(v({ newDays: 1.5 })).toMatch(/vacancy.newDays/);
    expect(v({ extra: 1 })).toMatch(/extra/);
    const { vacancy, ...none } = demandJson;
    void vacancy;
    expect(checkDemandBalance(none).join()).toMatch(/vacancy is missing/);
  });

  it("gives a new building a game month and a vacant one about three before it is abandoned", () => {
    expect(newDays).toBe(30);
    expect(abandonDays).toBeGreaterThanOrEqual(85);
    expect(abandonDays).toBeLessThanOrEqual(95);
  });
});

describe("a street of houses joined to nothing", () => {
  // The pull from outside holds the residential bar above zero, so houses
  // grow, but nobody can reach them. Commands only, no bars held: the
  // replay fixture below is this city.
  function unreachable(): SimState {
    const state = createState(SEED);
    const s = street(state, 16, false);
    zone(state, s, "residential", 1, 0, 16, 6, 1);
    zone(state, s, "residential", 1, 0, 16, 6, -1);
    return state;
  }

  /** For each of `built`, the ticks it went vacant, was abandoned and came back, as `statusSince` says, -1 for not yet. */
  function watch(built: number[]): Map<number, { vacant: number; abandoned: number; back: number }> {
    const seen = new Map<number, { vacant: number; abandoned: number; back: number }>();
    for (const id of built) seen.set(id, { vacant: -1, abandoned: -1, back: -1 });
    return seen;
  }

  function note(state: SimState, seen: ReturnType<typeof watch>): void {
    const b = state.buildings;
    for (const [id, at] of seen) {
      if (isVacant(b, id) && at.vacant < 0) at.vacant = b.statusSince[id] ?? 0;
      if (isAbandoned(b, id) && at.abandoned < 0) at.abandoned = b.statusSince[id] ?? 0;
      if (at.abandoned >= 0 && !isAbandoned(b, id) && at.back < 0) at.back = b.statusSince[id] ?? 0;
    }
  }

  it("stands in use for a game month, then vacant, and never abandoned while the bar is above zero", () => {
    const state = unreachable();
    runDays(state, 8);
    const built = homes(state);
    expect(built.length).toBeGreaterThan(5);
    const b = state.buildings;
    const seen = watch(built);
    runDays(state, 130, () => {
      expect(state.demand.residential.value).toBeGreaterThan(0);
      note(state, seen);
    });
    for (const [id, at] of seen) {
      const builtAt = b.builtAt[id] ?? 0;
      // Not vacant before it had stood a game month, and on the first visit after.
      expect(at.vacant - builtAt).toBeGreaterThanOrEqual(newDays * DAY);
      expect(at.vacant - builtAt).toBeLessThan((newDays + 1) * DAY);
      // Vacant past three months, but with demand above zero it would only
      // come straight back, and hold new homes back for a day: it waits.
      expect(at.abandoned).toBe(-1);
      expect(isVacant(b, id)).toBe(true);
    }
    expect(abandonedWaiting(state)[1]).toBe(0);
    expectRecount(state);
  });

  it("is abandoned three game months after it went vacant once the bar falls to zero, and comes back the day it rises", () => {
    const state = unreachable();
    runDays(state, 8);
    const built = homes(state);
    const seen = watch(built);
    holdDemand({ residential: 0 }, () => runDays(state, newDays + abandonDays + 2, () => note(state, seen)));
    holdDemand({ residential: 10 }, () => runDays(state, 2, () => note(state, seen)));
    for (const [, at] of seen) {
      // Abandoned exactly `abandonDays` after it went vacant: the visit falls on the same tick of the day.
      expect(at.abandoned - at.vacant).toBe(abandonDays * DAY);
      // And back in use on the first visit with the bar above zero, the ground still zoned for it.
      expect(at.back).toBeGreaterThan(at.abandoned);
      expect(at.back - (state.tick - 2 * DAY)).toBeLessThan(DAY);
    }
    expectRecount(state);
  });

  it.each([3_456, 9_050, 12_150, 12_250])("hashes the same saved and loaded at tick %d, part way to abandonment", (at) => {
    // Built, then the bar held at zero from day 8, so the homes go vacant and then abandoned along the way.
    const run = (saveAt: number): SimState => {
      // The same command numbers each run, since the log is in the hash.
      seq = 0;
      let state = unreachable();
      runDays(state, 8);
      holdDemand({ residential: 0 }, () => {
        while (state.tick < 12_400) {
          if (state.tick === saveAt) state = deserialize(serialize(state)).state;
          step(state);
        }
      });
      return state;
    };
    const straight = run(-1);
    const b = straight.buildings;
    expect(homes(straight).some((id) => isAbandoned(b, id))).toBe(true);
    expect(hashState(run(at))).toBe(hashState(straight));
  });

  it("offers no room while abandoned, so newcomers would pass it by", () => {
    const state = unreachable();
    // Not long enough for the bar to bring any back: hold it at zero.
    runDays(state, 8);
    holdDemand({ residential: 0 }, () => runDays(state, newDays + abandonDays + 2));
    const built = homes(state);
    expect(built.length).toBeGreaterThan(5);
    for (const id of built) {
      expect(isAbandoned(state.buildings, id)).toBe(true);
      expect(readBuilding(state.buildings, id).abandoned).toBe(true);
      expect(homeRoom(state.buildings, id)).toBe(0);
      expect(whyNoNewcomers(state, id)).toBe("abandoned");
      expect(state.buildings.residents[id]).toBeGreaterThan(0);
    }
    expect(homesWithRoom(state)).toEqual([]);
    expect(reachableRoom(state)).toEqual({ capacity: 0, empty: 0, unfilled: 0 });
    expectRecount(state);
  });
});

describe("a city that loses its jobs", () => {
  // Built once and shared: the three tests run in order on the one city.
  const { state, s } = workingCity();
  const b = state.buildings;
  const houses = homes(state);
  const emptiedAt = new Map<number, number>();

  it("finds homes vacant as pops leave, then abandoned about three game months later (scenario test)", () => {
    expect(population(state)).toBeGreaterThan(20);
    expect(houses.length).toBeGreaterThan(5);
    for (const id of houses) expect(isVacant(b, id) || isAbandoned(b, id)).toBe(false);
    bulldoze(state, workplaces(state));
    expect(workplaces(state)).toEqual([]);
    // The bars held at zero: nobody arrives and no new shops come, so the
    // pops leave on their own patience, about a month without work.
    holdDemand({ residential: 0, commercial: 0 }, () =>
      runDays(state, 60 + abandonDays, () => {
        for (const id of houses) {
          if (people(state, id) === 0 && !emptiedAt.has(id)) emptiedAt.set(id, state.tick);
          // A home with people in it is never vacant or abandoned.
          if (people(state, id) > 0) expect(b.flags[id]).toBe(BUILDING_ALIVE);
        }
      }),
    );
    // Pops with nobody who works do not leave for want of a job: their homes stay in use.
    expect(population(state)).toBeLessThan(10);
    const emptied = houses.filter((id) => people(state, id) === 0);
    expect(emptied.length).toBeGreaterThan(houses.length / 2);
    for (const id of houses) if (people(state, id) > 0) expect(b.flags[id]).toBe(BUILDING_ALIVE);
    // Most emptied as the pops ran out of patience, a month or so on. One
    // emptied by a death since then is vacant, and waits its three months.
    const early = emptied.filter((id) => (emptiedAt.get(id) ?? 0) < state.tick - (abandonDays + 1) * DAY);
    expect(early.length).toBeGreaterThan(houses.length / 2);
    for (const id of emptied) if (!early.includes(id)) expect(isVacant(b, id)).toBe(true);
    for (const id of early) {
      const emptied = emptiedAt.get(id) ?? -1;
      expect(emptied).toBeGreaterThan(state.tick - (60 + abandonDays - 25) * DAY);
      expect(isAbandoned(b, id)).toBe(true);
      // Abandoned three game months after it went vacant, on the first visit
      // after it emptied: the day `emptied` closed, or the next.
      const abandoned = b.statusSince[id] ?? 0;
      const vacant = abandoned - abandonDays * DAY;
      expect(vacant).toBeGreaterThan(emptied - DAY);
      expect(vacant).toBeLessThanOrEqual(emptied + DAY);
    }
    // No room or jobs left in the totals' view, and they still match the rows.
    expect(state.stats.totals["jobsCommercial"]).toBe(0);
    expectRecount(state);
  });

  it("brings the abandoned homes back, taking people again, before any new house is built (scenario test)", () => {
    // Free frontage for new houses, so the grower has somewhere to build.
    zone(state, s, "residential", 1, 21, 9, 6, 1);
    zone(state, s, "residential", 1, 21, 9, 6, -1);
    const before = new Set(live(state));
    const abandoned = houses.filter((id) => isAbandoned(b, id));
    expect(abandoned.length).toBeGreaterThan(houses.length / 2);
    holdDemand({ residential: 60, commercial: 60 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runDays(state, 15)));
    for (const id of abandoned) expect(isAbandoned(b, id)).toBe(false);
    const lastBack = Math.max(...abandoned.map((id) => b.statusSince[id] ?? 0));
    const newHouses = homes(state).filter((id) => !before.has(id));
    expect(newHouses.length).toBeGreaterThan(0);
    // Every abandoned home was back in use before the first new house went up.
    expect(Math.min(...newHouses.map((id) => b.builtAt[id] ?? 0))).toBeGreaterThan(lastBack);
    // And they took people again.
    expect(abandoned.filter((id) => people(state, id) > 0).length).toBeGreaterThan(abandoned.length / 2);
    // Shops came back too, with jobs in the totals.
    expect(state.stats.totals["jobsCommercial"]).toBeGreaterThan(0);
    expect(abandonedWaiting(state)).toEqual(new Int32Array(abandonedWaiting(state).length));
    expectRecount(state);
  });
});

describe("factories with nobody to work in them", () => {
  // Factories on a street joined to the outside, grown with the industrial
  // bar held up and never staffed: there are no residents.
  function factories(): SimState {
    const state = createState(SEED);
    const s = street(state, 24);
    zone(state, s, "industrial", 1, 0, 24, 6, 1);
    zone(state, s, "industrial", 1, 0, 24, 6, -1);
    holdDemand({ industrial: 60 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
      toDayStart(state);
      runDays(state, 5);
    }));
    return state;
  }

  it("keeps an unstaffed factory in use while the industrial bar is at or above zero", () => {
    const state = factories();
    holdDemand({ industrial: 0 }, () => runDays(state, newDays + 5));
    for (const id of workplaces(state)) {
      expect(buildingEmpty(state, id)).toBe(false);
      expect(state.buildings.flags[id]).toBe(BUILDING_ALIVE);
    }
  });

  it("finds an abandoned factory offers no jobs, and offers them again once the industrial bar is above zero (scenario test)", () => {
    const state = factories();
    const b = state.buildings;
    const built = workplaces(state);
    expect(built.length).toBeGreaterThan(3);
    const jobs = built.reduce((sum, id) => sum + lotJobs(b, id), 0);
    expect(state.stats.totals["jobsIndustrial"]).toBe(jobs);
    // The bar below zero: none of their jobs is filled, so they go vacant once a month old, then abandoned.
    holdDemand({ industrial: -20 }, () => runDays(state, newDays + abandonDays + 2));
    for (const id of built) {
      expect(isAbandoned(b, id)).toBe(true);
      expect(buildingJobs(b, id)).toBe(0);
      expect(lotJobs(b, id)).toBeGreaterThan(0);
      for (const education of [0, 1, 2]) expect(openJobsFor(state, id, education)).toBe(0);
    }
    expect(state.stats.totals["jobsIndustrial"]).toBe(0);
    expect(zoneJobs(state).jobs[4]).toBe(0);
    expectRecount(state);
    // The bar back above zero: within a day every factory whose ground is still industrial is back in use.
    holdDemand({ industrial: 20 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runDays(state, 1)));
    for (const id of built) {
      expect(isAbandoned(b, id)).toBe(false);
      expect(buildingJobs(b, id)).toBe(lotJobs(b, id));
    }
    expect(state.stats.totals["jobsIndustrial"]).toBeGreaterThanOrEqual(jobs);
    expectRecount(state);
  });

  it("clears a factory whose ground was rezoned once it is abandoned, and holds no new factory back for it (M3-14)", () => {
    const state = factories();
    const b = state.buildings;
    holdDemand({ industrial: -20 }, () => runDays(state, newDays + abandonDays + 2));
    const built = workplaces(state);
    for (const id of built) expect(isAbandoned(b, id)).toBe(true);
    const seen = new Map(built.map((id) => [id, `${b.firstSeg[id]}/${b.firstPlace[id]}/${b.builtAt[id]}`]));
    const same = (id: number) => b.flags[id] !== 0 && `${b.firstSeg[id]}/${b.firstPlace[id]}/${b.builtAt[id]}` === seen.get(id);
    // Rezone both sides commercial: the factories stand on ground no longer zoned for them.
    const r = state.roads;
    const edge = state.connections[0] ?? NONE;
    const inner = connectionEnd(r, edge);
    const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
    const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
    const s = { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
    zone(state, s, "commercial", 1, 0, 24, 6, 1);
    zone(state, s, "commercial", 1, 0, 24, 6, -1);
    // Every factory now stands on commercial ground. Until its next visit it
    // still holds new factories back: all but the few visited on the ticks
    // the two strokes took.
    expect(abandonedWaiting(state)[4]).toBeGreaterThan(built.length - 3);
    holdDemand({ industrial: -20 }, () => runDays(state, 1));
    // The visit marks it and redevelopment clears it the same tick, up to
    // `perDayMax` a day, and none left standing holds the grower.
    const cleared = built.filter((id) => !same(id));
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.length).toBeLessThanOrEqual(2 * DEMAND_BALANCE.redevelopment.perDayMax);
    for (const id of built) if (same(id)) expect(b.flags[id]).toBe(BUILDING_ALIVE | BUILDING_ABANDONED | BUILDING_UNZONED);
    expect(abandonedWaiting(state)[4]).toBe(0);
    holdDemand({ industrial: -20 }, () => runDays(state, 2));
    for (const id of built) expect(same(id)).toBe(false);
    expectRecount(state);
  });
});

describe("in the delta and the save", () => {
  it("sends a building's row when it becomes vacant, abandoned or comes back, and a copy applies it", () => {
    const state = createState(SEED);
    const s = street(state, 16, false);
    zone(state, s, "residential", 1, 0, 16, 6, 1);
    runDays(state, 6);
    const copy = cloneState(state);
    recordBuildingChanges(state);
    drainBuildingDelta(state);
    const changed = new Set<number>();
    const flagsSeen = new Set<number>();
    const each = () => {
      const delta = drainBuildingDelta(state);
      if (!delta) return;
      delta.ids.forEach((id, i) => {
        changed.add(id);
        flagsSeen.add(delta.rows.flags[i] ?? 0);
      });
      expect(applyBuildingDelta(copy, delta)).not.toEqual(expect.any(String));
    };
    // Vacant, then abandoned with the bar at zero, then back with it above.
    holdDemand({ residential: 0 }, () => runDays(state, newDays + abandonDays + 4, each));
    holdDemand({ residential: 10 }, () => runDays(state, 2, each));
    expect(flagsSeen).toContain(BUILDING_ALIVE | BUILDING_VACANT);
    expect(flagsSeen).toContain(BUILDING_ALIVE | BUILDING_ABANDONED);
    expect(flagsSeen).toContain(BUILDING_ALIVE);
    for (const id of homes(state)) expect(changed.has(id)).toBe(true);
    expect(Array.from(copy.buildings.flags)).toEqual(Array.from(state.buildings.flags));
    expect(Array.from(copy.buildings.statusSince)).toEqual(Array.from(state.buildings.statusSince));
  });

  it("refuses a delta row with both vacant and abandoned set, or an unknown bit", () => {
    const state = createState(SEED);
    const s = street(state, 16, false);
    zone(state, s, "residential", 1, 0, 16, 6, 1);
    const copy = cloneState(state);
    recordBuildingChanges(state);
    runDays(state, 2);
    const delta = drainBuildingDelta(state);
    if (!delta) throw new Error("no building changed");
    for (const bad of [BUILDING_ALIVE | BUILDING_VACANT | BUILDING_ABANDONED, BUILDING_ALIVE | BUILDING_UNZONED, BUILDING_ALIVE | 16]) {
      const broken = { ...delta, rows: { ...delta.rows, flags: delta.rows.flags.map(() => bad) } };
      expect(applyBuildingDelta(cloneState(copy), broken)).toMatch(/unknown flags/);
    }
  });

  it("refuses a save whose building flags or status tick are malformed", () => {
    const state = createState(SEED);
    const s = street(state, 16, false);
    zone(state, s, "residential", 1, 0, 16, 6, 1);
    runDays(state, 3);
    const id = homes(state)[0] ?? -1;
    expect(id).toBeGreaterThanOrEqual(0);
    const breaks: ((s: SimState) => void)[] = [
      (c) => (c.buildings.flags[id] = BUILDING_ALIVE | BUILDING_VACANT | BUILDING_ABANDONED),
      (c) => (c.buildings.flags[id] = BUILDING_ALIVE | BUILDING_UNZONED),
      (c) => (c.buildings.flags[id] = BUILDING_ALIVE | 16),
      (c) => (c.buildings.statusSince[id] = (c.buildings.builtAt[id] ?? 0) - 1),
      (c) => (c.buildings.statusSince[id] = c.tick + 1),
      (c) => (c.buildings.statusSince[id] = 0.5 + (c.buildings.builtAt[id] ?? 0)),
    ];
    for (const breakIt of breaks) {
      const copy = cloneState(state);
      breakIt(copy);
      expect(() => deserialize(serialize(copy))).toThrow(/buildings/);
    }
  });
});

describe("replay fixture vacancy", () => {
  const fixture = fixtureJson as unknown as ReplayFixture;

  it("replays to its recorded hash, with every home vacant and none abandoned while the bar is above zero", () => {
    const state = expectReplay(fixture);
    expect(homes(state).length).toBeGreaterThan(5);
    for (const id of homes(state)) expect(isVacant(state.buildings, id)).toBe(true);
    expectRecount(state);
    // In use for the first game month.
    const early = replayFixture(fixture, 2_000);
    for (const id of homes(early)) expect(early.buildings.flags[id]).toBe(BUILDING_ALIVE);
  });

  it.each([2_000, 3_456, 9_050, 12_250])("hashes the same saved and loaded at tick %d", (at) => {
    let state = createState(fixture.seed);
    let next = 0;
    while (state.tick < fixture.untilTick) {
      if (state.tick === at && state.log.length === next) state = deserialize(serialize(state)).state;
      for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
      step(state);
    }
    expect(hashState(state)).toBe(fixture.hash);
  });
});
