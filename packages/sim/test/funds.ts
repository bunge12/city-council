// Funds a test city (M4-03). Roads cost money from M4, and a test that
// builds more than the starting grant pays for sets the treasury first, so
// it builds what it built before. A replay of a funded city's log starts
// from a city funded the same way (`replayFrom(funded(createState(seed)), ...)`).

import { SCALE_TREASURY, fundCity, type SimState } from "../src/index";

/** `state` with its treasury set to `treasury` whole dollars, a trillion unless given, on the grants line. Returns it. */
export function funded<S extends SimState>(state: S, treasury = SCALE_TREASURY): S {
  fundCity(state, treasury);
  return state;
}
