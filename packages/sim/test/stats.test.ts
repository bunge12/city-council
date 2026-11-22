import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  HISTORY_LENGTH,
  NO_WORK,
  STAT_TOTALS,
  TIME_BALANCE,
  ZONING_BALANCE,
  applyStatsDelta,
  buildingJobs,
  cellAt,
  createState,
  deserialize,
  encodeStatsDelta,
  findLot,
  hashState,
  historyOf,
  isMonthStart,
  isYearStart,
  jobsByKind,
  jobsFilled,
  recountTotals,
  sampleCount,
  serialize,
  step,
  submit,
  yearDays,
  type Command,
  type SimState,
} from "../src/index";
import { addBuilding, removeBuilding } from "../src/buildings/buildings";
import { addPop, removePop, setPopProfile, setPopSatisfaction, setPopSize, setPopWork, type NewPop } from "../src/pops/pops";
import { nextInt, seedRng } from "../src/rng";
import { STATS, createStats, noteYear, takeSample } from "../src/stats/stats";

// M3-04: city statistics.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const PER_DAY = TIME_BALANCE.ticksPerDay;

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

/** Adds the building the lot at place `p` fits, with the type's most residents. */
function build(state: SimState, p: number): number {
  const [x, z] = north(p, 0);
  const cell = cellAt(state, x, z);
  if (!cell) throw new Error("no cell");
  const found = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth });
  if (!found.ok) throw new Error(`no lot: ${found.reason}`);
  const type = BUILDING_TYPES[found.lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...found.lot, residents: type.residents[1], variant: 0 });
}

/**
 * A paused city with a street and, on its north side, a house, a strip
 * mall, a small office, a high tower, a mixed tower at density 3 and a
 * small factory. Paused, so the grower builds nothing else.
 */
function town() {
  const state = createState(SEED);
  ok(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4600, z: 4600 }, type: "street" });
  state.speed = 0;
  zoneNorth(state, "residential", 1, 0, 2, 4);
  zoneNorth(state, "commercial", 2, 2, 6, 3);
  zoneNorth(state, "office", 1, 9, 2, 2);
  zoneNorth(state, "residential", 3, 15, 6, 6);
  zoneNorth(state, "mixed", 3, 22, 6, 6);
  zoneNorth(state, "industrial", 1, 29, 4, 4);
  const at = { house: 0, mall: 2, office: 9, tower: 15, mixed: 22, factory: 29 };
  const ids = { house: build(state, at.house), mall: build(state, at.mall), office: build(state, at.office), tower: build(state, at.tower), mixed: build(state, at.mixed), factory: build(state, at.factory) };
  return { state, at, ...ids };
}

const pop = (home: number, size: number, extra: Partial<NewPop> = {}): NewPop => ({ home, size, education: 1, wealth: 1, children: 0, satisfaction: 50, ...extra });

