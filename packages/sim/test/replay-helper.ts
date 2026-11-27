// Vitest helper for replay fixtures. A fixture is a seed, a command log and
// the tick to replay to, plus the state hash that replay must produce.
import { expect } from "vitest";
import { BALANCE_STAMP, createState, creditMilestones, fundCity, hashState, replayFrom, type LogEntry, type SimState } from "../src/index";
import { holdDemand } from "./demand-helper";

export interface ReplayFixture {
  description: string;
  seed: number;
  untilTick: number;
  log: LogEntry[];
  /** The balance stamp the hash was recorded under (src/balance-stamp.ts). */
  balance: string;
  /** Expected `hashState` of the replayed state. */
  hash: string;
  /**
   * When set, every demand bar is held at this value through the replay
   * (M3-07), so a fixture can record shops, offices, factories and mixed
   * ground growing on a city with no residents. The browser's replay check
   * holds them the same way.
   */
  heldDemand?: number;
  /**
   * When set, the city starts with this treasury, in whole dollars, set as
   * `fundCity` sets it (M4-03), so a fixture whose roads cost more than the
   * starting grant still builds them. The browser's replay check funds it
   * the same way.
   */
  treasury?: number;
  /**
   * When true, the city starts with every milestone credited, without
   * grants, as `creditMilestones` credits them (M4-12), so a fixture that
   * zones densities 2 and 3 on a new city still paints them. The browser's
   * replay check credits it the same way.
   */
  credited?: boolean;
}

/** A new city on `fixture`'s seed, funded and credited if the fixture says so: what its log replays onto. */
export function fixtureStart(fixture: ReplayFixture): SimState {
  const state = createState(fixture.seed);
  if (fixture.treasury !== undefined) fundCity(state, fixture.treasury);
  if (fixture.credited === true) creditMilestones(state);
  return state;
}

/** Replays `fixture` to `untilTick`, or to its end, with its bars held if it says so. */
export function replayFixture(fixture: ReplayFixture, untilTick = fixture.untilTick): SimState {
  const run = () => replayFrom(fixtureStart(fixture), fixture.log, untilTick);
  const v = fixture.heldDemand;
  return v === undefined ? run() : holdDemand({ residential: v, commercial: v, office: v, industrial: v }, run);
}

/** Replays a fixture and returns the final state and its hash. */
export function runFixture(fixture: ReplayFixture): { state: SimState; hash: string } {
  const state = replayFixture(fixture);
  return { state, hash: hashState(state) };
}

/**
 * Asserts a fixture replays to its recorded hash. When it does not, the sim
 * has become nondeterministic or its behaviour or state shape changed. If
 * the change is intended, explain it in the pull request and put the new
 * hash from the failure message into the fixture.
 *
 * The state holds the balance stamp, so a change to a balance number moves
 * every fixture's hash. The failure then says whether the numbers changed
 * what the commands built or only the stamp, so a refresh is never blind.
 */
export function expectReplay(fixture: ReplayFixture): SimState {
  const { state, hash } = runFixture(fixture);
  expect(state.tick, "replay stopped before untilTick").toBe(fixture.untilTick);
  if (fixture.balance !== BALANCE_STAMP) {
    const sameCity = hashState({ ...state, balance: fixture.balance }) === fixture.hash;
    expect.fail(
      `the balance changed since "${fixture.description}" was recorded. ` +
        (sameCity
          ? "The commands still build the same city: only the stamp moved. "
          : "The commands now build a DIFFERENT city: say in the pull request which number did it. ") +
        `Set "balance" to ${BALANCE_STAMP} and "hash" to ${hash}`,
    );
  }
  expect(
    hash,
    `replay hash changed for "${fixture.description}". If intended, set "hash" to ${hash}`,
  ).toBe(fixture.hash);
  return state;
}
