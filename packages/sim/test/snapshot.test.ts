import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_VERSION,
  SnapshotError,
  createState,
  deserialize,
  fnv1a64,
  hashState,
  nextU32,
  readLog,
  readSnapshotHeader,
  replay,
  serialize,
  serializeDetached,
  step,
  submit,
  type LogEntry,
  type SimState,
} from "../src/index";
import v1Fixture from "./fixtures/snapshots/v1.json";
import v2Fixture from "./fixtures/snapshots/v2.json";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rewrites the checksum after a test edits the body, so only the edit is wrong. */
function resign(bytes: Uint8Array): Uint8Array {
  const sum = fnv1a64(bytes.subarray(40));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(32, parseInt(sum.slice(0, 8), 16), true);
  view.setUint32(36, parseInt(sum.slice(8), 16), true);
  return bytes;
}

function refusal(bytes: Uint8Array): SnapshotError {
  try {
    deserialize(bytes);
  } catch (error) {
    if (error instanceof SnapshotError) return error;
    throw error;
  }
  throw new Error("deserialize accepted the bytes");
}

/** A state with commands applied and one still queued. */
function busyState(seed = 11): SimState {
  const state = createState(seed);
  nextU32(state.rng);
  submit(state, { seq: 1, playerId: "p1", type: "NoOp", payload: {} });
  step(state);
  submit(state, { seq: 2, playerId: "p2", type: "SetSpeed", payload: { speed: 4 } });
  step(state);
  step(state);
  submit(state, { seq: 3, playerId: "p1", type: "NoOp", payload: undefined });
  return state;
}

describe("serialize and deserialize", () => {
  it("round-trips a new city to the same hash", () => {
    const state = createState(1);
    const { state: back, pagedLog } = deserialize(serialize(state));
    expect(hashState(back)).toBe(hashState(state));
    expect(back).toEqual(state);
    expect(pagedLog).toEqual([]);
  });

  it("round-trips a city with log entries and a queued command", () => {
    const state = busyState();
    const back = deserialize(serialize(state)).state;
    expect(hashState(back)).toBe(hashState(state));
    expect(back.rng).toBeInstanceOf(Uint32Array);
    expect(back.pending).toHaveLength(1);
    expect(Object.hasOwn(back.pending[0] ?? {}, "payload")).toBe(true);
  });

  it("keeps values plain JSON would lose or confuse", () => {
    const state = createState(3);
    const payload = {
      $: "looks like a tag",
      nested: { $: "section", name: "rng" },
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      negZero: -0,
      missing: undefined,
      text: "Zürich 🏙️ \ud800 lone surrogate",
      list: [1, null, undefined, { $: "undefined" }],
    };
    state.log.push({ tick: 0, seq: 1, playerId: "pé", type: "NoOp", payload });
    const back = deserialize(serialize(state)).state;
    expect(hashState(back)).toBe(hashState(state));
    const entry = back.log[0] as LogEntry;
    expect(entry.payload).toEqual(payload);
    expect(Object.is((entry.payload as { negZero: number }).negZero, -0)).toBe(true);
  });

  it("gives state its own memory, apart from the bytes it was read from", () => {
    const bytes = serialize(busyState());
    const { state } = deserialize(bytes);
    const before = Array.from(state.rng);
    bytes.fill(0);
    expect(Array.from(state.rng)).toEqual(before);
    expect(state.rng.byteOffset).toBe(0);
    expect(state.rng.buffer.byteLength).toBe(state.rng.byteLength);
  });

  it("does not change the state it writes", () => {
    const state = busyState();
    const hash = hashState(state);
    serialize(state);
    expect(hashState(state)).toBe(hash);
  });

  it("writes a header that can be read without decoding the rest", () => {
    const state = busyState(77);
    const header = readSnapshotHeader(serialize(state));
    // A snapshot that carries its paged log is written as format 1, which
    // builds from before detached logs still read.
    expect(header).toEqual({
      formatVersion: 1,
      stateVersion: SNAPSHOT_VERSION,
      seed: 77,
      tick: state.tick,
    });
  });

  it("refuses to write a paged log that does not match logOffset", () => {
    const state = createState(1);
    state.logOffset = 2;
    expect(() => serialize(state, [])).toThrow(/pagedLog has 0 entries but 2/);
  });

  it("refuses state that is not plain data", () => {
    const state = createState(1) as SimState & { bad?: unknown };
    state.bad = new Map();
    expect(() => serialize(state)).toThrow(/not plain data/);
  });
});

