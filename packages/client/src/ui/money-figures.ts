// What the time card and the activity log say about money (M4-14). Display
// only: everything here reads the client's read-only copy and nothing feeds
// back into state.

import { expensesOf, formatMoneyFull, formatMoneyShort, incomeOf, type BudgetState } from "@city-council/sim";

/** The treasury as the time card shows it, such as "$3.2B" or "-$480K", or "-" before a city is open, like the date. */
export function formatTreasury(treasury: number | null): string {
  return treasury === null ? "-" : formatMoneyShort(treasury);
}

/** A net figure with its sign, such as "+$1.2M" or "-$40K". */
function signed(dollars: number): string {
  return dollars > 0 ? `+${formatMoneyShort(dollars)}` : formatMoneyShort(dollars);
}

/**
 * The treasury's tooltip: the balance in full, then the month in progress
 * from the ledger, income and expenses so far and the net. Each line on its
 * own, as the demand bars' tooltips set theirs out.
 */
export function formatTreasuryTitle(budget: Pick<BudgetState, "treasury" | "month"> | null): string {
  if (budget === null) return "The city's money";
  const income = incomeOf(budget.month);
  const expenses = expensesOf(budget.month);
  const balance = budget.treasury < 0 ? `Treasury ${formatMoneyFull(budget.treasury)}, overdrawn` : `Treasury ${formatMoneyFull(budget.treasury)}`;
  return [balance, "This month so far:", `Income ${formatMoneyShort(income)}`, `Expenses ${formatMoneyShort(expenses)}`, `Net ${signed(income - expenses)}`].join("\n");
}

/**
 * The money a log entry's command moved, as the log names it: "$1.4M" for a
 * cost, "+$12K" for one that paid into the treasury, such as a bulldoze
 * refunded more than its demolition or an undone road, and "" for none.
 * `spent` is the entry's `logSpent`: whole dollars taken, below zero for paid in.
 */
export function formatLogAmount(spent: number | undefined): string {
  if (spent === undefined || spent === 0) return "";
  return spent > 0 ? formatMoneyShort(spent) : `+${formatMoneyShort(-spent)}`;
}
