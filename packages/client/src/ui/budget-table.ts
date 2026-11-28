// What the budget panel shows (issue M4-15), worked out from the ledger the
// sim keeps and nothing else. Pure, so the table is checked without a page.
// Display only: nothing here writes state, and every figure is the sim's
// own, a ledger line or the sim's sum of them.

import {
  CHARGE_LINES,
  CHARGE_ZONES,
  ECONOMY,
  ECONOMY_SLIDERS,
  HISTORY_LENGTH,
  INCOME_LINES,
  LEDGER_LINES,
  LINE,
  TAX_LINES,
  TIME_BALANCE,
  expensesOf,
  gameDate,
  incomeOf,
  type ChargeZone,
  type EconomySlider,
  type LedgerLine,
  type StatsState,
} from "@city-council/sim";
import { lastSamples, monthShort, newestMonth } from "./stat-series";

export { moneyTicks } from "./stat-series";

/** What each ledger line is called in the panel. */
export const LINE_LABELS: Record<LedgerLine, string> = {
  taxResidential: "Residential",
  taxCommercial: "Commercial",
  taxOffice: "Office",
  taxIndustrial: "Industrial",
  chargeResidential: "Residential",
  chargeCommercial: "Commercial",
  chargeOffice: "Office",
  chargeIndustrial: "Industrial",
  chargeMixed: "Mixed",
  grants: "Grants",
  loansTaken: "Loans taken",
  construction: "Construction",
  demolition: "Demolition",
  compensation: "Compensation",
  roadUpkeep: "Road upkeep",
  buildingUpkeep: "Building upkeep",
  loanRepayments: "Loan repayments",
  interest: "Interest",
  otherSpending: "Other city spending",
};

/** One line of the table: a ledger line and what it moved last month and this month so far, whole dollars. */
export interface BudgetRow {
  line: LedgerLine;
  label: string;
  last: number;
  now: number;
}

/** A run of lines under a heading, such as the four taxes. */
export interface BudgetGroup {
  /** Its heading, or null for lines that stand alone, such as grants. */
  heading: string | null;
  rows: BudgetRow[];
}

/** A month's two figures, last month's and this month's so far. */
export interface MonthPair {
  last: number;
  now: number;
}

export interface BudgetTable {
  income: BudgetGroup[];
  expenses: BudgetGroup[];
  totalIncome: MonthPair;
  totalExpenses: MonthPair;
  /** Income less expenses: what the month moved the treasury by. */
  net: MonthPair;
}

function row(line: LedgerLine, lastMonth: ArrayLike<number>, month: ArrayLike<number>): BudgetRow {
  const at = LINE[line];
  return { line, label: LINE_LABELS[line], last: lastMonth[at] ?? 0, now: month[at] ?? 0 };
}

/**
 * The panel's table from a ledger: income by tax, by development charge
 * per zone, apart from the taxes as the PRD asks, then grants and loans,
 * and every expense line, each with last month's figure and this month's
 * so far, the totals and the net. Every ledger line is in it once.
 */
export function budgetTable(budget: { month: ArrayLike<number>; lastMonth: ArrayLike<number> }): BudgetTable {
  const { month, lastMonth } = budget;
  const r = (line: LedgerLine) => row(line, lastMonth, month);
  const grouped = new Set<LedgerLine>([...TAX_LINES, ...CHARGE_LINES]);
  const income: BudgetGroup[] = [
    { heading: "Taxes", rows: TAX_LINES.map(r) },
    { heading: "Development charges", rows: CHARGE_LINES.map(r) },
    { heading: null, rows: LEDGER_LINES.slice(0, INCOME_LINES).filter((l) => !grouped.has(l)).map(r) },
  ];
  const expenses: BudgetGroup[] = [{ heading: null, rows: LEDGER_LINES.slice(INCOME_LINES).map(r) }];
  const ledger = (a: ArrayLike<number>) => Float64Array.from(a);
  const last = ledger(lastMonth);
  const now = ledger(month);
  const totalIncome = { last: incomeOf(last), now: incomeOf(now) };
  const totalExpenses = { last: expensesOf(last), now: expensesOf(now) };
  return { income, expenses, totalIncome, totalExpenses, net: { last: totalIncome.last - totalExpenses.last, now: totalIncome.now - totalExpenses.now } };
}

