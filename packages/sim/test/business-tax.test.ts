import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  ECONOMY,
  LINE,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingTaxByLine,
  buildingTaxPerYear,
  businessTaxOf,
  collectTax,
  connectionEnd,
  createState,
  hashState,
  jobsFilled,
  shopSalesScale,
  spendingPower,
  step,
  type BuildingType,
  type BusinessTaxTerms,
  type Command,
  type SimState,
} from "../src/index";
import { buildingIdLimit } from "../src/buildings/buildings";
import { kindsOf, zeroTotals } from "../src/stats/stats";
import { submit } from "./seen-ends";
import { holdDemand } from "./demand-helper";
import { yearDays } from "../src/calendar";
import jobsJson from "./fixtures/replay/jobs.json";
import { replayFixture, type ReplayFixture } from "./replay-helper";
import { withValue } from "./with-value";

// Issue M4-06: shops, offices and factories pay tax on what they do, which
// in M4 follows their jobs filled.

const DAY = TIME_BALANCE.ticksPerDay;
const CELL = ZONING_BALANCE.cellSize;
const RATES: [number, number, number, number] = [ECONOMY.taxRates.residential.default, ECONOMY.taxRates.commercial.default, ECONOMY.taxRates.office.default, ECONOMY.taxRates.industrial.default];
const [, C, O, I] = [0, 1, 2, 3] as const;
const SALES = ECONOMY.business.salesPerJob;
const OFFICE_OUTPUT = ECONOMY.business.outputPerJob.office;
const FACTORY_OUTPUT = ECONOMY.business.outputPerJob.industrial;

const type = (id: string): BuildingType => {
  const t = BUILDING_TYPES.find((x) => x.id === id);
  if (!t) throw new Error(`no type ${id}`);
  return t;
};

const terms = (over: Partial<BusinessTaxTerms> = {}): BusinessTaxTerms => ({ rates: RATES, salesScale: 1, reachesOutside: true, ...over });
const none = { commercial: 0, office: 0, industrial: 0 };

describe("a business's yearly tax", () => {
  it("gives a shop, an office and a factory their rate times what their jobs filled sell or make", () => {
    expect(businessTaxOf(type("corner-store"), { ...none, commercial: 2 }, terms())).toEqual([0, Math.floor(2 * SALES * RATES[C]), 0, 0]);
    const office = BUILDING_TYPES.find((t) => t.zone === "office" && t.density === 1) as BuildingType;
    expect(businessTaxOf(office, { ...none, office: 10 }, terms())).toEqual([0, 0, Math.floor(10 * OFFICE_OUTPUT * RATES[O]), 0]);
    const factory = BUILDING_TYPES.find((t) => t.zone === "industrial" && t.density === 1) as BuildingType;
    expect(businessTaxOf(factory, { ...none, industrial: 10 }, terms())).toEqual([0, 0, 0, Math.floor(10 * FACTORY_OUTPUT * RATES[I])]);
    // Twice the rate, twice the tax; a zero rate, nothing.
    expect(businessTaxOf(factory, { ...none, industrial: 10 }, terms({ rates: [0, 0, 0, 2 * RATES[I]] }))[I]).toBe(Math.floor(10 * FACTORY_OUTPUT * 2 * RATES[I]));
    expect(businessTaxOf(office, { ...none, office: 10 }, terms({ rates: [0, 0, 0, 0] }))).toEqual([0, 0, 0, 0]);
  });

  it("is nothing for a workplace nobody works in", () => {
    expect(businessTaxOf(type("corner-store"), none, terms())).toEqual([0, 0, 0, 0]);
  });

  it("charges a factory nothing while its road does not reach outside, and a shop or office the same either way", () => {
    const factory = BUILDING_TYPES.find((t) => t.zone === "industrial") as BuildingType;
    expect(businessTaxOf(factory, { ...none, industrial: 10 }, terms({ reachesOutside: false }))).toEqual([0, 0, 0, 0]);
    const store = type("corner-store");
    expect(businessTaxOf(store, { ...none, commercial: 2 }, terms({ reachesOutside: false }))).toEqual(businessTaxOf(store, { ...none, commercial: 2 }, terms()));
  });

  it("scales a shop's sales by the city's sales scale, and nothing else", () => {
    const store = type("corner-store");
    expect(businessTaxOf(store, { ...none, commercial: 2 }, terms({ salesScale: 0.5 }))[C]).toBe(Math.floor(2 * SALES * 0.5 * RATES[C]));
    const office = BUILDING_TYPES.find((t) => t.zone === "office") as BuildingType;
    expect(businessTaxOf(office, { ...none, office: 10 }, terms({ salesScale: 0.5 }))[O]).toBe(Math.floor(10 * OFFICE_OUTPUT * RATES[O]));
  });

  it("charges a mixed building the commercial rate on all its jobs, onto the commercial line", () => {
    const mixed3 = BUILDING_TYPES.find((t) => t.zone === "mixed" && t.density === 3) as BuildingType;
    const out = businessTaxOf(mixed3, { ...none, commercial: 4, office: 4 }, terms());
    expect(out).toEqual([0, Math.floor((4 * SALES + 4 * OFFICE_OUTPUT) * RATES[C]), 0, 0]);
  });
});

