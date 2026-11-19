// The time budgets the benches and the soak hold, from
// `balance/budgets.json` (issue #232), and how a measured figure is judged
// against one. Nothing in a tick reads these: they are for the benches, the
// soak and the CI table, and live here so the client's benches and soak
// reach them through the sim's entry like any other number (CLAUDE.md
// rules 1 and 10). They are not game balance, so the balance stamp leaves
// them out.

import file from "../balance/budgets.json" with { type: "json" };

/** Which number of a case's timings a figure holds. */
export type BudgetStatistic = "mean" | "p50" | "p99" | "max" | "ratio" | "count over";

/** One held figure as written in the budgets file. */
export interface BudgetFigure {
  name: string;
  unit: "ms" | "ratio" | "steps";
  statistic: BudgetStatistic;
  /** Milliseconds, a share, or for `count over` the steps allowed past `overMs`. */
  budget: number;
  /** For `count over`: how long a step must take to count, in milliseconds. */
  overMs?: number;
  /** A miss fails the run, or only shows in the table. */
  mode: "blocks" | "reports";
  source: string;
}

/** One case judged against its figure: a row of the CI table. */
export interface BudgetRow {
  /** The figure's id in the budgets file. */
  figure: string;
  /** The bench case or soak source measured. */
  case: string;
  statistic: BudgetStatistic;
  unit: BudgetFigure["unit"];
  measured: number;
  budget: number;
  /** Budget over measured; null when nothing was measured past zero. */
  headroom: number | null;
  mode: BudgetFigure["mode"];
  pass: boolean;
}

const STATISTICS: readonly BudgetStatistic[] = ["mean", "p50", "p99", "max", "ratio", "count over"];
const UNITS: readonly BudgetFigure["unit"][] = ["ms", "ratio", "steps"];

/** The budgets file, checked when the module loads. */
function check(raw: unknown): { warnBelowHeadroom: number; figures: Readonly<Record<string, BudgetFigure>> } {
  const f = raw as { warnBelowHeadroom?: unknown; figures?: Record<string, Partial<BudgetFigure>> };
  if (typeof f.warnBelowHeadroom !== "number" || !(f.warnBelowHeadroom > 1)) throw new Error("budgets.json: warnBelowHeadroom must be a number over 1");
  if (typeof f.figures !== "object" || f.figures === null) throw new Error("budgets.json: no figures");
  for (const [id, b] of Object.entries(f.figures)) {
    const bad = (why: string) => new Error(`budgets.json: ${id}: ${why}`);
    if (typeof b.name !== "string" || b.name === "") throw bad("no name");
    if (!b.unit || !UNITS.includes(b.unit)) throw bad(`unit must be one of ${UNITS.join(", ")}`);
    if (!b.statistic || !STATISTICS.includes(b.statistic)) throw bad(`statistic must be one of ${STATISTICS.join(", ")}`);
    if (typeof b.budget !== "number" || !(b.budget > 0)) throw bad("budget must be a number over 0");
    if (b.mode !== "blocks" && b.mode !== "reports") throw bad("mode must be blocks or reports");
    if (typeof b.source !== "string" || b.source === "") throw bad("no source");
    if ((b.statistic === "count over") !== (typeof b.overMs === "number")) throw bad("overMs goes with count over, and only with it");
    if (b.statistic === "count over" && (b.unit !== "steps" || !Number.isInteger(b.budget))) throw bad("count over counts whole steps");
    if (b.statistic === "ratio" && b.unit !== "ratio") throw bad("a ratio's unit is ratio");
  }
  return { warnBelowHeadroom: f.warnBelowHeadroom, figures: f.figures as Record<string, BudgetFigure> };
}

const BUDGETS_FILE = check(file);

/** Every held figure, by id. */
export const BUDGETS: Readonly<Record<string, BudgetFigure>> = BUDGETS_FILE.figures;

/** Headroom under which CI warns about a figure. */
export const BUDGET_WARN_BELOW_HEADROOM: number = BUDGETS_FILE.warnBelowHeadroom;

/** The figure with this id. Throws for one the file does not list, so a typo fails the bench. */
export function budgetFigure(id: string): BudgetFigure {
  const figure = BUDGETS[id];
  if (!figure) throw new Error(`budgets.json lists no figure ${id}`);
  return figure;
}

/** The timings of a case, as a bench result gives them. */
export type BudgetTimings = { readonly [K in "mean" | "p50" | "p99" | "max"]?: number | undefined };

/**
 * Judges one case against figure `id`. `measured` is the case's timings,
 * from which the figure's statistic is taken, or the number itself for a
 * ratio or a count. A time or a ratio passes under the budget, a count at
 * or under it.
 */
export function judgeBudget(id: string, caseName: string, measured: number | BudgetTimings): BudgetRow {
  const figure = budgetFigure(id);
  let value: number | undefined;
  if (typeof measured === "number") {
    if (figure.statistic !== "ratio" && figure.statistic !== "count over") throw new Error(`${id} holds the ${figure.statistic}: pass the case's timings, not a number`);
    value = measured;
  } else {
    if (figure.statistic === "ratio" || figure.statistic === "count over") throw new Error(`${id} holds a ${figure.statistic}: pass the number`);
    value = measured[figure.statistic];
  }
  if (value === undefined || !Number.isFinite(value)) throw new Error(`${id}: ${caseName} has no ${figure.statistic}`);
  const pass = figure.statistic === "count over" ? value <= figure.budget : value < figure.budget;
  return {
    figure: id,
    case: caseName,
    statistic: figure.statistic,
    unit: figure.unit,
    measured: value,
    budget: figure.budget,
    headroom: value > 0 ? figure.budget / value : null,
    mode: figure.mode,
    pass,
  };
}
