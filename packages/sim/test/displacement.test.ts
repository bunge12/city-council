// M4-10: displacement lowers satisfaction. A pop the city moved carries its
// own hit wherever it went, and the expropriations near a pop's home in the
// last game year lower its target, fading over the year.

import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DISPLACED_BY_CITY,
  DISPLACED_BY_NONE,
  DISPLACED_BY_OWNER,
  ECONOMY,
  LAND_VALUE_BALANCE,
  NONE,
  NO_HOME,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  addPop,
  checkPopsBalance,
  connectionEnd,
  createState,
  deserialize,
  expropriationGridCells,
  expropriationGridOf,
  expropriationTicks,
  hashState,
  isBuilding,
  isPop,
  jobTarget,
  ownLoss,
  planRedevelopment,
  popIdLimit,
  removePop,
  replayFrom,
  satisfactionTarget,
  seeBuilding,
  serialize,
  step,
  type Command,
  type Expropriation,
  type SimState,
} from "../src/index";
import { redevelop } from "../src/buildings/redevelop";
import { lotCentres } from "../src/buildings/where";
import { cloneState } from "../src/state";
import { holdDemand } from "./demand-helper";
import { funded } from "./funds";
import { submit } from "./seen-ends";
import { withValue } from "./with-value";
import popsJson from "../balance/pops.json" with { type: "json" };

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const D = POPS_BALANCE.satisfaction.displacement;
const T = POPS_BALANCE.satisfaction.target;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
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
  const x = r.nodeX[inner] ?? 0;
  const z = r.nodeZ[inner] ?? 0;
  ok(state, command("BuildRoad", { from: { x, z }, to: { x: x + dx * CELL * places, z: z + dz * CELL * places }, type: "street" }));
  return { x, z, dx, dz };
}

/** Zones `width` places from `p0` on the street's left, `depth` cells deep, in rectangles of at most 25 places, the most a side may be. */
function zone(state: SimState, s: Street, density: number, p0: number, width: number, depth: number): void {
  const off = 5 + (CELL * depth) / 2;
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const rects = [];
  for (let from = p0; from < p0 + width; from += 25) {
    const a = CELL * from + 2;
    const b = CELL * Math.min(from + 25, p0 + width) - 2;
    rects.push({ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 });
  }
  ok(state, command("ZoneCells", { zone: "residential", density, rects }));
}

const PLACES = 100;

/**
 * A street of R1 houses 800 m long, grown out, then emptied of the pops
 * that arrived and given one of the test's own in every house: one person
 * with children, so nobody works and every score heads for `noWorkers`,
 * already there. The last `room` houses from the far end stay empty, room
 * for a pop the city moves. Funded, since clearing houses costs money.
 */
function houseStreet(room: number): { state: SimState; s: Street; houses: number[]; pops: Map<number, number> } {
  const state = funded(createState(SEED));
  const s = street(state, PLACES);
  zone(state, s, 1, 0, PLACES, 6);
  holdDemand({ residential: 80 }, () => {
    for (let i = 0; i < 30 * DAY; i++) step(state);
  });
  for (let id = 0; id < popIdLimit(state.pops); id++) if (isPop(state.pops, id)) removePop(state, id);
  const centres = lotCentres(state);
  const along = (id: number) => ((centres.x[id] ?? 0) - s.x) * s.dx + ((centres.z[id] ?? 0) - s.z) * s.dz;
  const houses: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id) && (state.buildings.residents[id] ?? 0) > 0) houses.push(id);
  houses.sort((a, b) => along(a) - along(b));
  const pops = new Map<number, number>();
  for (const home of houses.slice(0, houses.length - room)) {
    // Full: one household in a single family home, as many as it holds in any other.
    const households = BUILDING_TYPES[state.buildings.type[home] ?? 0]?.oneHousehold ? 1 : (state.buildings.residents[home] ?? 0);
    for (let i = 0; i < households; i++) pops.set(addPop(state, { home, size: 1, education: 0, wealth: 0, children: 1, satisfaction: T.noWorkers }), home);
  }
  return { state, s, houses, pops };
}

