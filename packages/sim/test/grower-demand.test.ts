import { describe, expect, it } from "vitest";
import {
  ECONOMY,
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  DEMAND_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  createDemand,
  createState,
  dayQuotas,
  extraChances,
  deserialize,
  hashState,
  readBuilding,
  serialize,
  step,
  zoneBar,
  type BuildingRow,
  type Command,
  type DemandState,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { holdDemand, setBars, type HeldBars } from "./demand-helper";
import { credited } from "./credited";

// M3-07: the grower follows demand. A zone builds only while its bar is
// above zero, mixed only while residential and commercial both are, at a
// pace that follows the bar, and on whatever density the cell is zoned.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const RATES = DEMAND_BALANCE.buildingsPerDayAtFullDemand;
const zoneOf = (b: BuildingRow) => BUILDING_TYPES[b.type]?.zone;
const typeOf = (b: BuildingRow) => BUILDING_TYPES[b.type]?.id;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

/** A street running east from (4200, 4600) for `places` cells. */
function street(places = 24, z = 4600): SimState {
  const state = credited(createState(SEED));
  ok(state, "BuildRoad", { from: { x: 4200, z }, to: { x: 4200 + CELL * places, z }, type: "street" });
  return state;
}

/** Zones `d` cells deep from place `p0` for `w` places on the north side of the street at `z`, or the south. */
function zone(state: SimState, zoneId: string, density: number, p0: number, w: number, d: number, south = false, z = 4600): void {
  const x0 = 4200 + CELL * p0 + 2;
  const x1 = 4200 + CELL * (p0 + w) - 2;
  const edge = south ? z + 5 : z - 5;
  const mid = edge + ((south ? 1 : -1) * CELL * d) / 2;
  ok(state, "ZoneCells", { zone: zoneId, density, rects: [{ from: { x: x0, z: mid }, to: { x: x1, z: mid }, width: CELL * d - 4 }] });
}

function buildings(state: SimState): BuildingRow[] {
  const out: BuildingRow[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id]) out.push(readBuilding(state.buildings, id));
  return out;
}

function runDays(state: SimState, days: number): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) step(state);
}

/** Bars as `setBars` leaves them on a new city, for the quota tests. */
function bars(held: HeldBars): DemandState {
  const state = credited(createState(SEED));
  state.demand = createDemand();
  setBars(state, held);
  return state.demand;
}

