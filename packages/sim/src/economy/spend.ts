// Spending and the overdraft (M4-03, PRD "M4 Economy").
//
// The treasury may fall to a small overdraft and no further. A command that
// costs money is refused when its price would take the treasury past it,
// with a reason that gives the price and what is left. Commands that cost
// nothing, zoning among them, are never refused for money: a broke city
// recovers by growing. Upkeep is not a command and keeps running past the
// overdraft, so a broke city is not stopped, it only cannot spend.
//
// A price is whole dollars out of the treasury. One at or below zero, a
// bulldoze whose refund is more than its demolition or the undo of a
// build, pays in and is never refused.

import type { SimState } from "../state";
import { ECONOMY } from "./balance";

/** What the treasury of `state` can still pay: its balance down to the overdraft. */
export function available(state: SimState): number {
  return state.budget.treasury + ECONOMY.overdraft;
}

/** Why `state` cannot pay `price` whole dollars, or null when it can: the check commands and the tools' previews run. */
export function spendingRefusal(state: SimState, price: number): string | null {
  if (price <= 0) return null;
  const left = available(state);
  if (price <= left) return null;
  return costsReason(price, left);
}

/** The words for a price past what is left: "Costs $4.2M, $1.1M available". */
export function costsReason(price: number, left: number): string {
  const shown = Math.max(0, left);
  let cost = formatMoneyShort(price);
  let have = formatMoneyShort(shown);
  // Rounded alike they would read as affordable, so both are given in full.
  if (cost === have) {
    cost = formatMoneyFull(price);
    have = formatMoneyFull(shown);
  }
  return `Costs ${cost}, ${have} available`;
}

// --- Money as words ----------------------------------------------------------------

const UNITS = [
  { size: 1e12, suffix: "T" },
  { size: 1e9, suffix: "B" },
  { size: 1e6, suffix: "M" },
  { size: 1e3, suffix: "K" },
] as const;

/** One decimal below 10 of a unit, whole numbers above, and no trailing ".0". */
function short(value: number): string {
  const text = value < 9.95 ? value.toFixed(1) : value.toFixed(0);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * Money in short form, such as $3.2B, $480M or -$12K, for places where a row
 * of zeros would be noise. Amounts under $1,000 are shown in full. Input is
 * whole dollars, as the sim stores money (CLAUDE.md rule 9). Words only:
 * nothing here feeds back into state.
 */
export function formatMoneyShort(dollars: number): string {
  if (!Number.isFinite(dollars)) throw new RangeError(`money must be a finite number, got ${dollars}`);
  const abs = Math.abs(Math.round(dollars));
  const sign = dollars < 0 && abs > 0 ? "-" : "";
  if (abs < 1000) return `${sign}$${abs}`;
  for (let i = 0; i < UNITS.length; i++) {
    const unit = UNITS[i];
    if (!unit || abs < unit.size) continue;
    const text = short(abs / unit.size);
    // Rounding can carry into the next unit up: 999,600 shows as $1M, not $1000K.
    const bigger = UNITS[i - 1];
    if (Number(text) >= 1000 && bigger) return `${sign}$1${bigger.suffix}`;
    return `${sign}$${text}${unit.suffix}`;
  }
  return `${sign}$${abs}`;
}

/** Money to the dollar with commas, such as $1,204,500. */
export function formatMoneyFull(dollars: number): string {
  if (!Number.isFinite(dollars)) throw new RangeError(`money must be a finite number, got ${dollars}`);
  const abs = Math.abs(Math.round(dollars));
  const sign = dollars < 0 && abs > 0 ? "-" : "";
  return `${sign}$${String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
