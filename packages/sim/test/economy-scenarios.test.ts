// The two scenario tests of M4's exit test (M4.md; M4-19). They take game
// years, so they are Vitest scenarios and not walkthrough steps.
//
// 1. A compact grid of density 1 houses with shops and work roughly breaks
//    even, and the same population spread along cul-de-sacs loses money.
// 2. A new city started on its grant can build a first town that breaks
//    even before density 2 unlocks.
//
// "Breaks even" is the money that comes back every year: tax less road and
// building upkeep and the other city spending. Development charges and
// grants are left out, since they stop when growth does (PRD, "Development
// charges"). "Roughly" is within 3% of the town's tax: the PRD asks for
// about zero at density 1, slightly negative on cul-de-sacs.
//
// These pin the balance numbers M4-19 tuned: a change to a rate, a price or
// a share that moves a town across these lines fails here.

import { beforeAll, describe, expect, it } from "vitest";
import { ECONOMY, LINE, TAX_LINES, TIME_BALANCE, isMonthStart, isUnlocked, milestonesReached, step, yearDays, type SimState } from "../src/index";
import { compactTown, culDeSacTown, firstTown, newCity } from "./economy-towns";
import { funded } from "./funds";

const DAY = TIME_BALANCE.ticksPerDay;
const YEAR = yearDays() * DAY;
/** How far from zero a town that roughly breaks even may be, as a share of its tax. */
const ROUGHLY = 0.03;

/** The ledger summed over the months that close while `state` steps to `until`. */
function ledgerUntil(state: SimState, until: number): Float64Array {
  const sum = new Float64Array(state.budget.month.length);
  while (state.tick < until) {
    step(state);
    if (isMonthStart(state.tick)) for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (state.budget.lastMonth[i] ?? 0);
  }
  return sum;
}

/** What a ledger brought in that comes back every year: tax less upkeep and other spending. */
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

describe("a compact density 1 town and the same people on cul-de-sacs (M4 exit test)", () => {
  let compact: ReturnType<typeof secondYear>;
  let spread: ReturnType<typeof secondYear>;
  beforeAll(() => {
    // Funded, so the cul-de-sacs' avenue is paid for: the test is about what each costs to keep.
    compact = secondYear(compactTown(funded(newCity())));
    spread = secondYear(culDeSacTown(funded(newCity())));
  });

  it("puts the same number of people in each, within 3%", () => {
    // Each resident costs more in other spending than their home pays, and both towns have the same jobs,
    // so a town with fewer people would come out ahead for that alone.
    expect(compact.people).toBeGreaterThan(1000);
    expect(Math.abs(spread.people - compact.people) / compact.people).toBeLessThan(0.03);
  });

  it("has the compact town roughly break even", () => {
    expect(Math.abs(compact.net) / compact.tax).toBeLessThan(ROUGHLY);
  });

  it("has the town on cul-de-sacs off an avenue lose money", () => {
    expect(spread.net).toBeLessThan(0);
    expect(spread.net).toBeLessThan(compact.net);
  });
});

describe("a new city on its starting grant (M4 exit test)", () => {
  let grant = 0;
  let laid = 0;
  let lowest = 0;
  let unlockedOn = 0;
  let density1Year: ReturnType<typeof secondYear>;
  let unlocked = false;
  let reached = 0;
  beforeAll(() => {
    const state = newCity();
    grant = state.budget.treasury;
    firstTown(state);
    laid = state.budget.treasury;
    // Day by day until density 2 unlocks, the treasury read at the end of each.
    lowest = laid;
    let day = 0;
    while (!isUnlocked(state, "density2") && day < yearDays()) {
      day++;
      while (state.tick < day * DAY) step(state);
      lowest = Math.min(lowest, state.budget.treasury);
    }
    unlockedOn = day;
    unlocked = isUnlocked(state, "density2");
    reached = milestonesReached(state);
    // The town zones nothing at density 2, so its year is still all density 1.
    density1Year = secondYear(state);
  });

  it("starts on the starting grant and lays its first town from it", () => {
    expect(grant).toBe(ECONOMY.startingGrant);
    expect(laid).toBeGreaterThan(0);
    expect(laid).toBeLessThan(grant);
  });

  it("never spends below what it had once the town was laid before density 2 unlocks, its development charges covering the weeks it fills", () => {
    expect(lowest).toBe(laid);
  });

  it("reaches the first milestone, which unlocks density 2, inside its first game year", () => {
    expect(unlocked).toBe(true);
    expect(reached).toBeGreaterThanOrEqual(1);
    expect(unlockedOn).toBeLessThan(yearDays());
  });

  it("has the first town, all density 1, roughly break even on what it brings in every year", () => {
    expect(Math.abs(density1Year.net) / density1Year.tax).toBeLessThan(ROUGHLY);
  });
});
