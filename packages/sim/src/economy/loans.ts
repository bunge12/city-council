// Borrowing (M4-11, PRD "Borrowing").
//
// The city may hold up to `loans.maxOpen` loans at once, each on one of the
// terms economy.json offers, at that term's rate. A loan pays its principal
// into the treasury on the loans line the tick `TakeLoan` applies. From the
// close after the month it was taken, each monthly close charges its
// repayment on the month that closes: the month's interest on the interest
// line and the rest on the repayment line. A repayment is charged whatever
// the treasury holds, since a debt does not wait, so it can take the
// treasury past the overdraft, and spending stays blocked until it
// recovers (economy/spend.ts). `RepayLoan` pays one off early, its balance
// on the repayment line.
//
// The credit limit bounds what the open loans owe together: whole dollars
// for each resident plus a multiple of the tax income of the last twelve
// months in the history, times a larger multiple once the city has opened
// `largerLoans` (progression.json).
//
// Exact on every host (CLAUDE.md rule 6). A month's interest is the floor of
// the balance times the annual rate over twelve. The fixed repayment is the
// floor of the annuity payment P r f / (f - 1), f = (1 + r)^n worked out by
// n multiplications, no `Math.pow`. The last month's payment takes whatever
// remains, so the balance ends at exactly zero, and a payment never takes
// more than the balance and its interest, so a loan whose floors made it
// short closes early rather than below zero.
//
// Loans live in the budget as one Float64Array, `LOAN_FIELDS` numbers per
// loan, oldest first (CLAUDE.md rule 7), so they go in the delta with it.

import { gameDate } from "../calendar";
import { isUnlocked } from "../progression/milestones";
import type { SimState } from "../state";
import { ECONOMY } from "./balance";
import { moveMoney, type BudgetState } from "./budget";
import { formatMoneyShort, spendingRefusal } from "./spend";

/** What each loan holds, in the order of its numbers in `BudgetState.loans`. */
export const LOAN_FIELDS = ["id", "taken", "principal", "annualRate", "termMonths", "monthsLeft", "balance", "repayment"] as const;
export type LoanField = (typeof LOAN_FIELDS)[number];

/** How many numbers each loan takes in `BudgetState.loans`. */
export const LOAN_STRIDE = LOAN_FIELDS.length;

const F: Readonly<Record<LoanField, number>> = Object.freeze(Object.fromEntries(LOAN_FIELDS.map((name, i) => [name, i])) as Record<LoanField, number>);

/** One open loan, read out of the budget. */
export interface Loan {
  /** Its number, from 0 for the city's first loan, never used again. `RepayLoan` names it. */
  id: number;
  /** The tick it was taken on. */
  taken: number;
  /** Whole dollars borrowed. */
  principal: number;
  /** The yearly rate, a fraction, from its offer in economy.json. */
  annualRate: number;
  /** Its term in months. */
  termMonths: number;
  /** Repayments still to come. */
  monthsLeft: number;
  /** Whole dollars still owed. */
  balance: number;
  /** The fixed monthly repayment, whole dollars. The last one takes what remains. */
  repayment: number;
}

/** How many loans `budget` holds. */
export function loanCount(budget: Pick<BudgetState, "loans">): number {
  return budget.loans.length / LOAN_STRIDE;
}

/** Loan `i` of `budget`, oldest first. */
export function loanAt(budget: Pick<BudgetState, "loans">, i: number): Loan {
  const at = i * LOAN_STRIDE;
  const read = (field: LoanField): number => budget.loans[at + F[field]] as number;
  return {
    id: read("id"),
    taken: read("taken"),
    principal: read("principal"),
    annualRate: read("annualRate"),
    termMonths: read("termMonths"),
    monthsLeft: read("monthsLeft"),
    balance: read("balance"),
    repayment: read("repayment"),
  };
}

/** Every open loan of `budget`, oldest first. */
export function loansOf(budget: Pick<BudgetState, "loans">): Loan[] {
  const out: Loan[] = [];
  for (let i = 0; i < loanCount(budget); i++) out.push(loanAt(budget, i));
  return out;
}