describe("the shop sales scale", () => {
  const wealthy = (residents: number, filled: number) => ({ ...zeroTotals(), residentsWealthMedium: residents, filledCommercial: filled });

  it("is 1 while spending power keeps every shop job filled busy, and their ratio once there are more", () => {
    const supported = spendingPower(wealthy(1000, 0)) * DEMAND_BALANCE.shopJobsPerSpending;
    expect(supported).toBeGreaterThan(0);
    expect(shopSalesScale(wealthy(1000, 0))).toBe(1);
    expect(shopSalesScale(wealthy(1000, Math.floor(supported)))).toBe(1);
    expect(shopSalesScale(wealthy(1000, 4 * supported))).toBeCloseTo(0.25, 12);
    expect(shopSalesScale(wealthy(0, 10))).toBe(0);
  });
});

// --- In a town -------------------------------------------------------------------

const fixture = jobsJson as ReplayFixture;

/** The live buildings of `state` with jobs filled, by zone of their type. */
function workplaces(state: SimState, zone: string): number[] {
  const out: number[] = [];
  for (let id = 0; id < buildingIdLimit(state.buildings); id++) {
    if (!state.buildings.flags[id] || jobsFilled(state, id) <= 0) continue;
    if (BUILDING_TYPES[state.buildings.type[id] ?? 0]?.zone === zone) out.push(id);
  }
  return out;
}

/**
 * Runs the tax sweep over one whole day from the next day's first tick,
 * without stepping anything else, then puts the tick back so the city
 * steps on from where it was. Returns what each tax line gained.
 */
function sweepDay(state: SimState): number[] {
  const before = [...state.budget.month.slice(LINE.taxResidential, LINE.taxIndustrial + 1)];
  const tick = state.tick;
  state.tick = Math.ceil(tick / DAY) * DAY;
  for (let k = 0; k < DAY; k++) {
    collectTax(state);
    state.tick += 1;
  }
  state.tick = tick;
  return before.map((was, i) => (state.budget.month[LINE.taxResidential + i] as number) - was);
}

