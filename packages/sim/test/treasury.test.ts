import { describe, expect, it } from "vitest";
import { TIME_BALANCE, createBareState, createState, deserialize, hashState, serialize, step, submit, yearDays, type SimState } from "../src/index";
import { ECONOMY, ECONOMY_SLIDERS } from "../src/economy/balance";
import { INCOME_LINES, LEDGER_LINES, LINE, checkBudget, closeMonth, copyBudget, createBudget, dailyShare, expensesOf, incomeOf, isIncome, moveMoney, sameBudget, taxIncomeOf } from "../src/economy/budget";
import { applyStatsDelta, createStats, encodeStatsDelta, historyOf, sampleCount, statsDeltaProblem } from "../src/stats/stats";
import { watchTreasury } from "./treasury-helper";

const DAY = TIME_BALANCE.ticksPerDay;
const JANUARY = TIME_BALANCE.monthDays[0] as number;
const FEBRUARY = TIME_BALANCE.monthDays[1] as number;

/** A small generator for the test's own amounts, so the sim's is left alone. */
function amounts(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x % 2_000_000;
  };
}

describe("the treasury", () => {
  it("starts a new city with the starting grant on the grants line of the month before the first, and the tax rates at their defaults", () => {
    const state = createState(2026);
    expect(state.budget.treasury).toBe(ECONOMY.startingGrant);
    expect(state.budget.opening).toBe(ECONOMY.startingGrant);
    expect(state.budget.lastMonth[LINE.grants]).toBe(ECONOMY.startingGrant);
    expect(incomeOf(state.budget.lastMonth)).toBe(ECONOMY.startingGrant);
    expect(expensesOf(state.budget.lastMonth)).toBe(0);
    expect(Array.from(state.budget.month).every((n) => n === 0)).toBe(true);
    expect(Array.from(state.budget.taxRates)).toEqual(ECONOMY_SLIDERS.map((s) => ECONOMY.taxRates[s].default));
    expect(checkBudget(state.budget)).toBeNull();
  });

  it("has a line for each income and expense of the PRD's table, the other city spending included", () => {
    expect(LEDGER_LINES).toHaveLength(18);
    expect(LEDGER_LINES.slice(0, INCOME_LINES).every(isIncome)).toBe(true);
    expect(LEDGER_LINES.slice(INCOME_LINES).some(isIncome)).toBe(false);
    expect(isIncome("otherSpending")).toBe(false);
    expect(isIncome("chargeIndustrial")).toBe(true);
  });

  it("moves money on each line, and the treasury is the starting grant plus every line ever moved", () => {
    const state = createBareState(7);
    const next = amounts(1);
    let expected = ECONOMY.startingGrant;
    for (let round = 0; round < 5; round++) {
      for (const line of LEDGER_LINES) {
        const amount = next();
        const before = state.budget.month[LINE[line]] as number;
        moveMoney(state, line, amount);
        expected += isIncome(line) ? amount : -amount;
        expect(state.budget.month[LINE[line]]).toBe(before + amount);
        expect(state.budget.treasury).toBe(expected);
      }
      // A refund moves the other way, and takes the line down.
      moveMoney(state, "construction", -1234);
      expected += 1234;
      expect(state.budget.treasury).toBe(expected);
    }
    // Every line moved, on top of the grant the month opened with.
    expect(state.budget.treasury).toBe(state.budget.opening + incomeOf(state.budget.month) - expensesOf(state.budget.month));
    expect(state.budget.opening).toBe(ECONOMY.startingGrant);
    expect(checkBudget(state.budget)).toBeNull();
  });

  it("goes below zero, which only the overdraft check of M4-03 refuses", () => {
    const state = createBareState(7);
    moveMoney(state, "construction", ECONOMY.startingGrant + 500);
    expect(state.budget.treasury).toBe(-500);
    expect(checkBudget(state.budget)).toBeNull();
  });

  it("refuses a fraction of a dollar or an unknown line, and changes nothing", () => {
    const state = createBareState(7);
    const before = copyBudget(state.budget);
    expect(() => moveMoney(state, "grants", 0.5)).toThrow(RangeError);
    expect(() => moveMoney(state, "grants", Number.NaN)).toThrow(RangeError);
    expect(() => moveMoney(state, "fines" as never, 1)).toThrow(RangeError);
    expect(() => moveMoney(state, "grants", Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(sameBudget(state.budget, before)).toBe(true);
  });

  it("adds the tax lines into the month's tax income", () => {
    const state = createBareState(7);
    moveMoney(state, "taxResidential", 10);
    moveMoney(state, "taxCommercial", 20);
    moveMoney(state, "taxOffice", 30);
    moveMoney(state, "taxIndustrial", 40);
    moveMoney(state, "chargeResidential", 1000);
    expect(taxIncomeOf(state.budget.month)).toBe(100);
  });
});

describe("the daily share", () => {
  const days = yearDays();

  it.each([1, 2, 7, 100, 364, 365, 366, 1000, 1_000_003, 123_456_789, 2_147_483_648, 9_999_999_999, 10_000_000_000])("spreads $%d over a year to the dollar", (yearly) => {
    let sum = 0;
    const low = Math.floor(yearly / days);
    for (let day = 0; day < days; day++) {
      const share = dailyShare(yearly, day);
      expect(Number.isSafeInteger(share)).toBe(true);
      // Never more than a dollar from an even share.
      expect(share === low || share === low + 1).toBe(true);
      sum += share;
    }
    expect(sum).toBe(yearly);
  });

  it("charges the same day the same share on every call, and nothing on a yearly amount of 0", () => {
    expect(dailyShare(123_456_789, 200)).toBe(dailyShare(123_456_789, 200));
    for (let day = 0; day < days; day++) expect(dailyShare(0, day)).toBe(0);
  });

  it("refuses a yearly amount that is not whole dollars, or a day outside the year", () => {
    expect(() => dailyShare(0.5, 0)).toThrow(RangeError);
    expect(() => dailyShare(-1, 0)).toThrow(RangeError);
    expect(() => dailyShare(Number.MAX_SAFE_INTEGER, 0)).toThrow(RangeError);
    expect(() => dailyShare(100, days)).toThrow(RangeError);
    expect(() => dailyShare(100, -1)).toThrow(RangeError);
  });
});

describe("the monthly close", () => {
  it("samples the starting grant as the month before the first, on tick 0", () => {
    const state = createState(2026);
    step(state);
    expect(state.budget.lastMonth[LINE.grants]).toBe(ECONOMY.startingGrant);
    expect(Array.from(state.budget.month).every((n) => n === 0)).toBe(true);
    expect(state.budget.opening).toBe(ECONOMY.startingGrant);
    expect(state.budget.treasury).toBe(ECONOMY.startingGrant);
    expect(historyOf(state.stats, "treasury")).toEqual([ECONOMY.startingGrant]);
    expect(historyOf(state.stats, "income")).toEqual([ECONOMY.startingGrant]);
    expect(historyOf(state.stats, "expenses")).toEqual([0]);
  });

  it("steps across a month's end and finds the month filed and a new one at zero", () => {
    const state = createState(2026);
    while (state.tick < 10 * DAY) step(state);
    moveMoney(state, "roadUpkeep", 4000);
    moveMoney(state, "taxResidential", 9000);
    moveMoney(state, "chargeCommercial", 500);
    const month = state.budget.month.slice();
    // To the last tick of January: nothing closes.
    while (state.tick < JANUARY * DAY - 1) step(state);
    expect(Array.from(state.budget.month)).toEqual(Array.from(month));
    // The step onto the first tick of February closes January, and February's first step samples it.
    step(state);
    expect(sampleCount(state.stats)).toBe(1);
    step(state);
    expect(Array.from(state.budget.lastMonth)).toEqual(Array.from(month));
    expect(Array.from(state.budget.month).every((n) => n === 0)).toBe(true);
    const treasury = ECONOMY.startingGrant + 9000 + 500 - 4000;
    expect(state.budget.treasury).toBe(treasury);
    expect(state.budget.opening).toBe(treasury);
    expect(historyOf(state.stats, "treasury")).toEqual([ECONOMY.startingGrant, treasury]);
    expect(historyOf(state.stats, "income")).toEqual([ECONOMY.startingGrant, 9500]);
    expect(historyOf(state.stats, "expenses")).toEqual([0, 4000]);
    expect(historyOf(state.stats, "taxIncome")).toEqual([0, 9000]);
    // Money moved in February is February's.
    moveMoney(state, "interest", 10);
    expect(state.budget.month[LINE.interest]).toBe(10);
    expect(state.budget.lastMonth[LINE.interest]).toBe(0);
    // And March closes February, with January gone from the ledger but kept in the history.
    while (state.tick <= (JANUARY + FEBRUARY) * DAY) step(state);
    expect(state.budget.lastMonth[LINE.interest]).toBe(10);
    expect(state.budget.lastMonth[LINE.taxResidential]).toBe(0);
    expect(historyOf(state.stats, "expenses")).toEqual([0, 4000, 10]);
  });

  it("holds a treasury past what an Int32Array holds in the history", () => {
    const state = createBareState(7);
    moveMoney(state, "loansTaken", 5_000_000_000);
    // The sample holds the treasury each month opened with: January's the grant, February's the grant and the loan.
    while (state.tick <= JANUARY * DAY) step(state);
    expect(historyOf(state.stats, "treasury")).toEqual([ECONOMY.startingGrant, ECONOMY.startingGrant + 5_000_000_000]);
  });

  it("files money moved on a month's first tick in the new month, paused steps and all", () => {
    const state = createBareState(7);
    while (state.tick < JANUARY * DAY - 1) step(state);
    moveMoney(state, "roadUpkeep", 7);
    // The step onto 1 February closes January before anything happens on it.
    step(state);
    expect(state.tick).toBe(JANUARY * DAY);
    expect(state.budget.lastMonth[LINE.roadUpkeep]).toBe(7);
    // What a command applied on that tick moves, here a whole paused planning session of it, is February's.
    state.speed = 0;
    for (let i = 0; i < 5; i++) {
      moveMoney(state, "construction", 100);
      step(state);
    }
    expect(state.tick).toBe(JANUARY * DAY);
    state.speed = 1;
    step(state);
    expect(state.budget.month[LINE.construction]).toBe(500);
    expect(state.budget.lastMonth[LINE.construction]).toBe(0);
    expect(historyOf(state.stats, "expenses")).toEqual([0, 7]);
  });

  it("closes a month only on its first tick, paused steps included", () => {
    const state = createBareState(7);
    const budget = copyBudget(state.budget);
    closeMonth(budget);
    closeMonth(budget);
    // Twice is the month filed and then an empty one: the step never runs it twice on a tick.
    expect(Array.from(budget.lastMonth).every((n) => n === 0)).toBe(true);
    step(state);
    const after = copyBudget(state.budget);
    state.speed = 0;
    for (let i = 0; i < 5; i++) step(state);
    expect(sameBudget(state.budget, after)).toBe(true);
  });
});

/**
 * Steps a city to tick `until`, moving money on a spread of lines every 37
 * ticks, and calls `check` after every step. What moves is a function of
 * the tick alone, so a session resumed from a save moves what the one it
 * was saved from would have.
 */
function session(state: SimState, until: number, check: (s: SimState) => void): void {
  while (state.tick < until) {
    if (state.tick % 37 === 0) {
      const next = amounts(state.tick);
      const line = LEDGER_LINES[next() % LEDGER_LINES.length] ?? "grants";
      moveMoney(state, line, next() - 50_000);
    }
    step(state);
    check(state);
  }
}

function town(): SimState {
  const state = createState(2026);
  expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
  step(state);
  const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
  expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
  return state;
}

describe("a long session", () => {
  it("keeps the treasury equal to the ledger and the history at every step, over three month ends", () => {
    const state = createState(2026);
    const watch = watchTreasury(state);
    watch.check(state);
    const rects = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } })).toEqual({ ok: true });
    step(state);
    watch.check(state);
    expect(submit(state, { seq: 2, playerId: "p1", type: "ZoneCells", payload: { zone: "residential", density: 1, rects } })).toEqual({ ok: true });
    session(state, (JANUARY + FEBRUARY + 2) * DAY, (s) => watch.check(s));
    // 1 February and 1 March, and a sample on each and on tick 0.
    expect(watch.closes).toBe(2);
    expect(sampleCount(state.stats)).toBe(3);
  });

  it("resumes a city saved mid-month to the same hash", () => {
    const until = (JANUARY + 5) * DAY;
    const straight = town();
    session(straight, until, () => {});
    const saved = town();
    session(saved, 17 * DAY + 41, () => {});
    let resumed = deserialize(serialize(saved)).state;
    expect(hashState(resumed)).toBe(hashState(saved));
    const watch = watchTreasury(resumed);
    session(resumed, until, (s) => watch.check(s));
    expect(watch.closes).toBe(1);
    expect(hashState(resumed)).toBe(hashState(straight));
    // And once more past the close, from a save on the close's own tick.
    resumed = deserialize(serialize(straight)).state;
    expect(resumed.budget).toEqual(straight.budget);
  });
});

