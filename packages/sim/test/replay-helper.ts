// Vitest helper for replay fixtures. A fixture is a seed, a command log and
// the tick to replay to, plus the state hash that replay must produce.
import { expect } from "vitest";
import { hashState, replay, type LogEntry, type SimState } from "../src/index";

export interface ReplayFixture {
  description: string;
  seed: number;
  untilTick: number;
  log: LogEntry[];
  /** Expected `hashState` of the replayed state. */
  hash: string;
}

/** Replays a fixture and returns the final state and its hash. */
export function runFixture(fixture: ReplayFixture): { state: SimState; hash: string } {
  const state = replay(fixture.seed, fixture.log, fixture.untilTick);
  return { state, hash: hashState(state) };
}

/**
 * Asserts a fixture replays to its recorded hash. When it does not, the sim
 * has become nondeterministic or its behaviour or state shape changed. If
 * the change is intended, explain it in the pull request and put the new
 * hash from the failure message into the fixture.
 */
export function expectReplay(fixture: ReplayFixture): SimState {
  const { state, hash } = runFixture(fixture);
  expect(state.tick, "replay stopped before untilTick").toBe(fixture.untilTick);
  expect(
    hash,
    `replay hash changed for "${fixture.description}". If intended, set "hash" to ${hash}`,
  ).toBe(fixture.hash);
  return state;
}
