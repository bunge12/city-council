import { enqueue } from "./commands";
import type { LogEntry } from "./log";
import { cloneState, createState, type SimState } from "./state";
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
 * Entries recorded at `untilTick` itself are the exception. Live, a step
 * that runs at a tick either moves past it or leaves the city paused on it,
 * so a city that is still at `untilTick` and has entries recorded there must
 * have applied them in paused steps: it is a city saved while paused. Those
 * entries are applied when doing so leaves the city paused on `untilTick`,
 * which makes the replay of a paused save match the save. When they would
 * unpause it they are left for the step that moves past `untilTick`.
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
  if (state.tick === untilTick && log[next]?.tick === untilTick) {
    const paused = cloneState(state);
    for (let entry = log[next]; entry !== undefined && entry.tick === untilTick; entry = log[++next]) {
      enqueue(paused, entry);
    }
    step(paused);
    if (paused.tick === untilTick) return paused;
  }
  return state;
}
