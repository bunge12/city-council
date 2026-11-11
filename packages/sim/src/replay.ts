import { enqueue } from "./commands";
import type { LogEntry } from "./log";
import { createState, type SimState } from "./state";
import { step } from "./step";

/**
 * Rebuilds a city from its seed and command log. Each entry is queued on the
 * tick it was recorded on and applied by that tick's `step`, so the result
 * matches the live city at `untilTick`, with entries recorded at or after
 * `untilTick` not yet applied.
 *
 * Live, several paused steps can share one tick. No system runs during a
 * paused step, so applying all of a tick's entries in one step gives the
 * same state.
 *
 * Stops early if the city is paused with no entry left to unpause it.
 */
export function replay(seed: number, log: readonly LogEntry[], untilTick: number): SimState {
  if (!Number.isSafeInteger(untilTick) || untilTick < 0) {
    throw new RangeError(`untilTick must be a non-negative integer, got ${untilTick}`);
  }
  const state = createState(seed);
  let next = 0;
  while (state.tick < untilTick) {
    const tick = state.tick;
    for (let entry = log[next]; entry !== undefined && entry.tick <= tick; entry = log[++next]) {
      if (entry.tick < tick) {
        throw new RangeError(`log entry ${next} is for tick ${entry.tick}, before tick ${tick}`);
      }
      // Skip submit's check: the entry was valid when applied live, but an
      // earlier entry in the same tick may be what made it valid. `step`
      // checks each one again in order, as it did live.
      enqueue(state, entry);
    }
    step(state);
    if (state.tick === tick) {
      if (next >= log.length) break;
      throw new RangeError(
        `city is paused at tick ${tick} but log entry ${next} is for tick ${log[next]?.tick}`,
      );
    }
  }
  return state;
}
