// Holds the demand bars through every test of a describe (M3-07), for tests
// of the grower that want zoning to fill whatever the city's economy says.

import { afterEach, beforeEach } from "vitest";
import { FULL_DEMAND, startHolding, type HeldBars } from "./demand-helper";

/**
 * Holds `bars`, every bar at 100 unless told otherwise, through each test of
 * the describe it is called in. Not for a describe that replays a recorded
 * fixture: a fixture records what its commands build on the bars its city
 * works out.
 */
export function holdEach(bars: HeldBars = FULL_DEMAND): void {
  let release = () => {};
  beforeEach(() => {
    release = startHolding(bars);
  });
  afterEach(() => release());
}
