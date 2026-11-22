// Holds the demand bars at chosen values through a run (M3-06), so tests of
// the grower (M3-07) and of arrivals (M3-08) do not need a working economy.
//
// The DEMAND system is swapped, for the length of `run`, for one that works
// the bars out as usual and then sets each held bar to its value, on every
// tick and not only a day's first, so a bar is held from the first step
// and through a city saved and loaded mid-run. A held bar's whole value is
// in its first part and the rest are 0, so its parts still add up to it.
// Every city stepped during `run` is held, which a test that compares a
// held city with one that is not must keep in mind. No vitest here, so
// Playwright specs can hold the bars too (e2e/m2-walkthrough.spec.ts).

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

/**
 * Holds the bars in `bars` at their values in every city stepped from now
 * until the returned function is called, for a `beforeEach` and an
 * `afterEach`. Holds do not nest: let go of one before taking another.
 */
export function startHolding(bars: HeldBars): () => void {
  const original = DEMAND.run;
  DEMAND.run = (state: SimState) => {
    original(state);
    setBars(state, bars);
  };
  return () => {
    DEMAND.run = original;
  };
}

/** Every bar at 100, for tests of the grower that want any zoning to fill as M2 had it. */
export const FULL_DEMAND: HeldBars = { residential: 100, commercial: 100, office: 100, industrial: 100 };


/** Runs `run` with the bars in `bars` held at their values in every city it steps, and returns what it returns. */
export function holdDemand<T>(bars: HeldBars, run: () => T): T {
  const release = startHolding(bars);
  try {
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === "function") throw new TypeError("holdDemand holds the bars through a synchronous run only");
    return result;
  } finally {
    release();
  }
}
