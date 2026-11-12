// Number formatting for the UI. Display only: nothing here feeds back into
// state.

import type { GameDate } from "@city-council/sim";

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
 * whole dollars, as the sim stores money (CLAUDE.md rule 9). Nothing uses
 * this until M4.
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A game date as the top bar shows it, such as "3 Feb, Year 1". */
export function formatGameDate(date: GameDate): string {
  return `${date.day} ${MONTHS[date.month - 1] ?? "?"}, Year ${date.year}`;
}

/** Speed as the page shows it: "paused", "1x" and so on. */
export function formatSpeed(speed: number): string {
  return speed === 0 ? "paused" : `${speed}x`;
}
