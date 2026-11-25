import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  ECONOMY,
  ROAD_BALANCE,
  ZONING_BALANCE,
  buildingInfo,
  cellAt,
  checkEconomyBalance,
  createState,
  findLot,
  floorSpaceOf,
  jobsForLot,
  propertyValue,
  propertyValueOf,
  resolveEconomy,
  step,
  submit,
  type BuildingType,
  type Command,
  type SimState,
} from "../src/index";
import economyJson from "../balance/economy.json" with { type: "json" };
import { BALANCE_FILES } from "../src/balance-stamp";
import { BUILDING_ABANDONED, addBuilding, removeBuilding } from "../src/buildings/buildings";
import { buildingValue } from "../src/landvalue/land-value";

// M4-01: the economy's balance file and what a building is worth in dollars.

const CELL = ZONING_BALANCE.cellSize;

const type = (id: string): BuildingType => {
  const t = BUILDING_TYPES.find((x) => x.id === id);
  if (!t) throw new Error(`no type ${id}`);
  return t;
};

type Json = Record<string, unknown>;

const copy = (): Json => JSON.parse(JSON.stringify(economyJson)) as Json;

/** The object at `path` inside `data`, to change one field of a copy. */
const at = (data: Json, ...path: string[]): Json => path.reduce((o, key) => o[key] as Json, data);

/** A building of `id` on a `width` × `depth` lot with room for `residents`, and the jobs its lot gives. */
const valueOf = (id: string, width: number, depth: number, residents: number, landValue: number): number => {
  const t = type(id);
  return propertyValueOf(t, residents, jobsForLot(t, width, depth), landValue);
};

describe("economy.json", () => {
  it("loads, is checked, and is in the balance stamp", () => {
    expect(checkEconomyBalance(economyJson)).toEqual([]);
    expect(BALANCE_FILES["economy"]).toBe(economyJson);
  });

  it("names a missing field", () => {
    const data = copy();
    delete data["overdraft"];
    delete at(data, "floorSpace")["perResident"];
    const errors = checkEconomyBalance(data);
    expect(errors).toContain("overdraft is missing");
    expect(errors).toContain("floorSpace.perResident must be a positive number of square metres");
    expect(() => resolveEconomy(data)).toThrow(/balance\/economy\.json: .*overdraft is missing/);
  });

  it("names a price with no source year, or no source", () => {
    const data = copy();
    delete at(data, "value", "perSquareMetre", "office")["sourceYear"];
    delete at(data, "eminentDomain", "relocationPerJob")["source"];
    const errors = checkEconomyBalance(data);
    expect(errors).toContain("value.perSquareMetre.office.sourceYear is missing");
    expect(errors).toContain("eminentDomain.relocationPerJob.source is missing");
  });

  it("names a rate or a charge outside its range", () => {
    const data = copy();
    at(data, "taxRates", "residential")["default"] = 0.05;
    at(data, "developmentCharges", "office")["amount"] = 1000;
    at(data, "taxRates", "commercial")["max"] = 1.5;
    const errors = checkEconomyBalance(data);
    expect(errors).toContain("taxRates.residential.default 0.05 is outside its range 0 to 0.03");
    expect(errors).toContain("developmentCharges.office.amount 1000 is outside its range 0 to 450");
    expect(errors).toContain("taxRates.commercial.max must be a rate from 0 to 1");
  });

  it("names an unknown field, a source year after 2026 and an index it does not know", () => {
    const data = copy();
    at(data, "startingGrant")["amonut"] = 5;
    at(data, "overdraft")["sourceYear"] = 2030;
    at(data, "overdraft")["index"] = "housing";
    const errors = checkEconomyBalance(data);
    expect(errors).toContain('startingGrant has an unknown field "amonut"');
    expect(errors).toContain("overdraft.sourceYear is after 2026");
    expect(errors).toContain('overdraft.index must be "construction" or "general"');
  });

  it("raises construction prices by roads.json's index and the rest by the general one, to whole dollars", () => {
    const data = copy();
    at(data, "eminentDomain")["demolitionPerSquareMetre"] = { amount: 100, sourceYear: 2024, index: "construction", source: "A test." };
    at(data, "eminentDomain")["relocationPerJob"] = { amount: 100, sourceYear: 2024, index: "general", source: "A test." };
    const e = resolveEconomy(data);
    const road = ROAD_BALANCE.escalation.annualFactor;
    const general = at(data, "generalEscalation")["annualFactor"] as number;
    expect(e.eminentDomain.demolitionPerSquareMetre).toBe(Math.floor(100 * road * road + 0.5));
    expect(e.eminentDomain.relocationPerJob).toBe(Math.floor(100 * general * general + 0.5));
    for (const n of [e.startingGrant, e.overdraft, e.eminentDomain.relocationPerResident, ...Object.values(e.value.perSquareMetre)]) {
      expect(Number.isSafeInteger(n)).toBe(true);
    }
  });
});

