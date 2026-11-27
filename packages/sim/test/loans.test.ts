// Borrowing (M4-11, PRD "Borrowing"): loans on the terms economy.json offers,
// up to a credit limit that grows with the city, repaid monthly on the close
// to a balance of exactly zero.

import { describe, expect, it } from "vitest";
import {
  ECONOMY,
  LINE,
  MILESTONES,
  TIME_BALANCE,
  checkEconomyBalance,
  creditLeft,
  creditLimit,
  debtOf,
  deserialize,
  fundCity,
  hashState,
  lastYearTaxIncome,
  loansOf,
  monthInterest,
  monthlyRepayment,
  replayFrom,
  spendingRefusal,
  serialize,
  step,
  submit,
  validateCommand,
  createState,
  type Command,
  type SimState,
} from "../src/index";
import { closeMonthOn } from "../src/economy/budget";
import { isMonthStart } from "../src/calendar";
import { creditMilestones } from "../src/progression/milestones";
import { unlockMilestone } from "../src/progression/balance";
import { takeSample, moneySample } from "../src/stats/stats";
import { enqueue } from "../src/commands";
import { cloneState } from "../src/state";
import { budgetTown } from "./budget-town";
import { watchTreasury } from "./treasury-helper";
import economyJson from "../balance/economy.json" with { type: "json" };

const SEED = 2026;
const DAY = TIME_BALANCE.ticksPerDay;
const [TEN_YEARS, TWENTY_YEARS, THIRTY_YEARS] = ECONOMY.loans.offers.map((o) => o.termMonths) as [number, number, number];

let seq = 0;
const command = (type: string, payload: unknown): Command => ({ seq: ++seq, playerId: "p1", type, payload });

/** Submits and applies a command on a paused step, so the tick stays where it is. */
function apply(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, command(type, payload));
  expect(result, `${type} ${JSON.stringify(payload)}`).toEqual({ ok: true });
  const speed = state.speed;
  state.speed = 0;
  expect(step(state)).toEqual([]);
  state.speed = speed;
}

function refusal(state: SimState, type: string, payload: unknown): string {
  const result = validateCommand(state, command(type, payload));
  if (result.ok) throw new Error(`${type} was not refused`);
  return result.reason;
}

/** A new city whose credit limit lets it borrow `limit` dollars, through its population alone. */
function cityWithLimit(limit = 100_000_000): SimState {
  const state = createState(SEED);
  state.stats.totals["population"] = Math.ceil(limit / ECONOMY.creditLimit.perResident);
  return state;
}

/** The first tick of each of the `count` months after `tick`. */
function monthStartsAfter(tick: number, count: number): number[] {
  const out: number[] = [];
  for (let t = (Math.floor(tick / DAY) + 1) * DAY; out.length < count; t += DAY) if (isMonthStart(t)) out.push(t);
  return out;
}

describe("the repayment", () => {
  it("is the annuity payment rounded down, by repeated multiplication", () => {
    // $1M at 4% over ten years: 1e6 × r × f / (f - 1), r = 0.04 / 12, f = (1 + r)^120 ≈ 1.4908, is $10,124.51.
    expect(monthlyRepayment(1_000_000, 0.04, 120)).toBe(10_124);
    // At 5% over thirty years, $5,368.22.
    expect(monthlyRepayment(1_000_000, 0.05, 360)).toBe(5_368);
    expect(monthlyRepayment(1_200, 0, 12)).toBe(100);
    expect(monthlyRepayment(1, 0.05, 360)).toBe(0);
    expect(() => monthlyRepayment(0.5, 0.04, 120)).toThrow(RangeError);
    expect(() => monthlyRepayment(1000, 0.04, 0)).toThrow(RangeError);
  });

  it("charges interest as the floor of the balance times the monthly rate", () => {
    expect(monthInterest(1_000_000, 0.04)).toBe(3_333);
    expect(monthInterest(299, 0.04)).toBe(0);
  });
});

