// Holds the demand bars at chosen values through a run (M3-06), so tests of
// the grower (M3-07) and of arrivals (M3-08) do not need a working economy.
//
// The DEMAND system is swapped, for the length of `run`, for one that works
// the bars out as usual and then sets each held bar to its value, on every
// tick and not only a day's first, so a bar is held from the first step
// and through a city saved and loaded mid-run. A held bar's whole value is
// in its first part and the rest are 0, so its parts still add up to it.
// Every city stepped during `run` is held, which a test that compares a
// held city with one that is not must keep in mind.

import { DEMAND, DEMAND_PARTS, type DemandBar, type SimState } from "../src/index";

export type HeldBars = Partial<Record<DemandBar, number>>;

/** Sets each bar in `bars` on `state` to its value, as held bars read. */
export function setBars(state: SimState, bars: HeldBars): void {
  for (const [bar, value] of Object.entries(bars) as [DemandBar, number][]) {
    if (!(value >= -100 && value <= 100)) throw new RangeError(`a bar runs from -100 to 100, not ${value}`);
    const names = DEMAND_PARTS[bar];
    state.demand[bar] = { value, parts: Object.fromEntries(names.map((name, i) => [name, i === 0 ? value : 0])) };
  }
}

/** Runs `run` with the bars in `bars` held at their values in every city it steps, and returns what it returns. */
export function holdDemand<T>(bars: HeldBars, run: () => T): T {
  const original = DEMAND.run;
  DEMAND.run = (state: SimState) => {
    original(state);
    setBars(state, bars);
  };
  try {
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === "function") throw new TypeError("holdDemand holds the bars through a synchronous run only");
    return result;
  } finally {
    DEMAND.run = original;
  }
}
