// Tax rates (M4-07, PRD "M4 Economy" and "Satisfaction"): the player sets
// four rates, each is a part of its zone's demand bar, and the residential
// rate weighs on every pop's satisfaction, more on a wealthy one.

import { describe, expect, it } from "vitest";
import {
  DEMAND_BALANCE,
  DEMAND_BARS,
  DEMAND_PARTS,
  ECONOMY,
  ECONOMY_SLIDERS,
  LINE,
  POPS_BALANCE,
  POP_ALIVE,
  TIME_BALANCE,
  createDemand,
  createState,
  demandPull,
  demandTargets,
  deserialize,
  hashState,
  jobTarget,
  moveDemand,
  replay,
  replayFrom,
  satisfactionTarget,
  serialize,
  step,
  submit,
  taxLosses,
  taxPressure,
  validateCommand,
  type Command,
  type DemandBar,
  type EconomySlider,
  type SimState,
  type StatTotals,
} from "../src/index";
import { holdDemand, type HeldBars } from "./demand-helper";
import jobsJson from "./fixtures/replay/jobs.json";
import { fixtureStart, replayFixture, type ReplayFixture } from "./replay-helper";

const SEED = 2026;
const DAY = TIME_BALANCE.ticksPerDay;

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

/** Submits `type`, steps until it applies, and checks it was logged with its player. */
function ok(state: SimState, type: string, payload: unknown): void {
  const c = command(type, payload);
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  while (state.pending.length > 0) step(state);
  const entry = state.log.at(-1);
  expect(entry?.seq, `${c.type} should apply`).toBe(c.seq);
  expect(entry?.playerId).toBe("p1");
}

/** Every rate at its default but `slider`'s, at `rate`. */
function ratesWith(slider: EconomySlider, rate: number): Float64Array {
  const rates = Float64Array.from(ECONOMY_SLIDERS, (s) => ECONOMY.taxRates[s].default);
  rates[ECONOMY_SLIDERS.indexOf(slider)] = rate;
  return rates;
}

/** The bar each slider's rate is a part of. */
const BAR_OF: Record<EconomySlider, DemandBar> = { residential: "residential", commercial: "commercial", office: "office", industrial: "industrial" };

/** A middling town's totals, so every bar has parts above and below zero to add to. */
const TOTALS: StatTotals = {
  population: 2000,
  workersEmployed: 900,
  workersUnemployed: 100,
  jobsCommercial: 200,
  filledCommercial: 150,
  jobsOffice: 100,
  filledOffice: 80,
  jobsIndustrial: 150,
  filledIndustrial: 120,
  residentsEducationLow: 800,
  residentsEducationMedium: 800,
  residentsEducationHigh: 400,
  residentsWealthLow: 800,
  residentsWealthMedium: 800,
  residentsWealthHigh: 400,
  residentSatisfaction: 2000 * 60,
};

