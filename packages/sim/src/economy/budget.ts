// The treasury and the month's budget (M4-02, PRD "M4 Economy").
//
// One treasury per city, in whole dollars, and a ledger of what moved it:
// one float64 per line for the month in progress and one for the month
// before. `moveMoney` is the only thing that writes either, so the treasury
// is always the month's opening balance plus the month's income less its
// expenses. The step that advances the tick onto the first tick of a game
// month files the month in progress as the month before and starts a new
// one at zero (`closeMonthOn`), before anything happens on the new tick: a
// command applied on that tick, paused or not, moves money in the new
// month. The statistics sample on that tick, so the history holds each
// closed month (stats/stats.ts).
//
// Tick 0 is a month's first tick too, and no step advances onto it. A new
// city's starting grant goes on the grants line and is filed at once as
// the month before the first, so every month the history holds, the first
// included, has its treasury equal to the one before plus its income less
// its expenses.

import { isMonthStart, yearDays } from "../calendar";
import type { SimState } from "../state";
import { CHARGE_ZONES, ECONOMY, ECONOMY_SLIDERS } from "./balance";
import { chargeLoans, checkLoans } from "./loans";

/**
 * The ledger's lines, in the order state holds them: income first, then
 * expenses. Development charges have one line per zone, mixed included,
 * since a mixed building is one project (M4-08). `otherSpending`
 * is the city's spending on what has no building yet, per resident, which
 * M8 and M9 replace a service at a time (M4.md, "Spending that has no
 * building yet"). A line no M4 issue fills yet stays at zero. The order is
 * the shape of a save: a change is a change of the snapshot version.
 */
export const LEDGER_LINES = [
  "taxResidential",
  "taxCommercial",
  "taxOffice",
  "taxIndustrial",
  "chargeResidential",
  "chargeCommercial",
  "chargeOffice",
  "chargeIndustrial",
  "chargeMixed",
  "grants",
  "loansTaken",
  "construction",
  "demolition",
  "compensation",
  "roadUpkeep",
  "buildingUpkeep",
  "loanRepayments",
  "interest",
  "otherSpending",
] as const;
export type LedgerLine = (typeof LEDGER_LINES)[number];

/** How many of `LEDGER_LINES`, from the first, are income. The rest are expenses. */
export const INCOME_LINES = 11;

/** Each line's place in the ledger arrays. */
export const LINE: Readonly<Record<LedgerLine, number>> = Object.freeze(Object.fromEntries(LEDGER_LINES.map((name, i) => [name, i])) as Record<LedgerLine, number>);

/** The four tax lines, in `ECONOMY_SLIDERS` order. */
export const TAX_LINES: readonly LedgerLine[] = ["taxResidential", "taxCommercial", "taxOffice", "taxIndustrial"];

/** The five development charge lines, in `CHARGE_ZONES` order (M4-08). */
export const CHARGE_LINES: readonly LedgerLine[] = ["chargeResidential", "chargeCommercial", "chargeOffice", "chargeIndustrial", "chargeMixed"];

/** Whether line `line` is income: money in. Otherwise it is an expense, money out. */
export function isIncome(line: LedgerLine): boolean {
  return LINE[line] < INCOME_LINES;
}

/** The city's money. Plain numbers and typed arrays (CLAUDE.md rule 7). Part of `SimState`. */
export interface BudgetState {
  /** Whole dollars. May fall below zero, down to the overdraft, which issue M4-03 enforces. */
  treasury: number;
  /** The treasury as the month in progress opened. A new city's first month opens with its grant. */
  opening: number;
  /** By line, in `LEDGER_LINES` order: whole dollars moved this month, each income or expense counted as a positive amount. */
  month: Float64Array;
  /** The same for the month that last closed. All 0 until the first close. */
  lastMonth: Float64Array;
  /** The four tax rates, in `ECONOMY_SLIDERS` order, as fractions. Set by `SetTaxRate` (M4-07). */
  taxRates: Float64Array;
  /**
   * The five development charges, in `CHARGE_ZONES` order: whole dollars
   * per square metre of floor space a new building adds (M4-08). Set by
   * `SetDevelopmentCharge`.
   */
  chargeRates: Float64Array;
  /**
   * The open loans, oldest first, `LOAN_STRIDE` numbers each in
   * `LOAN_FIELDS` order (economy/loans.ts, M4-11). Replaced when a loan is
   * taken or closed; a close writes the balances in place.
   */
  loans: Float64Array;
  /** The id the next loan taken gets: how many the city has taken. */
  nextLoan: number;
}

/**
 * A new city's budget: the starting grant on the grants line of the month
 * before the first, filed, a first month with nothing on it yet, and the
 * tax rates at their defaults.
 */