/** What the open loans of `budget` owe together, whole dollars. */
export function debtOf(budget: Pick<BudgetState, "loans">): number {
  let sum = 0;
  for (let i = 0; i < loanCount(budget); i++) sum += budget.loans[i * LOAN_STRIDE + F.balance] as number;
  return sum;
}

/**
 * The fixed monthly repayment in whole dollars of `principal` over
 * `termMonths` at `annualRate` a year: the floor of P r f / (f - 1), r the
 * monthly rate and f = (1 + r)^n by n multiplications; P / n at no
 * interest.
 */
export function monthlyRepayment(principal: number, annualRate: number, termMonths: number): number {
  if (!Number.isSafeInteger(principal) || principal < 0) throw new RangeError(`a principal is whole dollars of at least 0, not ${principal}`);
  if (!Number.isSafeInteger(termMonths) || termMonths < 1) throw new RangeError(`a term is a whole number of months of at least 1, not ${termMonths}`);
  const r = annualRate / 12;
  if (r === 0) return Math.floor(principal / termMonths);
  let f = 1;
  for (let i = 0; i < termMonths; i++) f *= 1 + r;
  return Math.floor((principal * r * f) / (f - 1));
}

/** A month's interest in whole dollars on `balance` at `annualRate` a year: the floor of the balance times the rate over twelve. */
export function monthInterest(balance: number, annualRate: number): number {
  return Math.floor((balance * annualRate) / 12);
}

/** The tax income of the last twelve months the history holds, or fewer for a young city, whole dollars. */
export function lastYearTaxIncome(state: SimState): number {
  const stats = state.stats;
  const series = stats.money.taxIncome;
  const count = series.length;
  let sum = 0;
  // `next` is where the next sample goes, so the newest is just before it, wrapping in a full ring.
  for (let k = 1; k <= Math.min(12, count); k++) sum += series[(stats.next - k + count) % count] as number;
  return sum;
}

/**
 * How much the open loans of `state` may owe together, whole dollars:
 * `perResident` for each resident plus `lastYearTaxMultiple` times the tax
 * income of the last twelve months, floored, times `largerLoansMultiple`
 * once the city has opened `largerLoans`.
 */
export function creditLimit(state: SimState): number {
  const weights = ECONOMY.creditLimit;
  const population = state.stats.totals["population"] ?? 0;
  const base = Math.floor(weights.perResident * population + weights.lastYearTaxMultiple * Math.max(0, lastYearTaxIncome(state)));
  return isUnlocked(state, "largerLoans") ? Math.floor(base * weights.largerLoansMultiple) : base;
}

/** What `state` may still borrow: its credit limit less what its open loans owe, never below 0. */
export function creditLeft(state: SimState): number {
  return Math.max(0, creditLimit(state) - debtOf(state.budget));
}

// --- The commands ----------------------------------------------------------------

/** A `TakeLoan` payload: whole dollars to borrow, and one of the terms economy.json offers. */
export interface TakeLoanPayload {
  principal: number;
  termMonths: number;
}

/** The checked payload of a `TakeLoan`, or why it is malformed whatever the state. */
export function takeLoanPayload(payload: unknown): TakeLoanPayload | string {
  if (typeof payload !== "object" || payload === null) return "TakeLoan needs a principal and a term";
  const { principal, termMonths } = payload as { principal?: unknown; termMonths?: unknown };
  if (!Number.isSafeInteger(principal) || (principal as number) < 1) return "TakeLoan payload.principal must be whole dollars of at least 1";
  const terms = ECONOMY.loans.offers.map((o) => o.termMonths);
  if (!terms.includes(termMonths as number)) return `TakeLoan payload.termMonths must be one of ${terms.join(", ")}`;
  return { principal: principal as number, termMonths: termMonths as number };
}

/**
 * Why `state` cannot take a loan of `principal` whole dollars over
 * `termMonths`, or null when it can: every slot taken, past the credit
 * limit, or so small that its whole-dollar repayment would not pay down
 * the balance after the first month's interest, which would leave a loan
 * that owes nothing until its last month and holds a slot meanwhile.
 */
