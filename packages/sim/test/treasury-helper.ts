// A watch on a city's money for long scripted sessions (M4-02). Made once
// and called after every step, it checks that the treasury is what the
// ledger says, that every month the budget closes is filed in the history
// as it stood, and that the treasury is where it started plus every dollar
// moved since. The issues that charge and pay (M4-03 onward) run their
// sessions under it.

import { expect } from "vitest";
import { expensesOf, incomeOf, taxIncomeOf } from "../src/economy/budget";
import { HISTORY_LENGTH, MONEY_SERIES, sampleCount } from "../src/stats/stats";
import type { SimState } from "../src/state";

export interface TreasuryWatch {
  /** Checks `state`, which must be the city the watch was made on, stepped any number of times since the last check but across no more than one month's close. */
  check(state: SimState): void;
  /** Months closed while watched. */
  readonly closes: number;
}

/** The newest money sample of `state`'s history, or null when it has none. */
function newestMoney(state: SimState): Record<(typeof MONEY_SERIES)[number], number> | null {
  const count = sampleCount(state.stats);
  if (count === 0) return null;
  const at = (state.stats.next - 1 + HISTORY_LENGTH) % HISTORY_LENGTH;
  return Object.fromEntries(MONEY_SERIES.map((name) => [name, state.stats.money[name][at] ?? 0])) as Record<(typeof MONEY_SERIES)[number], number>;
}

/**
 * A watch on `state`'s money from now. A new city's watch starts from a
 * treasury of 0 at its opening balance, so its starting grant is a dollar
 * moved like any other.
 */
export function watchTreasury(state: SimState): TreasuryWatch {
  // The treasury the month in progress opened at, less everything closed while watched, is where the watch began.
  const start = state.budget.opening;
  let filed = 0;
  let closes = 0;
  let seenNext = state.stats.next;
  let seenCount = sampleCount(state.stats);
  let lastSample = newestMoney(state);
  // A sample already in the history may come from before the money (a migrated city): the chain starts at the first one watched.
  let chained = false;
  return {
    get closes() {
      return closes;
    },
    check(now: SimState) {
      const b = now.budget;
      for (const ledger of [b.month, b.lastMonth]) for (const dollars of ledger) expect(Number.isSafeInteger(dollars), "a ledger line holds whole dollars").toBe(true);
      expect(Number.isSafeInteger(b.treasury), "the treasury holds whole dollars").toBe(true);
      expect(b.treasury, "the treasury is the month's opening balance plus its income less its expenses").toBe(b.opening + incomeOf(b.month) - expensesOf(b.month));
      const count = sampleCount(now.stats);
      if (now.stats.next !== seenNext || count !== seenCount) {
        // A month closed, and the statistics sampled it straight after.
        closes++;
        const sample = newestMoney(now);
        expect(sample).not.toBeNull();
        expect(sample?.treasury, "the sample's treasury is the treasury at the close").toBe(b.opening);
        expect(sample?.income).toBe(incomeOf(b.lastMonth));
        expect(sample?.expenses).toBe(expensesOf(b.lastMonth));
        expect(sample?.taxIncome).toBe(taxIncomeOf(b.lastMonth));
        if (chained && lastSample && sample) {
          expect(sample.treasury, "each month's treasury is the one before plus its income less its expenses").toBe(lastSample.treasury + sample.income - sample.expenses);
        }
        filed += incomeOf(b.lastMonth) - expensesOf(b.lastMonth);
        lastSample = sample;
        chained = true;
        seenNext = now.stats.next;
        seenCount = count;
      }
      expect(b.treasury, "the treasury is where the watch began plus every dollar moved since").toBe(start + filed + incomeOf(b.month) - expensesOf(b.month));
    },
  };
}