describe("the running totals", () => {
  it("count buildings by zone and density, and the jobs each offers by kind, a mixed tower's split between commercial and office", () => {
    const { state, mixed, mall, office, factory, house, tower } = town();
    const t = state.stats.totals;
    expect(t["buildingsR1"]).toBe(1);
    expect(t["buildingsC2"]).toBe(1);
    expect(t["buildingsO1"]).toBe(1);
    expect(t["buildingsR3"]).toBe(1);
    expect(t["buildingsM3"]).toBe(1);
    expect(t["buildingsI1"]).toBe(1);
    expect(STAT_TOTALS.filter((n) => n.startsWith("buildings")).reduce((n, name) => n + (t[name] ?? 0), 0)).toBe(6);
    const kinds = (id: number) => {
      const type = BUILDING_TYPES[state.buildings.type[id] ?? 0];
      if (!type) throw new Error("no such type");
      return jobsByKind(type, buildingJobs(state.buildings, id));
    };
    const mixedJobs = kinds(mixed);
    // Half commercial, half office at density 3.
    expect(mixedJobs.commercial).toBeGreaterThan(0);
    expect(mixedJobs.office).toBeGreaterThan(0);
    expect(t["jobsCommercial"]).toBe(kinds(mall).commercial + mixedJobs.commercial);
    expect(t["jobsOffice"]).toBe(kinds(office).office + mixedJobs.office);
    expect(t["jobsIndustrial"]).toBe(kinds(factory).industrial);
    expect(buildingJobs(state.buildings, house) + buildingJobs(state.buildings, tower)).toBe(0);
    expect(t).toEqual(recountTotals(state));
  });

  it("count people, pops, workers and jobs filled as pops move in, take jobs and change", () => {
    const { state, house, tower, mixed } = town();
    const a = addPop(state, pop(house, 4, { education: 2, wealth: 0, children: 1 }));
    const b = addPop(state, pop(tower, 100, { education: 0, wealth: 2 }));
    const t = state.stats.totals;
    expect(t["population"]).toBe(104);
    expect(t["pops"]).toBe(2);
    expect(t["residentsDensity1"]).toBe(4);
    expect(t["residentsDensity3"]).toBe(100);
    expect(t["residentsEducationHigh"]).toBe(4);
    expect(t["residentsEducationLow"]).toBe(100);
    expect(t["residentsWealthLow"]).toBe(4);
    expect(t["residentsWealthHigh"]).toBe(100);
    expect(t["popsWithChildren"]).toBe(1);
    expect(t["workersEmployed"]).toBe(0);
    const workers = (t["workersUnemployed"] ?? 0);
    expect(workers).toBeGreaterThan(50);
    // Pop b takes jobs in the mixed tower: they count as filled under commercial and office.
    setPopWork(state, b, mixed);
    const filled = jobsFilled(state, mixed);
    expect(filled).toBeGreaterThan(0);
    expect(t["workersEmployed"]).toBe(filled);
    expect(t["workersUnemployed"]).toBe(workers - filled);
    expect((t["filledCommercial"] ?? 0) + (t["filledOffice"] ?? 0)).toBe(filled);
    expect(t["filledCommercial"]).toBeGreaterThan(0);
    expect(t["filledOffice"]).toBeGreaterThan(0);
    removePop(state, a);
    expect(t["population"]).toBe(100);
    expect(state.stats.highestPopulation).toBe(104);
    expect(t).toEqual(recountTotals(state));
  });

  it("equal a recount after every step of a scripted session of adds, changes and removals of pops and buildings", () => {
    const { state, at, house, tower, mall, office, mixed, factory } = town();
    const homes = [house, tower, mixed];
    const works = [NO_WORK, mall, office, mixed, factory];
    const places = Object.values(at);
    const rng = seedRng(171);
    const pick = <T>(list: readonly T[]): T => list[nextInt(rng, list.length)] as T;
    let highest = 0;
    let refused = 0;
    let rebuilt = 0;
    for (let i = 0; i < 3000; i++) {
      const live = Array.from(state.pops.flags.keys()).filter((id) => state.pops.flags[id]);
      const id = live.length > 0 ? pick(live) : -1;
      try {
        switch (nextInt(rng, 9)) {
          case 0:
          case 1:
            addPop(state, pop(pick(homes), 1 + nextInt(rng, pick([4, 100])), { children: nextInt(rng, 2), education: nextInt(rng, 3), wealth: nextInt(rng, 3) }));
            break;
          case 2:
            removePop(state, id);
            break;
          case 3:
            setPopSize(state, id, 1 + nextInt(rng, pick([4, 100])));
            break;
          case 4:
          case 5:
            setPopWork(state, id, pick(works));
            break;
          case 6:
            setPopProfile(state, id, { education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2) });
            break;
          case 7:
            setPopSatisfaction(state, id, nextInt(rng, 101));
            break;
          default: {
            // Now and then a building goes, its pops with it, and is built again on the same lot under the same id.
            if (nextInt(rng, 10) !== 0) break;
            const place = pick(places);
            const [x, z] = north(place, 0);
            const cell = cellAt(state, x, z);
            const standing = [...homes, ...works].find((b) => b !== NO_WORK && state.buildings.firstSeg[b] === cell?.segment && state.buildings.firstPlace[b] === cell?.place && state.buildings.flags[b]);
            if (standing === undefined) break;
            removeBuilding(state, standing);
            expect(build(state, place)).toBe(standing);
            rebuilt++;
          }
        }
      } catch {
        refused++;
      }
      expect(state.stats.totals, `after change ${i}`).toEqual(recountTotals(state));
      highest = Math.max(highest, state.stats.totals["population"] ?? 0);
      expect(state.stats.highestPopulation).toBe(highest);
    }
    expect(refused).toBeGreaterThan(100);
    expect(rebuilt).toBeGreaterThan(5);
    expect(state.stats.totals["workersEmployed"]).toBeGreaterThan(0);
    expect(state.stats.totals["filledIndustrial"]).toBeGreaterThan(0);
  });
});

