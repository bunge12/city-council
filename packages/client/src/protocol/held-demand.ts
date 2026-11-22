// A test hook (M3-07): holds every demand bar at one value in this worker,
// so a walkthrough can zone shops, offices and factories on an empty city
// and see them grow. The page asks for it with the test switch's
// `heldDemand` (test-switch.ts), which travels in the worker's name
// (save/lock.ts). A player's storage never has the switch.
//
// The demand system still runs and works the bars out from the city's
// totals; after it, each bar is set to the held value, its whole value in
// its first part so the parts still add up to it, as the sim's test helper
// does (packages/sim/test/demand-helper.ts). A replay of the city's log
// gives the same city only with the bars held the same way.
import { DEMAND, DEMAND_BARS, DEMAND_PARTS, type SimState } from "@city-council/sim";

/**
 * Holds every bar at `value`, from -100 to 100, in every city this realm
 * steps from now on, until the returned function lets go. The worker never
 * lets go; the client's unit tests do.
 */
export function holdDemandBars(value: number): () => void {
  const original = DEMAND.run;
  DEMAND.run = (state: SimState) => {
    original(state);
    for (const bar of DEMAND_BARS) {
      const names = DEMAND_PARTS[bar];
      state.demand[bar] = { value, parts: Object.fromEntries(names.map((name, i) => [name, i === 0 ? value : 0])) };
    }
  };
  return () => {
    DEMAND.run = original;
  };
}