export function createBudget(): BudgetState {
  const budget = emptyBudget(0);
  moveInto(budget, "grants", ECONOMY.startingGrant);
  closeMonth(budget);
  return budget;
}

/**
 * A budget holding `treasury` with nothing on any line, the tax rates and
 * development charges at their defaults and no loans: what the
 * version 30 migration gives a city saved before the treasury, with the
 * starting grant as its opening balance, by way of version 33's.
 */
export function emptyBudget(treasury: number): BudgetState {
  return {
    treasury,
    opening: treasury,
    month: new Float64Array(LEDGER_LINES.length),
    lastMonth: new Float64Array(LEDGER_LINES.length),
    taxRates: Float64Array.from(ECONOMY_SLIDERS, (slider) => ECONOMY.taxRates[slider].default),
    ...chargesAtDefaults(),
    ...noLoans(),
  };
}

/** The version 38 fields (M4-11): no loans open, and none taken. */
export function noLoans(): Pick<BudgetState, "loans" | "nextLoan"> {
  return { loans: new Float64Array(0), nextLoan: 0 };
}

/** The version 33 field (M4-08): the development charges at their defaults. */
export function chargesAtDefaults(): Pick<BudgetState, "chargeRates"> {
  return { chargeRates: Float64Array.from(CHARGE_ZONES, (zone) => ECONOMY.developmentCharges[zone].default) };
}

/**
 * Moves `amount` whole dollars on line `line`: into the treasury for an
 * income line, out of it for an expense. A negative amount moves the other
 * way and takes the line down, as a refund or an undo does. The only
 * function that writes the treasury or the ledger.
 */
export function moveMoney(state: SimState, line: LedgerLine, amount: number): void {
  moveInto(state.budget, line, amount);
}

function moveInto(budget: BudgetState, line: LedgerLine, amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`money moves in whole dollars, not ${amount}`);
  const index = LINE[line];
  if (index === undefined) throw new RangeError(`no ledger line "${line}"`);
  const treasury = budget.treasury + (index < INCOME_LINES ? amount : -amount);
  const total = (budget.month[index] as number) + amount;
  if (!Number.isSafeInteger(treasury) || !Number.isSafeInteger(total)) throw new RangeError(`moving ${amount} on ${line} leaves the whole dollars a float64 holds exactly`);
  budget.treasury = treasury;
  budget.month[index] = total;
}

/**
 * Sets the treasury of `state` to `treasury` whole dollars, the difference
 * on the grants line. For the generators, tests and walkthroughs that build
 * more than a starting grant pays for (M4-03): the scale cities, the
 * balance check's standard cities and the test builders, so they build
 * what they built before M4. Not a command and not in the log, so a replay
 * of a funded city starts from one funded the same way (`replayFrom`).
 */
export function fundCity(state: SimState, treasury: number): void {
  moveMoney(state, "grants", treasury - state.budget.treasury);
}

/** The sum of the income lines of `ledger`, a `month` or `lastMonth`. */
export function incomeOf(ledger: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < INCOME_LINES; i++) sum += ledger[i] as number;
  return sum;
}

/** The sum of the expense lines of `ledger`. */
export function expensesOf(ledger: Float64Array): number {
  let sum = 0;
  for (let i = INCOME_LINES; i < LEDGER_LINES.length; i++) sum += ledger[i] as number;
  return sum;
}

/** The sum of the four tax lines of `ledger`. Issue M4-11 reads a year of it from the history. */
export function taxIncomeOf(ledger: Float64Array): number {
  let sum = 0;
  for (const line of TAX_LINES) sum += ledger[LINE[line]] as number;
  return sum;
}

/** Files the month in progress as the month before and starts a new one at zero, opening at today's treasury. */
export function closeMonth(budget: BudgetState): void {
  budget.lastMonth.set(budget.month);
  budget.month.fill(0);
  budget.opening = budget.treasury;
}

/**
 * Day `day`'s share of `yearly` whole dollars, `day` counting from 0 on 1
 * January: floor(yearly × (day + 1) / D) less floor(yearly × day / D), D
 * the days of a game year. The days of a year add up to `yearly` exactly,
 * and no fraction of a dollar is stored between them. Issues M4-04 and
 * M4-05 charge upkeep and tax with it.
 *
 * Exact on every host (CLAUDE.md rule 6): `yearly × (day + 1)` is a whole
 * number below 2^53, so the product is exact, and a quotient of two whole
 * numbers that is not whole is at least 1 / D from one, far more than the
 * rounding of a correctly rounded division below 2^53 / D, so the floor is
 * the true one.
 */