describe("the tax part of each demand bar", () => {
  it("reads 0 at the default rate, below zero above it and above zero below it, for each of the four rates", () => {
    for (const slider of ECONOMY_SLIDERS) {
      const bar = BAR_OF[slider];
      const { min, max, default: d } = ECONOMY.taxRates[slider];
      const at = (rate: number) => demandTargets({ totals: TOTALS, segmentsOutside: 1, highestPopulation: 2000, taxRates: ratesWith(slider, rate) })[bar]["tax"] ?? NaN;
      expect(Object.is(at(d), 0), `${slider} at its default`).toBe(true);
      expect(at(max), `${slider} at the top`).toBeLessThan(0);
      expect(at(min), `${slider} at the bottom`).toBeGreaterThan(0);
      // At the top of the range the part is the bar's whole weight.
      expect(at(max)).toBeCloseTo((DEMAND_BALANCE[bar] as { tax: number }).tax, 12);
      // The other bars' tax parts stay at 0.
      for (const other of DEMAND_BARS) if (other !== bar) expect(demandTargets({ totals: TOTALS, segmentsOutside: 1, taxRates: ratesWith(slider, max) })[other]["tax"]).toBe(0);
    }
  });

  it("leaves every bar where M3 put it at the default rates", () => {
    const without = demandTargets({ totals: TOTALS, segmentsOutside: 1, highestPopulation: 2000 });
    const atDefaults = demandTargets({ totals: TOTALS, segmentsOutside: 1, highestPopulation: 2000, taxRates: createState(SEED).budget.taxRates });
    expect(atDefaults).toEqual(without);
    for (const bar of DEMAND_BARS) expect(atDefaults[bar]["tax"]).toBe(0);
  });

  it("is one of the parts the bar adds up to, and one the systems that act on demand read", () => {
    for (const slider of ECONOMY_SLIDERS) {
      const bar = BAR_OF[slider];
      for (const rate of [ECONOMY.taxRates[slider].min, ECONOMY.taxRates[slider].max]) {
        const demand = createDemand();
        moveDemand(demand, demandTargets({ totals: TOTALS, segmentsOutside: 1, taxRates: ratesWith(slider, rate) }), 1);
        const parts = DEMAND_PARTS[bar].map((name) => demand[bar].parts[name] ?? 0);
        expect(demand[bar].value).toBeCloseTo(parts.reduce((a, b) => a + b, 0), 12);
        const atDefault = createDemand();
        moveDemand(atDefault, demandTargets({ totals: TOTALS, segmentsOutside: 1 }), 1);
        // The pull moves with the tax part, the way the bar does.
        expect(demandPull(demand, bar) - demandPull(atDefault, bar)).toBeCloseTo((demand[bar].parts["tax"] ?? 0) - 0, 9);
      }
    }
  });

  it("is taken away with the rest while industry has no road out, so a low rate builds no factory without one", () => {
    const targets = demandTargets({ totals: TOTALS, segmentsOutside: 0, taxRates: ratesWith("industrial", 0) });
    expect(targets.industrial["tax"]).toBeGreaterThan(0);
    const sum = DEMAND_PARTS.industrial.reduce((a, name) => a + (targets.industrial[name] ?? 0), 0);
    expect(sum).toBeCloseTo(0, 12);
  });

  it("moves each bar's tax part in a city once its rate is set, and the parts still add up to the bar", () => {
    for (const slider of ECONOMY_SLIDERS) {
      const bar = BAR_OF[slider];
      const high = createState(SEED);
      const low = createState(SEED);
      ok(high, "SetTaxRate", { zone: slider, rate: ECONOMY.taxRates[slider].max });
      ok(low, "SetTaxRate", { zone: slider, rate: ECONOMY.taxRates[slider].min });
      for (const state of [high, low]) while (state.tick < 3 * DAY + 1) step(state);
      expect(high.demand[bar].parts["tax"]).toBeLessThan(0);
      expect(low.demand[bar].parts["tax"]).toBeGreaterThan(0);
      for (const state of [high, low]) {
        for (const b of DEMAND_BARS) {
          const sum = DEMAND_PARTS[b].reduce((a, name) => a + (state.demand[b].parts[name] ?? 0), 0);
          expect(state.demand[b].value).toBeCloseTo(sum, 12);
          if (b !== bar) expect(state.demand[b].parts["tax"]).toBe(0);
        }
      }
    }
  });
});

describe("SetTaxRate", () => {
  it("sets one rate, leaves the others, and is logged with its player", () => {
    const state = createState(SEED);
    const was = Array.from(state.budget.taxRates);
    const rate = ECONOMY.taxRates.office.max;
    ok(state, "SetTaxRate", { zone: "office", rate });
    const office = ECONOMY_SLIDERS.indexOf("office");
    expect(state.budget.taxRates[office]).toBe(rate);
    expect(Array.from(state.budget.taxRates).filter((_, i) => i !== office)).toEqual(was.filter((_, i) => i !== office));
    expect(state.log.at(-1)?.type).toBe("SetTaxRate");
    // -0 is stored as 0, as a JSON log would carry it, so the hash agrees.
    ok(state, "SetTaxRate", { zone: "office", rate: -0 });
    expect(Object.is(state.budget.taxRates[office], 0)).toBe(true);
  });

  it("refuses a rate outside the range in economy.json with a reason, and a zone or rate it does not know", () => {
    const state = createState(SEED);
    const { min, max } = ECONOMY.taxRates.commercial;
    expect(validateCommand(state, command("SetTaxRate", { zone: "commercial", rate: max }))).toEqual({ ok: true });
    expect(validateCommand(state, command("SetTaxRate", { zone: "commercial", rate: min }))).toEqual({ ok: true });
    expect(validateCommand(state, command("SetTaxRate", { zone: "commercial", rate: (min + max) / 3 }))).toEqual({ ok: true });
    expect(validateCommand(state, command("SetTaxRate", { zone: "commercial", rate: max + 0.001 }))).toEqual({
      ok: false,
      reason: `The commercial tax rate runs from ${min * 100}% to ${max * 100}%`,
    });
    const refused = (payload: unknown) => validateCommand(state, command("SetTaxRate", payload)).ok;
    expect(refused({ zone: "commercial", rate: min - 0.001 })).toBe(false);
    expect(refused({ zone: "commercial", rate: Number.NaN })).toBe(false);
    expect(refused({ zone: "commercial", rate: "0.01" })).toBe(false);
    expect(refused({ zone: "mixed", rate: 0.01 })).toBe(false);
    expect(refused({ zone: "commercial" })).toBe(false);
    expect(refused(null)).toBe(false);
    // A refused command changes nothing and is not logged.
    const before = hashState(state);
    expect(submit(state, command("SetTaxRate", { zone: "industrial", rate: 1 })).ok).toBe(false);
    expect(hashState(state)).toBe(before);
  });

  it("replays to the same state hash, and a save between two changes loads to the same city", () => {
    const state = createState(SEED);
    ok(state, "SetTaxRate", { zone: "residential", rate: ECONOMY.taxRates.residential.max });
    while (state.tick < 2 * DAY + 50) step(state);
    const saved = serialize(state);
    ok(state, "SetTaxRate", { zone: "industrial", rate: 0 });
    while (state.tick < 4 * DAY) step(state);
    const loaded = deserialize(saved).state;
    // The loaded city gets the second change on the same tick.
    const second = state.log.at(-1);
    if (!second) throw new Error("no second command");
    expect(submit(loaded, { seq: second.seq, playerId: second.playerId, type: second.type, payload: second.payload })).toEqual({ ok: true });
    while (loaded.tick < 4 * DAY) step(loaded);
    expect(hashState(loaded)).toBe(hashState(state));
    const again = replay(SEED, state.log, state.tick);
    expect(hashState(again)).toBe(hashState(state));
  });
});