describe("a loan run to its term", () => {
  for (const [principal, term] of [
    [250_000_000, TEN_YEARS],
    [7_654_321, TWENTY_YEARS],
    [99_999_999, THIRTY_YEARS],
    [1_000, THIRTY_YEARS],
  ] as const) {
    it(`repays $${principal} over ${term} months to a balance of exactly zero, its payments the principal plus the interest`, () => {
      const state = cityWithLimit(principal);
      const before = state.budget.treasury;
      apply(state, "TakeLoan", { principal, termMonths: term });
      expect(state.budget.treasury).toBe(before + principal);
      expect(state.budget.month[LINE.loansTaken]).toBe(principal);
      const [loan] = loansOf(state.budget);
      expect(loan).toMatchObject({ id: 0, taken: 0, principal, termMonths: term, monthsLeft: term, balance: principal, repayment: monthlyRepayment(principal, loan?.annualRate ?? 0, term) });
      expect(loan?.annualRate).toBe(ECONOMY.loans.offers.find((o) => o.termMonths === term)?.annualRate);
      let interest = 0;
      const payments: number[] = [];
      let closedAfter = -1;
      // Taken in the first month, it pays from the close after that month's: one close more than its term.
      for (const [k, tick] of monthStartsAfter(state.tick, term + 1).entries()) {
        state.tick = tick;
        closeMonthOn(state);
        const month = (state.budget.lastMonth[LINE.loanRepayments] ?? 0) + (state.budget.lastMonth[LINE.interest] ?? 0);
        interest += state.budget.lastMonth[LINE.interest] ?? 0;
        if (k === 0) expect(month, "nothing on the close of the month it was taken in").toBe(0);
        else payments.push(month);
        if (loansOf(state.budget).length === 0 && closedAfter < 0) closedAfter = k;
      }
      expect(loansOf(state.budget)).toEqual([]);
      expect(debtOf(state.budget)).toBe(0);
      const paid = payments.reduce((a, b) => a + b, 0);
      expect(paid).toBe(principal + interest);
      // Closed on its last month, or a little before where the floors of the interest paid it down early.
      expect(closedAfter).toBeGreaterThan(term * 0.9);
      expect(closedAfter).toBeLessThanOrEqual(term);
      // Every payment but the last is the fixed repayment; the last takes what remains, and nothing after.
      for (const p of payments.slice(0, closedAfter - 1)) expect(p).toBe(loan?.repayment);
      for (const p of payments.slice(closedAfter)) expect(p).toBe(0);
      expect(state.budget.treasury).toBe(before + principal - paid);
    });
  }

  it("pays nothing on the close of the month it was taken in, then charges on the next, on the month that closes", () => {
    const state = cityWithLimit();
    state.speed = 1;
    // Mid-January.
    while (state.tick < 10 * DAY + 37) step(state);
    apply(state, "TakeLoan", { principal: 1_000_000, termMonths: TEN_YEARS });
    const watch = watchTreasury(state);
    const [february, march] = monthStartsAfter(state.tick, 2) as [number, number];
    while (state.tick < february) {
      step(state);
      watch.check(state);
    }
    expect(state.budget.lastMonth[LINE.loansTaken]).toBe(1_000_000);
    expect(state.budget.lastMonth[LINE.interest]).toBe(0);
    expect(state.budget.lastMonth[LINE.loanRepayments]).toBe(0);
    while (state.tick < march) {
      step(state);
      watch.check(state);
    }
    expect(state.budget.lastMonth[LINE.interest]).toBe(3_333);
    expect(state.budget.lastMonth[LINE.loanRepayments]).toBe(10_124 - 3_333);
    expect(loansOf(state.budget)[0]).toMatchObject({ balance: 1_000_000 - (10_124 - 3_333), monthsLeft: TEN_YEARS - 1 });
  });

  it("is charged past the overdraft, since a debt does not wait, and spending stays blocked until the treasury recovers", () => {
    const state = cityWithLimit();
    apply(state, "TakeLoan", { principal: 50_000_000, termMonths: TEN_YEARS });
    // Spent down to the overdraft's edge.
    fundCity(state, -ECONOMY.overdraft);
    const [first, second] = monthStartsAfter(state.tick, 2) as [number, number];
    state.tick = first;
    closeMonthOn(state);
    state.tick = second;
    closeMonthOn(state);
    const charged = monthlyRepayment(50_000_000, 0.04, TEN_YEARS);
    expect(state.budget.treasury).toBe(-ECONOMY.overdraft - charged);
    expect(spendingRefusal(state, 1)).toMatch(/available$/);
  });
});

