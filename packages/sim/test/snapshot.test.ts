import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_VERSION,
  SnapshotError,
  captureState,
  createBareState,
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
  serializeDetachedSteps,
  serializeSteps,
  step,
  submit,
  type LogEntry,
  type SimState,
} from "../src/index";
import v1Fixture from "./fixtures/snapshots/v1.json";
import v2Fixture from "./fixtures/snapshots/v2.json";
import v3Fixture from "./fixtures/snapshots/v3.json";
import v4Fixture from "./fixtures/snapshots/v4.json";
import v5Fixture from "./fixtures/snapshots/v5.json";
import v6Fixture from "./fixtures/snapshots/v6.json";
import v7Fixture from "./fixtures/snapshots/v7.json";
import { snapshotChecksum } from "../src/snapshot";
import { checkConnections } from "../src/roads/connections";
import { heldIds } from "../src/undo";
import { addNode, addSegment, removeSegment, segmentsAt } from "../src/roads/network";

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
  const sum = snapshotChecksum(bytes);
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
  const state = createBareState(seed);
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
    const state = createBareState(1);
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
    const state = createBareState(3);
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
    const state = createBareState(1);
    state.logOffset = 2;
    expect(() => serialize(state, [])).toThrow(/pagedLog has 0 entries but 2/);
  });

  it("refuses state that is not plain data", () => {
    const state = createBareState(1) as SimState & { bad?: unknown };
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
    const state = createBareState(21);
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

  it("is written as format 3, whose checksum reads the body a word at a time", () => {
    const { state } = pagedCity();
    const bytes = serializeDetached(state);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(4, true)).toBe(3);
    // The two sums, written out the slow way.
    let a = 0x811c9dc5;
    let b = 0xcbf29ce4;
    for (let at = 40; at < bytes.byteLength; at += 4) {
      const word = view.getInt32(at, true);
      a = Math.imul(a ^ word, 0x01000193);
      b = Math.imul(((b << 5) | (b >>> 27)) ^ word, 0x9e3779b1);
    }
    expect(view.getUint32(32, true)).toBe(a >>> 0);
    expect(view.getUint32(36, true)).toBe(b >>> 0);
    // Not the checksum of formats 1 and 2.
    expect(snapshotChecksum(bytes)).not.toBe(fnv1a64(bytes.subarray(40)));
  });

  it("still reads a format 2 save, which has the FNV-1a checksum", () => {
    const { state } = pagedCity();
    const bytes = serializeDetached(state);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(4, 2, true);
    expect(refusal(bytes.slice()).message).toMatch(/checksum does not match/);
    const sum = fnv1a64(bytes.subarray(40));
    expect(snapshotChecksum(bytes)).toBe(sum);
    view.setUint32(32, parseInt(sum.slice(0, 8), 16), true);
    view.setUint32(36, parseInt(sum.slice(8), 16), true);
    const back = deserialize(bytes);
    expect(back.header.formatVersion).toBe(2);
    expect(back.logDetached).toBe(true);
    expect(hashState(back.state)).toBe(hashState(state));
  });

  it("notices any one byte of the body changing", () => {
    const bytes = serializeDetached(busyState());
    for (let at = 40; at < bytes.byteLength; at++) {
      const damaged = bytes.slice();
      damaged[at] = (damaged[at] ?? 0) ^ (1 << (at % 8));
      expect(() => readSnapshotHeader(damaged), `byte ${at}`).toThrow(/checksum does not match/);
    }
  });

  it("reads a save that does not start on a word boundary of its buffer", () => {
    const { state } = pagedCity();
    const bytes = serializeDetached(state);
    for (const shift of [1, 2, 3]) {
      const moved = new Uint8Array(bytes.byteLength + shift);
      moved.set(bytes, shift);
      expect(hashState(deserialize(moved.subarray(shift)).state)).toBe(hashState(state));
    }
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
      let state = createBareState(42);
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
    const rng = createBareState(5).rng;
    nextU32(rng);
    const fresh = createState(5);
    expect(state).toEqual({
      version: SNAPSHOT_VERSION,
      tick: 42,
      seed: 5,
      rng,
      speed: 2,
      pending: [],
      log: [],
      logOffset: 0,
      roads: fresh.roads,
      undo: [],
      connections: fresh.connections,
    });
  });

  it("loads the version 2 fixture as a current city with no roads but its outside connections and no undo history", () => {
    const { state, header } = deserialize(fromHex(v2Fixture.hex));
    expect(header.stateVersion).toBe(2);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    const { roads, undo, connections, ...rest } = state;
    const fresh = createState(state.seed);
    expect(roads).toEqual(fresh.roads);
    expect(connections).toEqual(fresh.connections);
    expect(undo).toEqual([]);
    // Everything the version 2 save held comes back unchanged.
    expect(hashState({ ...rest, version: 2 })).toBe(v2Fixture.hash);
  });

  it("loads the version 3 fixture with an empty undo history, and connections in its free ids", () => {
    const { state, header } = deserialize(fromHex(v3Fixture.hex));
    expect(header.stateVersion).toBe(3);
    expect(state.undo).toEqual([]);
    expect(segmentsAt(state.roads, 1)).toHaveLength(2);
    // The connections take the ids the save had free, then new ones.
    expect(Array.from(state.connections)).toEqual([4, 6]);
    expect(Array.from(state.roads.segFree)).toEqual([]);
    expect(Array.from(state.roads.nodeFree)).toEqual([]);
    expect(checkConnections(state.connections, state.roads)).toBeNull();
    expect(hashState(state)).toBe("0c8ce64d94f25291");
  });

  it("loads the version 4 fixture to its recorded hash, with the ids its undo history holds", () => {
    const { state, header } = deserialize(fromHex(v4Fixture.hex));
    expect(header.stateVersion).toBe(4);
    // Migrated, it is the version 7 fixture.
    expect(hashState(state)).toBe(v7Fixture.hash);
    expect(Array.from(state.connections)).toEqual(v5Fixture.connections);
    expect(state.undo.map((r) => [r.playerId, r.type])).toEqual([
      ["p1", "BuildRoad"],
      ["p2", "BuildRoad"],
      ["p1", "UpgradeRoad"],
      ["p2", "BulldozeRoad"],
    ]);
    expect(heldIds(state.undo)).toEqual(v4Fixture.held);
    // p2's bulldoze comes back on undo.
    expect(submit(state, { seq: 1, playerId: "p2", type: "Undo", payload: {} })).toEqual({ ok: true });
  });

  it("loads the version 5 fixture with each segment's level at both its ends", () => {
    const { state, header } = deserialize(fromHex(v5Fixture.hex));
    expect(header.stateVersion).toBe(5);
    // Migrated, it is the version 7 fixture.
    expect(hashState(state)).toBe(v7Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v5Fixture.held);
    expect(Array.from(state.connections)).toEqual(v5Fixture.connections);
    expect(Array.from(state.roads.segLevelB)).toEqual(Array.from(state.roads.segLevelA));
    expect("segLevel" in state.roads).toBe(false);
    for (const record of state.undo) {
      for (const op of record.ops) {
        if (op.op === "addSeg" || op.op === "removeSeg") {
          expect(op.row.levelB).toBe(op.row.levelA);
          expect("level" in op.row).toBe(false);
        }
      }
    }
    // An undo of a migrated record still applies.
    expect(submit(state, { seq: 1, playerId: "p2", type: "Undo", payload: {} })).toEqual({ ok: true });
  });

  it("loads the version 6 fixture with every undo op saying which road it means", () => {
    const { state, header } = deserialize(fromHex(v6Fixture.hex));
    expect(header.stateVersion).toBe(6);
    // Migrated, it is the version 7 fixture.
    expect(hashState(state)).toBe(v7Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v6Fixture.held);
    expect(Array.from(state.connections)).toEqual(v6Fixture.connections);
    let filled = 0;
    for (const record of state.undo) {
      for (const op of record.ops) {
        if (op.op === "removeSeg") {
          expect([op.ax, op.az, op.bx, op.bz].every(Number.isFinite)).toBe(true);
          filled++;
        }
        if (op.op === "restyle") {
          expect(op.a).not.toBe(op.b);
          filled++;
        }
      }
    }
    expect(filled).toBeGreaterThan(1);
    // Undos of migrated records still apply: p2's bulldoze, then p1's upgrade.
    expect(submit(state, { seq: 1, playerId: "p2", type: "Undo", payload: {} })).toEqual({ ok: true });
    expect(submit(state, { seq: 2, playerId: "p1", type: "Undo", payload: {} })).toEqual({ ok: true });
  });

  it("loads the version 7 fixture to its recorded hash", () => {
    const { state, header } = deserialize(fromHex(v7Fixture.hex));
    expect(header.stateVersion).toBe(7);
    expect(hashState(state)).toBe(v7Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v7Fixture.held);
    expect(Array.from(state.connections)).toEqual(v7Fixture.connections);
  });

  it("still writes the version 7 fixture byte for byte", () => {
    // If this fails the byte layout changed: bump SNAPSHOT_FORMAT_VERSION and
    // keep reading the old layout, or explain in the pull request why not.
    const { state } = deserialize(fromHex(v7Fixture.hex));
    expect(toHex(serialize(state))).toBe(v7Fixture.hex);
  });

  it("refuses a save whose connection list names a node that is not a connection", () => {
    const { state } = deserialize(fromHex(v7Fixture.hex));
    state.connections = Int32Array.of(0);
    const error = refusal(serialize(state));
    expect(error.code).toBe("corrupt");
    expect(error.message).toMatch(/outside connections are malformed/);
  });
});