/** Births, deaths, children leaving and replacements all off, so only displacement moves the scores. */
function noTurnover<R>(body: () => R): R {
  const t = POPS_BALANCE.turnover;
  return withValue(t, "birthsPerPersonYear", 0, () =>
    withValue(t, "deathsPerPersonYear", 0, () => withValue(t, "childrenLeaveYears", 1e9, () => withValue(t, "replacementsPerPopYear", 0, body))),
  );
}

/** Steps `days` game days with the residential bar held at 0, so nobody arrives on it and nobody is sent away. */
function stepDays(state: SimState, days: number, each: (day: number) => void = () => undefined): void {
  holdDemand({ residential: 0, commercial: 0, office: 0, industrial: 0 }, () => {
    for (let d = 0; d < days; d++) {
      for (let i = 0; i < DAY; i++) step(state);
      each(d);
    }
  });
}

function distanceSquared(state: SimState, a: number, x: number, z: number): number {
  const c = lotCentres(state);
  const dx = (c.x[a] ?? 0) - x;
  const dz = (c.z[a] ?? 0) - z;
  return dx * dx + dz * dz;
}

/** The test's pops still living where they were put, within `radius` of (x, z). */
function neighboursOf(state: SimState, pops: Map<number, number>, x: number, z: number, skip: Set<number> = new Set()): number[] {
  const out: number[] = [];
  for (const [id, home] of pops) {
    if (skip.has(id) || !isPop(state.pops, id) || state.pops.home[id] !== home) continue;
    if (distanceSquared(state, home, x, z) <= D.radius * D.radius) out.push(id);
  }
  return out;
}

function averageScore(state: SimState, ids: readonly number[]): number {
  let sum = 0;
  for (const id of ids) sum += state.pops.satisfaction[id] ?? 0;
  return sum / ids.length;
}

function bulldoze(state: SimState, ids: readonly number[]): void {
  ok(state, command("BulldozeBuilding", { buildings: ids.map((id) => seeBuilding(state.buildings, id)) }));
}

const ROOM = 8;
const town = houseStreet(ROOM);
const fresh = () => ({ ...town, state: cloneState(town.state), pops: new Map(town.pops) });

describe("the displacement balance", () => {
  it("checks satisfaction.displacement in pops.json", () => {
    expect(checkPopsBalance(popsJson)).toEqual([]);
    const broken = structuredClone(popsJson) as unknown as { satisfaction: Record<string, unknown> };
    const d = broken.satisfaction["displacement"] as Record<string, Record<string, unknown> | number>;
    d["radius"] = 0;
    (d["neighbours"] as Record<string, unknown>)["most"] = -1;
    (d["own"] as Record<string, unknown>)["byOwnerShare"] = 2;
    (d["own"] as Record<string, unknown>)["extra"] = 1;
    const errors = checkPopsBalance(broken);
    expect(errors.some((e) => e.includes("radius"))).toBe(true);
    expect(errors.some((e) => e.includes("neighbours.most"))).toBe(true);
    expect(errors.some((e) => e.includes("byOwnerShare"))).toBe(true);
    expect(errors.some((e) => e.includes("extra"))).toBe(true);
    delete broken.satisfaction["displacement"];
    expect(checkPopsBalance(broken)).toContain("satisfaction.displacement is missing");
  });

  it("leaves a pop in a job at its level above the score that sends it away, at the worst displacement", () => {
    expect(T.fittingJob - D.neighbours.most - D.own.most).toBeGreaterThanOrEqual(POPS_BALANCE.satisfaction.leaveBelow);
  });

  it("gives a pop its owner moved a smaller hit than one the city moved, and none after a game year", () => {
    const year = expropriationTicks();
    const city = ownLoss(DISPLACED_BY_CITY, 0, 4, 0);
    expect(city).toBe(Math.min(D.own.most, D.own.base + 4 * D.own.perPerson));
    expect(ownLoss(DISPLACED_BY_OWNER, 0, 4, 0)).toBe(city * D.own.byOwnerShare);
    expect(ownLoss(DISPLACED_BY_OWNER, 0, 4, 0)).toBeLessThan(city);
    expect(ownLoss(DISPLACED_BY_CITY, 0, 4, year / 2)).toBe(city / 2);
    expect(ownLoss(DISPLACED_BY_CITY, 0, 4, year)).toBe(0);
    expect(ownLoss(DISPLACED_BY_NONE, 0, 4, 0)).toBe(0);
    // A tower's people reach the cap.
    expect(ownLoss(DISPLACED_BY_CITY, 0, 5000, 0)).toBe(D.own.most);
  });
});