/** The columns' names for a copy at `tick`: the month that closed last and the one in progress, such as "Mar" and "Apr so far". */
export function monthColumns(tick: number): { last: string; now: string } {
  const d = gameDate(tick);
  const now = d.month - 1;
  return { last: monthShort(now + 11), now: `${monthShort(now)} so far` };
}

/** Month number `month`, as `newestMonth` counts and from -1 for the month before the first, as "Mar, Year 2". */
export function monthLabel(month: number): string {
  return `${monthShort(((month % 12) + 12) % 12)}, Year ${Math.floor(month / 12) + TIME_BALANCE.firstYear}`;
}

/** A tax rate as the panel writes it: 0.015 as "1.5%". */
export function formatRate(rate: number): string {
  return `${Math.round(rate * 10000) / 100}%`;
}

/** A development charge as the panel writes it: "$150/m²". */
export function formatCharge(rate: number): string {
  return `$${rate.toLocaleString("en-US")}/m²`;
}

/**
 * The step of a tax slider: a twentieth of a percent, so every default in
 * economy.json lies on it (the residential default is 1.65% since M4-19).
 * A range input snaps its value to its step, so a default off the step
 * could never be set again once the slider moved (M4 review, #456).
 */
export const TAX_STEP = 0.0005;

/** A tax slider's value as a rate the sim takes, on the slider's step, clear of float noise. */
export function taxRateOfSlider(value: number): number {
  const rate = Math.round(value / TAX_STEP) / Math.round(1 / TAX_STEP);
  return rate === 0 ? 0 : rate;
}

const TAX_NOTES: Record<EconomySlider, string> = {
  residential: "A yearly share of each home's value, mixed buildings' homes too. Higher pulls residential demand and residents' satisfaction down.",
  commercial: "A share of shops' sales, mixed buildings' shops too. Higher pulls commercial demand down.",
  office: "A share of offices' output. Higher pulls office demand down.",
  industrial: "A share of factories' output. Higher pulls industrial demand down.",
};

const ZONE_NAMES: Record<ChargeZone, string> = { residential: "Residential", commercial: "Commercial", office: "Office", industrial: "Industrial", mixed: "Mixed" };

/** One tax slider: what it sets, its range from economy.json and what it does, in one line. */
export interface TaxSlider {
  zone: EconomySlider;
  label: string;
  min: number;
  max: number;
  default: number;
  note: string;
}

/** One development charge slider, the same. */
export interface ChargeSlider {
  zone: ChargeZone;
  label: string;
  min: number;
  max: number;
  default: number;
  note: string;
}

export const TAX_SLIDERS: readonly TaxSlider[] = ECONOMY_SLIDERS.map((zone) => ({ zone, label: ZONE_NAMES[zone], ...ECONOMY.taxRates[zone], note: TAX_NOTES[zone] }));

export const CHARGE_SLIDERS: readonly ChargeSlider[] = CHARGE_ZONES.map((zone) => ({
  zone,
  label: ZONE_NAMES[zone],
  ...ECONOMY.developmentCharges[zone],
  note: `Paid once on each square metre a new ${zone} building adds. Higher slows ${zone} building.`,
}));

/** One month of the graph: what came in and went out in a month that closed, and the treasury at its close, whole dollars. */
export interface MoneyMonth {
  /** Months since January of the first year, as `newestMonth` counts, of the month the figures are for. */
  month: number;
  income: number;
  expenses: number;
  treasury: number;
}

/**
 * The last `months` closed months of the money history, oldest first, from
 * the city's first month on. Each
 * sample is taken on a month's first tick and holds the month just closed:
 * its income and expenses, and the treasury the new month opened with,
 * which is the closed month's last.
 */
export function moneyMonths(stats: Pick<StatsState, "money" | "next">, tick: number, months = 12): MoneyMonth[] {
  const ring = (name: "income" | "expenses" | "treasury") => lastSamples({ values: stats.money[name], next: stats.next, capacity: HISTORY_LENGTH }, months);
  const income = ring("income");
  const expenses = ring("expenses");
  const treasury = ring("treasury");
  // The newest sample was taken at the start of the month in progress, so it holds the month before.
  const newest = newestMonth(tick) - 1;
  const n = income.length;
  // The month before the first holds only the starting grant, which would flatten every month after it: the graph starts with play.
  return income.map((value, k) => ({ month: newest - (n - 1 - k), income: value, expenses: expenses[k] ?? 0, treasury: treasury[k] ?? 0 })).filter((m) => m.month >= 0);
}

