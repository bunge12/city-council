// Development charges (M4-08, PRD "Development charges"): every new private
// building pays its zone's rate times its floor space, a redevelopment pays
// on the floor space it adds, and a higher rate slows the grower in its zone.

import { describe, expect, it } from "vitest";
import {
  BUILDING_ALIVE,
  BUILDING_TYPES,
  CHARGE_LINES,
  CHARGE_ZONES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  ECONOMY,
  LAND_VALUE_BALANCE,
  LINE,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingFloorSpace,
  checkEconomyBalance,
  chargeShareAt,
  connectionEnd,
  extraChances,
  dayQuotas,
  dayWants,
  floorSpaceOf,
  lotJobs,
  planRedevelopment,
  step,
  submit,
  validateCommand,
  createDemand,
  deserialize,
  hashState,
  replay,
  serialize,
  createState,
  type Command,
  type DemandState,
  type SimState,
} from "../src/index";
import { growOne } from "../src/buildings/grower";
import { enqueue } from "../src/commands";
import { redevelop } from "../src/buildings/redevelop";
import { holdDemand, setBars } from "./demand-helper";
import { watchTreasury } from "./treasury-helper";
import { withValue } from "./with-value";
import economyJson from "../balance/economy.json" with { type: "json" };

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const RESIDENTIAL = 1;
const OFFICE = 3;
const MIXED = 5;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The stub end of seed 2026's first outside connection, which runs east into dry ground (outside.test.ts). */
function stubEnd(state: SimState): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
}

function road(state: SimState, s: Street, places: number, type = "street"): Street {
  const to = { x: s.x + s.dx * CELL * places, z: s.z + s.dz * CELL * places };
  ok(state, "BuildRoad", { from: { x: s.x, z: s.z }, to, type });
  return { ...to, dx: s.dx, dz: s.dz };
}

/** Zones `depth` cells deep for `width` places along `s`, on both sides, 24 places to a rectangle. */
function zoneBoth(state: SimState, s: Street, zoneId: string, density: number, width: number, depth: number): void {
  for (let p0 = 0; p0 < width; p0 += 24) {
    for (const side of [1, -1]) {
      const off = side * (5 + (CELL * depth) / 2);
      const nx = -s.dz * off;
      const nz = s.dx * off;
      const a = CELL * p0 + 2;
      const b = CELL * Math.min(width, p0 + 24) - 2;
      ok(state, "ZoneCells", {
        zone: zoneId,
        density,
        rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }],
      });
    }
  }
}

/** A street from the stub, 24 places long, zoned `zoneId` at `density` six deep on both sides. */
function zonedStreet(zoneId: string, density: number, places = 24): { state: SimState; street: Street } {
  const state = createState(SEED);
  const street = stubEnd(state);
  road(state, street, places);
  zoneBoth(state, street, zoneId, density, places, 6);
  return { state, street };
}

