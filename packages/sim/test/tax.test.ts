import { describe, expect, it } from "vitest";
import {
  BUILDING_ABANDONED,
  BUILDING_ALIVE,
  BUILDING_TYPES,
  BUILDING_VACANT,
  ECONOMY,
  LINE,
  SYSTEMS,
  TAX_SYSTEM,
  TIME_BALANCE,
  UPKEEP_SYSTEM,
  buildingTaxPerYear,
  collectTax,
  dailyShare,
  deserialize,
  floorSpaceOf,
  hashState,
  jobsForLot,
  prepareDerived,
  propertyValue,
  propertyValueOf,
  residentialTaxOf,
  serialize,
  step,
  type BuildingType,
  type SimState,
} from "../src/index";
import { isMonthStart, yearDays } from "../src/calendar";
import { buildingIdLimit } from "../src/buildings/buildings";
import { popIndexOf } from "../src/pops/where";
import { holdDemand, type HeldBars } from "./demand-helper";
import jobsJson from "./fixtures/replay/jobs.json";
import { replayFixture, type ReplayFixture } from "./replay-helper";
import { watchTreasury } from "./treasury-helper";

// Issue M4-05: the tax sweep, and property tax on homes a day at a time.

const DAY = TIME_BALANCE.ticksPerDay;
const LV = ECONOMY.value.landValueReference;
const RATE = ECONOMY.taxRates.residential.default;
const RESIDENTIAL = 0;

/** The jobs fixture's town: R1 and R2 homes with people in them, shops, offices and factories, every bar held at 60. */
const fixture = jobsJson as ReplayFixture;
const v = fixture.heldDemand ?? 60;
const BARS: HeldBars = { residential: v, commercial: v, office: v, industrial: v };
const held = <T>(run: () => T): T => holdDemand(BARS, run);

const type = (id: string): BuildingType => {
  const t = BUILDING_TYPES.find((x) => x.id === id);
  if (!t) throw new Error(`no type ${id}`);
  return t;
};

/** The live buildings of `state` with homes and people in them, not abandoned. */
function occupiedHomes(state: SimState): number[] {
  const b = state.buildings;
  const people = popIndexOf(state).people;
  const out: number[] = [];
  for (let id = 0; id < buildingIdLimit(b); id++) {
    const flags = b.flags[id] ?? 0;
    if ((flags & BUILDING_ALIVE) === 0 || (flags & BUILDING_ABANDONED) !== 0) continue;
    if ((b.residents[id] ?? 0) > 0 && (people[id] ?? 0) > 0) out.push(id);
  }
  return out;
}

/** The town, replayed and stepped on to the first tick of the next day. */
function town(): SimState {
  const state = replayFixture(fixture);
  held(() => {
    while (state.tick % DAY !== 0) step(state);
  });
  return state;
}

describe("a building's yearly tax", () => {
  it("gives a house and a tower their rate times their value", () => {
    const per = ECONOMY.floorSpace.perResident;
    const price = ECONOMY.value.perSquareMetre.residential;
    // At the reference land value a square metre is worth its price.
    const house = type("single-family-home");
    expect(propertyValueOf(house, 4, 0, LV)).toBe(4 * per * price);
    expect(residentialTaxOf(house, 4, 0, LV, RATE)).toBe(Math.floor(4 * per * price * RATE));
    const tower = type("high-tower");
    expect(residentialTaxOf(tower, 1000, 0, LV, RATE)).toBe(Math.floor(1000 * per * price * RATE));
    // A tower of a thousand residents pays what 250 houses of four do, to within the rounding.
    expect(Math.abs(residentialTaxOf(tower, 1000, 0, LV, RATE) - 250 * residentialTaxOf(house, 4, 0, LV, RATE))).toBeLessThan(250);
    // The tax follows the value, so better land pays more and a zero rate nothing.
    expect(residentialTaxOf(house, 4, 0, 90, RATE)).toBeGreaterThan(residentialTaxOf(house, 4, 0, 10, RATE));
    expect(residentialTaxOf(tower, 1000, 0, LV, 0)).toBe(0);
  });

  it("charges a mixed building on the share of its floor space that is homes", () => {
    const t = type("shop-top-row");
    const jobs = jobsForLot(t, 3, 2);
    expect(jobs).toBeGreaterThan(0);
    const space = floorSpaceOf(t, 10, jobs);
    const value = propertyValueOf(t, 10, jobs, LV);
    expect(residentialTaxOf(t, 10, jobs, LV, RATE)).toBe(Math.floor(((value * space.homes) / space.total) * RATE));
    expect(residentialTaxOf(t, 10, jobs, LV, RATE)).toBeLessThan(Math.floor(value * RATE));
  });

  it("is nothing for a workplace", () => {
    const store = type("corner-store");
    expect(residentialTaxOf(store, 0, jobsForLot(store, 1, 1), LV, RATE)).toBe(0);
  });

  it("is read for a building in state at the city's rate, and is nothing for one abandoned or gone", () => {
    const state = town();
    const homes = occupiedHomes(state);
    expect(homes.length).toBeGreaterThan(0);
    const id = homes[0] as number;
    const yearly = buildingTaxPerYear(state, id);
    expect(yearly).toBe(Math.floor(propertyValue(state, id) * RATE));
    state.budget.taxRates[RESIDENTIAL] = 2 * RATE;
    expect(buildingTaxPerYear(state, id)).toBe(Math.floor(propertyValue(state, id) * 2 * RATE));
    state.budget.taxRates[RESIDENTIAL] = RATE;
    const b = state.buildings;
    // A vacant home shows what it would pay; the sweep asks who lives there.
    b.flags[id] = BUILDING_ALIVE | BUILDING_VACANT;
    expect(buildingTaxPerYear(state, id)).toBe(yearly);
    b.flags[id] = BUILDING_ALIVE | BUILDING_ABANDONED;
    expect(buildingTaxPerYear(state, id)).toBe(0);
    b.flags[id] = 0;
    expect(buildingTaxPerYear(state, id)).toBe(0);
  });
});