export function loanRefusal(state: SimState, principal: number, termMonths: number): string | null {
  const offer = ECONOMY.loans.offers.find((o) => o.termMonths === termMonths);
  if (offer && monthlyRepayment(principal, offer.annualRate, termMonths) <= monthInterest(principal, offer.annualRate)) {
    return `A loan of ${formatMoneyShort(principal)} over ${termMonths} months is too small to repay in whole dollars`;
  }
  const max = ECONOMY.loans.maxOpen;
  if (loanCount(state.budget) >= max) return `The city has ${max} loans open, the most it may hold`;
  const left = creditLeft(state);
  if (principal > left) return `Borrowing ${formatMoneyShort(principal)} is past the credit limit, ${formatMoneyShort(left)} left to borrow`;
  return null;
}

/** Why a `TakeLoan` is refused in `state`, or null when it applies. */
export function checkTakeLoan(state: SimState, payload: unknown): string | null {
  const result = takeLoanPayload(payload);
  return typeof result === "string" ? result : loanRefusal(state, result.principal, result.termMonths);
}

/** Takes a checked loan: its principal on the loans line, and the loan on the end of the list. */
export function takeLoan(state: SimState, payload: TakeLoanPayload): void {
  const budget = state.budget;
  const offer = ECONOMY.loans.offers.find((o) => o.termMonths === payload.termMonths);
  if (!offer) throw new RangeError(`no loan offer of ${payload.termMonths} months`);
  const row = new Float64Array(LOAN_STRIDE);
  row[F.id] = budget.nextLoan;
  row[F.taken] = state.tick;
  row[F.principal] = payload.principal;
  row[F.annualRate] = offer.annualRate;
  row[F.termMonths] = offer.termMonths;
  row[F.monthsLeft] = offer.termMonths;
  row[F.balance] = payload.principal;
  row[F.repayment] = monthlyRepayment(payload.principal, offer.annualRate, offer.termMonths);
  const loans = new Float64Array(budget.loans.length + LOAN_STRIDE);
  loans.set(budget.loans);
  loans.set(row, budget.loans.length);
  budget.loans = loans;
  budget.nextLoan += 1;
  moveMoney(state, "loansTaken", payload.principal);
}

/** Where in `budget`'s list loan `id` is, or -1. */
function loanIndex(budget: BudgetState, id: number): number {
  for (let i = 0; i < loanCount(budget); i++) if (budget.loans[i * LOAN_STRIDE + F.id] === id) return i;
  return -1;
}

/** `budget.loans` without loan `i`. */
function withoutLoan(budget: BudgetState, i: number): Float64Array {
  const out = new Float64Array(budget.loans.length - LOAN_STRIDE);
  out.set(budget.loans.subarray(0, i * LOAN_STRIDE));
  out.set(budget.loans.subarray((i + 1) * LOAN_STRIDE), i * LOAN_STRIDE);
  return out;
}

/** The loan a `RepayLoan` payload names, `payload.loan` its id. */
function repayIdOf(payload: unknown): number | string {
  if (typeof payload !== "object" || payload === null) return "RepayLoan needs a loan";
  const { loan } = payload as { loan?: unknown };
  if (!Number.isSafeInteger(loan) || (loan as number) < 0) return "RepayLoan payload.loan must be a loan's id";
  return loan as number;
}

/** Why a `RepayLoan` is refused in `state`, or null when it applies: no open loan of that id, or a treasury that cannot cover its balance. */
export function checkRepayLoan(state: SimState, payload: unknown): string | null {
  const id = repayIdOf(payload);
  if (typeof id === "string") return id;
  const i = loanIndex(state.budget, id);
  if (i < 0) return `The city has no open loan ${id}`;
  return spendingRefusal(state, loanAt(state.budget, i).balance);
}

/** Pays off a checked `RepayLoan`: the loan's balance on the repayment line, and the loan closed. */
export function repayLoan(state: SimState, payload: unknown): void {
  const id = repayIdOf(payload);
  if (typeof id === "string") return;
  const budget = state.budget;
  const i = loanIndex(budget, id);
  if (i < 0) return;
  const balance = loanAt(budget, i).balance;
  budget.loans = withoutLoan(budget, i);
  if (balance !== 0) moveMoney(state, "loanRepayments", balance);
}

