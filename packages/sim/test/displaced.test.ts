import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  NO_HOME,
  NO_WORK,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingJobs,
  buildingPeople,
  connectionEnd,
  createState,
  deserialize,
  hashState,
  isBuilding,
  planBulldozeBuildings,
  popCount,
  popsAtHome,
  readPop,
  recountTotals,
  replayFrom,
  seeBuilding,
  serialize,
  step,
  type Command,
  type SimState,
} from "../src/index";
import { checkPopsBalance } from "../src/pops/balance";
import { checkPops, removePop } from "../src/pops/pops";
import { popIndexOf } from "../src/pops/where";
import { nextInt, seedRng } from "../src/rng";
import { holdDemand } from "./demand-helper";
import { submit } from "./seen-ends";
import { withValue } from "./with-value";
import popsJson from "../balance/pops.json" with { type: "json" };
import { credited } from "./credited";

// M3-12: displaced pops. A pop whose home is removed joins a queue in state
// and is placed in another home, near its job if it has one, up to a cap a
// tick, or leaves the city when no home has room.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;

let seq = 0;
function send(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
}

function ok(state: SimState, type: string, payload: unknown): void {
  send(state, type, payload);
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.type, `${type} should apply`).toBe(type);
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

const homes = (state: SimState) => live(state, (id) => (state.buildings.residents[id] ?? 0) > 0);
const isHouse = (state: SimState, id: number) => BUILDING_TYPES[state.buildings.type[id] ?? 0]?.oneHousehold === true;

function livePops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.pops.flags.length; id++) if (state.pops.flags[id]) out.push(id);
  return out;
}

const population = (state: SimState): number => state.stats.totals["population"] ?? 0;

/** The totals equal a recount, the rows pass the load check, and no pop names a building that is gone. */
function expectSound(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
  expect(checkPops(state.pops, state.buildings)).toBeNull();
  const p = state.pops;
  for (const id of livePops(state)) {
    const home = p.home[id] ?? 0;
    const work = p.work[id] ?? NO_WORK;
    if (home !== NO_HOME && !isBuilding(state.buildings, home)) throw new Error(`pop ${id} lives in building ${home}, which is gone`);
    if (work !== NO_WORK && !isBuilding(state.buildings, work)) throw new Error(`pop ${id} works in building ${work}, which is gone`);
  }
  const byScore = new Float64Array(101);
  for (const id of livePops(state)) byScore[p.satisfaction[id] ?? 0] = (byScore[p.satisfaction[id] ?? 0] ?? 0) + (p.size[id] ?? 0);
  expect(Array.from(popIndexOf(state).peopleBySatisfaction)).toEqual(Array.from(byScore));
}

const seen = (state: SimState, ids: readonly number[]) => ({ buildings: ids.map((id) => seeBuilding(state.buildings, id)) });

/**
 * Houses on both sides of a street joined to the outside, and a strip of
 * shops at its start, grown with the bars held up until most pops work,
 * then held at 0 so nobody arrives, nothing grows and the bar sends nobody
 * away.
 */
function workingTown(): SimState {
  return holdDemand({ residential: 60, commercial: 60 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => growTown().state));
}

/** The streets and zoning of `workingTown`, grown 20 days under whatever bars the caller holds. */
function growTown(): { state: SimState; s: Street } {
  const state = credited(createState(SEED));
  const s = street(state, 30);
  zone(state, s, "commercial", 3, 0, 4, 4, 1);
  zone(state, s, "commercial", 3, 0, 4, 4, -1);
  zone(state, s, "residential", 1, 6, 24, 6, 1);
  zone(state, s, "residential", 1, 6, 24, 6, -1);
  runDays(state, 20);
  return { state, s };
}

const STILL = { residential: 0, commercial: 0, office: 0, industrial: 0 };