describe("the neighbours' hit", () => {
  it("gives a pop near a fresh record a lower target than one near an old record, and that one lower than a pop far from any", () => {
    const { state, houses, pops } = fresh();
    const year = expropriationTicks();
    // A city a game year old, so a record can be most of a year old.
    state.tick = year + 1;
    const c = lotCentres(state);
    const homeOf = new Map([...pops].map(([id, home]) => [home, id]));
    // Houses along an 800 m street: the first, then the first more than a radius on from it, and the first more than a radius on from that.
    const beyond = (from: number) => houses.find((id) => homeOf.has(id) && distanceSquared(state, id, c.x[from] ?? 0, c.z[from] ?? 0) > D.radius * D.radius && (c.x[id] ?? 0) * town.s.dx + (c.z[id] ?? 0) * town.s.dz > (c.x[from] ?? 0) * town.s.dx + (c.z[from] ?? 0) * town.s.dz) as number;
    const near = houses[0] as number;
    const middle = beyond(near);
    const far = beyond(middle);
    expect(homeOf.has(far)).toBe(true);
    const record = (id: number, tick: number): Expropriation => ({ tick, x: c.x[id] ?? 0, z: c.z[id] ?? 0, people: 50, jobs: 0, playerId: "p1" });
    // Oldest first, as the list keeps them: three quarters of a year old by the middle house, fresh by the near one.
    state.expropriations = [record(middle, state.tick - Math.floor((3 * year) / 4)), record(near, state.tick)];
    const target = (home: number) => satisfactionTarget(state, homeOf.get(home) as number);
    expect(jobTarget(state, homeOf.get(near) as number)).toBe(T.noWorkers);
    expect(target(near)).toBe(Math.floor(T.noWorkers - Math.min(D.neighbours.most, 50 * D.neighbours.perPerson) + 0.5));
    expect(target(near)).toBeLessThan(target(middle));
    expect(target(middle)).toBeLessThan(target(far));
    expect(target(far)).toBe(T.noWorkers);
    // Past a game year a record takes nothing, even before the step drops it.
    state.tick += year;
    expect(target(near)).toBe(T.noWorkers);
  });

  it("caps what all the records near a pop take together", () => {
    const { state, houses, pops } = fresh();
    const c = lotCentres(state);
    const home = houses[5] as number;
    const id = [...pops].find(([, h]) => h === home)?.[0] as number;
    state.expropriations = Array.from({ length: 30 }, () => ({ tick: state.tick, x: c.x[home] ?? 0, z: c.z[home] ?? 0, people: 5, jobs: 0, playerId: "p1" }));
    expect(satisfactionTarget(state, id)).toBe(T.noWorkers - D.neighbours.most);
  });
});