export function dailyShare(yearly: number, day: number): number {
  const days = yearDays();
  if (!Number.isSafeInteger(yearly) || yearly < 0 || yearly > Math.floor(Number.MAX_SAFE_INTEGER / days)) {
    throw new RangeError(`a yearly amount is whole dollars from 0 to 2^53 / ${days}, not ${yearly}`);
  }
  if (!Number.isInteger(day) || day < 0 || day >= days) throw new RangeError(`a day of the year is from 0 to ${days - 1}, not ${day}`);
  return Math.floor((yearly * (day + 1)) / days) - Math.floor((yearly * day) / days);
}

/**
 * Closes the month when `state.tick` is a month's first tick. The step
 * calls it once, right after it advances the tick, so the close comes
 * before the buildings, commands and systems of the new tick, paused steps
 * on it included, and before the statistics sample the month it filed.
 * Each loan charges its repayment first, on the month that closes
 * (economy/loans.ts, M4-11).
 */
export function closeMonthOn(state: SimState): void {
  if (!isMonthStart(state.tick)) return;
  chargeLoans(state);
  closeMonth(state.budget);
}

/** The name the timer hook reports for the monthly close. */
export const BUDGET_SYSTEM = "budget";

// --- Copies, deltas and loading ----------------------------------------------------

/** A copy of `budget` that shares nothing with it. */
export function copyBudget(budget: BudgetState): BudgetState {
  return {
    treasury: budget.treasury,
    opening: budget.opening,
    month: budget.month.slice(),
    lastMonth: budget.lastMonth.slice(),
    taxRates: budget.taxRates.slice(),
    chargeRates: budget.chargeRates.slice(),
    loans: budget.loans.slice(),
    nextLoan: budget.nextLoan,
  };
}

/** Whether `a` and `b` hold the same numbers. For a host deciding whether the budget goes in a delta. */
export function sameBudget(a: BudgetState, b: BudgetState): boolean {
  return (
    a.treasury === b.treasury &&
    a.opening === b.opening &&
    sameArray(a.month, b.month) &&
    sameArray(a.lastMonth, b.lastMonth) &&
    sameArray(a.taxRates, b.taxRates) &&
    sameArray(a.chargeRates, b.chargeRates) &&
    sameArray(a.loans, b.loans) &&
    a.nextLoan === b.nextLoan
  );
}

function sameArray(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BUDGET_KEYS = ["treasury", "opening", "month", "lastMonth", "taxRates", "chargeRates", "loans", "nextLoan"];

/** Whether `ledger` is one whole dollar amount per line. A line may be below zero, where refunds took more off it than it held. */
function isLedger(ledger: unknown): boolean {
  if (!(ledger instanceof Float64Array) || ledger.length !== LEDGER_LINES.length) return false;
  for (const value of ledger) if (!Number.isSafeInteger(value)) return false;
  return true;
}

/**
 * Why `value` is not a well-formed `BudgetState`, or null if it is. For
 * loading a save and checking a delta: whole dollars everywhere, the
 * treasury equal to the opening balance plus the month's income less its
 * expenses, one amount per ledger line, a tax rate of at least 0 per
 * slider, a development charge of whole dollars per zone, and well-formed
 * loans (economy/loans.ts).
 */
export function checkBudget(value: unknown): string | null {
  if (!isRecord(value)) return "it is not an object";
  const keys = Object.keys(value);
  if (keys.length !== BUDGET_KEYS.length || BUDGET_KEYS.some((key, i) => keys[i] !== key)) return "it has missing or unknown fields";
  const { treasury, opening, month, lastMonth, taxRates, chargeRates, loans, nextLoan } = value;
  if (!Number.isSafeInteger(treasury) || !Number.isSafeInteger(opening)) return "its treasury is not whole dollars";
  if (!isLedger(month) || !isLedger(lastMonth)) return `its ledger is not ${LEDGER_LINES.length} whole dollar amounts a month in a Float64Array`;
  if ((opening as number) + incomeOf(month as Float64Array) - expensesOf(month as Float64Array) !== treasury) return "its treasury is not its opening balance plus the month's income less its expenses";
  if (!(taxRates instanceof Float64Array) || taxRates.length !== ECONOMY_SLIDERS.length) return `its tax rates are not ${ECONOMY_SLIDERS.length} numbers in a Float64Array`;
  // Not held to this build's ranges: a city saved under other balance numbers still loads.
  for (const rate of taxRates) if (!(Number.isFinite(rate) && rate >= 0)) return "its tax rates are not fractions of at least 0";
  if (!(chargeRates instanceof Float64Array) || chargeRates.length !== CHARGE_ZONES.length) return `its development charges are not ${CHARGE_ZONES.length} numbers in a Float64Array`;
  for (const rate of chargeRates) if (!(Number.isSafeInteger(rate) && rate >= 0)) return "its development charges are not whole dollars of at least 0";
  return checkLoans(loans, nextLoan);
}
