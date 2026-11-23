// The client benches' and the soak's side of the time budgets (issue
// #232). The same as packages/sim/test/budget.ts, which the client may not
// import (CLAUDE.md rule 1): the judging itself is the sim's `judgeBudget`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { budgetFigure, judgeBudget, type BudgetRow, type BudgetTimings } from "@city-council/sim";

/** The mark that lets `scripts/budget-retry.mjs` run a missed budget once more. */
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

/** Holds one case to figure `id` of the sim's `balance/budgets.json`, softly, and records its row. */
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

/** Appends `row` to `$BUDGET_ROWS/attempt-<n>.jsonl` for the CI headroom table; nothing without `BUDGET_ROWS`. */
export function recordBudgetRow(row: BudgetRow): void {
  const dir = process.env["BUDGET_ROWS"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `attempt-${process.env["BUDGET_ATTEMPT"] ?? "1"}.jsonl`), `${JSON.stringify(row)}\n`);
}