describe("business tax in the jobs town", () => {
  const state = replayFixture(fixture);

  it("charges each shop, office and factory people work in the business tax its jobs filled give, by line", () => {
    for (const [zone, line] of [["commercial", C], ["office", O], ["industrial", I]] as const) {
      const ids = workplaces(state, zone);
      expect(ids.length, zone).toBeGreaterThan(0);
      for (const id of ids) {
        const by = buildingTaxByLine(state, id);
        expect(by[line], `${zone} ${id}`).toBeGreaterThan(0);
        expect(buildingTaxPerYear(state, id)).toBe(by[0] + by[1] + by[2] + by[3]);
      }
    }
  });

  it("reads the jobs filled from the caller when given, as a client's copy with no pop rows passes them (M4-16)", () => {
    const ids = [...workplaces(state, "commercial"), ...workplaces(state, "office"), ...workplaces(state, "industrial")];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      // The same counts the sim reads give the same tax.
      expect(buildingTaxPerYear(state, id, (b) => jobsFilled(state, b))).toBe(buildingTaxPerYear(state, id));
      expect(buildingTaxByLine(state, id, [0, 0, 0, 0], (b) => jobsFilled(state, b))).toEqual(buildingTaxByLine(state, id));
      // Nobody at work: no business tax.
      const idle = buildingTaxByLine(state, id, [0, 0, 0, 0], () => 0);
      expect(idle[C] + idle[O] + idle[I]).toBe(0);
    }
  });

  it("files a day of sweeping on each business line as the sum of each workplace's daily shares", () => {
    const copy = replayFixture(fixture);
    const days = yearDays();
    const day = Math.ceil(copy.tick / DAY) % days;
    const expected = [0, 0, 0, 0];
    for (let id = 0; id < buildingIdLimit(copy.buildings); id++) {
      const by = buildingTaxByLine(copy, id);
      for (let line = 1; line < 4; line++) {
        const y = by[line] as number;
        expected[line] = (expected[line] as number) + Math.floor((y * (day + 1)) / days) - Math.floor((y * day) / days);
      }
    }
    const gained = sweepDay(copy);
    for (let line = 1; line < 4; line++) expect(gained[line], `line ${line}`).toBe(expected[line]);
    expect((gained[C] ?? 0) + (gained[O] ?? 0) + (gained[I] ?? 0)).toBeGreaterThan(0);
  });

  it("scales each shop's sales down when the city has more shop jobs filled than spending power keeps busy", () => {
    const shops = workplaces(state, "commercial");
    const full = shops.map((id) => buildingTaxByLine(state, id)[C]);
    const others = [...workplaces(state, "office"), ...workplaces(state, "industrial")];
    expect(others.length).toBeGreaterThan(0);
    const othersFull = others.map((id) => buildingTaxByLine(state, id));
    expect(shopSalesScale(state.stats.totals)).toBe(1);
    // A tenth of the shop jobs filled are kept busy.
    const supported = (state.stats.totals["filledCommercial"] ?? 0) / 10;
    const per = supported / spendingPower(state.stats.totals);
    withValue(DEMAND_BALANCE, "shopJobsPerSpending", per, () => {
      const scale = shopSalesScale(state.stats.totals);
      expect(scale).toBeCloseTo(0.1, 9);
      shops.forEach((id, i) => {
        const filled = kindsOf(state.buildings.type[id] ?? 0, jobsFilled(state, id))?.commercial ?? 0;
        const scaled = buildingTaxByLine(state, id)[C];
        expect(scaled).toBe(Math.floor(filled * SALES * scale * RATES[C]));
        expect(scaled).toBeLessThan(full[i] as number);
      });
      // Offices and factories do not sell to residents, so they pay the same.
      others.forEach((id, i) => expect(buildingTaxByLine(state, id)).toEqual(othersFull[i]));
    });
  });

  it("replays to the same hash, with business tax collected on every business line", () => {
    const a = replayFixture(fixture);
    const b = replayFixture(fixture);
    expect(hashState(a)).toBe(hashState(b));
    for (const line of [LINE.taxCommercial, LINE.taxOffice, LINE.taxIndustrial]) {
      expect((a.budget.month[line] as number) + (a.budget.lastMonth[line] as number), `line ${line}`).toBeGreaterThan(0);
    }
  });

});

// --- A factory cut off from the outside ---------------------------------------------