describe("the residential rate and satisfaction", () => {
  it("takes more off a wealthy pop's target than a poor one's, nothing at the default, and adds below it", () => {
    const { min, max, default: d } = ECONOMY.taxRates.residential;
    expect(taxLosses(d)).toEqual([0, 0, 0]);
    const [low, medium, high] = taxLosses(max);
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeCloseTo(POPS_BALANCE.satisfaction.taxByWealth.high * taxPressure("residential", max), 12);
    for (const loss of taxLosses(min)) expect(loss).toBeLessThan(0);
  });

  it("lowers a wealthy pop's score more than a poor one's for the same rate", () => {
    const fixture = jobsJson as ReplayFixture;
    const v = fixture.heldDemand ?? 60;
    const bars: HeldBars = { residential: v, commercial: v, office: v, industrial: v };
    const town = replayFixture(fixture);
    // A pop in work at its own level, with a score near its target.
    const p = town.pops;
    let id = -1;
    for (let i = 0; i < p.flags.length; i++) {
      if (((p.flags[i] ?? 0) & POP_ALIVE) === 0) continue;
      if (jobTarget(town, i) === POPS_BALANCE.satisfaction.target.fittingJob && (p.satisfaction[i] ?? 0) >= 60) {
        id = i;
        break;
      }
    }
    expect(id).toBeGreaterThanOrEqual(0);
    const run = (wealth: number): number => {
      const state = structuredClone(town);
      state.pops.wealth[id] = wealth;
      const before = state.pops.satisfaction[id] ?? 0;
      expect(submit(state, command("SetTaxRate", { zone: "residential", rate: ECONOMY.taxRates.residential.max })).ok).toBe(true);
      holdDemand(bars, () => {
        const until = state.tick + 10 * DAY;
        while (state.tick < until) step(state);
      });
      expect((state.pops.flags[id] ?? 0) & POP_ALIVE, "the pop is still in the city").not.toBe(0);
      expect(satisfactionTarget(state, id)).toBe(jobTarget(state, id) - Math.round(taxLosses(ECONOMY.taxRates.residential.max)[wealth] ?? 0));
      return before - (state.pops.satisfaction[id] ?? 0);
    };
    const poor = run(0);
    const rich = run(2);
    expect(poor).toBeGreaterThan(0);
    expect(rich).toBeGreaterThan(poor);
  });
});

describe("a higher residential rate in a growing town", () => {
  it("slows arrivals and raises the tax each resident pays", () => {
    // The job matching fixture's town with its bars free: by day 3 houses
    // are growing beside its shops, offices and factories and people moving
    // in, and it fills over the next two weeks.
    const fixture = jobsJson as ReplayFixture;
    const town = replayFrom(fixtureStart(fixture), fixture.log, 3 * DAY);
    expect(town.stats.totals["population"] ?? 0).toBeGreaterThan(0);
    const run = (rate: number) => {
      const state = structuredClone(town);
      expect(submit(state, command("SetTaxRate", { zone: "residential", rate })).ok).toBe(true);
      const arrivedBefore = state.stats.year.arrivals;
      let tax = 0;
      let residentDays = 0;
      let last = state.budget.month[LINE.taxResidential] ?? 0;
      const until = state.tick + 12 * DAY;
      while (state.tick < until) {
        step(state);
        const now = state.budget.month[LINE.taxResidential] ?? 0;
        // A month that closed starts its line again from 0.
        tax += now >= last ? now - last : now;
        last = now;
        if (state.tick % DAY === 0) residentDays += state.stats.totals["population"] ?? 0;
      }
      return { arrivals: state.stats.year.arrivals - arrivedBefore, taxPerResidentDay: tax / residentDays, bar: state.demand.residential };
    };
    const atDefault = run(ECONOMY.taxRates.residential.default);
    const atTop = run(ECONOMY.taxRates.residential.max);
    expect(atDefault.bar.parts["tax"]).toBe(0);
    expect(atTop.bar.parts["tax"]).toBeLessThan(0);
    expect(atDefault.arrivals).toBeGreaterThan(0);
    expect(atTop.arrivals).toBeLessThan(atDefault.arrivals);
    expect(atTop.taxPerResidentDay).toBeGreaterThan(atDefault.taxPerResidentDay);
  });
});