describe("the day's quota for each zone", () => {
  const index = (id: string) => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;

  it("is none while the zone's bar is at or below zero", () => {
    expect(dayQuotas(bars({}))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(dayQuotas(bars({ residential: -30, commercial: -1, office: -100, industrial: 0 }))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("follows the bar: the full rate at 100, the whole part of the rate times the bar over 100 below it, the fraction as the chance of one more, and one a day barely above zero (M4-08)", () => {
    const all = (bar: number) => bars({ residential: bar, commercial: bar, office: bar, industrial: bar });
    for (const id of ["residential", "commercial", "office", "industrial", "mixed"]) {
      const rate = RATES[id] ?? 0;
      expect(rate, id).toBeGreaterThan(0);
      expect(dayQuotas(all(100))[index(id)], id).toBe(rate);
      expect(dayQuotas(all(50))[index(id)], id).toBe(Math.floor(rate / 2));
      expect(extraChances(all(50))[index(id)], id).toBeCloseTo(rate / 2 - Math.floor(rate / 2), 12);
      // Barely above zero: one a day for certain, as M3-07 had it, with no charge.
      expect(dayQuotas(all(0.01))[index(id)], id).toBe(1);
      expect(extraChances(all(0.01))[index(id)], id).toBe(0);
      // At the top charge that one a day is a chance of shareAtMax.
      const top = new Float64Array(6).fill(1);
      top[index(id)] = ECONOMY.developmentChargeGrowth.shareAtMax;
      expect(dayQuotas(all(0.01), top)[index(id)], id).toBe(0);
      expect(extraChances(all(0.01), top)[index(id)], id).toBeCloseTo(ECONOMY.developmentChargeGrowth.shareAtMax, 12);
    }
  });

  it("gives mixed the lower of the residential and commercial bars, and none while either is at or below zero", () => {
    expect(zoneBar(bars({ residential: 60, commercial: 20 }), "mixed")).toBe(20);
    expect(zoneBar(bars({ residential: 10, commercial: 70 }), "mixed")).toBe(10);
    const mixed = index("mixed");
    expect(dayQuotas(bars({ residential: 60, commercial: 20 }))[mixed]).toBe(Math.floor((RATES["mixed"] ?? 0) * 0.2));
    expect(dayQuotas(bars({ residential: 60, commercial: 0 }))[mixed]).toBe(0);
    expect(dayQuotas(bars({ residential: -5, commercial: 90 }))[mixed]).toBe(0);
  });

  it("keeps every zone together inside growthPerDayMax", () => {
    const all = dayQuotas(bars({ residential: 100, commercial: 100, office: 100, industrial: 100 }));
    expect(all.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BUILDINGS_BALANCE.growthPerDayMax);
  });
});

describe("the grower follows demand", () => {
  it("builds no house with the residential bar below zero, and shops and factories with theirs above it", () => {
    const state = street(30);
    zone(state, "residential", 1, 0, 30, 6);
    zone(state, "commercial", 1, 0, 14, 6, true);
    zone(state, "industrial", 1, 16, 14, 6, true);
    holdDemand({ residential: -20, commercial: 40, industrial: 40 }, () => runDays(state, 4));
    const all = buildings(state);
    expect(all.filter((b) => zoneOf(b) === "residential")).toEqual([]);
    expect(all.filter((b) => zoneOf(b) === "commercial").length).toBeGreaterThan(2);
    expect(all.filter((b) => zoneOf(b) === "industrial").length).toBeGreaterThan(2);
  });

  it("builds mixed ground only while the residential and commercial bars are both above zero", () => {
    const state = street();
    zone(state, "mixed", 1, 0, 24, 6);
    holdDemand({ residential: 50, commercial: -10 }, () => runDays(state, 3));
    expect(buildings(state)).toEqual([]);
    holdDemand({ residential: -10, commercial: 50 }, () => runDays(state, 3));
    expect(buildings(state)).toEqual([]);
    holdDemand({ residential: 0, commercial: 50 }, () => runDays(state, 3));
    expect(buildings(state)).toEqual([]);
    holdDemand({ residential: 50, commercial: 50 }, () => runDays(state, 3));
    const all = buildings(state);
    expect(all.length).toBeGreaterThan(2);
    for (const b of all) expect(zoneOf(b)).toBe("mixed");
  });

  it("builds a tower on an empty R3 lot of 4 x 4 as soon as the residential bar is above zero, with no smaller building first", () => {
    const state = street();
    zone(state, "residential", 3, 0, 4, 4);
    holdDemand({ residential: -10 }, () => runDays(state, 2));
    expect(buildings(state)).toEqual([]);
    // A day's quota of one for certain: a bar of 2 with no development charge (M4-08).
    ok(state, "SetDevelopmentCharge", { zone: "residential", rate: 0 });
    holdDemand({ residential: 100 / (RATES["residential"] ?? 1) }, () => runDays(state, 1));
    const all = buildings(state);
    expect(all.length).toBe(1);
    expect(typeOf(all[0] as BuildingRow)).toBe("low-tower");
    expect(all[0]?.width).toBe(4);
    expect(all[0]?.depth).toBe(4);
  });

  it("builds a day's quota in a day, so the pace follows the bar", () => {
    for (const bar of [10, 50, 100]) {
      // Three streets of R1 on both sides: more frontage than a day at 100 builds on, 50 since M3-21.
      const state = street(24, 4600);
      zone(state, "residential", 1, 0, 24, 6);
      zone(state, "residential", 1, 0, 24, 6, true);
      for (const z of [4800, 4400]) {
        ok(state, "BuildRoad", { from: { x: 4200, z }, to: { x: 4200 + CELL * 24, z }, type: "street" });
        zone(state, "residential", 1, 0, 24, 6, false, z);
        zone(state, "residential", 1, 0, 24, 6, true, z);
      }
      // With no development charge, so a day builds the bar's whole want (M4-08).
      ok(state, "SetDevelopmentCharge", { zone: "residential", rate: 0 });
      while (state.tick % DAY !== 0) step(state);
      const before = buildings(state).length;
      holdDemand({ residential: bar }, () => runDays(state, 1));
      expect(buildings(state).length - before, `bar ${bar}`).toBe(((RATES["residential"] ?? 0) * bar) / 100);
    }
  });

  it("fills an R1 street in an empty city on the pull from outside, and leaves C1 and O1 beside it empty", () => {
    const state = street(30);
    zone(state, "residential", 1, 0, 30, 6);
    zone(state, "commercial", 1, 0, 14, 6, true);
    zone(state, "office", 1, 16, 14, 6, true);
    runDays(state, 30);
    expect(state.demand.residential.value).toBeGreaterThan(0);
    expect(state.demand.commercial.value).toBeLessThanOrEqual(0);
    expect(state.demand.office.value).toBeLessThanOrEqual(0);
    const all = buildings(state);
    expect(all.length).toBeGreaterThan(8);
    for (const b of all) expect(zoneOf(b)).toBe("residential");
  });

  it("hashes the same saved and loaded mid-day as a city that never stopped", () => {
    const run = (straight: SimState) => {
      runDays(straight, 2);
      const saved = deserialize(serialize(straight)).state;
      runDays(straight, 2);
      for (let i = 0; i < 37; i++) step(saved);
      const reloaded = deserialize(serialize(saved)).state;
      while (reloaded.tick < straight.tick) step(reloaded);
      return { straight, reloaded };
    };
    const state = street();
    zone(state, "residential", 1, 0, 24, 6);
    zone(state, "mixed", 2, 0, 24, 6, true);
    const { straight, reloaded } = holdDemand({ residential: 70, commercial: 40 }, () => run(state));
    expect(buildings(straight).length).toBeGreaterThan(5);
    expect(hashState(reloaded)).toBe(hashState(straight));
  });
});