function live(state: SimState, zone: number): number[] {
  const out: number[] = [];
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) if (((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0 && b.zone[id] === zone) out.push(id);
  return out;
}

function charged(state: SimState, zone: number): number {
  return state.budget.month[LINE[CHARGE_LINES[zone - 1] ?? "chargeResidential"]] ?? 0;
}

/** The rate of zone number `zone` in `state`. */
const rateOf = (state: SimState, zone: number): number => state.budget.chargeRates[zone - 1] ?? 0;

/** Runs `body` with the hold on new homes out of reach, so a test of pace is not held by homes still filling (M3-21). */
function noHomeHold<T>(body: () => T): T {
  return withValue(DEMAND_BALANCE, "unfilledHomesMax", 1_000_000, body);
}

describe("economy.json's development charges", () => {
  it("has a charge for each of the five zones and a share at the top of the range, and names a bad one", () => {
    expect(checkEconomyBalance(economyJson)).toEqual([]);
    const { mixed, ...four } = economyJson.developmentCharges;
    void mixed;
    expect(checkEconomyBalance({ ...economyJson, developmentCharges: four }).join()).toMatch(/developmentCharges\.mixed is missing/);
    const share = (shareAtMax: unknown) => checkEconomyBalance({ ...economyJson, developmentChargeGrowth: { ...economyJson.developmentChargeGrowth, shareAtMax } }).join();
    expect(share(1.5)).toMatch(/developmentChargeGrowth\.shareAtMax/);
    expect(share(-0.1)).toMatch(/developmentChargeGrowth\.shareAtMax/);
    expect(share(0.4)).toBe("");
  });
});

describe("the development charge on a new building", () => {
  it("starts every zone at its default from economy.json, mixed included", () => {
    const state = createState(SEED);
    expect(CHARGE_ZONES).toEqual(ZONING_BALANCE.zones.map((z) => z.id));
    expect(Array.from(state.budget.chargeRates)).toEqual(CHARGE_ZONES.map((z) => ECONOMY.developmentCharges[z].default));
    for (const line of CHARGE_LINES) expect(state.budget.month[LINE[line]]).toBe(0);
  });

  it("charges a house its rate times its floor space, on the residential line", () => {
    const { state } = zonedStreet("residential", 1);
    const before = state.budget.treasury;
    const id = growOne(state, RESIDENTIAL);
    expect(id).toBeGreaterThanOrEqual(0);
    const b = state.buildings;
    const type = BUILDING_TYPES[b.type[id] ?? 0];
    if (!type) throw new Error("no type");
    const space = floorSpaceOf(type, b.residents[id] ?? 0, lotJobs(b, id)).total;
    expect(space).toBeGreaterThan(0);
    expect(buildingFloorSpace(b, id)).toBe(space);
    const charge = rateOf(state, RESIDENTIAL) * space;
    expect(charge).toBeGreaterThan(0);
    expect(charged(state, RESIDENTIAL)).toBe(charge);
    expect(state.budget.treasury - before).toBe(charge);
    for (const zone of [2, 3, 4, 5]) expect(charged(state, zone)).toBe(0);
  });

  it("charges a tower its rate times its floor space, many times a house's", () => {
    const house = zonedStreet("residential", 1).state;
    const tower = zonedStreet("residential", 3).state;
    const h = growOne(house, RESIDENTIAL);
    const t = growOne(tower, RESIDENTIAL);
    expect(tower.buildings.density[t]).toBe(3);
    const space = buildingFloorSpace(tower.buildings, t);
    expect(charged(tower, RESIDENTIAL)).toBe(rateOf(tower, RESIDENTIAL) * space);
    expect(charged(tower, RESIDENTIAL)).toBeGreaterThan(10 * charged(house, RESIDENTIAL));
    expect(buildingFloorSpace(house.buildings, h)).toBeLessThan(space);
  });

  it("charges an office and a mixed building on their own lines, at their own rates", () => {
    const office = zonedStreet("office", 1).state;
    const o = growOne(office, OFFICE);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(charged(office, OFFICE)).toBe(rateOf(office, OFFICE) * buildingFloorSpace(office.buildings, o));
    expect(charged(office, RESIDENTIAL)).toBe(0);
    const mixed = zonedStreet("mixed", 1).state;
    const m = growOne(mixed, MIXED);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(charged(mixed, MIXED)).toBe(rateOf(mixed, MIXED) * buildingFloorSpace(mixed.buildings, m));
    expect(charged(mixed, RESIDENTIAL) + charged(mixed, 2)).toBe(0);
  });

  it("charges nothing at a rate of zero", () => {
    const { state } = zonedStreet("residential", 1);
    ok(state, "SetDevelopmentCharge", { zone: "residential", rate: 0 });
    const before = state.budget.treasury;
    expect(growOne(state, RESIDENTIAL)).toBeGreaterThanOrEqual(0);
    expect(charged(state, RESIDENTIAL)).toBe(0);
    expect(state.budget.treasury).toBe(before);
  });
});

describe("the development charge on a redevelopment", () => {
  it("charges a row of houses rebuilt as a tower only on the floor space it adds", () => {
    // Owners rebuild as soon as a tower is worth anything more than the houses.
    withValue(LAND_VALUE_BALANCE.redevelopment, "margin", 0, () => {
      const { state, street } = zonedStreet("residential", 1);
      noHomeHold(() => {
        for (let i = 0; i < 200 && growOne(state, RESIDENTIAL) >= 0; i++);
      });
      const houses = live(state, RESIDENTIAL);
      expect(houses.length).toBeGreaterThan(10);
      zoneBoth(state, street, "residential", 3, 24, 6);
      const plan = houses.map((id) => planRedevelopment(state, id)).find((p) => p !== null && p.replaces.length > 1);
      if (!plan) throw new Error("no tower replaces more than one house");
      let replaced = 0;
      for (const id of plan.replaces) replaced += buildingFloorSpace(state.buildings, id);
      const before = charged(state, RESIDENTIAL);
      const id = redevelop(state, plan);
      const space = buildingFloorSpace(state.buildings, id);
      expect(space).toBeGreaterThan(replaced);
      expect(charged(state, RESIDENTIAL) - before).toBe(rateOf(state, RESIDENTIAL) * (space - replaced));
      // Charged on the whole tower it would have paid more.
      expect(charged(state, RESIDENTIAL) - before).toBeLessThan(rateOf(state, RESIDENTIAL) * space);
    });
  });
});

describe("SetDevelopmentCharge", () => {
  it("sets one zone's rate and leaves the others", () => {
    const state = createState(SEED);
    const was = Array.from(state.budget.chargeRates);
    ok(state, "SetDevelopmentCharge", { zone: "mixed", rate: ECONOMY.developmentCharges.mixed.max });
    expect(rateOf(state, MIXED)).toBe(ECONOMY.developmentCharges.mixed.max);
    expect(Array.from(state.budget.chargeRates).slice(0, 4)).toEqual(was.slice(0, 4));
  });

  it("refuses a rate outside the range in economy.json, one not whole, and a zone it does not know", () => {
    const state = createState(SEED);
    const { min, max } = ECONOMY.developmentCharges.commercial;
    expect(validateCommand(state, command("SetDevelopmentCharge", { zone: "commercial", rate: max }))).toEqual({ ok: true });
    expect(validateCommand(state, command("SetDevelopmentCharge", { zone: "commercial", rate: min }))).toEqual({ ok: true });
    const refused = (payload: unknown) => validateCommand(state, command("SetDevelopmentCharge", payload)).ok;
    expect(refused({ zone: "commercial", rate: max + 1 })).toBe(false);
    expect(refused({ zone: "commercial", rate: min - 1 })).toBe(false);
    expect(refused({ zone: "commercial", rate: 10.5 })).toBe(false);
    expect(refused({ zone: "parks", rate: 10 })).toBe(false);
    expect(refused({ zone: "commercial" })).toBe(false);
    expect(refused(null)).toBe(false);
    expect(validateCommand(state, command("SetDevelopmentCharge", { zone: "commercial", rate: max + 1 }))).toEqual({
      ok: false,
      reason: `The commercial development charge runs from $${min} to $${max} a square metre`,
    });
  });
});

describe("how a charge slows the grower", () => {
  const held = (bars: Partial<Record<"residential" | "commercial" | "office" | "industrial", number>>): DemandState => {
    const state = createState(SEED);
    state.demand = createDemand();
    setBars(state, bars);
    return state.demand;
  };

  it("keeps the whole want at a charge of 0 and shareAtMax of it at the top of the range, in a straight line", () => {
    for (const [i, zone] of CHARGE_ZONES.entries()) {
      const { max } = ECONOMY.developmentCharges[zone];
      expect(chargeShareAt(i + 1, 0)).toBe(1);
      expect(chargeShareAt(i + 1, max)).toBeCloseTo(ECONOMY.developmentChargeGrowth.shareAtMax, 12);
      expect(chargeShareAt(i + 1, max / 2)).toBeCloseTo((1 + ECONOMY.developmentChargeGrowth.shareAtMax) / 2, 12);
    }
  });

  it("builds the whole part of the want for certain, and gives the fraction left over as the chance of one more", () => {
    const demand = held({ residential: 3 });
    // Residential at a bar of 3 wants 1.5 a day at a charge of 0, and 0.6 at the top of the range.
    const rate = DEMAND_BALANCE.buildingsPerDayAtFullDemand["residential"] ?? 0;
    expect(dayWants(demand)[RESIDENTIAL]).toBeCloseTo((rate * 3) / 100, 12);
    expect(dayQuotas(demand)[RESIDENTIAL]).toBe(1);
    expect(extraChances(demand)[RESIDENTIAL]).toBeCloseTo(0.5, 12);
    const top = new Float64Array(6).fill(1);
    top[RESIDENTIAL] = chargeShareAt(RESIDENTIAL, ECONOMY.developmentCharges.residential.max);
    const want = dayWants(demand, top)[RESIDENTIAL] ?? 0;
    expect(want).toBeCloseTo(1.5 * ECONOMY.developmentChargeGrowth.shareAtMax, 12);
    expect(dayQuotas(demand, top)[RESIDENTIAL]).toBe(Math.floor(want));
    expect(extraChances(demand, top)[RESIDENTIAL]).toBeCloseTo(want - Math.floor(want), 12);
    // A zone with its bar at 0 wants nothing and has no chance.
    expect(dayQuotas(demand)[OFFICE]).toBe(0);
    expect(extraChances(demand)[OFFICE]).toBe(0);
  });

  it("draws only on the day's last tick, and only for a zone with a free cell, so a city with nothing zoned never moves the generator", () => {
    const state = createState(SEED);
    road(state, stubEnd(state), 24);
    holdDemand({ residential: 3 }, () => {
      const rng = Array.from(state.rng);
      for (let i = 0; i < 3 * DAY; i++) step(state);
      expect(Array.from(state.rng)).toEqual(rng);
    });
    const { state: zoned } = zonedStreet("residential", 1);
    holdDemand({ residential: 3 }, () => {
      while (zoned.tick % DAY !== DAY - 2) step(zoned);
      const rng = Array.from(zoned.rng);
      // The tick before the last moves nothing unless it builds.
      const before = live(zoned, RESIDENTIAL).length;
      step(zoned);
      if (live(zoned, RESIDENTIAL).length === before) expect(Array.from(zoned.rng)).toEqual(rng);
    });
  });

  /** Buildings of zone number `zone` grown on a street zoned for it over `days` days at the charge `rate`, and what they paid. */
  function grown(zoneId: string, density: number, zone: number, bar: number, rate: number, days: number): { buildings: number; charges: number } {
    const { state } = zonedStreet(zoneId, density, 48);
    ok(state, "SetDevelopmentCharge", { zone: zoneId, rate });
    const watch = watchTreasury(state);
    let before = 0;
    let chargedBefore = 0;
    const bars = zoneId === "mixed" ? { residential: bar, commercial: bar } : { [zoneId]: bar };
    noHomeHold(() =>
      withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () =>
        holdDemand(bars, () => {
          while (state.tick % DAY !== 0) step(state);
          before = live(state, zone).length;
          chargedBefore = charged(state, zone);
          for (let i = 0; i < days * DAY; i++) {
            step(state);
            watch.check(state);
          }
        }),
      ),
    );
    // Both months, when the run crossed a close.
    const line = LINE[CHARGE_LINES[zone - 1] ?? "chargeResidential"];
    expect(watch.closes).toBeLessThanOrEqual(1);
    const charges = charged(state, zone) + (watch.closes === 1 ? (state.budget.lastMonth[line] ?? 0) : 0) - chargedBefore;
    return { buildings: live(state, zone).length - before, charges };
  }

  it("grows fewer buildings at the top rate than at zero, and takes no charge at zero, on a zone building one a day (scenario test)", () => {
    // Residential at a bar of 2: one house a day at zero, 0.4 of one at the top.
    const days = 30;
    const zero = grown("residential", 1, RESIDENTIAL, 2, 0, days);
    const top = grown("residential", 1, RESIDENTIAL, 2, ECONOMY.developmentCharges.residential.max, days);
    expect(zero.buildings).toBe(days);
    expect(zero.charges).toBe(0);
    expect(top.buildings).toBeLessThan(zero.buildings * 0.7);
    expect(top.buildings).toBeGreaterThan(zero.buildings * 0.15);
    expect(top.charges).toBeGreaterThan(0);
  });

  it("grows fewer buildings at the top rate than at zero, and takes no charge at zero, on a zone building many a day (scenario test)", () => {
    // Residential at a bar of 40: twenty houses a day at zero, eight at the top, over one game day.
    const zero = grown("residential", 1, RESIDENTIAL, 40, 0, 1);
    const top = grown("residential", 1, RESIDENTIAL, 40, ECONOMY.developmentCharges.residential.max, 1);
    expect(zero.charges).toBe(0);
    expect(top.charges).toBeGreaterThan(0);
    expect(zero.buildings).toBeGreaterThan(15);
    expect(top.buildings).toBeLessThan(zero.buildings * 0.6);
  });
});