describe("the monthly history", () => {
  it("takes a sample on the first tick of each month and of no other tick", () => {
    const monthStarts = [0];
    for (const days of TIME_BALANCE.monthDays) monthStarts.push((monthStarts.at(-1) ?? 0) + days * PER_DAY);
    const year = yearDays() * PER_DAY;
    for (let tick = 0; tick < 2 * year; tick++) {
      expect(isMonthStart(tick), `tick ${tick}`).toBe(monthStarts.includes(tick % year));
      expect(isYearStart(tick)).toBe(tick % year === 0);
    }
  });

  it("keeps 1,200 samples over 1,201 game months, the oldest gone", () => {
    const state = createState(1);
    const stats = state.stats;
    let months = 0;
    for (state.tick = 0; months < 1201; state.tick++) {
      // Each month's sample of the population is its number, counting from 1.
      if (isMonthStart(state.tick)) stats.totals["population"] = ++months;
      STATS.run(state);
    }
    expect(sampleCount(stats)).toBe(HISTORY_LENGTH);
    expect(STAT_TOTALS.every((name) => stats.history[name]?.length === HISTORY_LENGTH)).toBe(true);
    const population = historyOf(stats, "population");
    expect(population).toHaveLength(1200);
    expect(population[0]).toBe(2);
    expect(population.at(-1)).toBe(1201);
    expect(population.every((v, i) => v === i + 2)).toBe(true);
    // The 1,201st month starts a hundred game years after the first.
    expect(state.tick - 1).toBe(100 * yearDays() * PER_DAY);
  });

  it("grows a sample at a time until full, then writes over the oldest", () => {
    const stats = createStats();
    for (let i = 1; i <= HISTORY_LENGTH + 3; i++) {
      stats.totals["pops"] = i;
      takeSample(stats);
      expect(sampleCount(stats)).toBe(Math.min(i, HISTORY_LENGTH));
      expect(historyOf(stats, "pops").at(-1)).toBe(i);
      expect(historyOf(stats, "pops")[0]).toBe(Math.max(1, i - HISTORY_LENGTH + 1));
    }
    expect(stats.next).toBe(3);
  });

  it("keeps the year that ended beside the running one, from 1 January", () => {
    const state = createState(1);
    state.speed = 1;
    // After the first tick, which is 1 January and starts the year afresh.
    step(state);
    noteYear(state, "births", 5);
    noteYear(state, "arrivals", 40);
    const newYear = yearDays() * PER_DAY;
    while (state.tick < newYear) step(state);
    expect(state.stats.year).toEqual({ births: 5, deaths: 0, arrivals: 40, departures: 0 });
    step(state);
    expect(state.stats.lastYear).toEqual({ births: 5, deaths: 0, arrivals: 40, departures: 0 });
    expect(state.stats.year).toEqual({ births: 0, deaths: 0, arrivals: 0, departures: 0 });
    noteYear(state, "departures", 3);
    expect(state.stats.year.departures).toBe(3);
    expect(() => noteYear(state, "deaths", -1)).toThrow(RangeError);
    expect(() => noteYear(state, "deaths", 0.5)).toThrow(RangeError);
    // Twelve samples in the first year and one on 1 January.
    expect(sampleCount(state.stats)).toBe(13);
  });

  it("hashes the same saved and reloaded mid-month as a city that never stopped, and takes its next sample on the same tick", () => {
    const { state, tower, mixed } = town();
    for (let i = 0; i < 4; i++) addPop(state, pop(tower, 100));
    setPopWork(state, 0, mixed);
    noteYear(state, "arrivals", 400);
    state.speed = 1;
    // 15 January, partway through a day.
    while (state.tick < 14 * PER_DAY + 37) step(state);
    expect(sampleCount(state.stats)).toBe(1);
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(hashState(state));
    const february = 31 * PER_DAY;
    while (state.tick < february) {
      step(state);
      step(loaded);
      expect(sampleCount(loaded.stats)).toBe(sampleCount(state.stats));
    }
    expect(sampleCount(state.stats)).toBe(1);
    step(state);
    step(loaded);
    expect(sampleCount(state.stats)).toBe(2);
    expect(sampleCount(loaded.stats)).toBe(2);
    // Nobody lived there on 1 January.
    expect(historyOf(loaded.stats, "population")).toEqual([0, 400]);
    expect(hashState(loaded)).toBe(hashState(state));
  });
});

