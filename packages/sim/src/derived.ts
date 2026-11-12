// Derived data: structures rebuilt from state that are never saved or
// hashed, such as the road spatial index and, from issue 15, the routing
// graph. See "Derived data" in the PRD.
//
// Each one is cached by the state object it comes from and built from its
// arrays on first use, so a city loaded from a save, cloned or replayed
// rebuilds its own and nothing about a host's history can leak into it.

import { roadIndexOf } from "./roads/spatial";
import type { SimState } from "./state";

/**
 * Builds every piece of derived data `state` does not have yet. Optional: a
 * query builds what it needs anyway. A host calls this after it creates or
 * loads a city, so the cost lands at load and not inside the first tick that
 * asks.
 */
export function prepareDerived(state: SimState): void {
  roadIndexOf(state.roads);
}