describe("loading and the delta", () => {
  it("finds a budget whose numbers do not add up", () => {
    const budget = createBudget();
    expect(checkBudget(budget)).toBeNull();
    expect(checkBudget({ ...budget, treasury: budget.treasury + 1 })).toMatch(/opening balance/);
    expect(checkBudget({ ...budget, month: new Float64Array(2) })).toMatch(/ledger/);
    expect(checkBudget({ ...budget, taxRates: new Float64Array([0.01, 0.01, 0.01]) })).toMatch(/tax rates/);
    expect(checkBudget({ ...budget, extra: 1 })).toMatch(/fields/);
  });

  it("tells a budget that changed from one that did not, and copies share nothing", () => {
    const state = createBareState(7);
    const copy = copyBudget(state.budget);
    expect(sameBudget(state.budget, copy)).toBe(true);
    moveMoney(state, "demolition", 1);
    expect(sameBudget(state.budget, copy)).toBe(false);
    expect(copy.month[LINE.demolition]).toBe(0);
    const again = copyBudget(state.budget);
    again.taxRates[0] = 0.02;
    expect(sameBudget(state.budget, again)).toBe(false);
  });

  it("sends the money samples in the statistics delta, and a copy's history matches the sim's", () => {
    const state = createBareState(7);
    const copy = createStats();
    let sent = 0;
    // Past tick 0, 1 February and 1 March, each a close and a sample.
    for (const end of [1, JANUARY * DAY + 1, (JANUARY + FEBRUARY) * DAY + 1]) {
      moveMoney(state, "loansTaken", 3_000_000_000);
      moveMoney(state, "taxOffice", 77);
      while (state.tick < end) step(state);
      const delta = encodeStatsDelta(state.stats, sent);
      expect(statsDeltaProblem(delta)).toBeNull();
      expect(applyStatsDelta(copy, delta)).not.toBeTypeOf("string");
      sent = state.stats.next;
    }
    expect(copy.money).toEqual(state.stats.money);
    // Tick 0's sample is the month before the first; the first two moves were January's.
    expect(historyOf(copy, "taxIncome")).toEqual([0, 154, 77]);
    expect(historyOf(copy, "treasury")[2]).toBe(ECONOMY.startingGrant + 3 * (3_000_000_000 + 77));
    const delta = encodeStatsDelta(state.stats, 0);
    expect(statsDeltaProblem({ ...delta, moneySamples: new Float64Array(1) })).toMatch(/money samples/);
    expect(statsDeltaProblem({ ...delta, moneySamples: delta.moneySamples.map(() => 0.5) })).toMatch(/whole dollars/);
  });
});
