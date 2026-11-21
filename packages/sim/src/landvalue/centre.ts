// The city centre land value measures from (M3-13). Plain numbers in state,
// since it is worked out once a game month and a city loaded mid-month must
// measure from the same one. The rules that set it are in land-value.ts.

/** The city centre. Part of `SimState`. */
export interface CentreState {
  /** Where it is, metres. 0 while `weight` is 0. */
  x: number;
  z: number;
  /** The jobs, or the room in homes while there are no jobs, it is the middle of. 0 for a city with no centre. */
  weight: number;
  /** The tick from which the land value system works it out again. */
  due: number;
}

/** A new city's: no centre, worked out on the first tick. */
export function createCentre(): CentreState {
  return { x: 0, z: 0, weight: 0, due: 0 };
}
