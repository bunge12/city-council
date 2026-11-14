import { describe, expect, it } from "vitest";
import {
  CELLS_SYSTEM,
  COMMANDS_SYSTEM,
  LOG_PAGE_SIZE,
  MAX_PENDING_COMMANDS,
  SNAPSHOT_VERSION,
  createBareState,
  nextU32,
  step,
  submit,
  type Command,
  type SimState,
} from "../src/index";

// Node has it; the sim tsconfig carries no DOM or Node types.
declare function structuredClone<T>(value: T): T;

function cmd(type: string, payload: unknown = {}, seq = 1): Command {
  return { seq, playerId: "p1", type, payload };
}

describe("createBareState", () => {
  it("starts at tick 0, 1x speed and the current snapshot version", () => {
    const state = createBareState(42);
    expect(state).toMatchObject({ version: SNAPSHOT_VERSION, tick: 0, seed: 42, speed: 1 });
    expect(state.rng).toBeInstanceOf(Uint32Array);
    expect(state.pending).toEqual([]);
    expect(state.log).toEqual([]);
    expect(state.logOffset).toBe(0);
  });

  it("rejects seeds that are not 32-bit unsigned integers", () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => createBareState(seed)).toThrow(RangeError);
    }
  });

  it("survives structuredClone, as a snapshot must", () => {
    const state = createBareState(9);
    submit(state, cmd("NoOp"));
    expect(structuredClone(state)).toEqual(state);
  });
});

describe("step", () => {
  it("advances the tick by exactly one", () => {
    const state = createBareState(1);
    step(state);
    expect(state.tick).toBe(1);
    step(state);
    expect(state.tick).toBe(2);
  });

  it("leaves the generator alone when no system draws from it", () => {
    const state = createBareState(1);
    const before = state.rng.slice();
    step(state);
    expect(state.rng).toEqual(before);
  });

  it("reports each system to the host timer in order", () => {
    const state = createBareState(1);
    const calls: string[] = [];
    step(state, {
      start: (name) => calls.push(`start ${name}`),
      end: (name) => calls.push(`end ${name}`),
    });
    expect(calls).toEqual([`start ${COMMANDS_SYSTEM}`, `end ${COMMANDS_SYSTEM}`, `start ${CELLS_SYSTEM}`, `end ${CELLS_SYSTEM}`]);
  });
});

describe("submit", () => {
  it("refuses commands once a step's worth is queued, so none page out unread", () => {
    const state = createBareState(1);
    expect(MAX_PENDING_COMMANDS).toBeLessThanOrEqual(LOG_PAGE_SIZE);
    for (let i = 0; i < MAX_PENDING_COMMANDS; i++) {
      expect(submit(state, cmd("NoOp", {}, i)).ok).toBe(true);
    }
    expect(submit(state, cmd("NoOp", {}, MAX_PENDING_COMMANDS))).toEqual({
      ok: false,
      reason: `too many commands this tick, at most ${MAX_PENDING_COMMANDS}`,
    });
    step(state);
    expect(submit(state, cmd("NoOp", {}, 0)).ok).toBe(true);
  });

  it("accepts NoOp and applies it on the next tick", () => {
    const state = createBareState(1);
    expect(submit(state, cmd("NoOp"))).toEqual({ ok: true });
    expect(state.pending).toHaveLength(1);
    step(state);
    expect(state.pending).toHaveLength(0);
    expect(state.tick).toBe(1);
  });

  it("rejects an unknown command with a reason", () => {
    const state = createBareState(1);
    expect(submit(state, cmd("BuildMoonBase"))).toEqual({
      ok: false,
      reason: 'unknown command type "BuildMoonBase"',
    });
    expect(state.pending).toHaveLength(0);
  });

  it("does not treat Object.prototype keys as commands", () => {
    const state = createBareState(1);
    expect(submit(state, cmd("toString")).ok).toBe(false);
    expect(submit(state, cmd("__proto__")).ok).toBe(false);
  });

  it("rejects a type that is not a string, even one that reads as a command name", () => {
    const state = createBareState(1);
    for (const type of [["NoOp"], { toString: () => "NoOp" }, 7, null, undefined]) {
      const result = submit(state, { seq: 1, playerId: "p1", type: type as unknown as string, payload: {} });
      expect(result).toEqual({ ok: false, reason: "type must be a string" });
    }
    expect(state.pending).toEqual([]);
  });

  it("refuses a payload JSON cannot hold instead of throwing", () => {
    const state = createBareState(1);
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    for (const payload of [{ big: 1n }, loop]) {
      expect(submit(state, cmd("NoOp", payload))).toEqual({ ok: false, reason: "payload must be plain JSON data" });
    }
    expect(state.pending).toEqual([]);
  });

  it("rejects a command without a player id", () => {
    const state = createBareState(1);
    const result = submit(state, { seq: 1, playerId: "", type: "NoOp", payload: {} });
    expect(result).toEqual({ ok: false, reason: "playerId is required" });
  });

  it("rejects a bad seq", () => {
    const state = createBareState(1);
    expect(submit(state, cmd("NoOp", {}, -1)).ok).toBe(false);
    expect(submit(state, cmd("NoOp", {}, 0.5)).ok).toBe(false);
  });

  it("copies the payload so the sender cannot change it after submitting", () => {
    const state = createBareState(1);
    const payload = { speed: 2 };
    submit(state, cmd("SetSpeed", payload));
    payload.speed = 99;
    step(state);
    expect(state.speed).toBe(2);
  });
});