describe("the activity log across a save", () => {
  it("keeps paged-out entries, and the full log replays to the saved hash", () => {
    const state = createState(9);
    const read: LogEntry[] = [];
    let seq = 1;
    // Enough commands that live state pages some out, read after every step
    // as the host does.
    while (state.logOffset === 0 || state.log.length < 100) {
      for (let i = 0; i < MAX_PENDING_COMMANDS; i++) {
        expect(submit(state, { seq: seq++, playerId: i % 2 ? "a" : "b", type: "NoOp", payload: { i } }).ok).toBe(true);
      }
      step(state);
      read.push(...readLog(state, read.length));
    }
    expect(state.logOffset).toBeGreaterThan(0);
    expect(state.log.length).toBeLessThanOrEqual(LOG_LIVE_LIMIT);
    const hash = hashState(state);

    const back = deserialize(serialize(state, read.slice(0, state.logOffset)));
    expect(hashState(back.state)).toBe(hash);
    expect(back.pagedLog).toEqual(read.slice(0, state.logOffset));
    const fullLog = [...back.pagedLog, ...back.state.log];
    expect(fullLog).toEqual(read);
    expect(hashState(replay(back.state.seed, fullLog, back.state.tick))).toBe(hash);
  });
});

describe("a snapshot written without its paged log", () => {
  /** A city with entries paged out of live state, and the entries a host would have read. */
  function pagedCity(): { state: SimState; fullLog: LogEntry[] } {
    const state = createState(21);
    const fullLog: LogEntry[] = [];
    let seq = 0;
    while (state.logOffset === 0) {
      for (let i = 0; i < MAX_PENDING_COMMANDS; i++) submit(state, { seq: seq++, playerId: "a", type: "NoOp", payload: { i } });
      step(state);
      fullLog.push(...readLog(state, fullLog.length));
    }
    return { state, fullLog };
  }

  it("comes back to the same hash and says its log is elsewhere", () => {
    const { state } = pagedCity();
    const back = deserialize(serializeDetached(state));
    expect(back.logDetached).toBe(true);
    expect(back.pagedLog).toEqual([]);
    expect(back.state.logOffset).toBe(state.logOffset);
    expect(hashState(back.state)).toBe(hashState(state));
    expect(back.header.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
  });

  it("does not grow with the entries that have left live state", () => {
    const { state, fullLog } = pagedCity();
    const detached = serializeDetached(state).byteLength;
    const whole = serialize(state, fullLog.slice(0, state.logOffset)).byteLength;
    expect(whole - detached).toBeGreaterThan(state.logOffset * 50);
    expect(deserialize(serialize(state, fullLog.slice(0, state.logOffset))).logDetached).toBe(false);
  });

  it("is refused in the old layout, where the paged log is required", () => {
    const bytes = serializeDetached(pagedCity().state);
    new DataView(bytes.buffer).setUint16(4, 1, true);
    expect(refusal(bytes).code).toBe("corrupt");
  });
});

describe("save and resume against an uninterrupted run", () => {
  // Steps the host loop from step `from` to step `to`. The commands depend
  // only on the step number, so two runs send the same ones. They include
  // pauses, so some steps do not advance the tick.
  function drive(state: SimState, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      if (i % 13 === 0) submit(state, { seq: i, playerId: i % 2 ? "a" : "b", type: "NoOp", payload: { i } });
      if (i % 97 === 0) {
        const speed = ([0, 1, 2, 4] as const)[(i / 97) % 4];
        submit(state, { seq: i, playerId: "a", type: "SetSpeed", payload: { speed } });
      }
      if (i % 97 === 5) submit(state, { seq: i, playerId: "b", type: "SetSpeed", payload: { speed: 2 } });
      step(state);
    }
  }

  it("1,000 steps straight equal 500, a save, a load and 500 more", () => {
    const straight = createState(42);
    drive(straight, 0, 1000);

    let resumed = createState(42);
    drive(resumed, 0, 500);
    resumed = deserialize(serialize(resumed)).state;
    drive(resumed, 500, 1000);

    expect(straight.tick).toBeGreaterThan(900);
    expect(straight.log.length).toBeGreaterThan(80);
    expect(resumed.tick).toBe(straight.tick);
    expect(hashState(resumed)).toBe(hashState(straight));
    expect(hashState(replay(42, resumed.log, resumed.tick))).toBe(hashState(straight));
  });

  it("holds when the save lands with a command still queued", () => {
    const run = (save: boolean): SimState => {
      let state = createState(42);
      drive(state, 0, 500);
      submit(state, { seq: 9999, playerId: "a", type: "SetSpeed", payload: { speed: 4 } });
      if (save) state = deserialize(serialize(state)).state;
      drive(state, 500, 1000);
      return state;
    };
    expect(hashState(run(true))).toBe(hashState(run(false)));
  });
});