describe("a city that sets its charges as it grows", () => {
  /** A street zoned R1 from the stub, grown on the pull from outside, with the residential charge raised mid-day and lowered on a later one. */
  function session(): SimState {
    const { state } = zonedStreet("residential", 1);
    while (state.tick < 5 * DAY + DAY / 2) step(state);
    ok(state, "SetDevelopmentCharge", { zone: "residential", rate: ECONOMY.developmentCharges.residential.max });
    while (state.tick < 9 * DAY + 37) step(state);
    ok(state, "SetDevelopmentCharge", { zone: "residential", rate: 0 });
    while (state.tick < 14 * DAY) step(state);
    return state;
  }

  it("replays its log to the same city, and hashes the same saved and loaded mid-day", () => {
    const live = session();
    expect(live.log.filter((e) => e.type === "SetDevelopmentCharge")).toHaveLength(2);
    expect(charged(live, RESIDENTIAL) + (live.budget.lastMonth[LINE.chargeResidential] ?? 0)).toBeGreaterThan(0);
    expect(hashState(replay(SEED, live.log, live.tick))).toBe(hashState(live));
    // Saved and loaded at a tick between the two commands, mid-day, it steps on to the same city.
    let state = createState(SEED);
    let next = 0;
    while (state.tick < live.tick) {
      if (state.tick === 7 * DAY + 41) state = deserialize(serialize(state)).state;
      for (let e = live.log[next]; e && e.tick <= state.tick; e = live.log[++next]) enqueue(state, e);
      step(state);
    }
    expect(hashState(state)).toBe(hashState(live));
  });
});
