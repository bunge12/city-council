import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  NO_HOME,
  NO_WORK,
  POPS_BALANCE,
  POP_ROW_BYTES,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingJobs,
  buildingPeople,
  cellAt,
  createState,
  cutPeople,
  deserialize,
  findLot,
  hashState,
  jobsFilled,
  popCount,
  popSizeCap,
  popSlice,
  popWorkers,
  popsAtHome,
  popsAtWork,
  readPop,
  serialize,
  step,
  submit,
  workersFor,
  type Command,
  type Lot,
  type SimState,
} from "../src/index";
import { addBuilding, removeBuilding } from "../src/buildings/buildings";
import { checkPopsBalance } from "../src/pops/balance";
import { withValue } from "./with-value";
import { POP_ARRAYS, addPop, addSplitPop, checkPops, createPops, rehomePop, removePop, setPopGraceDays, setPopHousehold, setPopProfile, setPopSatisfaction, setPopSize, setPopWork, type NewPop } from "../src/pops/pops";
import { nextInt, seedRng } from "../src/rng";
import { cloneState } from "../src/state";
import { recountTotals } from "../src/stats/stats";
import popsJson from "../balance/pops.json" with { type: "json" };
import { holdDemand } from "./demand-helper";

// M3-03: pops in state.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
}

/** The centre of the cell at place `p` along x from 4200 and `k` deep in the north strip of the street. */
const north = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

function zoneNorth(state: SimState, zone: string, density: number, p0: number, w: number, d: number): void {
  const [x0, zMid0] = north(p0, 0);
  const [x1] = north(p0 + w - 1, 0);
  const z = zMid0 - (CELL * (d - 1)) / 2;
  ok(state, "ZoneCells", { zone, density, rects: [{ from: { x: x0 - 2, z }, to: { x: x1 + 2, z }, width: CELL * (d - 1) + 4 }] });
}

function lotAt(state: SimState, at: [number, number]): Lot {
  const cell = cellAt(state, at[0], at[1]);
  if (!cell) throw new Error("no cell");
  const result = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth });
  if (!result.ok) throw new Error(`no lot: ${result.reason}`);
  return result.lot;
}

/** Adds the building the lot at place `p` fits, with the type's most residents. */
function build(state: SimState, p: number): number {
  const lot = lotAt(state, north(p, 0));
  const type = BUILDING_TYPES[lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...lot, residents: type.residents[1], variant: 0 });
}

/**
 * A paused city with a street and, on its north side, a house at place 0,
 * a strip mall from place 2, an office from place 9 and a high tower from
 * place 15. Paused, so the grower builds nothing else.
 */