let seq = 0;
function ok(state: SimState, kind: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type: kind, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

/**
 * A street from the first outside connection, empty for its first ten
 * places, then homes on both sides and factories past them, grown with the
 * residential and industrial bars held full. Returns the town, the street's
 * direction, and its start.
 */
function factoryTown(): { state: SimState; x: number; z: number; dx: number; dz: number } {
  const state = createState(2026);
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const x = r.nodeX[inner] ?? 0;
  const z = r.nodeZ[inner] ?? 0;
  ok(state, "BuildRoad", { from: { x, z }, to: { x: x + dx * CELL * 40, z: z + dz * CELL * 40 }, type: "street" });
  const zone = (zoneId: string, p0: number, width: number, depth: number, side: 1 | -1) => {
    const off = side * (5 + (CELL * depth) / 2);
    const nx = -dz * off;
    const nz = dx * off;
    const a = CELL * p0 + 2;
    const b = CELL * (p0 + width) - 2;
    ok(state, "ZoneCells", { zone: zoneId, density: 1, rects: [{ from: { x: x + dx * a + nx, z: z + dz * a + nz }, to: { x: x + dx * b + nx, z: z + dz * b + nz }, width: CELL * depth - 4 }] });
  };
  zone("residential", 12, 12, 4, 1);
  zone("residential", 12, 12, 4, -1);
  zone("industrial", 26, 10, 4, 1);
  holdDemand({ residential: 100, industrial: 100 }, () =>
    withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
      for (let k = 0; k < 10 * DAY; k++) step(state);
    }),
  );
  return { state, x, z, dx, dz };
}

describe("a factory cut off from the outside", () => {
  it("pays no industrial tax while its road does not reach an outside connection, and pays again once it does", () => {
    const { state, x, z, dx, dz } = factoryTown();
    const factories = workplaces(state, "industrial");
    expect(factories.length).toBeGreaterThan(0);
    const yearly = factories.map((id) => buildingTaxByLine(state, id)[I]);
    for (const y of yearly) expect(y).toBeGreaterThan(0);
    expect(sweepDay(state)[I]).toBeGreaterThan(0);

    // A side street at place 6 splits the empty stretch; bulldozing the piece from the stub to it cuts the town off.
    const at = { x: x + dx * CELL * 6, z: z + dz * CELL * 6 };
    ok(state, "BuildRoad", { from: at, to: { x: at.x - dz * 60, z: at.z + dx * 60 }, type: "street" });
    const r = state.roads;
    const inner = connectionEnd(r, state.connections[0] ?? NONE);
    let cut = NONE;
    for (let seg = 0; seg < r.segFlags.length; seg++) {
      if (!r.segFlags[seg]) continue;
      const a = r.segA[seg] ?? NONE;
      const b = r.segB[seg] ?? NONE;
      const other = a === inner ? b : b === inner ? a : NONE;
      if (other === NONE) continue;
      if (Math.abs((r.nodeX[other] ?? 0) - at.x) < 1 && Math.abs((r.nodeZ[other] ?? 0) - at.z) < 1) cut = seg;
    }
    expect(cut).not.toBe(NONE);
    ok(state, "BulldozeRoad", { segments: [cut] });

    const still = factories.filter((id) => state.buildings.flags[id] && jobsFilled(state, id) > 0);
    expect(still.length).toBeGreaterThan(0);
    for (const id of still) expect(buildingTaxByLine(state, id)[I], `factory ${id}`).toBe(0);
    expect(sweepDay(state)[I]).toBe(0);

    // Joined again: the factories pay from their next visit.
    ok(state, "Undo", {});
    const back = factories.filter((id) => state.buildings.flags[id] && jobsFilled(state, id) > 0);
    expect(back.length).toBeGreaterThan(0);
    for (const id of back) expect(buildingTaxByLine(state, id)[I], `factory ${id}`).toBeGreaterThan(0);
    expect(sweepDay(state)[I]).toBeGreaterThan(0);
  });
});
