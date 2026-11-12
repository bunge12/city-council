import { describe, expect, it } from "vitest";
import { TIME_BALANCE, gameDate } from "../src/index";

const DAY = TIME_BALANCE.ticksPerDay;

describe("gameDate", () => {
  it("starts on the first of January of the first year", () => {
    expect(gameDate(0)).toEqual({ year: 1, month: 1, day: 1, dayNumber: 0 });
    expect(gameDate(DAY - 1)).toEqual({ year: 1, month: 1, day: 1, dayNumber: 0 });
  });

  it("turns the day every 100 ticks, 10 seconds at 1x", () => {
    expect(DAY).toBe(100);
    expect(gameDate(DAY)).toMatchObject({ month: 1, day: 2, dayNumber: 1 });
  });

  it("crosses months and years on the right days", () => {
    expect(gameDate(30 * DAY)).toMatchObject({ month: 1, day: 31 });
    expect(gameDate(31 * DAY)).toMatchObject({ month: 2, day: 1 });
    // No leap years: 28 February is followed by 1 March.
    expect(gameDate(58 * DAY)).toMatchObject({ month: 2, day: 28 });
    expect(gameDate(59 * DAY)).toMatchObject({ month: 3, day: 1 });
    expect(gameDate(364 * DAY)).toMatchObject({ year: 1, month: 12, day: 31 });
    expect(gameDate(365 * DAY)).toEqual({ year: 2, month: 1, day: 1, dayNumber: 365 });
    expect(gameDate(10 * 365 * DAY + 45 * DAY)).toMatchObject({ year: 11, month: 2, day: 15 });
  });

  it("has a 365 day year", () => {
    expect(TIME_BALANCE.monthDays.reduce((a, b) => a + b, 0)).toBe(365);
  });

  it("refuses ticks that are not whole and non-negative", () => {
    expect(() => gameDate(-1)).toThrow(RangeError);
    expect(() => gameDate(1.5)).toThrow(RangeError);
  });
});
