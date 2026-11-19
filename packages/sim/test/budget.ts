// Helpers for the benches' time budgets (issues #231 and #232).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { judgeBudget, type BudgetRow, type BudgetTimings } from "../src/index";

/**
 * The message for a check that holds a time to a budget. The mark tells
 * `scripts/budget-retry.mjs` that the failure may be a pause of the runner,
 * so it runs the file once more; a failure without it fails the run at once.
 */
export const budget = (name: string): string => `[budget] ${name}`;

/**
 * Holds one case to figure `id` of `balance/budgets.json`: the figure says
 * the budget, which statistic of `measured` it holds, and whether a miss
 * fails the run. The row goes to the CI headroom table
 * (`scripts/budget-table.mjs`) when `scripts/budget-retry.mjs` runs the
 * bench. The check is soft, so a miss still lets every later case be
 * measured and put in the table.
 */
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

/**
 * Appends `row` to `$BUDGET_ROWS/attempt-<n>.jsonl`, where budget-retry
 * points `BUDGET_ROWS`. A run without it, a bench started by hand say,
 * writes nothing. The client keeps the same function in its
 * test/budget.ts, since it may not import the sim's tests (rule 1).
 */
export function recordBudgetRow(row: BudgetRow): void {
  const dir = process.env["BUDGET_ROWS"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `attempt-${process.env["BUDGET_ATTEMPT"] ?? "1"}.jsonl`), `${JSON.stringify(row)}\n`);
}

/**
 * A full garbage collection, run before each held case so the garbage the
 * setup or the case before it left is not collected inside this case's runs.
 * A collection the case itself causes on every call still shows. The bench
 * runs with `--expose-gc` (vitest.config.ts).
 */
export function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("the benches need node's --expose-gc, set in vitest.config.ts");
  gc();
}