describe("statistics deltas", () => {
  it("bring a copy level with the sim, the samples taken in between included, across the history filling up", () => {
    const sim = createStats();
    const copy = createStats();
    const rng = seedRng(4);
    let sent = 0;
    let sentTotals = { ...sim.totals };
    for (let round = 0; round < 600; round++) {
      // Up to five months between two deltas.
      const months = nextInt(rng, 6);
      for (let m = 0; m < months; m++) {
        for (const name of STAT_TOTALS) sim.totals[name] = nextInt(rng, 1000);
        takeSample(sim);
      }
      // A few totals move after the last sample, and the rest stay.
      for (const name of STAT_TOTALS) if (nextInt(rng, 4) === 0) sim.totals[name] = nextInt(rng, 1000);
      sim.highestPopulation = round;
      noteYearOn(sim, round);
      const delta = encodeStatsDelta(sim, sent, sentTotals);
      expect(delta.samples.length).toBe(months * STAT_TOTALS.length);
      // Only the totals that changed travel (M3-05).
      const moved = STAT_TOTALS.filter((name) => sim.totals[name] !== sentTotals[name]);
      expect(Object.keys(delta.totals)).toEqual(moved);
      expect(applyStatsDelta(copy, delta)).toEqual(moved);
      sent = sim.next;
      sentTotals = { ...sim.totals };
      expect(copy).toEqual(sim);
      expect(Object.keys(copy.totals)).toEqual(STAT_TOTALS);
    }
    expect(sampleCount(sim)).toBe(HISTORY_LENGTH);
    expect(applyStatsDelta(copy, { ...encodeStatsDelta(sim, sent), samples: new Int32Array(3) })).toMatch(/whole rows/);
    expect(applyStatsDelta(copy, { ...encodeStatsDelta(sim, sent), totals: { wealth: 3 } })).toMatch(/unknown total/);
    expect(applyStatsDelta(copy, { ...encodeStatsDelta(sim, sent), totals: { population: 0.5 } })).toMatch(/whole number/);
    // Without the totals last sent, every one goes.
    expect(Object.keys(encodeStatsDelta(sim, sent).totals)).toEqual(STAT_TOTALS);
  });
});

function noteYearOn(stats: ReturnType<typeof createStats>, n: number): void {
  stats.year.births = n;
  stats.lastYear.deaths = n + 1;
}