describe("snapshots with a road network", () => {
  function withRoads(): SimState {
    const state = busyState(3);
    const r = state.roads;
    const a = addNode(r, 10, 20, 5, true);
    const b = addNode(r, 110, 20, 6);
    const c = addNode(r, 110, 220, 7.5);
    addSegment(r, a, b, { type: 0 });
    const gone = addSegment(r, b, c, { type: 1, cx: 200, cz: 100 });
    addSegment(r, a, c, { type: 2, level: 1 });
    removeSegment(r, gone);
    // Spare capacity behind the arrays must not reach the save or the hash.
    for (let i = 0; i < 20; i++) addNode(r, i, i, 0);
    return state;
  }

  it("writes the same bytes a part at a time", () => {
    const state = withRoads();
    for (const [steps, whole] of [
      [serializeSteps(state), serialize(state)],
      [serializeDetachedSteps(state), serializeDetached(state)],
    ] as const) {
      let parts = 0;
      let part = steps.next();
      while (!part.done) {
        parts++;
        part = steps.next();
      }
      // Find the arrays, write the JSON, lay out the bytes, then the checksum.
      expect(parts).toBe(3);
      expect(toHex(part.value)).toBe(toHex(whole));
    }
  });

  it("refuses a bad state on the first part", () => {
    const state = withRoads();
    state.tick = -1;
    expect(() => serializeDetachedSteps(state).next()).toThrow(RangeError);
  });

  it("captures a state that a save can be written from while the city changes", () => {
    const state = withRoads();
    state.undo = [{ playerId: "p1", entry: 0, type: "BuildRoad", ops: [{ op: "addNode", id: 1, grown: true }] }];
    const before = toHex(serialize(state));
    const hash = hashState(state);
    const captured = captureState(state);
    expect(hashState(captured)).toBe(hash);
    // The entries are the same objects; the arrays and lists are copies.
    expect(captured.log[0]).toBe(state.log[0]);
    expect(captured.undo).toBe(state.undo);
    expect(captured.log).not.toBe(state.log);
    expect(captured.pending).not.toBe(state.pending);
    expect(captured.rng).not.toBe(state.rng);
    expect(captured.roads.nodeX).not.toBe(state.roads.nodeX);

    // A save started on the capture, then the city moves on between parts.
    const steps = serializeSteps(captured);
    const change = (n: number): void => {
      const r = state.roads;
      const a = addNode(r, 500 + n, 40, 1);
      const b = addNode(r, 600 + n, 40, 2);
      const seg = addSegment(r, a, b, { type: 0 });
      if (n % 2 === 0) removeSegment(r, seg);
      r.nodeX[0] = 999 + n;
      submit(state, { seq: 100 + n, playerId: "p1", type: "NoOp", payload: { n } });
      step(state);
      state.undo = [...state.undo, { playerId: "p2", entry: n, type: "BuildRoad", ops: [] }];
    };
    let n = 0;
    let part = steps.next();
    while (!part.done) {
      change(n++);
      part = steps.next();
    }
    expect(n).toBeGreaterThan(0);
    expect(hashState(state)).not.toBe(hash);
    expect(toHex(part.value)).toBe(before);
    expect(hashState(captured)).toBe(hash);
  });

  it("serialises, deserialises and hashes the same", () => {
    const state = withRoads();
    const { state: back } = deserialize(serialize(state));
    expect(hashState(back)).toBe(hashState(state));
    expect(back.roads).toEqual(state.roads);
    expect(toHex(serialize(back))).toBe(toHex(serialize(state)));
  });

  it("refuses a save whose road network is malformed", () => {
    const state = withRoads();
    state.roads.segA[0] = 99;
    const error = refusal(serialize(state));
    expect(error.code).toBe("corrupt");
    expect(error.message).toMatch(/road network is malformed/);
  });

  it("refuses a save whose road arrays differ in length", () => {
    const state = withRoads();
    state.roads.nodeX = state.roads.nodeX.slice(1);
    expect(refusal(serialize(state)).message).toMatch(/node arrays differ in length/);
  });
});

describe("snapshots that are refused", () => {
  it("refuses a newer state version with a clear message", () => {
    const bytes = serialize(createBareState(1));
    new DataView(bytes.buffer).setUint16(6, SNAPSHOT_VERSION + 1, true);
    const error = refusal(bytes);
    expect(error.code).toBe("newer-version");
    expect(error.message).toMatch(/newer version of the game/);
    expect(error.message).toContain(`save version ${SNAPSHOT_VERSION + 1}`);
  });

  it("refuses a newer file format before reading anything after the version", () => {
    const bytes = serialize(createBareState(1)).slice(0, 8);
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
      const state = createBareState(3);
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
