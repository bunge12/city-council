// The two scenario tests of M4's exit test (M4.md; M4-19). They take game
// years, so they are Vitest scenarios and not walkthrough steps.
//
// 1. A compact grid of density 1 houses with shops and work roughly breaks
//    even, and the same population spread along long cul-de-sacs loses
//    money.
// 2. A new city started on its grant can build a first town that breaks
//    even before density 2 unlocks.
//
// "Breaks even" is the money that comes back every year: tax less road and
// building upkeep and the other city spending. Development charges and
// grants are left out, since they stop when growth does (PRD, "Development
// charges"). These pin the balance numbers M4-19 tuned: a change to a
// rate, a price or a share that moves a town across zero fails here.

import { describe, expect, it } from "vitest";
import { ECONOMY, LINE, TAX_LINES, TIME_BALANCE, isMonthStart, isUnlocked, milestonesReached, step, yearDays, type SimState } from "../src/index";
import { compactTown, culDeSacTown, firstTown, newCity } from "./economy-towns";
import { funded } from "./funds";

const DAY = TIME_BALANCE.ticksPerDay;
const YEAR = yearDays() * DAY;

/** The ledger summed over the months that close while `state` steps to `until`. */
function ledgerUntil(state: SimState, until: number): Float64Array {
  const sum = new Float64Array(state.budget.month.length);
  while (state.tick < until) {
    step(state);
    if (isMonthStart(state.tick)) for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (state.budget.lastMonth[i] ?? 0);
  }
  return sum;
}

/** What a ledger's year brought in every year: tax less upkeep and other spending. */
function recurring(ledger: Float64Array): { tax: number; net: number } {
  const at = (line: keyof typeof LINE) => ledger[LINE[line]] ?? 0;
  const tax = TAX_LINES.reduce((sum, line) => sum + at(line), 0);
  return { tax, net: tax - at("roadUpkeep") - at("buildingUpkeep") - at("otherSpending") };
}

/** Steps a town through its first game year, while it fills, and returns its second. */
function secondYear(state: SimState): { tax: number; net: number; people: number } {
  ledgerUntil(state, YEAR);
  const money = recurring(ledgerUntil(state, 2 * YEAR));
  return { ...money, people: state.stats.totals["population"] ?? 0 };
}

describe("a compact density 1 town and the same town on cul-de-sacs (M4 exit test)", () => {
  // Funded, so the cul-de-sacs' extra road is paid for: the test is about what each costs to keep.
  const compact = secondYear(compactTown(funded(newCity())));
  const spread = secondYear(culDeSacTown(funded(newCity())));

  it("puts about the same number of people in each", () => {
    expect(compact.people).toBeGreaterThan(1000);
    expect(Math.abs(spread.people - compact.people) / compact.people).toBeLessThan(0.05);
  });

  it("has the compact town roughly break even", () => {
    expect(compact.net).toBeGreaterThanOrEqual(0);
    expect(compact.net / compact.tax).toBeLessThan(0.05);
  });

  it("has the town on cul-de-sacs lose money", () => {
    expect(spread.net).toBeLessThan(0);
    expect(spread.net).toBeLessThan(compact.net);
  });
});

describe("a new city on its starting grant (M4 exit test)", () => {
  const state = newCity();
  const grant = state.budget.treasury;
  firstTown(state);
  const laid = state.budget.treasury;
  // Days until density 2 unlocks, the treasury read at the end of each.
  let lowest = laid;
  let day = 0;
  while (!isUnlocked(state, "density2") && day < yearDays()) {
    day++;
    while (state.tick < day * DAY) step(state);
    lowest = Math.min(lowest, state.budget.treasury);
  }
  const unlockedOn = day;
  const year = secondYear(state);

  it("starts on the starting grant and lays its first town from it", () => {
    expect(grant).toBe(ECONOMY.startingGrant);
    expect(laid).toBeGreaterThan(0);
    expect(laid).toBeLessThan(grant);
  });

  it("never spends below what it had once the town was laid, before density 2 unlocks", () => {
    expect(lowest).toBe(laid);
  });

  it("reaches the first milestone, which unlocks density 2, inside its first game year", () => {
    expect(isUnlocked(state, "density2")).toBe(true);
    expect(milestonesReached(state)).toBeGreaterThanOrEqual(1);
    expect(unlockedOn).toBeLessThan(yearDays());
  });

  it("has the first town, all density 1, break even on what it brings in every year", () => {
    expect(year.net).toBeGreaterThanOrEqual(0);
  });
});