function town(): { state: SimState; house: number; mall: number; office: number; tower: number } {
  const state = createState(SEED);
  ok(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
  state.speed = 0;
  zoneNorth(state, "residential", 1, 0, 2, 4);
  zoneNorth(state, "commercial", 2, 2, 6, 3);
  zoneNorth(state, "office", 1, 9, 2, 2);
  zoneNorth(state, "residential", 3, 15, 6, 6);
  const house = build(state, 0);
  const mall = build(state, 2);
  const office = build(state, 9);
  const tower = build(state, 15);
  return { state, house, mall, office, tower };
}

const pop = (home: number, size: number, extra: Partial<NewPop> = {}): NewPop => ({ home, size, education: 1, wealth: 1, children: 0, satisfaction: 50, ...extra });

/** Every derived answer, counted from the pop rows alone. */
function countFromScratch(state: SimState) {
  const p = state.pops;
  const limit = state.buildings.flags.length;
  const homes: number[][] = Array.from({ length: limit }, () => []);
  const works: number[][] = Array.from({ length: limit }, () => []);
  const people = new Array<number>(limit).fill(0);
  const filled = new Array<number>(limit).fill(0);
  for (let id = 0; id < p.flags.length; id++) {
    if (!p.flags[id]) continue;
    const home = p.home[id] ?? 0;
    if (home !== NO_HOME) {
      homes[home]?.push(id);
      people[home] = (people[home] ?? 0) + (p.size[id] ?? 0);
    }
    const work = p.work[id] ?? NO_WORK;
    if (work === NO_WORK) continue;
    works[work]?.push(id);
    filled[work] = (filled[work] ?? 0) + workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
  }
  return { homes, works, people, filled };
}

/** Every derived answer as the index gives it. */
function derived(state: SimState) {
  const limit = state.buildings.flags.length;
  const ids = Array.from({ length: limit }, (_, b) => b);
  return {
    homes: ids.map((b) => popsAtHome(state, b)),
    works: ids.map((b) => popsAtWork(state, b)),
    people: ids.map((b) => buildingPeople(state, b)),
    filled: ids.map((b) => jobsFilled(state, b)),
  };
}

/** The index kept current, a fresh build of it and a count from the rows all agree, and the rows pass the load check. */
function expectConsistent(state: SimState): void {
  const scratch = countFromScratch(state);
  expect(derived(state)).toEqual(scratch);
  // A clone has no index yet, so it builds one from the rows.
  expect(derived(cloneState(state))).toEqual(scratch);
  expect(checkPops(state.pops, state.buildings)).toBeNull();
  expect(state.stats.totals).toEqual(recountTotals(state));
}

describe("the rules a pop row follows", () => {
  it("cuts a building's people into as few pops as the size cap allows, as even as whole people make them", () => {
    expect(POPS_BALANCE.popSizeCap).toEqual([5, 20, 100]);
    expect(cutPeople(0, 1)).toEqual([]);
    expect(cutPeople(4, 1)).toEqual([4]);
    expect(cutPeople(5, 1)).toEqual([5]);
    expect(cutPeople(16, 1)).toEqual([4, 4, 4, 4]);
    expect(cutPeople(50, 2)).toEqual([17, 17, 16]);
    expect(cutPeople(1000, 3)).toEqual(Array(10).fill(100));
    expect(cutPeople(550, 3)).toEqual([92, 92, 92, 92, 91, 91]);
    for (const [people, density] of [[1, 1], [999, 3], [37, 2], [301, 3]] as const) {
      const sizes = cutPeople(people, density);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(people);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(popSizeCap(density));
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("cuts every house the balance can draw into one pop", () => {
    for (const type of BUILDING_TYPES.filter((t) => t.id === "single-family-home")) {
      expect(cutPeople(type.residents[1], type.density)).toHaveLength(1);
    }
  });

  it("counts a share of a pop's people as workers, fewer with children", () => {
    expect(POPS_BALANCE.workerShare).toEqual({ withoutChildren: 0.6, withChildren: 0.4 });
    expect(workersFor(100, 0)).toBe(60);
    expect(workersFor(100, 1)).toBe(40);
    expect(workersFor(4, 0)).toBe(2);
    expect(workersFor(4, 1)).toBe(2);
    expect(workersFor(1, 0)).toBe(1);
    expect(workersFor(1, 1)).toBe(0);
  });

  it("takes a size cap only up to what a byte holds", () => {
    expect(checkPopsBalance({ ...popsJson, popSizeCap: [5, 20, 256] }).join()).toMatch(/popSizeCap must list 3 whole numbers from 1 to 255/);
    expect(checkPopsBalance(popsJson)).toEqual([]);
  });

  it("keeps a pop row at 16 bytes", () => {
    expect(POP_ARRAYS).toEqual(["flags", "home", "work", "size", "education", "wealth", "children", "satisfaction", "daysLow", "graceDays"]);
    expect(POP_ROW_BYTES).toBe(16);
  });
});

describe("pops in state", () => {
  it("fills a tower to capacity with pops within the size cap, and a house with one pop", () => {
    const { state, house, tower } = town();
    const room = state.buildings.residents[tower] ?? 0;
    expect(room).toBe(1000);
    const density = state.buildings.density[tower] ?? 0;
    for (const size of cutPeople(room, density)) addPop(state, pop(tower, size));
    const pops = popsAtHome(state, tower);
    expect(pops.length).toBeGreaterThanOrEqual(10);
    for (const id of pops) expect(readPop(state.pops, id).size).toBeLessThanOrEqual(popSizeCap(3));
    expect(buildingPeople(state, tower)).toBe(room);
    // Full: not one more person.
    expect(() => addPop(state, pop(tower, 1))).toThrow(/room for 1000 people/);

    const houseRoom = state.buildings.residents[house] ?? 0;
    const sizes = cutPeople(houseRoom, state.buildings.density[house] ?? 0);
    expect(sizes).toEqual([houseRoom]);
    addPop(state, pop(house, houseRoom));
    expect(popsAtHome(state, house)).toHaveLength(1);
    expect(popCount(state.pops)).toBe(pops.length + 1);
    expectConsistent(state);
  });

  it("refuses a pop that would break a building's room, its jobs, the size cap or the ranges", () => {
    const { state, house, mall, tower } = town();
    const before = hashState(state);
    expect(() => addPop(state, pop(mall, 1))).toThrow(/is not a home/);
    expect(() => addPop(state, pop(999, 1))).toThrow(/is not a home/);
    expect(() => addPop(state, pop(house, 6))).toThrow(/holds 1 to 5 people/);
    expect(() => addPop(state, pop(tower, 0))).toThrow(/holds 1 to 100 people/);
    expect(() => addPop(state, pop(tower, 101))).toThrow(/holds 1 to 100 people/);
    expect(() => addPop(state, pop(tower, 2.5))).toThrow(/holds 1 to 100 people/);
    expect(() => addPop(state, pop(tower, 10, { education: 3 }))).toThrow(/education and wealth/);
    expect(() => addPop(state, pop(tower, 10, { wealth: -1 }))).toThrow(/education and wealth/);
    expect(() => addPop(state, pop(tower, 10, { children: 2 }))).toThrow(/children/);
    expect(() => addPop(state, pop(tower, 10, { satisfaction: 101 }))).toThrow(/satisfaction/);
    expect(hashState(state)).toBe(before);

    const id = addPop(state, pop(tower, 100));
    const jobs = buildingJobs(state.buildings, mall);
    expect(jobs).toBe(36);
    // 60 workers do not fit 36 jobs.
    expect(() => setPopWork(state, id, mall)).toThrow(/offers 36 jobs, not 60/);
    expect(() => setPopWork(state, id, house)).toThrow(/offers no jobs/);
    setPopSize(state, id, 50);
    setPopWork(state, id, mall);
    expect(jobsFilled(state, mall)).toBe(30);
    // Growing to 70 would need 42 workers; the home has room but the mall does not.
    const held = hashState(state);
    expect(() => setPopSize(state, id, 70)).toThrow(/offers 36 jobs, not 42/);
    expect(() => setPopSize(state, id, 101)).toThrow(/holds 1 to 100/);
    expect(hashState(state)).toBe(held);
    // Children lower the share that works, so that change fits.
    setPopProfile(state, id, { education: 2, wealth: 0, children: 1 });
    expect(jobsFilled(state, mall)).toBe(20);
    setPopSize(state, id, 90);
    expect(popWorkers(state.pops, id)).toBe(36);
    expect(jobsFilled(state, mall)).toBe(36);
    expect(() => setPopProfile(state, id, { education: 2, wealth: 0, children: 0 })).toThrow(/offers 36 jobs, not 54/);
    // Setting the same workplace again counts its own workers once.
    setPopWork(state, id, mall);
    expect(jobsFilled(state, mall)).toBe(36);
    expect(() => setPopSatisfaction(state, id, -1)).toThrow(/satisfaction/);
    setPopSatisfaction(state, id, 100);
    expect(readPop(state.pops, id)).toEqual({ id, home: tower, work: mall, size: 90, education: 2, wealth: 0, children: 1, satisfaction: 100, daysLow: 0, graceDays: 0 });
    expectConsistent(state);
  });

  it("lets a pop past a lowered size cap shrink and split, and refuses only growth past it (M3 review, #365)", () => {
    const { state, tower } = town();
    const id = addPop(state, pop(tower, 100, { children: 1 }));
    // A save from a build with a higher cap loads with its pops as they are (PRD, "Pops").
    withValue(POPS_BALANCE, "popSizeCap", [5, 20, 40], () => {
      // A death or a child leaving.
      setPopHousehold(state, id, 99, 0);
      expect(readPop(state.pops, id).size).toBe(99);
      // A split, as job matching and turnover make one: the part, then the rest.
      setPopSize(state, id, 60);
      const rest = addSplitPop(state, pop(tower, 39), 99);
      expect(readPop(state.pops, rest).size).toBe(39);
      // Growth past the cap is still refused, and so is a new pop past it.
      expect(() => setPopSize(state, id, 61)).toThrow(/holds 1 to 40/);
      expect(() => setPopHousehold(state, id, 61, 1)).toThrow(/holds 1 to 40/);
      expect(() => addPop(state, pop(tower, 41))).toThrow(/holds 1 to 40/);
      expect(() => addSplitPop(state, pop(tower, 61), 60)).toThrow(/holds 1 to 40/);
    });
    expectConsistent(state);
  });

  it("keeps every derived answer equal to a count from scratch through a long run of changes", () => {
    const { state, house, mall, office, tower } = town();
    const homes = [house, tower];
    const works = [NO_WORK, mall, office];
    const rng = seedRng(170);
    const pick = <T>(list: readonly T[]): T => list[nextInt(rng, list.length)] as T;
    let refused = 0;
    for (let i = 0; i < 2000; i++) {
      const live = Array.from(state.pops.flags.keys()).filter((id) => state.pops.flags[id]);
      const id = live.length > 0 ? pick(live) : -1;
      const before = hashState(state);
      try {
        switch (nextInt(rng, 7)) {
          case 0:
          case 1:
            addPop(state, { ...pop(pick(homes), 1 + nextInt(rng, 100), { children: nextInt(rng, 2), education: nextInt(rng, 3) }), graceDays: nextInt(rng, 3) });
            break;
          case 6:
            // Days of grace running out, or a pop given more (#361).
            setPopGraceDays(state, id, nextInt(rng, 3));
            break;
          case 2:
            removePop(state, id);
            break;
          case 3:
            setPopSize(state, id, 1 + nextInt(rng, 100));
            break;
          case 4:
            setPopWork(state, id, pick(works));
            break;
          default:
            setPopProfile(state, id, { education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2) });
        }
      } catch {
        refused++;
        // A refusal changes nothing.
        expect(hashState(state)).toBe(before);
      }
      if (i % 50 === 0) expectConsistent(state);
    }
    expectConsistent(state);
    expect(refused).toBeGreaterThan(100);
    expect(popCount(state.pops)).toBeGreaterThan(5);
    expect(jobsFilled(state, mall)).toBeLessThanOrEqual(buildingJobs(state.buildings, mall));
    expect(buildingPeople(state, tower)).toBeLessThanOrEqual(state.buildings.residents[tower] ?? 0);
  });

  it("gives no job to a pop with nobody who works, and takes the job of one left with nobody", () => {
    const { state, house, mall } = town();
    // One person with children: 0.4 of a worker rounds to none.
    const alone = addPop(state, pop(house, 1, { children: 1 }));
    expect(popWorkers(state.pops, alone)).toBe(0);
    expect(() => setPopWork(state, alone, mall)).toThrow(/has nobody who works/);
    setPopProfile(state, alone, { education: 1, wealth: 1, children: 0 });
    setPopWork(state, alone, mall);
    expect(popsAtWork(state, mall)).toEqual([alone]);
    setPopProfile(state, alone, { education: 1, wealth: 1, children: 1 });
    expect(readPop(state.pops, alone).work).toBe(NO_WORK);
    expect(popsAtWork(state, mall)).toEqual([]);
    setPopSize(state, alone, 3);
    setPopWork(state, alone, mall);
    setPopSize(state, alone, 1);
    expect(readPop(state.pops, alone).work).toBe(NO_WORK);
    expectConsistent(state);
  });

  it("reuses the last removed id first and clears its row", () => {
    const { state, tower } = town();
    const a = addPop(state, pop(tower, 10));
    const b = addPop(state, pop(tower, 20));
    const c = addPop(state, pop(tower, 30));
    removePop(state, a);
    removePop(state, c);
    for (const key of POP_ARRAYS) expect(state.pops[key][c]).toBe(0);
    expect(() => removePop(state, c)).toThrow(/does not exist/);
    expect(() => readPop(state.pops, c)).toThrow(/does not exist/);
    expect(addPop(state, pop(tower, 5))).toBe(c);
    expect(addPop(state, pop(tower, 5))).toBe(a);
    expect(popsAtHome(state, tower)).toEqual([a, b, c]);
    expect(buildingPeople(state, tower)).toBe(30);
    expectConsistent(state);
  });

  it("displaces a building's pops into the queue, keeping their jobs, and frees the jobs in it", () => {
    const { state, house, mall, office, tower } = town();
    const atHouse = addPop(state, pop(house, 4));
    const workers = [addPop(state, pop(tower, 20)), addPop(state, pop(tower, 30))];
    for (const id of workers) setPopWork(state, id, mall);
    setPopWork(state, atHouse, office);
    expect(jobsFilled(state, mall)).toBe(30);
    expect(jobsFilled(state, office)).toBe(2);

    removeBuilding(state, mall);
    for (const id of workers) expect(readPop(state.pops, id).work).toBe(NO_WORK);
    expect(popsAtWork(state, mall)).toEqual([]);
    expect(jobsFilled(state, mall)).toBe(0);
    expectConsistent(state);

    // The house's pop is displaced (M3-12): no home, in the queue, still in
    // the population and still at work.
    const population = state.stats.totals["population"];
    removeBuilding(state, house);
    expect(readPop(state.pops, atHouse)).toMatchObject({ home: NO_HOME, work: office, size: 4 });
    expect(Array.from(state.pops.displaced)).toEqual([atHouse]);
    expect(popsAtHome(state, house)).toEqual([]);
    expect(popsAtWork(state, office)).toEqual([atHouse]);
    expect(jobsFilled(state, office)).toBe(2);
    expect(popCount(state.pops)).toBe(3);
    expect(state.stats.totals["population"]).toBe(population);
    expectConsistent(state);

    // The tower's pops join the queue behind it, in id order.
    removeBuilding(state, tower);
    expect(Array.from(state.pops.displaced)).toEqual([atHouse, ...workers]);
    expect(popCount(state.pops)).toBe(3);
    expectConsistent(state);

    // A pop that leaves from the queue leaves it.
    removePop(state, workers[0] as number);
    expect(Array.from(state.pops.displaced)).toEqual([atHouse, workers[1]]);
    expectConsistent(state);
  });

  it("moves a pop with no home into one with room, and refuses one with too little", () => {
    const { state, house, tower, office } = town();
    const id = addPop(state, pop(tower, 8));
    setPopWork(state, id, office);
    const other = addPop(state, pop(house, 2));
    removeBuilding(state, tower);
    expect(() => setPopSize(state, id, 10)).toThrow(/has no home/);
    // A density 1 house takes a pop of at most 5.
    expect(() => rehomePop(state, id, house)).toThrow(RangeError);
    expect(() => rehomePop(state, other, house)).toThrow(/has a home/);
    removePop(state, id);
    const small = addPop(state, pop(house, 1));
    removeBuilding(state, house);
    expect(Array.from(state.pops.displaced)).toEqual([other, small].sort((a, b) => a - b));
    expectConsistent(state);
  });

  it("round-trips a snapshot with pops to the same hash, and rebuilds the same answers from it", () => {
    const { state, mall, office, tower, house } = town();
    for (const size of cutPeople(900, 3)) addPop(state, pop(tower, size, { education: size % 3, wealth: (size + 1) % 3, children: size % 2 }));
    addPop(state, pop(tower, 15, { children: 1 }));
    addPop(state, pop(house, 3));
    setPopWork(state, 9, office);
    setPopWork(state, 10, mall);
    removePop(state, 4);
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(hashState(state));
    expect(derived(loaded)).toEqual(derived(state));
    expect(loaded.pops.free).toEqual(new Int32Array([4]));
  });

  it("refuses a save whose pops break a rule", () => {
    const { state, tower, mall } = town();
    const id = addPop(state, pop(tower, 50));
    setPopWork(state, id, mall);
    const refuse = (edit: (s: SimState) => void): string => {
      const copy = cloneState(state);
      edit(copy);
      const bytes = serialize(copy);
      try {
        deserialize(bytes);
      } catch (error) {
        return (error as Error).message;
      }
      return "loaded";
    };
    expect(refuse(() => undefined)).toBe("loaded");
    expect(refuse((s) => void (s.pops.size[id] = 0))).toMatch(/pops are malformed: pop 0 has nobody in it/);
    expect(refuse((s) => void (s.pops.home[id] = mall))).toMatch(/pops are malformed: pop 0 lives in a building that is not a home/);
    expect(refuse((s) => void (s.pops.work[id] = tower))).toMatch(/pops are malformed: pop 0 works at a building with no jobs/);
    expect(refuse((s) => void (s.pops.education[id] = 3))).toMatch(/bad education or wealth/);
    expect(refuse((s) => void (s.pops.sweep = 2))).toMatch(/sweep is not a pop id limit/);
    expect(
      refuse((s) => {
        s.pops.flags[id] = 0;
      }),
    ).toMatch(/neither live nor free/);
    // More people than the tower's stored room.
    expect(refuse((s) => void (s.buildings.residents[tower] = 40))).toMatch(/building \d+ holds more people than it has room for/);
    // Past what today's balance allows, but that is for tuning, not corruption:
    // past the size cap, and 60 workers where there are 36 jobs.
    expect(refuse((s) => void (s.pops.size[id] = 100))).toBe("loaded");
    expect(checkPops(createPops(), state.buildings)).toBeNull();
  });
});

describe("the daily sweep", () => {
  it("visits every pop id once a game day, a strided slice a tick, from the limit set on the day's first tick", () => {
    const { state, tower } = town();
    for (let i = 0; i < 10; i++) addPop(state, pop(tower, 50));
    removePop(state, 3);
    addPop(state, pop(tower, 50));
    state.speed = 1;
    // Run to the start of the next day, so its limit is set. The bar held
    // above zero so nobody is sent away: tick 0 now visits id 0, and a pop
    // that left would free its id for the late one.
    const perDay = TIME_BALANCE.ticksPerDay;
    const stepHeld = () => holdDemand({ residential: 50 }, () => step(state));
    while (state.tick % perDay !== 0) stepHeld();
    stepHeld();
    expect(state.pops.sweep).toBe(10);
    // A pop added mid-day past the limit waits for the next day.
    const late = addPop(state, pop(tower, 1));
    expect(late).toBe(10);
    // Tick 0 of the day took id 0; from tick 1 to the day's last, tick k takes ids k, k + perDay and on.
    const seen: number[] = [];
    do {
      const { from, to, step: stride } = popSlice(state);
      expect(from).toBe(state.tick % perDay);
      for (let id = from; id < to; id += stride) seen.push(id);
      stepHeld();
    } while (state.tick % perDay !== 0);
    expect(seen).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
    expect(seen).not.toContain(late);
    // The next day's first tick takes the new pop in.
    stepHeld();
    expect(state.pops.sweep).toBe(11);
  });

  it("gives 150,000 pops a slice of 1,500 a tick and covers each once a day", () => {
    const perDay = TIME_BALANCE.ticksPerDay;
    const state = createState(SEED);
    state.pops.sweep = 150_000;
    const visits = new Uint8Array(150_000);
    let largest = 0;
    for (let k = 0; k < perDay; k++) {
      state.tick = 7 * perDay + k;
      const { from, to, step: stride } = popSlice(state);
      let count = 0;
      for (let id = from; id < to; id += stride) {
        visits[id] = (visits[id] ?? 0) + 1;
        count++;
      }
      largest = Math.max(largest, count);
    }
    expect(visits.every((v) => v === 1)).toBe(true);
    expect(largest).toBe(150_000 / perDay);
  });

  it("spreads the newest ids, a day's newcomers, over the day's ticks (#354)", () => {
    const perDay = TIME_BALANCE.ticksPerDay;
    const state = createState(SEED);
    // 140,000 pops from before and 1,000 that came yesterday, at the top of the ids.
    state.pops.sweep = 141_000;
    let most = 0;
    for (let k = 0; k < perDay; k++) {
      state.tick = 7 * perDay + k;
      const { from, to, step: stride } = popSlice(state);
      let newest = 0;
      for (let id = from; id < to; id += stride) if (id >= 140_000) newest++;
      most = Math.max(most, newest);
    }
    expect(most).toBe(1_000 / perDay);
  });

  it("visits the same slice on a city saved and loaded mid-day", () => {
    const { state, tower } = town();
    for (let i = 0; i < 10; i++) addPop(state, pop(tower, 100));
    state.speed = 1;
    const perDay = TIME_BALANCE.ticksPerDay;
    while (state.tick % perDay !== 37) step(state);
    const loaded = deserialize(serialize(state)).state;
    for (let i = 0; i < perDay; i++) {
      expect(popSlice(loaded)).toEqual(popSlice(state));
      step(state);
      step(loaded);
    }
    expect(hashState(loaded)).toBe(hashState(state));
  });
});