describe("the tax sweep", () => {
  it("runs as a system the debug panel times, right after upkeep", () => {
    expect(SYSTEMS.map((s) => s.name).slice(1, 3)).toEqual([UPKEEP_SYSTEM, TAX_SYSTEM]);
  });

  it("charges each tick's slice of occupied homes the day's share, and each home once a day", () => {
    const state = town();
    const homes = occupiedHomes(state);
    const day = Math.floor(state.tick / DAY) % yearDays();
    const start = state.tick;
    let total = 0;
    for (let k = 0; k < DAY; k++) {
      state.tick = start + k;
      const due = homes.filter((id) => id % DAY === k).reduce((sum, id) => sum + dailyShare(buildingTaxPerYear(state, id), day), 0);
      const before = state.budget.month[LINE.taxResidential] as number;
      const treasury = state.budget.treasury;
      collectTax(state);
      expect(state.budget.month[LINE.taxResidential], `tick ${k} of the day`).toBe(before + due);
      expect(state.budget.treasury).toBe(treasury + due);
      total += due;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("charges nothing for an abandoned home or one nobody lives in, vacant or not", () => {
    const state = town();
    const homes = occupiedHomes(state);
    const b = state.buildings;
    const before = state.budget.month[LINE.taxResidential] as number;
    const day = () => {
      for (let k = 0; k < DAY; k++) {
        state.tick += 1;
        collectTax(state);
      }
    };
    for (const id of homes) b.flags[id] = BUILDING_ALIVE | BUILDING_ABANDONED;
    day();
    expect(state.budget.month[LINE.taxResidential]).toBe(before);
    // Emptied of people, in use or marked vacant, they pay nothing.
    const people = popIndexOf(state).people;
    const kept = people.slice();
    people.fill(0);
    for (const [i, id] of homes.entries()) b.flags[id] = BUILDING_ALIVE | (i % 2 === 0 ? BUILDING_VACANT : 0);
    day();
    expect(state.budget.month[LINE.taxResidential]).toBe(before);
    // People moved back into a home still marked vacant: it pays on the visit, before the vacancy check clears the mark.
    people.set(kept);
    day();
    expect(state.budget.month[LINE.taxResidential]).toBeGreaterThan(before);
  });
});

describe("a game year of the town", () => {
  it("files on the residential tax line the sum of each home's yearly tax over the days it was lived in", () => {
    const state = town();
    const watch = watchTreasury(state);
    /** By building: what it owed on each day it was visited lived in, and the yearly tax it was charged on. */
    const owed = new Map<number, { paid: number; days: number; yearly: Set<number> }>();
    let expected = 0;
    // What the line held as the year began, less what it holds at the end, plus every month the year closed.
    let filed = -(state.budget.month[LINE.taxResidential] as number);
    const end = state.tick + DAY * yearDays();
    held(() => {
      while (state.tick < end) {
        // The sweep runs before any system of the tick moves a pop or a building, and no command comes in the year.
        const k = state.tick % DAY;
        const day = Math.floor(state.tick / DAY) % yearDays();
        for (const id of occupiedHomes(state)) {
          if (id % DAY !== k) continue;
          const yearly = buildingTaxPerYear(state, id);
          const share = dailyShare(yearly, day);
          const row = owed.get(id) ?? { paid: 0, days: 0, yearly: new Set<number>() };
          row.paid += share;
          row.days += 1;
          row.yearly.add(yearly);
          owed.set(id, row);
          expected += share;
        }
        step(state);
        watch.check(state);
        if (isMonthStart(state.tick)) filed += state.budget.lastMonth[LINE.taxResidential] as number;
      }
    });
    filed += state.budget.month[LINE.taxResidential] as number;
    expect(watch.closes).toBe(12);
    expect(filed).toBe(expected);
    expect(filed).toBeGreaterThan(0);
    // A home lived in on every day of a year at one value pays its yearly tax to the dollar.
    const wholeYear = [...owed.values()].filter((row) => row.days === yearDays() && row.yearly.size === 1);
    expect(wholeYear.length).toBeGreaterThan(0);
    for (const row of wholeYear) expect(row.paid).toBe([...row.yearly][0]);
  });
});

describe("saving and replaying", () => {
  it("resumes a city saved half way through a day to the same hash", () => {
    const state = town();
    held(() => {
      for (let k = 0; k < DAY / 2; k++) step(state);
    });
    expect(state.tick % DAY).toBe(DAY / 2);
    const loaded = deserialize(serialize(state)).state;
    prepareDerived(loaded);
    expect(hashState(loaded)).toBe(hashState(state));
    const before = state.budget.month[LINE.taxResidential] as number;
    held(() => {
      for (const s of [state, loaded]) for (let k = 0; k < 2 * DAY; k++) step(s);
    });
    expect(state.budget.month[LINE.taxResidential]).toBeGreaterThan(before);
    expect(loaded.budget.month[LINE.taxResidential]).toBe(state.budget.month[LINE.taxResidential]);
    expect(hashState(loaded)).toBe(hashState(state));
  });

  it("replays the town to its recorded hash, with property tax collected", () => {
    const state = replayFixture(fixture);
    expect(hashState(state)).toBe(fixture.hash);
    let tax = 0;
    for (let i = 0; i < 2; i++) tax += (i === 0 ? state.budget.month : state.budget.lastMonth)[LINE.taxResidential] as number;
    expect(tax).toBeGreaterThan(0);
  });
});