describe("the balance", () => {
  it("checks the number displaced a tick", () => {
    expect(checkPopsBalance(popsJson)).toEqual([]);
    expect(checkPopsBalance({ ...popsJson, displacedPerTick: 0 }).join()).toMatch(/displacedPerTick must be a whole number at least 1/);
    expect(checkPopsBalance({ ...popsJson, displacedPerTick: 2.5 }).join()).toMatch(/displacedPerTick/);
    const { displacedPerTick, ...rest } = popsJson;
    void displacedPerTick;
    expect(checkPopsBalance(rest).join()).toMatch(/displacedPerTick is missing/);
  });
});

describe("displaced pops", () => {
  it("move a bulldozed house's pop into an empty house, with its job kept and the population unchanged", () => {
    const state = workingTown();
    holdDemand(STILL, () => {
      const p = state.pops;
      const working = livePops(state).filter((id) => p.work[id] !== NO_WORK && isHouse(state, p.home[id] ?? 0));
      expect(working.length).toBeGreaterThan(2);
      const id = working[0] as number;
      const { home, work, size } = readPop(p, id);
      // Empty a house beside it, so there is room to move into.
      const other = working.find((o) => p.home[o] !== home) as number;
      const spare = p.home[other] as number;
      removePop(state, other);
      expect(buildingPeople(state, spare)).toBe(0);
      const before = population(state);
      const departures = state.stats.year.departures;

      const plan = planBulldozeBuildings(state, seen(state, [home]));
      expect(plan.ok && plan.residents).toBe(size);
      ok(state, "BulldozeBuilding", seen(state, [home]));

      expect(isBuilding(state.buildings, home)).toBe(false);
      const after = readPop(p, id);
      expect(after.home).not.toBe(home);
      expect(isBuilding(state.buildings, after.home)).toBe(true);
      expect(after.work).toBe(work);
      expect(after.size).toBe(size);
      expect(popsAtHome(state, after.home)).toContain(id);
      expect(population(state)).toBe(before);
      expect(state.stats.year.departures).toBe(departures);
      expect(state.pops.displaced.length).toBe(0);
      expectSound(state);
    });
  });

  it("send the pops of every home in a full city away, counted as departures", () => {
    const state = workingTown();
    holdDemand(STILL, () => {
      const people = population(state);
      expect(people).toBeGreaterThan(50);
      const departures = state.stats.year.departures;
      ok(state, "BulldozeBuilding", seen(state, homes(state)));
      while (state.pops.displaced.length > 0) step(state);
      expect(homes(state)).toEqual([]);
      expect(popCount(state.pops)).toBe(0);
      expect(population(state)).toBe(0);
      expect(state.stats.year.departures - departures).toBe(people);
      expectSound(state);
    });
  });

  it("wait in the queue past the cap a tick, homeless and still counted, and are placed over the ticks after", () => {
    const state = workingTown();
    holdDemand(STILL, () =>
      withValue(POPS_BALANCE, "displacedPerTick", 3, () => {
        const p = state.pops;
        // Room for everyone: free every other house, then bulldoze the occupied ones on one side.
        const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
        for (const [i, home] of occupied.entries()) if (i % 2 === 1) for (const pop of popsAtHome(state, home)) removePop(state, pop);
        const targets = occupied.filter((_, i) => i % 2 === 0).slice(0, 10);
        const moving = targets.flatMap((home) => popsAtHome(state, home));
        expect(moving.length).toBeGreaterThan(6);
        const jobs = new Map(moving.map((id) => [id, p.work[id]]));
        const before = population(state);
        const departures = state.stats.year.departures;

        ok(state, "BulldozeBuilding", seen(state, targets));
        expect(state.pops.displaced.length).toBe(moving.length - 3);
        for (const id of state.pops.displaced) {
          expect(p.home[id]).toBe(NO_HOME);
          expect(p.work[id]).toBe(jobs.get(id));
        }
        expect(population(state)).toBe(before);
        expectSound(state);

        let ticks = 1;
        while (state.pops.displaced.length > 0) {
          step(state);
          ticks++;
          expectSound(state);
        }
        expect(ticks).toBe(Math.ceil(moving.length / 3));
        // Each found a house with room for all its people and kept its job, or
        // found none that large and left, counted as a departure.
        const placed = moving.filter((id) => p.flags[id] === 1);
        expect(placed.length).toBeGreaterThan(moving.length / 2);
        for (const id of placed) {
          expect(isBuilding(state.buildings, p.home[id] ?? NO_HOME)).toBe(true);
          expect(p.work[id]).toBe(jobs.get(id));
        }
        expect(population(state) + (state.stats.year.departures - departures)).toBe(before);
      }),
    );
  });

  it("wait while the game is paused, and are placed once it goes on", () => {
    const state = workingTown();
    holdDemand(STILL, () => {
      const p = state.pops;
      const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
      for (const pop of popsAtHome(state, occupied[1] as number)) removePop(state, pop);
      const target = occupied[0] as number;
      const moving = popsAtHome(state, target);
      ok(state, "SetSpeed", { speed: 0 });
      ok(state, "BulldozeBuilding", seen(state, [target]));
      for (let i = 0; i < 5; i++) step(state);
      expect(Array.from(state.pops.displaced)).toEqual(moving);
      ok(state, "SetSpeed", { speed: 1 });
      expect(state.pops.displaced.length).toBe(0);
      for (const id of moving) expect(p.home[id]).not.toBe(NO_HOME);
      expectSound(state);
    });
  });

  it("leave the queue in order when one waiting pop is removed", () => {
    const state = workingTown();
    holdDemand(STILL, () => {
      const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
      ok(state, "SetSpeed", { speed: 0 });
      ok(state, "BulldozeBuilding", seen(state, occupied.slice(0, 6)));
      const queue = Array.from(state.pops.displaced);
      expect(queue.length).toBeGreaterThan(3);
      const gone = queue[2] as number;
      removePop(state, gone);
      expect(Array.from(state.pops.displaced)).toEqual(queue.filter((id) => id !== gone));
      removePop(state, queue[0] as number);
      removePop(state, queue[queue.length - 1] as number);
      expect(Array.from(state.pops.displaced)).toEqual(queue.slice(1, -1).filter((id) => id !== gone));
      expectSound(state);
    });
  });

  it("are displaced by a road built through their homes, and placed the same way", () => {
    holdDemand({ residential: 60, commercial: 60 }, () =>
      withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
        const { state, s } = growTown();
        holdDemand(STILL, () => {
          // Empty two houses in three, so there is room for the people the road moves.
          const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
          for (const [i, home] of occupied.entries()) if (i % 3 !== 0) for (const pop of popsAtHome(state, home)) removePop(state, pop);
          const before = population(state);
          const departures = state.stats.year.departures;
          const standing = homes(state);
          // A cross street through the houses on both sides, twelve places along.
          const along = CELL * 12 + CELL / 2;
          const at = (across: number) => ({ x: s.x + s.dx * along - s.dz * across, z: s.z + s.dz * along + s.dx * across });
          ok(state, "BuildRoad", { from: at(70), to: at(-70), type: "street" });
          for (let i = 0; i < 30; i++) step(state);
          const gone = standing.filter((id) => !isBuilding(state.buildings, id));
          expect(gone.length).toBeGreaterThan(0);
          expect(state.pops.displaced.length).toBe(0);
          // Everyone the road moved found room, or left and was counted.
          expect(population(state) + (state.stats.year.departures - departures)).toBe(before);
          expectSound(state);
        });
      }),
    );
  });

  it("keep the totals and the rows sound at every step of a long scripted session, and replay to the same hash", () => {
    // One hold for the whole run, so the replay below can hold the same.
    const held = <T>(body: () => T): T =>
      holdDemand({ residential: 40, commercial: 40 }, () => withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => withValue(POPS_BALANCE, "displacedPerTick", 4, body)));
    const state = held(() => {
      const { state } = growTown();
      const rng = seedRng(12);
      for (let round = 0; round < 40; round++) {
        const standing = homes(state);
        const pick: number[] = [];
        for (let k = 1 + nextInt(rng, 4); k > 0 && standing.length > 0; k--) {
          const id = standing[nextInt(rng, standing.length)] as number;
          if (!pick.includes(id)) pick.push(id);
        }
        if (pick.length > 0) send(state, "BulldozeBuilding", seen(state, pick.sort((a, b) => a - b)));
        for (let t = 0; t < 30; t++) {
          step(state);
          expectSound(state);
        }
      }
      return state;
    });
    expect(state.log.filter((e) => e.type === "BulldozeBuilding").length).toBe(40);
    const replayed = held(() => replayFrom(credited(createState(SEED)), state.log, state.tick));
    expect(hashState(replayed)).toBe(hashState(state));
  });

  it("resume from a save with pops in the queue to the same hash", () => {
    const state = workingTown();
    holdDemand(STILL, () =>
      withValue(POPS_BALANCE, "displacedPerTick", 2, () => {
        const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
        for (const [i, home] of occupied.entries()) if (i % 2 === 1) for (const pop of popsAtHome(state, home)) removePop(state, pop);
        ok(state, "BulldozeBuilding", seen(state, occupied.filter((_, i) => i % 2 === 0).slice(0, 8)));
        expect(state.pops.displaced.length).toBeGreaterThan(2);
        const loaded = deserialize(serialize(state)).state;
        expect(hashState(loaded)).toBe(hashState(state));
        expect(Array.from(loaded.pops.displaced)).toEqual(Array.from(state.pops.displaced));
        for (let i = 0; i < 2 * DAY; i++) {
          step(state);
          step(loaded);
        }
        expect(state.pops.displaced.length).toBe(0);
        expect(hashState(loaded)).toBe(hashState(state));
        expectSound(loaded);
      }),
    );
  });

  it("refuse a save whose queue is malformed", () => {
    const state = workingTown();
    holdDemand(STILL, () =>
      withValue(POPS_BALANCE, "displacedPerTick", 1, () => {
        const occupied = homes(state).filter((id) => buildingPeople(state, id) > 0);
        ok(state, "BulldozeBuilding", seen(state, occupied.slice(0, 3)));
      }),
    );
    expect(state.pops.displaced.length).toBeGreaterThan(0);
    const queued = state.pops.displaced[0] as number;
    const someone = livePops(state).find((id) => state.pops.home[id] !== NO_HOME) as number;
    const refuse = (edit: (s: SimState) => void) => {
      const copy = deserialize(serialize(state)).state;
      edit(copy);
      return checkPops(copy.pops, copy.buildings);
    };
    expect(refuse(() => undefined)).toBeNull();
    expect(refuse((s) => void (s.pops.displaced = Int32Array.from([queued, queued])))).toMatch(/names a pop twice/);
    expect(refuse((s) => void (s.pops.displaced = s.pops.displaced.slice(1)))).toMatch(/has no home and is not in the queue/);
    expect(refuse((s) => void (s.pops.displaced = Int32Array.from([...s.pops.displaced, someone])))).toMatch(/is in it with a home/);
    expect(refuse((s) => void ((s.pops as unknown as Record<string, unknown>)["displaced"] = [queued]))).toMatch(/displaced is not an Int32Array/);
  });
});

describe("placing", () => {
  it("lets a pop whose workplace goes with its home lose its job and still find a home", () => {
    const state = workingTown();
    holdDemand(STILL, () => {
      const p = state.pops;
      const working = livePops(state).filter((id) => p.work[id] !== NO_WORK && isHouse(state, p.home[id] ?? 0));
      const id = working[0] as number;
      const home = p.home[id] as number;
      const work = p.work[id] as number;
      expect(buildingJobs(state.buildings, work)).toBeGreaterThan(0);
      const spare = homes(state).find((h) => h !== home && buildingPeople(state, h) > 0) as number;
      for (const pop of popsAtHome(state, spare)) removePop(state, pop);
      ok(state, "BulldozeBuilding", seen(state, [home, work].sort((a, b) => a - b)));
      expect(readPop(p, id).work).toBe(NO_WORK);
      expect(readPop(p, id).home).not.toBe(NO_HOME);
      expectSound(state);
    });
  });
});
