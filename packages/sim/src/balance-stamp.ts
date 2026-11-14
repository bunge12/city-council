// The balance stamp: one hash over every balance file the sim reads.
//
// A city is its seed and its command log played under one set of balance
// numbers. Change a slope limit and a logged road can land somewhere else
// or be refused, so the log no longer replays to the city it made (M1
// review, issue 80). A city carries the stamp of the balance it was created
// under in `SimState.balance`, and `replaysUnderThisBalance` says whether
// this build's balance is that one.
//
// Only numbers and switches count. Keys that start with an underscore and
// the `source`, `sourceUrl` and `note` of a price are words for people, so
// editing them leaves the stamp alone.

import connections from "../balance/connections.json" with { type: "json" };
import roads from "../balance/roads.json" with { type: "json" };
import routing from "../balance/routing.json" with { type: "json" };
import terrain from "../balance/terrain.json" with { type: "json" };
import time from "../balance/time.json" with { type: "json" };
import zoning from "../balance/zoning.json" with { type: "json" };
import { hashState } from "./hash";

const WORDS = new Set(["source", "sourceUrl", "note"]);

/** `value` without the keys that only explain it. */
function numbersOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(numbersOnly);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!key.startsWith("_") && !WORDS.has(key)) out[key] = numbersOnly(inner);
  }
  return out;
}

/** The stamp of a set of balance files, keyed by file name. For the test that pins what counts. */
export function balanceStampOf(files: Readonly<Record<string, unknown>>): string {
  return hashState(numbersOnly(files));
}

/** The stamp of the balance this build of the sim runs. */
export const BALANCE_STAMP = balanceStampOf({ connections, roads, routing, terrain, time, zoning });

/**
 * Whether `state` was created under the balance this build runs, so its log
 * can be expected to replay to it. False for a city from another balance,
 * and for one saved before saves carried a stamp, whose stamp is empty.
 */
export function replaysUnderThisBalance(state: { balance: string }): boolean {
  return state.balance === BALANCE_STAMP;
}