describe("SetSpeed", () => {
  it.each([0, 1, 2, 4])("accepts speed %d and applies it on the next tick", (speed) => {
    const state = createBareState(1);
    state.speed = speed === 1 ? 2 : 1;
    expect(submit(state, cmd("SetSpeed", { speed }))).toEqual({ ok: true });
    expect(state.speed).not.toBe(speed);
    step(state);
    expect(state.speed).toBe(speed);
  });

  it.each([3, -1, 8, 1.5, "2", null, undefined])("rejects speed %s", (speed) => {
    const state = createBareState(1);
    const result = submit(state, cmd("SetSpeed", { speed }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SetSpeed payload\.speed must be one of 0, 1, 2, 4/);
  });

  it("rejects a missing payload", () => {
    expect(submit(createBareState(1), cmd("SetSpeed", null)).ok).toBe(false);
  });

  it("holds the tick while paused but still applies commands", () => {
    const state = createBareState(1);
    submit(state, cmd("SetSpeed", { speed: 0 }));
    step(state);
    expect(state).toMatchObject({ tick: 0, speed: 0 });
    step(state);
    expect(state.tick).toBe(0);
    submit(state, cmd("SetSpeed", { speed: 4 }, 2));
    step(state);
    expect(state).toMatchObject({ tick: 1, speed: 4 });
  });

  it("applies commands in submit order within one tick", () => {
    const state = createBareState(1);
    submit(state, cmd("SetSpeed", { speed: 2 }, 1));
    submit(state, cmd("SetSpeed", { speed: 4 }, 2));
    step(state);
    expect(state.speed).toBe(4);
  });
});

describe("determinism", () => {
  function run(seed: number): SimState {
    const state = createBareState(seed);
    for (let i = 0; i < 1000; i++) {
      if (i % 100 === 0) submit(state, cmd("NoOp", {}, i));
      if (i === 500) submit(state, cmd("SetSpeed", { speed: 2 }, i));
      step(state);
      nextU32(state.rng);
    }
    return state;
  }

  it("two states from the same seed stepped 1,000 times are equal", () => {
    const a = run(2026);
    const b = run(2026);
    expect(a.tick).toBe(1000);
    expect(a).toEqual(b);
  });

  it("states from different seeds differ", () => {
    expect(run(2026).rng).not.toEqual(run(2027).rng);
  });
});