// --- The monthly charge ----------------------------------------------------------

/**
 * Charges every loan of `state` its repayment on the month closing as
 * `state.tick`, a month's first tick, opens the next: its interest on the
 * interest line and the rest on the repayment line. A loan taken in the
 * month that closes pays from the next close. The last of its term takes
 * whatever remains, and a loan paid down to zero closes. Run by the close
 * (economy/budget.ts) before it files the month.
 */
export function chargeLoans(state: SimState): void {
  const budget = state.budget;
  const count = loanCount(budget);
  if (count === 0 || state.tick === 0) return;
  const closing = gameDate(state.tick - 1);
  let closed = false;
  for (let i = 0; i < count; i++) {
    const at = i * LOAN_STRIDE;
    const taken = gameDate(budget.loans[at + F.taken] as number);
    if (taken.year === closing.year && taken.month === closing.month) continue;
    const balance = budget.loans[at + F.balance] as number;
    const monthsLeft = budget.loans[at + F.monthsLeft] as number;
    const interestDue = monthInterest(balance, budget.loans[at + F.annualRate] as number);
    const owed = balance + interestDue;
    const payment = monthsLeft <= 1 ? owed : Math.min(budget.loans[at + F.repayment] as number, owed);
    const interest = Math.min(interestDue, payment);
    const principal = payment - interest;
    if (interest !== 0) moveMoney(state, "interest", interest);
    if (principal !== 0) moveMoney(state, "loanRepayments", principal);
    budget.loans[at + F.balance] = balance - principal;
    budget.loans[at + F.monthsLeft] = monthsLeft - 1;
    if (balance - principal === 0) closed = true;
  }
  if (closed) {
    for (let i = loanCount(budget) - 1; i >= 0; i--) if (budget.loans[i * LOAN_STRIDE + F.balance] === 0) budget.loans = withoutLoan(budget, i);
  }
}

// --- Loading ---------------------------------------------------------------------

/**
 * Why `loans` and `nextLoan` are not a well-formed list of open loans, or
 * null if they are: whole numbers of `LOAN_STRIDE` per loan, ids rising
 * and below `nextLoan`, whole dollars owed of at least 1, months left
 * within the term, and a rate from 0 to 1. Not held to this build's offers
 * or slot count, so a city saved under other balance numbers still loads.
 */
export function checkLoans(loans: unknown, nextLoan: unknown): string | null {
  if (!Number.isSafeInteger(nextLoan) || (nextLoan as number) < 0) return "its next loan id is not a whole number";
  if (!(loans instanceof Float64Array) || loans.length % LOAN_STRIDE !== 0) return `its loans are not ${LOAN_STRIDE} numbers a loan in a Float64Array`;
  let lastId = -1;
  for (let i = 0; i < loans.length / LOAN_STRIDE; i++) {
    const loan = loanAt({ loans }, i);
    if (!Number.isSafeInteger(loan.id) || loan.id <= lastId || loan.id >= (nextLoan as number)) return "its loan ids are not rising whole numbers below the next id";
    lastId = loan.id;
    if (!Number.isSafeInteger(loan.taken) || loan.taken < 0) return "a loan's tick is not a whole number";
    if (![loan.principal, loan.balance, loan.repayment].every((n) => Number.isSafeInteger(n) && n >= 0) || loan.balance < 1) return "a loan's dollars are not whole, or it owes nothing";
    if (!Number.isSafeInteger(loan.termMonths) || loan.termMonths < 1 || !Number.isSafeInteger(loan.monthsLeft) || loan.monthsLeft < 1 || loan.monthsLeft > loan.termMonths) {
      return "a loan's months left are not within its term";
    }
    if (!(Number.isFinite(loan.annualRate) && loan.annualRate >= 0 && loan.annualRate <= 1)) return "a loan's rate is not from 0 to 1";
  }
  return null;
}
