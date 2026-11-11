import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  LOG_PAGE_SIZE,
  createState,
  logLength,
  readLog,
  replay,
  hashState,
  step,
  submit,
} from "../src/index";

describe("activity log", () => {
  it("records each applied command with its tick, player, type and payload", () => {
    const state = createState(1);
    step(state);
    submit(state, { seq: 4, playerId: "p2", type: "SetSpeed", payload: { speed: 2 } });
    step(state);
    expect(state.log).toEqual([
      { tick: 1, seq: 4, playerId: "p2", type: "SetSpeed", payload: { speed: 2 } },
    ]);
  });

  it("does not record a command dropped at apply time", () => {
    const state = createState(1);
    submit(state, { seq: 1, playerId: "p1", type: "NoOp", payload: {} });
    // Corrupt the queued command so the second check at apply time fails.
    if (state.pending[0]) state.pending[0].playerId = "";
    step(state);
    expect(state.log).toEqual([]);
  });

  it("pages the oldest entries out of live state past the cap", () => {
    const state = createState(1);
    const total = LOG_LIVE_LIMIT + LOG_PAGE_SIZE + 10;
    let cursor = 0;
    const kept = [];
    for (let i = 0; i < total; i++) {
      submit(state, { seq: i, playerId: "p1", type: "NoOp", payload: {} });
      step(state);
      // A host reads new entries after every step and keeps them.
      kept.push(...readLog(state, cursor));
      cursor = logLength(state);
    }
    expect(state.log.length).toBeLessThanOrEqual(LOG_LIVE_LIMIT);
    expect(state.logOffset).toBe(2 * LOG_PAGE_SIZE);
    expect(logLength(state)).toBe(total);
    expect(state.log[0]?.seq).toBe(state.logOffset);
    expect(kept.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i));
    // The full log the host kept still replays to the live state.
    expect(hashState(replay(1, kept, state.tick))).toBe(hashState(state));
  });

  it("readLog refuses entries that already left live state", () => {
    const state = createState(1);
    state.logOffset = 10;
    expect(() => readLog(state, 9)).toThrow(/left live state/);
    expect(readLog(state, 10)).toEqual([]);
    expect(() => readLog(state, -1)).toThrow(RangeError);
  });

  it("readLog returns a copy, so the host cannot change state through it", () => {
    const state = createState(1);
    submit(state, { seq: 1, playerId: "p1", type: "NoOp", payload: {} });
    step(state);
    readLog(state, 0).pop();
    expect(state.log).toHaveLength(1);
  });
});