describe("a building's value", () => {
  const LV = ECONOMY.value.landValueReference;

  it("prices a house, a plex, a tower, a corner store and a factory from a known land value", () => {
    const v = ECONOMY.value.perSquareMetre;
    const per = ECONOMY.floorSpace;
    // At the reference land value a square metre is worth its price.
    expect(valueOf("single-family-home", 2, 3, 4, LV)).toBe(4 * per.perResident * v.residential);
    expect(valueOf("plex", 3, 4, 12, LV)).toBe(12 * per.perResident * v.residential);
    expect(valueOf("high-tower", 6, 6, 1000, LV)).toBe(1000 * per.perResident * v.residential);
    // A corner store on 1 x 1 has one job; a small factory on 4 x 4 has five.
    expect(valueOf("corner-store", 1, 1, 0, LV)).toBe(per.perJob.commercial * v.commercial);
    expect(valueOf("small-factory", 4, 4, 0, LV)).toBe(5 * per.perJob.industrial * v.industrial);
  });

  it("rises with land value and with floor space", () => {
    for (const [id, w, d, r] of [
      ["single-family-home", 2, 3, 4],
      ["plex", 3, 4, 12],
      ["high-tower", 6, 6, 1000],
      ["corner-store", 1, 1, 0],
      ["small-factory", 4, 4, 0],
    ] as const) {
      let last = -1;
      for (const lv of [0, 20, 50, 80, 100]) {
        const value = valueOf(id, w, d, r, lv);
        expect(value, `${id} at ${lv}`).toBeGreaterThan(last);
        last = value;
      }
    }
    expect(valueOf("plex", 3, 5, 16, LV)).toBeGreaterThan(valueOf("plex", 3, 3, 8, LV));
    expect(valueOf("small-factory", 4, 4, 0, LV)).toBeGreaterThan(valueOf("small-factory", 3, 2, 0, LV));
    // A tower holds hundreds of people, so it is worth many houses on far less ground a resident.
    expect(valueOf("high-tower", 6, 6, 1000, LV) / 36).toBeGreaterThan(20 * (valueOf("single-family-home", 2, 3, 4, LV) / 6));
  });

  it("adds a mixed building's homes and its shops", () => {
    const t = type("shop-top-row");
    const jobs = jobsForLot(t, 3, 2);
    const space = floorSpaceOf(t, 10, jobs);
    expect(space.homes).toBe(10 * ECONOMY.floorSpace.perResident);
    expect(space.jobs.commercial).toBe(jobs * ECONOMY.floorSpace.perJob.commercial);
    expect(space.total).toBe(space.homes + space.jobs.commercial);
    const v = ECONOMY.value.perSquareMetre;
    expect(propertyValueOf(t, 10, jobs, LV)).toBe(space.homes * v.residential + space.jobs.commercial * v.commercial);
  });

  it("is whole dollars, never below zero", () => {
    for (const lv of [0, 1, 33, 67, 99, 100]) {
      const value = valueOf("restaurant", 2, 3, 0, lv);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("shows in buildingInfo for a building in state, from the land value at its lot", () => {
    let seq = 0;
    const send = (state: SimState, t: string, payload: unknown): void => {
      const c: Command = { seq: ++seq, playerId: "p1", type: t, payload };
      expect(submit(state, c)).toEqual({ ok: true });
      step(state);
    };
    // Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000) (build-road.test.ts).
    const state = createState(2026);
    send(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
    const z = 4595 - CELL / 2;
    send(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: z - CELL }, to: { x: 4246, z: z - CELL }, width: 3 * CELL }] });
    const cell = cellAt(state, 4200 + CELL / 2, z);
    if (!cell) throw new Error("no cell");
    const found = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth });
    if (!found.ok) throw new Error(found.reason);
    const id = addBuilding(state, { ...found.lot, residents: 4, variant: 0 });
    const t = BUILDING_TYPES[found.lot.type];
    const info = buildingInfo(state, id);
    if (!info || !t) throw new Error("no building");
    const land = buildingValue(state, id);
    expect(land).toBeGreaterThan(0);
    expect(info.value).toBe(propertyValueOf(t, 4, info.jobs, land));
    expect(propertyValue(state, id)).toBe(info.value);
    // Abandoned, it keeps the value of what was built: its readers decide what that means.
    state.buildings.flags[id] = (state.buildings.flags[id] ?? 0) | BUILDING_ABANDONED;
    expect(propertyValue(state, id)).toBe(info.value);
    removeBuilding(state, id);
    expect(propertyValue(state, id)).toBe(0);
  });
});

describe("the economy as the sim reads it", () => {
  it("is frozen, so nothing writes a balance number by mistake", () => {
    expect(Object.isFrozen(ECONOMY)).toBe(true);
    expect(Object.isFrozen(ECONOMY.taxRates.residential)).toBe(true);
    expect(() => {
      (ECONOMY.taxRates.residential as { default: number }).default = 0.5;
    }).toThrow(TypeError);
  });
});
