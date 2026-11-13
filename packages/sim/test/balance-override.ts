// Runs part of a test with one road type's bridge limit lowered. Issue 47 set
// every type's limit longer than the map, so no bridge the map can hold breaks
// it, and the check is only reachable with a lower limit than the balance has.

import type { RoadType } from "../src/index";

/** Runs `body` with `type`'s longest bridge set to `metres`, and puts the balance back after. */
export function withBridgeLimit<T>(type: RoadType, metres: number, body: () => T): T {
  const was = type.bridge.maxLength;
  type.bridge.maxLength = metres;
  try {
    return body();
  } finally {
    type.bridge.maxLength = was;
  }
}
