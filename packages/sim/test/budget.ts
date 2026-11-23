// Helpers for the benches' time budgets (issues #231 and #232).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { budgetFigure, judgeBudget, type BudgetRow, type BudgetTimings } from "../src/index";

/**
 * The message for a check that holds a time to a budget. The mark tells
 * `scripts/budget-retry.mjs` that the failure may be a pause of the runner,
 * so it runs the file once more; a failure without it fails the run at once.
 */
export const budget = (name: string): string => `[budget] ${name}`;

/**
 * Each case's figure on the code before the change, by figure and case:
 * the rows of the base's bench, which CI runs on the same machine first
 * and names in `BUDGET_BASE` (a JSON lines file, issue #319). The smallest
 * of a case's rows, so a pause in the base's run does not widen what the
 * change may take. A row that held another statistic or unit than the
 * figure does now is left out: the change moved what the figure measures,
 * and the two numbers are not the same thing. Empty without `BUDGET_BASE`,
 * as on a developer's machine.
 */
let baseRows: Map<string, number> | undefined;
function baseOf(id: string, caseName: string): number | undefined {
  if (!baseRows) {
    baseRows = new Map();
    const path = process.env["BUDGET_BASE"];
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const row = JSON.parse(line) as Partial<BudgetRow>;
        if (typeof row.figure !== "string" || typeof row.case !== "string" || typeof row.measured !== "number") continue;
        const key = `${row.figure}\u0000${row.case}\u0000${row.statistic}\u0000${row.unit}`;
        baseRows.set(key, Math.min(baseRows.get(key) ?? Infinity, row.measured));
      }
    }
  }
  const figure = budgetFigure(id);
  return baseRows.get(`${id}\u0000${caseName}\u0000${figure.statistic}\u0000${figure.unit}`);
}

/**
 * Holds one case to figure `id` of `balance/budgets.json`: the figure says
 * the budget, which statistic of `measured` it holds, and whether a miss
 * fails the run. The row goes to the CI headroom table
 * (`scripts/budget-table.mjs`) when `scripts/budget-retry.mjs` runs the
 * bench. The check is soft, so a miss still lets every later case be
 * measured and put in the table. On CI the bench of the code before the
 * change runs first on the same machine, and a case over its budget that
 * is no slower than it was there does not fail (`judgeBudget`).
 */
export function hold(id: string, caseName: string, measured: number | BudgetTimings): BudgetRow {
  const row = judgeBudget(id, caseName, measured, baseOf(id, caseName));
  recordBudgetRow(row);
  // Over its budget, but no slower than the code before the change on this
  // machine: shown in the table, and not this change's to fail on.
  if (row.mode === "blocks" && !row.inherited) {
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
