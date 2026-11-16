// The grower's pace for the day (issue 135). Plain numbers in state, so a
// city loaded mid-day lands the same buildings as one that never stopped.
// The rules that set them are in grower.ts.

/** What the grower has planned. Part of `SimState`. */
export interface GrowthState {
  /** Buildings the grower adds on day `day`. */
  quota: number;
  /** The game day `quota` is for, or -1 before the first plan. */
  day: number;
  /** The game day the free cells counted at the last plan should be built on by. */
  deadline: number;
  /** Free zoned front cells counted at the last plan. */
  free: number;
}

/** A new city's: nothing planned yet. */
export function createGrowth(): GrowthState {
  return { quota: 0, day: -1, deadline: 0, free: 0 };
}
