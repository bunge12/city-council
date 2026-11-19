// The client benches' and the soak's side of the time budgets (issue
// #232). The same as packages/sim/test/budget.ts, which the client may not
// import (CLAUDE.md rule 1): the judging itself is the sim's `judgeBudget`.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { judgeBudget, type BudgetRow, type BudgetTimings } from "@city-council/sim";

/** The mark that lets `scripts/budget-retry.mjs` run a missed budget once more. */
export const budget = (name: string): string => `[budget] ${name}`;

/** Holds one case to figure `id` of the sim's `balance/budgets.json`, softly, and records its row. */
export function hold(id: string, caseName: string, measured: number | BudgetTimings): BudgetRow {
  const row = judgeBudget(id, caseName, measured);
  recordBudgetRow(row);
  if (row.mode === "blocks") {
    const check = expect.soft(row.measured, budget(caseName));
    if (row.statistic === "count over") check.toBeLessThanOrEqual(row.budget);
    else check.toBeLessThan(row.budget);
  }
  return row;
}

/** Appends `row` to `$BUDGET_ROWS/attempt-<n>.jsonl` for the CI headroom table; nothing without `BUDGET_ROWS`. */
export function recordBudgetRow(row: BudgetRow): void {
  const dir = process.env["BUDGET_ROWS"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `attempt-${process.env["BUDGET_ATTEMPT"] ?? "1"}.jsonl`), `${JSON.stringify(row)}\n`);
}