describe("TakeLoan", () => {
  it("is refused past the credit limit, with what is left to borrow", () => {
    const state = createState(SEED);
    expect(creditLimit(state)).toBe(0);
    expect(refusal(state, "TakeLoan", { principal: 1_000, termMonths: TEN_YEARS })).toBe("Borrowing $1K is past the credit limit, $0 left to borrow");
    state.stats.totals["population"] = 2_000;
    expect(creditLimit(state)).toBe(2_000 * ECONOMY.creditLimit.perResident);
    apply(state, "TakeLoan", { principal: 1_500_000, termMonths: TEN_YEARS });
    expect(creditLeft(state)).toBe(500_000);
    expect(refusal(state, "TakeLoan", { principal: 500_001, termMonths: TWENTY_YEARS })).toBe("Borrowing $500K is past the credit limit, $500K left to borrow");
    apply(state, "TakeLoan", { principal: 500_000, termMonths: TWENTY_YEARS });
    expect(creditLeft(state)).toBe(0);
  });

  it("is refused with every slot taken", () => {
    const state = cityWithLimit();
    for (let i = 0; i < ECONOMY.loans.maxOpen; i++) apply(state, "TakeLoan", { principal: 1_000_000, termMonths: TEN_YEARS });
    expect(loansOf(state.budget).map((l) => l.id)).toEqual([...Array(ECONOMY.loans.maxOpen).keys()]);
    expect(refusal(state, "TakeLoan", { principal: 1_000, termMonths: TEN_YEARS })).toBe(`The city has ${ECONOMY.loans.maxOpen} loans open, the most it may hold`);
  });

  it("is refused a principal that is not whole dollars, or a term the file does not offer", () => {
    const state = cityWithLimit();
    expect(refusal(state, "TakeLoan", null)).toBe("TakeLoan needs a principal and a term");
    for (const principal of [0, -5, 1.5, "100", undefined]) expect(refusal(state, "TakeLoan", { principal, termMonths: TEN_YEARS })).toMatch(/principal must be whole dollars/);
    // $100 over thirty years repays floor($0.54) = $0 a month: refused, not left owing nothing for 359 months.
    expect(refusal(state, "TakeLoan", { principal: 100, termMonths: THIRTY_YEARS })).toBe("A loan of $100 over 360 months is too small to repay in whole dollars");
    expect(refusal(state, "TakeLoan", { principal: 100, termMonths: 13 })).toBe(`TakeLoan payload.termMonths must be one of ${ECONOMY.loans.offers.map((o) => o.termMonths).join(", ")}`);
  });
});

describe("the credit limit", () => {
  it("weighs the population and the tax income of the last twelve months in the history", () => {
    const state = createState(SEED);
    state.stats.totals["population"] = 3_000;
    const budget = state.budget;
    // Fourteen months of tax income, $1,000 more each month: only the last twelve count.
    for (let m = 1; m <= 14; m++) {
      budget.lastMonth.fill(0);
      budget.lastMonth[LINE.taxResidential] = m * 1_000;
      takeSample(state.stats, moneySample(budget));
    }
    const year = (3 + 14) * 6 * 1_000;
    expect(lastYearTaxIncome(state)).toBe(year);
    expect(creditLimit(state)).toBe(3_000 * ECONOMY.creditLimit.perResident + Math.floor(ECONOMY.creditLimit.lastYearTaxMultiple * year));
  });

  it("is larger once the milestone that opens it is reached", () => {
    const state = createState(SEED);
    state.stats.totals["population"] = 3_000;
    const base = creditLimit(state);
    creditMilestones(state, unlockMilestone("largerLoans"));
    expect(creditLimit(state)).toBe(base);
    creditMilestones(state, unlockMilestone("largerLoans") + 1);
    expect(creditLimit(state)).toBe(base * ECONOMY.creditLimit.largerLoansMultiple);
    expect(MILESTONES[unlockMilestone("largerLoans")]?.unlocks).toContain("largerLoans");
  });

  it("is read from economy.json, which says what is wrong with a bad multiple", () => {
    const bad = structuredClone(economyJson) as { creditLimit: Record<string, unknown> };
    bad.creditLimit["largerLoansMultiple"] = 0.5;
    expect(checkEconomyBalance(bad)).toContain("creditLimit.largerLoansMultiple must be a number of at least 1");
    delete bad.creditLimit["largerLoansMultiple"];
    expect(checkEconomyBalance(bad)).toContain("creditLimit.largerLoansMultiple must be a number of at least 1");
  });
});