describe("committed snapshots", () => {
  it("loads the version 1 fixture and migrates it to the current version", () => {
    const { state, header } = deserialize(fromHex(v1Fixture.hex));
    expect(header.stateVersion).toBe(1);
    const rng = createState(5).rng;
    nextU32(rng);
    expect(state).toEqual({
      version: SNAPSHOT_VERSION,
      tick: 42,
      seed: 5,
      rng,
      speed: 2,
      pending: [],
      log: [],
      logOffset: 0,
    });
  });

  it("loads the version 2 fixture to its recorded hash", () => {
    const { state } = deserialize(fromHex(v2Fixture.hex));
    expect(hashState(state)).toBe(v2Fixture.hash);
  });

  it("still writes the version 2 fixture byte for byte", () => {
    // If this fails the byte layout changed: bump SNAPSHOT_FORMAT_VERSION and
    // keep reading the old layout, or explain in the pull request why not.
    const { state } = deserialize(fromHex(v2Fixture.hex));
    expect(toHex(serialize(state))).toBe(v2Fixture.hex);
  });
});

describe("snapshots that are refused", () => {
  it("refuses a newer state version with a clear message", () => {
    const bytes = serialize(createState(1));
    new DataView(bytes.buffer).setUint16(6, SNAPSHOT_VERSION + 1, true);
    const error = refusal(bytes);
    expect(error.code).toBe("newer-version");
    expect(error.message).toMatch(/newer version of the game/);
    expect(error.message).toContain(`save version ${SNAPSHOT_VERSION + 1}`);
  });

  it("refuses a newer file format before reading anything after the version", () => {
    const bytes = serialize(createState(1)).slice(0, 8);
    new DataView(bytes.buffer).setUint16(4, SNAPSHOT_FORMAT_VERSION + 1, true);
    const error = refusal(bytes);
    expect(error.code).toBe("newer-version");
    expect(error.message).toContain(`file format ${SNAPSHOT_FORMAT_VERSION + 1}`);
  });

  it("refuses bytes that are not a snapshot", () => {
    for (const bytes of [new Uint8Array(), new TextEncoderLike().encode("hello, this is a text file")]) {
      expect(refusal(bytes).code).toBe("not-a-snapshot");
    }
  });

  it("refuses a snapshot that was cut short", () => {
    const bytes = serialize(busyState());
    for (const length of [20, 40, bytes.length - 1]) {
      expect(refusal(bytes.slice(0, length)).code).toBe("truncated");
    }
  });

  it("detects a flipped byte anywhere in the body", () => {
    const bytes = serialize(busyState());
    for (const at of [40, 60, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const copy = bytes.slice();
      copy[at] = (copy[at] ?? 0) ^ 0x10;
      expect(refusal(copy).code).toBe("corrupt");
    }
  });

  it("refuses a queued command that is not a command, which would throw on the first step", () => {
    for (const bad of [null, 7, { seq: 1, playerId: "p1" }, { seq: 1, playerId: "p1", type: ["NoOp"] }]) {
      const state = createState(3);
      state.pending.push(bad as never);
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/queued command 0/);
    }
  });

  it("detects bad contents even when the checksum matches", () => {
    const good = serialize(busyState());
    // Change the speed digit in the state JSON ("speed":4 to "speed":7).
    const units = new Uint16Array(good.slice(40).buffer.slice(0, good.length - 40 - ((good.length - 40) % 2)));
    const text = String.fromCharCode(...units);
    const at = text.indexOf('"speed":4');
    expect(at).toBeGreaterThan(0);
    const bytes = good.slice();
    new DataView(bytes.buffer).setUint16(40 + (at + 8) * 2, "7".charCodeAt(0), true);
    const error = refusal(resign(bytes));
    expect(error.code).toBe("corrupt");
    expect(error.message).toMatch(/speed 7 is not a game speed/);
  });

  it("detects a header that disagrees with the contents", () => {
    const bytes = serialize(busyState());
    new DataView(bytes.buffer).setUint32(8, 12345, true);
    expect(refusal(bytes).message).toMatch(/header does not match/);
  });
});

/** ASCII only; the sim's test types have no TextEncoder. */
class TextEncoderLike {
  encode(text: string): Uint8Array {
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  }
}
