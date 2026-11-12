// The game calendar. A game date is worked out from the tick alone, so every
// host and client shows the same date for the same tick. Integer arithmetic
// only. Years have 365 days and no leap years.

import balance from "../balance/time.json";

/** Game time settings, as stored in `balance/time.json`. */
export type TimeBalance = typeof balance;

export const TIME_BALANCE: TimeBalance = balance;

/** A day on the game calendar. `month` and `day` count from 1. */
export interface GameDate {
  year: number;
  month: number;
  day: number;
  /** Whole game days since the city was created. */
  dayNumber: number;
}

/** The calendar date that `tick` falls on. */
export function gameDate(tick: number, time: TimeBalance = TIME_BALANCE): GameDate {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, got ${tick}`);
  }
  const yearDays = time.monthDays.reduce((sum, days) => sum + days, 0);
  const dayNumber = Math.floor(tick / time.ticksPerDay);
  const year = time.firstYear + Math.floor(dayNumber / yearDays);
  let rest = dayNumber % yearDays;
  let month = 1;
  for (const days of time.monthDays) {
    if (rest < days) break;
    rest -= days;
    month += 1;
  }
  return { year, month, day: rest + 1, dayNumber };
}