describe("RepayLoan", () => {
  it("pays a loan off early: the loan closed and the treasury down by its balance, on the repayment line", () => {
    const state = cityWithLimit();
    apply(state, "TakeLoan", { principal: 2_000_000, termMonths: TEN_YEARS });
    apply(state, "TakeLoan", { principal: 3_000_000, termMonths: THIRTY_YEARS });
    const [first, second] = monthStartsAfter(state.tick, 2) as [number, number];
    state.tick = first;
    closeMonthOn(state);
    state.tick = second;
    closeMonthOn(state);
    const [, thirty] = loansOf(state.budget);
    expect(thirty?.balance).toBeLessThan(3_000_000);
    const treasury = state.budget.treasury;
    const repaid = state.budget.month[LINE.loanRepayments] ?? 0;
    apply(state, "RepayLoan", { loan: 1 });
    expect(loansOf(state.budget).map((l) => l.id)).toEqual([0]);
    expect(state.budget.treasury).toBe(treasury - (thirty?.balance ?? 0));
    expect(state.budget.month[LINE.loanRepayments]).toBe(repaid + (thirty?.balance ?? 0));
    expect(state.logSpent.at(-1)).toBe(thirty?.balance);
    // Its slot is free again, and the next loan takes a new id.
    apply(state, "TakeLoan", { principal: 1_000, termMonths: TEN_YEARS });
    expect(loansOf(state.budget).map((l) => l.id)).toEqual([0, 2]);
  });

  it("is refused for a loan that is not open, or a treasury that cannot cover the balance", () => {
    const state = cityWithLimit();
    apply(state, "TakeLoan", { principal: 40_000_000, termMonths: TEN_YEARS });
    expect(refusal(state, "RepayLoan", { loan: 7 })).toBe("The city has no open loan 7");
    expect(refusal(state, "RepayLoan", {})).toBe("RepayLoan payload.loan must be a loan's id");
    fundCity(state, 1_000_000);
    expect(refusal(state, "RepayLoan", { loan: 0 })).toMatch(/^Costs \$40M, \$2M available$/);
  });
});

describe("loans in play", () => {
  it("replays a town that borrows and repays to the same state hash, and saves and loads the same", () => {
    const { state: town } = budgetTown(12);
    const start = cloneState(town);
    const live = cloneState(start);
    const from = live.log.length;
    const limit = creditLimit(live);
    expect(limit).toBeGreaterThan(10_000);
    expect(submit(live, command("TakeLoan", { principal: Math.floor(limit / 2), termMonths: TWENTY_YEARS })).ok).toBe(true);
    const end = live.tick + 75 * DAY;
    let repaid = false;
    while (live.tick < end) {
      if (!repaid && live.tick === start.tick + 50 * DAY) {
        expect(submit(live, command("RepayLoan", { loan: 0 })).ok).toBe(true);
        live.speed = 0;
        step(live);
        live.speed = 1;
        expect(submit(live, command("TakeLoan", { principal: Math.floor(limit / 4), termMonths: TEN_YEARS }))).toEqual({ ok: true });
        repaid = true;
      }
      step(live);
    }
    const log = live.log.slice(from);
    expect(log.map((e) => e.type)).toEqual(["TakeLoan", "RepayLoan", "TakeLoan"]);
    expect(loansOf(live.budget).map((l) => l.id)).toEqual([1]);
    expect(hashState(replayFrom(start, log, live.tick))).toBe(hashState(live));
    // Saved and loaded mid-way, it steps on to the same city.
    let state = cloneState(start);
    let next = 0;
    while (state.tick < live.tick) {
      if (state.tick === start.tick + 31 * DAY + 13) state = deserialize(serialize(state)).state;
      for (let e = log[next]; e && e.tick <= state.tick; e = log[++next]) enqueue(state, e);
      step(state);
    }
    expect(hashState(state)).toBe(hashState(live));
  });
});