describe("a pop the city moved", () => {
  it("bulldozes an occupied house, finds its pop in a home across the city, and finds its score lower than its new neighbours'", () => {
    noTurnover(() => {
      const { state, houses, pops } = fresh();
      const house = houses[1] as number;
      const pop = [...pops].find(([, home]) => home === house)?.[0] as number;
      const c = lotCentres(state);
      const at = { x: c.x[house] ?? 0, z: c.z[house] ?? 0 };
      const people = popsIn(state, house).length;
      bulldoze(state, [house]);
      expect(state.expropriations.at(-1)).toMatchObject({ people, x: at.x, z: at.z });
      // Placed on the tick it was cleared, in one of the empty houses at the far end.
      expect(isPop(state.pops, pop)).toBe(true);
      const home = state.pops.home[pop] ?? NO_HOME;
      expect(home).not.toBe(NO_HOME);
      expect(houses.slice(-ROOM)).toContain(home);
      expect(distanceSquared(state, home, at.x, at.z)).toBeGreaterThan(D.radius * D.radius);
      expect(state.pops.displacedBy[pop]).toBe(DISPLACED_BY_CITY);
      expect(state.pops.displacedWith[pop]).toBe(people);
      const cleared = state.tick - 1;
      expect(state.pops.displacedTick[pop]).toBeGreaterThanOrEqual(cleared);
      stepDays(state, 20);
      const nc = lotCentres(state);
      const neighbours = neighboursOf(state, pops, nc.x[home] ?? 0, nc.z[home] ?? 0, new Set([pop]));
      expect(neighbours.length).toBeGreaterThan(5);
      // Its new neighbours are far from the record and keep their score.
      expect(averageScore(state, neighbours)).toBe(T.noWorkers);
      expect(state.pops.satisfaction[pop]).toBeLessThan(averageScore(state, neighbours));
      expect(satisfactionTarget(state, pop)).toBeLessThan(T.noWorkers);
    });
  });

  it("reads its target without changing state, a year-old mark included, and refuses a save with a mark from after the city's tick", () => {
    const { state, houses, pops } = fresh();
    const pop = [...pops].find(([, home]) => home === houses[4])?.[0] as number;
    state.pops.displacedBy[pop] = DISPLACED_BY_CITY;
    state.pops.displacedTick[pop] = 0;
    state.pops.displacedWith[pop] = 1;
    state.tick += expropriationTicks();
    const before = hashState(state);
    expect(satisfactionTarget(state, pop)).toBe(T.noWorkers);
    expect(hashState(state)).toBe(before);
    expect(state.pops.displacedBy[pop]).toBe(DISPLACED_BY_CITY);
    state.pops.displacedTick[pop] = state.tick + 1;
    expect(() => deserialize(serialize(state))).toThrow(/displaced after the city's tick/);
  });

  it("keeps its mark through a save, and has it cleared a game year on", () => {
    noTurnover(() => {
      const { state, houses, pops } = fresh();
      const house = houses[1] as number;
      const pop = [...pops].find(([, home]) => home === house)?.[0] as number;
      bulldoze(state, [house]);
      const back = deserialize(serialize(state)).state;
      expect(back.pops.displacedBy[pop]).toBe(DISPLACED_BY_CITY);
      expect(hashState(back)).toBe(hashState(state));
      stepDays(state, Math.ceil(expropriationTicks() / DAY) + 1);
      expect(state.pops.displacedBy[pop]).toBe(DISPLACED_BY_NONE);
      expect(state.pops.displacedTick[pop]).toBe(0);
      expect(state.pops.displacedWith[pop]).toBe(0);
      expect(state.pops.satisfaction[pop]).toBe(T.noWorkers);
    });
  });

  it("marks the pops of a house its owner redevelops as moved by the owner, and leaves no record", () => {
    withValue(LAND_VALUE_BALANCE.redevelopment, "margin", 0, () => {
      const { state, s, houses } = fresh();
      zone(state, s, 3, 0, PLACES, 6);
      const plan = houses.map((id) => (state.buildings.residents[id] ?? 0) > 0 ? planRedevelopment(state, id) : null).find((p) => p !== null && p.replaces.some((id) => popsIn(state, id).length > 0));
      if (!plan) throw new Error("no tower replaces an occupied house");
      const moved = plan.replaces.flatMap((id) => popsIn(state, id));
      // One the city once paid to clear and left standing, as a road undone before its buildings went leaves it: rebuilt by its owner all the same.
      state.buildings.paid[plan.replaces[0] as number] = 1;
      const records = state.expropriations.length;
      redevelop(state, plan);
      expect(state.expropriations.length).toBe(records);
      for (const id of moved) {
        expect(state.pops.displacedBy[id]).toBe(DISPLACED_BY_OWNER);
        expect(state.pops.displacedTick[id]).toBe(state.tick);
      }
    });
  });
});

/** The pops living in building `home`. */
function popsIn(state: SimState, home: number): number[] {
  const out: number[] = [];
  for (let id = 0; id < popIdLimit(state.pops); id++) if (isPop(state.pops, id) && state.pops.home[id] === home) out.push(id);
  return out;
}

describe("clearing a block (scenario test)", () => {
  it("finds the neighbours' average score drop and recover over a game year, and the grid kept through it equal to one built at load", () => {
    noTurnover(() => {
      const { state, houses, pops } = fresh();
      // Ten houses in the middle of the street, and a house beside them cleared a month later.
      const mid = Math.floor(houses.length / 2);
      const block = houses.slice(mid - 5, mid + 5);
      const later = houses[mid - 6] as number;
      const c = lotCentres(state);
      const centre = { x: c.x[houses[mid] as number] ?? 0, z: c.z[houses[mid] as number] ?? 0 };
      const moved = new Set([...block, later].flatMap((id) => popsIn(state, id)));
      const neighbours = neighboursOf(state, pops, centre.x, centre.z, moved);
      expect(neighbours.length).toBeGreaterThan(10);
      expect(averageScore(state, neighbours)).toBe(T.noWorkers);
      bulldoze(state, block);
      expect(state.expropriations).toHaveLength(block.length);
      const year = Math.ceil(expropriationTicks() / DAY);
      const days = year + 45;
      const averages: number[] = [];
      const grids: string[] = [];
      stepDays(state, days, (d) => {
        averages.push(averageScore(state, neighbours));
        if (d === 30) bulldoze(state, [later]);
        if (d % 30 === 0 || d === year + 5) {
          const kept = expropriationGridCells(expropriationGridOf(state));
          const loaded = deserialize(serialize(state)).state;
          expect(kept).toEqual(expropriationGridCells(expropriationGridOf(loaded)));
          grids.push(JSON.stringify(kept.map(([key, list]) => [key, list.length])));
        }
      });
      // Every neighbour stayed: the hit alone sends nobody away.
      for (const id of neighbours) expect(isPop(state.pops, id)).toBe(true);
      const low = Math.min(...averages);
      const lowDay = averages.indexOf(low);
      expect(low).toBeLessThan(T.noWorkers - 4);
      expect(lowDay).toBeLessThan(60);
      // It recovers as the records fade: three quarters of a year on it is well above its lowest, and once they are a year old it is back where it was.
      expect(averages[Math.floor((3 * year) / 4)] as number).toBeGreaterThan(low + 4);
      for (let d = 120; d < days; d++) expect(averages[d] as number).toBeGreaterThanOrEqual(averages[d - 1] as number);
      expect(averages[days - 1]).toBe(T.noWorkers);
      expect(state.expropriations).toEqual([]);
      // The grid held the block, then the block and the house, then the house alone, then nothing.
      expect(new Set(grids).size).toBeGreaterThanOrEqual(3);
    });
  });

  it("keeps the grid equal to one built afresh when the cap drops records from the head", () => {
    noTurnover(() => {
      const { state, houses } = fresh();
      const most = ECONOMY.expropriationsMax;
      const old = { tick: 0, x: 1, z: 1, people: 1, jobs: 0, playerId: "old" };
      state.expropriations = Array.from({ length: most - 2 }, (_, i) => ({ ...old, tick: Math.min(i, state.tick) }));
      expropriationGridOf(state);
      for (const id of houses.slice(0, 5)) {
        bulldoze(state, [id]);
        expect(state.expropriations).toHaveLength(Math.min(most, state.expropriations.length));
        expect(expropriationGridCells(expropriationGridOf(state))).toEqual(expropriationGridCells(expropriationGridOf(cloneState(state))));
      }
      expect(state.expropriations).toHaveLength(most);
      expect(state.expropriations.slice(-5).every((r) => r.playerId === "p1")).toBe(true);
    });
  });

  it("replays to the same state hash", () => {
    noTurnover(() => {
      const { state, houses } = fresh();
      const start = cloneState(state);
      const bars = { residential: 0, commercial: 0, office: 0, industrial: 0 };
      holdDemand(bars, () => {
        bulldoze(state, houses.slice(10, 16));
        for (let i = 0; i < 5 * DAY; i++) step(state);
      });
      expect(state.pops.displacedBy.some((by) => by === DISPLACED_BY_CITY)).toBe(true);
      const replayed = holdDemand(bars, () => replayFrom(start, state.log.slice(start.log.length), state.tick));
      expect(hashState(replayed)).toBe(hashState(state));
    });
  });
});
