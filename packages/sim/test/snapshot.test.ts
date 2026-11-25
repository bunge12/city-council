import { describe, expect, it } from "vitest";
import { syncCells } from "../src/zoning/cell-index";
import {
  BALANCE_STAMP,
  recountTotals,
  DEMAND_BALANCE,
  replaysUnderThisBalance,
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_VERSION,
  NO_LEAVING,
  SnapshotError,
  captureState,
  createBareState,
  createCaptureBuffers,
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
  type SnapshotBuffer,
} from "../src/index";
import { withValue } from "./with-value";
import v1Fixture from "./fixtures/snapshots/v1.json";
import v2Fixture from "./fixtures/snapshots/v2.json";
import v3Fixture from "./fixtures/snapshots/v3.json";
import v4Fixture from "./fixtures/snapshots/v4.json";
import v5Fixture from "./fixtures/snapshots/v5.json";
import v6Fixture from "./fixtures/snapshots/v6.json";
import v7Fixture from "./fixtures/snapshots/v7.json";
import v8Fixture from "./fixtures/snapshots/v8.json";
import v9Fixture from "./fixtures/snapshots/v9.json";
import v10Fixture from "./fixtures/snapshots/v10.json";
import v11Fixture from "./fixtures/snapshots/v11.json";
import v12Fixture from "./fixtures/snapshots/v12.json";
import v13Fixture from "./fixtures/snapshots/v13.json";
import v14Fixture from "./fixtures/snapshots/v14.json";
import v15Fixture from "./fixtures/snapshots/v15.json";
import v16Fixture from "./fixtures/snapshots/v16.json";
import v17Fixture from "./fixtures/snapshots/v17.json";
import v18Fixture from "./fixtures/snapshots/v18.json";
import v19Fixture from "./fixtures/snapshots/v19.json";
import v20Fixture from "./fixtures/snapshots/v20.json";
import v21Fixture from "./fixtures/snapshots/v21.json";
import v22Fixture from "./fixtures/snapshots/v22.json";
import v23Fixture from "./fixtures/snapshots/v23.json";
import v24Fixture from "./fixtures/snapshots/v24.json";
import v25Fixture from "./fixtures/snapshots/v25.json";
import v26Fixture from "./fixtures/snapshots/v26.json";
import v27Fixture from "./fixtures/snapshots/v27.json";
import v28Fixture from "./fixtures/snapshots/v28.json";
import v29Fixture from "./fixtures/snapshots/v29.json";
import { withoutSatisfaction } from "./before-satisfaction";
import { withoutVacancy } from "./before-vacancy";
import { withoutDisplaced } from "./before-displaced";
import { withoutRedevelopment } from "./before-redevelopment";
import { withoutTravelLast } from "./before-travel-last";
import { withoutTiers } from "./before-tiers";
import { withoutGrace } from "./before-grace";
import { serializeStepsOf, snapshotChecksum, type SnapshotSteps } from "../src/snapshot";
import { Fnv64 } from "../src/hash";
import { checkConnections } from "../src/roads/connections";
import { heldIds } from "../src/undo";
import { createPops } from "../src/pops/pops";
import { HISTORY_LENGTH, createStats } from "../src/stats/stats";
import { createDemand, type DemandState } from "../src/demand/demand";
import { NO_TIER, addNode, addSegment, checkRoadNetwork, isSegment, removeSegment, segmentsAt } from "../src/roads/network";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `state` with the grower's plan that versions 13 to 20 held put back after
 * the buildings, where they kept it, so an older version's bytes and hash
 * can be rebuilt from a current state. Version 21 dropped it (M3-07).
 */
function withPlan<T extends object>(state: T, growth: unknown = v13Fixture.growth): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withoutOwed(state))) {
    out[key] = value;
    if (key === "buildings") out["growth"] = growth;
  }
  return out as T;
}

/** `state` as it was before version 22 gave the pops the day's plan of arrivals, and so before version 23 too. */
function withoutOwed<T extends object>(state: T): T {
  const before = withoutSatisfaction(state);
  const pops = (before as Record<string, unknown>)["pops"];
  if (typeof pops !== "object" || pops === null || !("owed" in pops)) return before;
  const { owed, ...rest } = pops as Record<string, unknown>;
  void owed;
  return { ...before, pops: rest };
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
    // One expect at the end, not one per byte: the body is about 17,000
    // bytes, and an expect for each took the test past 5 s on CI.
    const bytes = serializeDetached(busyState());
    const missed: string[] = [];
    for (let at = 40; at < bytes.byteLength; at++) {
      const bit = 1 << (at % 8);
      bytes[at] = (bytes[at] ?? 0) ^ bit;
      try {
        readSnapshotHeader(bytes);
        missed.push(`byte ${at}: read`);
      } catch (e) {
        if (!/checksum does not match/.test((e as Error).message)) missed.push(`byte ${at}: ${(e as Error).message}`);
      }
      bytes[at] = (bytes[at] ?? 0) ^ bit;
    }
    expect(missed).toEqual([]);
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
      balance: "",
      cells: fresh.cells,
      cellsReadyAt: 0,
      buildings: fresh.buildings,
      cellReads: 0,
      pops: createPops(),
      // No centre yet, due on the tick it was saved on.
      centre: { x: 0, z: 0, weight: 0, due: 42 },
      // No buildings or pops to count, and no history yet.
      stats: createStats(),
      travelReadyAt: 0,
      demand: createDemand(),
      redevelopedToday: 0,
      travelLast: null,
    });
  });

  it("loads the version 2 fixture as a current city with no roads but its outside connections and no undo history", () => {
    const { state, header } = deserialize(fromHex(v2Fixture.hex));
    expect(header.stateVersion).toBe(2);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    const { roads, undo, connections, balance, cells, cellsReadyAt, buildings, cellReads, pops, centre, stats, travelReadyAt, demand, redevelopedToday, travelLast, ...rest } = state;
    const fresh = createState(state.seed);
    expect(redevelopedToday).toBe(0);
    expect(travelLast).toBeNull();
    expect(roads).toEqual(fresh.roads);
    expect(connections).toEqual(fresh.connections);
    expect(undo).toEqual([]);
    expect(balance).toBe("");
    expect(cells).toEqual(fresh.cells);
    expect(cellsReadyAt).toBe(0);
    expect(buildings).toEqual(fresh.buildings);
    expect(cellReads).toBe(0);
    expect(pops).toEqual(createPops());
    expect(centre).toEqual({ x: 0, z: 0, weight: 0, due: state.tick });
    expect(stats).toEqual(createStats());
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
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
    // 837c1f5f97e7223e before version 16 added the pops, none of them,
    // 047f63c44d3532c6 before version 17 added the city centre,
    // 2c8417bd488aaf2c before version 18 added the statistics and
    // b90ed457773da23b before version 19 added `travelReadyAt` and
    // ca9cac638ae35bc2 before version 20 added the demand bars and M3-06's
    // demand numbers moved the stamp, 73bdd4f0f1feda71 before version 21
    // dropped the grower's plan, and c9e3752ab3c3c792 before version 22 gave
    // the pops the day's plan of arrivals.
    const { stats, travelReadyAt, demand, ...before } = state;
    expect(stats).toEqual(createStats());
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 17 }))))))).toBe("2c8417bd488aaf2c");
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, stats, version: 18 }))))))).toBe("b90ed457773da23b");
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, stats, travelReadyAt, version: 19 }))))))).toBe("ca9cac638ae35bc2");
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 20 }))))))).toBe("73bdd4f0f1feda71");
    expect(hashState(withoutOwed(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 21 }))))))).toBe("c9e3752ab3c3c792");
    expect(state.pops.owed).toBe(0);
    // d9d6b0d11b282721 before version 23 added what satisfaction keeps (M3-10).
    expect(hashState(withoutSatisfaction(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 22 }))))))).toBe("d9d6b0d11b282721");
    // 0690c599161c774a before version 24 gave the buildings the tick each became what it is (M3-24).
    expect(hashState(withoutVacancy(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 23 }))))))).toBe("0690c599161c774a");
    // e2daa92cde0fdfbf before version 25 added the queue of displaced pops (M3-12).
    expect(hashState(withoutDisplaced(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 24 }))))))).toBe("e2daa92cde0fdfbf");
    // 0a7b5b33789aa45d before version 26 added the count of buildings redeveloped today (M3-14).
    expect(hashState(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 25 })))))).toBe("0a7b5b33789aa45d");
    expect(state.redevelopedToday).toBe(0);
    // 10e82429ba0b0d29 before version 27 added the last travel-time table (#313).
    expect(hashState(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 26 }))))).toBe("10e82429ba0b0d29");
    expect(state.travelLast).toBeNull();
    // f753e91d9059e2a6 before version 28 gave every segment's strips a tier (#341).
    expect(hashState(withoutGrace(withoutTiers({ ...state, version: 27 })))).toBe("f753e91d9059e2a6");
    // 3a464ff76463e88b before version 29 gave the pops their days of grace (#361).
    expect(hashState(withoutGrace({ ...state, version: 28 }))).toBe("3a464ff76463e88b");
    expect(hashState(state)).toBe("7d710d3c180e0bdb");
  });

  it("loads the version 4 fixture to its recorded hash, with the ids its undo history holds", () => {
    const { state, header } = deserialize(fromHex(v4Fixture.hex));
    expect(header.stateVersion).toBe(4);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
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
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
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
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
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

  it("loads the version 7 fixture with an empty balance stamp, so it is not taken to replay", () => {
    const { state, header } = deserialize(fromHex(v7Fixture.hex));
    expect(header.stateVersion).toBe(7);
    expect(state.balance).toBe("");
    expect(replaysUnderThisBalance(state)).toBe(false);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v7Fixture.held);
    expect(Array.from(state.connections)).toEqual(v7Fixture.connections);
  });

  it("loads the version 8 fixture with a build order on every segment, in id order", () => {
    const { state, header } = deserialize(fromHex(v8Fixture.hex));
    expect(header.stateVersion).toBe(8);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v8Fixture.held);
    expect(Array.from(state.connections)).toEqual(v8Fixture.connections);
    const net = state.roads;
    const live: number[] = [];
    for (let id = 0; id < net.segFlags.length; id++) if (isSegment(net, id)) live.push(id);
    expect(live.map((id) => net.segOrder[id])).toEqual(live.map((_, i) => i));
    // The segment p2's bulldoze holds comes next, and the counter is past it.
    const [heldSeg] = v8Fixture.held.segs;
    const removed = state.undo.flatMap((r) => r.ops).find((op) => op.op === "removeSeg" && op.id === heldSeg);
    expect(removed?.op === "removeSeg" && removed.row.order).toBe(live.length);
    expect(net.segOrderNext).toBe(live.length + 1);
    for (const op of state.undo.flatMap((r) => r.ops)) if (op.op === "addSeg") expect(op.fresh).toBe(false);
    // p2's bulldoze comes back with that number, then p1's upgrade is taken back.
    expect(submit(state, { seq: 1, playerId: "p2", type: "Undo", payload: {} })).toEqual({ ok: true });
    expect(submit(state, { seq: 2, playerId: "p1", type: "Undo", payload: {} })).toEqual({ ok: true });
    // Both read the cells, so they apply a tick apart (`cellCommandsPerTick`, M2 review #147).
    while (state.pending.length > 0) step(state);
    expect(state.undo.map((r) => r.playerId)).toEqual(["p1", "p2"]);
    expect(net.segOrder[heldSeg ?? -1]).toBe(live.length);
    expect(checkRoadNetwork(net, heldIds(state.undo))).toBeNull();
  });

  it("loads the version 9 fixture with unzoned cells along every zonable road", () => {
    const { state, header } = deserialize(fromHex(v9Fixture.hex));
    expect(header.stateVersion).toBe(9);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.cells.zone).toHaveLength(v10Fixture.cells);
    expect(state.cells.zone.every((z) => z === 0) && state.cells.density.every((d) => d === 0)).toBe(true);
    expect(state.cells.offset).toHaveLength(state.roads.segFlags.length + 1);
    expect(heldIds(state.undo)).toEqual(v9Fixture.held);
  });

  it("loads the version 10 fixture with no buildings", () => {
    const { state, header } = deserialize(fromHex(v10Fixture.hex));
    expect(header.stateVersion).toBe(10);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.buildings).toEqual(createBareState(0).buildings);
    expect(heldIds(state.undo)).toEqual(v10Fixture.held);
    expect(Array.from(state.connections)).toEqual(v10Fixture.connections);
  });

  it("loads the version 11 fixture with the back-lot arrays of a through-lot, empty", () => {
    const { state, header } = deserialize(fromHex(v11Fixture.hex));
    expect(header.stateVersion).toBe(11);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.buildings).toEqual(createBareState(0).buildings);
    expect(heldIds(state.undo)).toEqual(v11Fixture.held);
    expect(Array.from(state.connections)).toEqual(v11Fixture.connections);
  });

  it("loads the version 12 fixture, and its grower's plan goes in version 21", () => {
    const { state, header } = deserialize(fromHex(v12Fixture.hex));
    expect(header.stateVersion).toBe(12);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    // Migrated, it is the version 29 fixture.
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v12Fixture.held);
    expect(Array.from(state.connections)).toEqual(v12Fixture.connections);
  });

  it("loads the version 13 fixture with an empty zone journal on every undo record", () => {
    const { state, header } = deserialize(fromHex(v13Fixture.hex));
    expect(header.stateVersion).toBe(13);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.undo.map((r) => [r.playerId, r.type])).toEqual(v14Fixture.undo);
    for (const record of state.undo) expect(record.zones).toEqual(new Int32Array(0));
    expect(heldIds(state.undo)).toEqual(v13Fixture.held);
    expect(Array.from(state.connections)).toEqual(v13Fixture.connections);
    // Its undos still apply: p2's bulldoze, then p1's upgrade.
    expect(submit(state, { seq: 1, playerId: "p2", type: "Undo", payload: {} })).toEqual({ ok: true });
    expect(submit(state, { seq: 2, playerId: "p1", type: "Undo", payload: {} })).toEqual({ ok: true });
  });

  it("loads the version 14 fixture and migrates it, adding only the version, a count of no cell commands, no pops and no centre yet", () => {
    const { state, header } = deserialize(fromHex(v14Fixture.hex));
    expect(header.stateVersion).toBe(14);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { cellReads, pops, centre, stats, travelReadyAt, demand, ...before } = state;
    expect(stats).toEqual(createStats());
    expect(cellReads).toBe(0);
    expect(pops).toEqual(createPops());
    expect(centre).toEqual({ x: 0, z: 0, weight: 0, due: state.tick });
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 14 }))))))).toBe(v14Fixture.hash);
    for (const record of state.undo) expect(record.stroke).toBeUndefined();
    expect(heldIds(state.undo)).toEqual(v14Fixture.held);
    expect(Array.from(state.connections)).toEqual(v14Fixture.connections);
  });

  it("loads the version 15 fixture unchanged apart from an empty pop table, no centre yet and no travel rebuild under way", () => {
    const { state, header } = deserialize(fromHex(v15Fixture.hex));
    expect(header.stateVersion).toBe(15);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { pops, centre, stats, travelReadyAt, demand, ...before } = state;
    expect(stats).toEqual(createStats());
    expect(centre).toEqual({ x: 0, z: 0, weight: 0, due: state.tick });
    expect(pops).toEqual(createPops());
    expect(pops.sweep).toBe(0);
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 15 }))))))).toBe(v15Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v15Fixture.held);
    expect(Array.from(state.connections)).toEqual(v15Fixture.connections);
  });

  it("loads the version 16 fixture and migrates it, adding only the version, a city centre due on its tick and statistics with no history", () => {
    const { state, header } = deserialize(fromHex(v16Fixture.hex));
    expect(header.stateVersion).toBe(16);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { centre, stats, travelReadyAt, demand, ...before } = state;
    expect(stats).toEqual(createStats());
    expect(centre).toEqual({ x: 0, z: 0, weight: 0, due: state.tick });
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 16 }))))))).toBe(v16Fixture.hash);
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(heldIds(state.undo)).toEqual(v16Fixture.held);
    expect(Array.from(state.connections)).toEqual(v16Fixture.connections);
  });

  it("loads the version 17 fixture and migrates it, adding only the version, its statistics, counted, with no history, and no travel rebuild under way", () => {
    const { state, header } = deserialize(fromHex(v17Fixture.hex));
    expect(header.stateVersion).toBe(17);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { stats, travelReadyAt, demand, ...before } = state;
    // No buildings and no pops, so every total is 0.
    expect(stats).toEqual(createStats());
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 17 }))))))).toBe(v17Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v17Fixture.held);
    expect(Array.from(state.connections)).toEqual(v17Fixture.connections);
  });

  it("loads the version 18 fixture and migrates it, adding only the version, no rebuild of the travel times under way and the bars at 0", () => {
    const { state, header } = deserialize(fromHex(v18Fixture.hex));
    expect(header.stateVersion).toBe(18);
    expect(state.version).toBe(SNAPSHOT_VERSION);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { travelReadyAt, demand, ...before } = state;
    expect(travelReadyAt).toBe(0);
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 18 }))))))).toBe(v18Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v18Fixture.held);
    expect(Array.from(state.connections)).toEqual(v18Fixture.connections);
  });

  it("loads the version 19 fixture and migrates it to version 29, adding only the version and the demand bars, all at 0, dropping the grower's plan and adding the plan of arrivals", () => {
    const { state, header } = deserialize(fromHex(v19Fixture.hex));
    expect(header.stateVersion).toBe(19);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    const { demand, ...before } = state;
    expect(demand).toEqual(createDemand());
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...before, version: 19 }))))))).toBe(v19Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v19Fixture.held);
    expect(Array.from(state.connections)).toEqual(v19Fixture.connections);
  });

  it("loads the version 20 fixture and migrates it to version 29, dropping only the grower's plan and adding the plan of arrivals", () => {
    const { state, header } = deserialize(fromHex(v20Fixture.hex));
    expect(header.stateVersion).toBe(20);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect("growth" in state).toBe(false);
    expect(hashState(withPlan(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 20 }))))))).toBe(v20Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v20Fixture.held);
    expect(Array.from(state.connections)).toEqual(v20Fixture.connections);
  });

  it("loads the version 21 fixture and migrates it to version 29, adding only the plan of arrivals, at 0", () => {
    const { state, header } = deserialize(fromHex(v21Fixture.hex));
    expect(header.stateVersion).toBe(21);
    expect(state.version).toBe(29);
    expect(state.pops.owed).toBe(0);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(hashState(withoutOwed(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 21 }))))))).toBe(v21Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v21Fixture.held);
    expect(Array.from(state.connections)).toEqual(v21Fixture.connections);
  });

  it("loads the version 22 fixture and migrates it to version 29, adding only the days low, no plan of departures, the residents' summed satisfaction and the bar's satisfaction part", () => {
    const { state, header } = deserialize(fromHex(v22Fixture.hex));
    expect(header.stateVersion).toBe(22);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.pops.leaveScore).toBe(NO_LEAVING);
    expect(state.pops.leaveAtScore).toBe(0);
    expect(state.stats.totals["residentSatisfaction"]).toBe(0);
    expect(state.stats.history["residentSatisfaction"]?.length).toBe(state.stats.history["population"]?.length);
    expect(state.demand.residential.parts["satisfaction"]).toBe(0);
    expect(hashState(withoutSatisfaction(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 22 }))))))).toBe(v22Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v22Fixture.held);
    expect(Array.from(state.connections)).toEqual(v22Fixture.connections);
  });

  it("loads the version 23 fixture and migrates it to version 29, adding only the tick each building became what it is", () => {
    const { state, header } = deserialize(fromHex(v23Fixture.hex));
    expect(header.stateVersion).toBe(23);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.buildings.statusSince).toEqual(new Float64Array(0));
    expect(hashState(withoutVacancy(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 23 }))))))).toBe(v23Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v23Fixture.held);
    expect(Array.from(state.connections)).toEqual(v23Fixture.connections);
  });

  it("loads the version 24 fixture and migrates it to version 29, adding only an empty queue of displaced pops", () => {
    const { state, header } = deserialize(fromHex(v24Fixture.hex));
    expect(header.stateVersion).toBe(24);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.pops.displaced).toEqual(new Int32Array(0));
    expect(hashState(withoutDisplaced(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 24 }))))))).toBe(v24Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v24Fixture.held);
    expect(Array.from(state.connections)).toEqual(v24Fixture.connections);
  });

  it("loads the version 25 fixture and migrates it to version 29, adding only no buildings redeveloped today", () => {
    const { state, header } = deserialize(fromHex(v25Fixture.hex));
    expect(header.stateVersion).toBe(25);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.redevelopedToday).toBe(0);
    expect(hashState(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 25 })))))).toBe(v25Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v25Fixture.held);
    expect(Array.from(state.connections)).toEqual(v25Fixture.connections);
  });

  it("loads the version 26 fixture and migrates it to version 29, adding only no last travel-time table", () => {
    const { state, header } = deserialize(fromHex(v26Fixture.hex));
    expect(header.stateVersion).toBe(26);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(state.travelLast).toBeNull();
    expect(hashState(withoutTravelLast(withoutGrace(withoutTiers({ ...state, version: 26 }))))).toBe(v26Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v26Fixture.held);
    expect(Array.from(state.connections)).toEqual(v26Fixture.connections);
  });

  it("loads the version 27 fixture and migrates it to version 29, adding only strip tiers that front no block, and no days of grace", () => {
    const { state, header } = deserialize(fromHex(v27Fixture.hex));
    expect(header.stateVersion).toBe(27);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    for (let seg = 0; seg < state.roads.segFlags.length; seg++) {
      const want = isSegment(state.roads, seg) ? NO_TIER : 0;
      expect([state.roads.segTierL[seg], state.roads.segTierR[seg]]).toEqual([want, want]);
    }
    expect(hashState(withoutGrace(withoutTiers({ ...state, version: 27 })))).toBe(v27Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v27Fixture.held);
    expect(Array.from(state.connections)).toEqual(v27Fixture.connections);
  });

  it("loads the version 28 fixture and migrates it to version 29, adding only no days of grace and no unemployed newcomers", () => {
    const { state, header } = deserialize(fromHex(v28Fixture.hex));
    expect(header.stateVersion).toBe(28);
    expect(state.version).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(Array.from(state.pops.graceDays).every((d) => d === 0)).toBe(true);
    expect(state.pops.graceDays.length).toBe(state.pops.flags.length);
    expect(state.stats.totals["workersUnemployedNew"]).toBe(0);
    expect(state.stats.history["workersUnemployedNew"]?.length).toBe(state.stats.history["population"]?.length);
    expect(Array.from(state.stats.history["workersUnemployedNew"] ?? []).every((n) => n === 0)).toBe(true);
    expect(hashState(withoutGrace({ ...state, version: 28 }))).toBe(v28Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v28Fixture.held);
    expect(Array.from(state.connections)).toEqual(v28Fixture.connections);
  });

  it("loads the version 29 fixture to its recorded hash", () => {
    const { state, header } = deserialize(fromHex(v29Fixture.hex));
    expect(header.stateVersion).toBe(29);
    expect(hashState(state)).toBe(v29Fixture.hash);
    expect(heldIds(state.undo)).toEqual(v29Fixture.held);
    expect(Array.from(state.connections)).toEqual(v29Fixture.connections);
  });

  it("refuses a save whose last travel-time table is malformed", () => {
    const zones = 576;
    const breaks: unknown[] = [
      undefined,
      7,
      { table: new Uint16Array(zones * zones), sources: new Int32Array(zones) },
      { table: new Uint16Array(3), sources: new Int32Array(zones), tick: 0 },
      { table: new Uint16Array(zones * zones), sources: new Int32Array(2), tick: 0 },
      { table: new Uint16Array(zones * zones), sources: new Int32Array(zones), tick: 0.5 },
      { table: new Uint16Array(zones * zones), sources: new Int32Array(zones), tick: 1e9 },
      { table: new Uint16Array(zones * zones), sources: new Int32Array(zones), tick: 0, more: 1 },
    ];
    for (const travelLast of breaks) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      (state as unknown as Record<string, unknown>)["travelLast"] = travelLast;
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/last travel-time table/);
    }
  });

  it("keeps a last travel-time table through a save, byte for byte", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    const table = new Uint16Array(576 * 576).map((_, i) => i % 65536);
    const sources = new Int32Array(576).map((_, i) => i - 1);
    state.travelLast = { table, sources, tick: state.tick };
    const back = deserialize(serialize(state)).state;
    expect(back.travelLast).toEqual({ table, sources, tick: state.tick });
    expect(hashState(back)).toBe(hashState(state));
  });

  it("still writes the version 29 fixture byte for byte", () => {
    // If this fails the byte layout changed: bump SNAPSHOT_FORMAT_VERSION and
    // keep reading the old layout, or explain in the pull request why not.
    const { state } = deserialize(fromHex(v29Fixture.hex));
    expect(toHex(serialize(state))).toBe(v29Fixture.hex);
  });

  it("refuses a save whose count of buildings redeveloped today is not a whole number of 0 or more", () => {
    for (const redevelopedToday of [undefined, -1, 0.5]) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      (state as unknown as Record<string, unknown>)["redevelopedToday"] = redevelopedToday;
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/redeveloped today/);
    }
  });

  it("refuses a save whose plan of departures is malformed", () => {
    const breaks: ((pops: Record<string, unknown>) => void)[] = [
      (p) => delete p["leaveScore"],
      (p) => (p["leaveScore"] = -2),
      (p) => (p["leaveScore"] = 101),
      (p) => (p["leaveScore"] = 0.5),
      (p) => (p["leaveAtScore"] = 0.5),
      (p) => delete p["daysLow"],
    ];
    for (const breakIt of breaks) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      breakIt(state.pops as unknown as Record<string, unknown>);
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/pops/);
    }
  });

  it("refuses a save whose plan of arrivals is not a whole number of 0 or below", () => {
    for (const owed of [undefined, -0.5, 3]) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      (state.pops as unknown as Record<string, unknown>)["owed"] = owed;
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/pops/);
    }
  });

  it("refuses a save whose demand bars are malformed", () => {
    type Loose = Record<string, { value: unknown; parts: Record<string, unknown> }>;
    const breaks: ((demand: Loose) => void)[] = [
      (d) => delete d["office"],
      (d) => ((d as unknown as DemandState).residential.value = 101),
      (d) => ((d as unknown as DemandState).commercial.value = Number.NaN),
      (d) => delete (d as unknown as DemandState).industrial.parts["outsideRoute"],
      (d) => ((d as unknown as DemandState).industrial.parts["extra"] = 1),
      (d) => (((d as unknown as DemandState).office.parts as Record<string, unknown>)["serviceBuyers"] = "1"),
    ];
    for (const breakIt of breaks) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      breakIt(state.demand as unknown as Loose);
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/demand bars/);
    }
  });

  it("refuses a save whose tick for the travel times is not a whole number", () => {
    for (const travelReadyAt of [undefined, -1, 0.5]) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      (state as unknown as Record<string, unknown>)["travelReadyAt"] = travelReadyAt;
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/travel times/);
    }
  });

  it("refuses a save whose statistics are malformed", () => {
    const breaks: ((stats: Record<string, unknown>) => void)[] = [
      (st) => delete st["next"],
      (st) => ((st["totals"] as Record<string, number>)["population"] = -1),
      (st) => ((st["totals"] as Record<string, number>)["population"] = 0.5),
      (st) => delete (st["totals"] as Record<string, number>)["pops"],
      (st) => ((st["totals"] as Record<string, number>)["population"] = 10),
      (st) => ((st["year"] as Record<string, number>)["births"] = -2),
      (st) => ((st["history"] as Record<string, Int32Array>)["pops"] = new Int32Array(1)),
      (st) => delete (st["history"] as Record<string, Int32Array>)["pops"],
      (st) => (st["next"] = 3),
      (st) => (st["next"] = HISTORY_LENGTH),
    ];
    for (const breakIt of breaks) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      // Under this build's numbers: a city from another balance has its totals counted again instead (below).
      state.balance = BALANCE_STAMP;
      breakIt(state.stats as unknown as Record<string, unknown>);
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/statistics/);
    }
  });

  it("counts the totals of a city from another balance again as it loads, whatever they were (M3 review, #365)", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    expect(state.balance).not.toBe(BALANCE_STAMP);
    const recounted = recountTotals(state);
    expect(state.stats.totals).toEqual(recounted);
    const totals = state.stats.totals as Record<string, number>;
    totals["population"] = -1;
    delete totals["pops"];
    expect(deserialize(serialize(state)).state.stats.totals).toEqual(recounted);
  });

  it("refuses a save whose city centre is malformed", () => {
    for (const centre of [undefined, { x: 0, z: 0, weight: -1, due: 0 }, { x: Number.NaN, z: 0, weight: 0, due: 0 }, { x: 0, z: 0, weight: 0, due: 0.5 }, { x: 0, z: 0, weight: 0 }]) {
      const { state } = deserialize(fromHex(v29Fixture.hex));
      (state as unknown as Record<string, unknown>)["centre"] = centre;
      const error = refusal(serialize(state));
      expect(error.code).toBe("corrupt");
      expect(error.message).toMatch(/city centre/);
    }
  });

  it("refuses a save whose undo history gives a stroke id to a road record, or a bad one", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    const road = state.undo[0];
    if (!road) throw new Error("the fixture has no undo record");
    state.undo = [{ ...road, stroke: 3 }, ...state.undo.slice(1)];
    expect(refusal(serialize(state)).message).toMatch(/undo history is malformed/);
  });

  it("refuses a save whose undo history holds a bad cell anchor", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    const op = state.undo.flatMap((r) => r.ops).find((o) => o.op === "removeSeg");
    if (op?.op !== "removeSeg") throw new Error("the fixture's undo history removes no segment");
    op.row.anchor = { ...op.row.anchor, tA: 2 };
    expect(refusal(serialize(state)).message).toMatch(/undo history is malformed/);
    (op.row as unknown as Record<string, unknown>)["anchor"] = undefined;
    expect(refusal(serialize(state)).message).toMatch(/undo history is malformed/);
  });

  it("refuses a save whose zoning cells do not fit its roads", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    state.cells = { ...state.cells, zone: state.cells.zone.slice(1) };
    const error = refusal(serialize(state));
    expect(error.code).toBe("corrupt");
    expect(error.message).toMatch(/zoning cells are malformed/);
  });

  it("refuses a save whose balance stamp is not text", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
    (state as unknown as Record<string, unknown>)["balance"] = 7;
    const error = refusal(serialize(state));
    expect(error.code).toBe("corrupt");
    expect(error.message).toMatch(/balance stamp/);
  });

  it("keeps a new city's stamp through a save, and a city from another balance keeps its own", () => {
    const fresh = createState(7);
    expect(fresh.balance).toBe(BALANCE_STAMP);
    expect(replaysUnderThisBalance(deserialize(serialize(fresh)).state)).toBe(true);
    const other = deserialize(serialize({ ...fresh, balance: "0123456789abcdef" })).state;
    expect(other.balance).toBe("0123456789abcdef");
    expect(replaysUnderThisBalance(other)).toBe(false);
  });

  it("refuses a save whose connection list names a node that is not a connection", () => {
    const { state } = deserialize(fromHex(v29Fixture.hex));
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
      // Find the arrays, write the JSON, then lay out the bytes and take
      // their checksum, which for a city this small fits in one part.
      expect(parts).toBe(2);
      expect(toHex(part.value)).toBe(toHex(whole));
    }
  });

  it("splits the layout and the checksum into parts of a few bytes each, to the same bytes (issue #204)", () => {
    const state = withRoads();
    const run = (steps: SnapshotSteps): { parts: number; bytes: Uint8Array } => {
      let parts = 0;
      for (;;) {
        const part = steps.next();
        if (part.done) return { parts, bytes: part.value };
        parts++;
      }
    };
    const into: SnapshotBuffer = { buffer: null };
    for (const [pagedLog, whole] of [
      [null, serializeDetached(state)],
      [[], serialize(state)],
    ] as const) {
      let lastParts = Infinity;
      // Sizes that split a section anywhere: a word, an odd number of words, part of the JSON.
      for (const partBytes of [1, 8, 24, 40, 1000, 1 << 20]) {
        const fresh = run(serializeStepsOf(state, pagedLog, partBytes));
        expect(toHex(fresh.bytes), `${partBytes} bytes a part`).toBe(toHex(whole));
        const kept = run(serializeStepsOf(state, pagedLog, partBytes, into));
        expect(toHex(kept.bytes), `${partBytes} bytes a part, into a kept buffer`).toBe(toHex(whole));
        expect(kept.parts).toBe(fresh.parts);
        // Fewer parts as each holds more, and never one laying out more than its share.
        expect(fresh.parts).toBeLessThanOrEqual(lastParts);
        lastParts = fresh.parts;
      }
      expect(run(serializeStepsOf(state, pagedLog, 8)).parts).toBeGreaterThan(whole.byteLength / 16);
    }
    // The bytes the build before #204 wrote for this state, so a split
    // that changes them shows here and not only as a mismatch with itself.
    // The balance stamp is in them, so they move with any balance number:
    // M3-01's new files moved it, and with the old stamp put back the bytes
    // were the same. M3-03's empty pop table moved them again: with it taken
    // out and the version set back to 15 they were 8712:67d557fe3b9bcf92 and
    // 8688:eb848d418513d897. M3-13's landvalue.json and the city centre
    // version 17 adds moved them once more: with the centre taken out, the
    // version set back to 16 and the old stamp put back they were
    // 9760:b326e4c3f30b6cf9 and 9736:1a2e2319ea47dd8c. M3-04's statistics,
    // version 18, moved them again; with them taken out and the version set
    // back to 17 the bytes are the same, which the first two lines check.
    // M3-23's `travelReadyAt`, version 19, and its balance numbers moved them
    // once more; with the field taken out, the version set back to 18 and the
    // old stamp the bytes are main's, which the next two lines check.
    // M3-06's demand bars, version 20, and its demand numbers moved them
    // again; with the bars taken out, the version set back to 19 and the
    // stamp before them the bytes are main's, which the two after check.
    // M3-07 dropped the grower's plan, version 21, and moved the stamp: with
    // a new city's plan put back after the buildings, the version set back
    // to 20 and the stamp before it the bytes are main's, which the two
    // after those check. M3-08's plan of arrivals, version 22, and its
    // balance numbers moved them again: with the plan taken out, the version
    // set back to 21 and the stamp before it the bytes are main's, which the
    // next two check. M3-10's satisfaction, version 23, and its balance
    // numbers moved them again: with what it added taken out, the version
    // set back to 22 and the stamp before it the bytes are main's, which the
    // two after those check. M3-24's vacancy, version 24, and M3-12's queue
    // of displaced pops, version 25, M3-14's count of buildings redeveloped
    // today, version 26, and #313's last travel-time table, version 27,
    // moved them again: with each taken out,
    // the version set back and the stamp before it, the bytes are main's,
    // which the lines below check.
    // M3-21 slowed the bars (`dailyShare`), so the stepped city's bars, which
    // these bytes hold, moved: the city for the lines below is stepped at the
    // old share, and with it the bytes are main's but for the stamp, which
    // only the last two lines carry. Versions 26 and 27 hold the stamp from
    // before #353 lowered `bulldozeMaxBuildings`.
    const digest = (bytes: Uint8Array): string => {
      const h = new Fnv64();
      h.bytes(bytes);
      return `${bytes.length}:${h.hex()}`;
    };
    const old = withValue(DEMAND_BALANCE, "dailyShare", 0.2, withRoads);
    const { stats, travelReadyAt, demand, ...rest } = withoutSatisfaction(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old)))));
    const before = withPlan(rest, { quota: 1, day: 0, deadline: 30, free: 0, used: 0 });
    // The stamp main had, before M3-23's balance numbers.
    const v17 = { ...before, version: 17, balance: "1cbab0077b3a0b86" } as SimState;
    const v18 = { ...before, stats, version: 18, balance: "1cbab0077b3a0b86" } as SimState;
    expect(digest(serialize(v17))).toBe("9848:2fef5b1f49b30497");
    expect(digest(serializeDetached(v17))).toBe("9824:8ef9f989c0e9f202");
    expect(digest(serialize(v18))).toBe("18048:c7190637feaf2d5e");
    expect(digest(serializeDetached(v18))).toBe("18024:09c0e7870579ae73");
    const v19 = { ...before, stats, travelReadyAt, version: 19, balance: "fde8ade604d3a3df" } as SimState;
    expect(digest(serialize(v19))).toBe("18080:13dfab8c365e6187");
    expect(digest(serializeDetached(v19))).toBe("18056:5745030fc67f00ad");
    const v20 = { ...before, stats, travelReadyAt, demand, version: 20, balance: "0ef336e5d5886479" } as SimState;
    expect(digest(serialize(v20))).toBe("18800:729675b587eff893");
    expect(digest(serializeDetached(v20))).toBe("18776:0b455789496e4d74");
    const v21 = { ...withoutOwed(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old))))), version: 21, balance: "8f43a4e4c054be82" } as SimState;
    expect(digest(serialize(v21))).toBe("18680:4ef9247766983ea3");
    expect(digest(serializeDetached(v21))).toBe("18656:bc87851caa95eed8");
    const v22 = { ...withoutSatisfaction(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old))))), version: 22, balance: "03b81fd101b40744" } as SimState;
    expect(digest(serialize(v22))).toBe("18696:91fd3064b4cf8893");
    expect(digest(serializeDetached(v22))).toBe("18672:4a93762c49972633");
    const v23 = { ...withoutVacancy(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old))))), version: 23, balance: "4672c4929d82c237" } as SimState;
    expect(digest(serialize(v23))).toBe("19184:0054c66e8dde554f");
    expect(digest(serializeDetached(v23))).toBe("19160:afbc14db5924acc5");
    const v24 = { ...withoutDisplaced(withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old))))), version: 24, balance: "9095ef77f1543543" } as SimState;
    expect(digest(serialize(v24))).toBe("19336:dbd6a79733c4b461");
    expect(digest(serializeDetached(v24))).toBe("19312:aff953be152a7156");
    const v25 = { ...withoutRedevelopment(withoutTravelLast(withoutGrace(withoutTiers(old)))), version: 25, balance: "8dc8d084bbb30043" } as SimState;
    expect(digest(serialize(v25))).toBe("19464:2848b690113dc7a6");
    expect(digest(serializeDetached(v25))).toBe("19440:084523f65622559e");
    // #361's balance number moved the stamp the versions after this carry: they are given the one before it.
    const v26 = { ...withoutTravelLast(withoutGrace(withoutTiers(old))), version: 26, balance: "5f9aaa58dfbdf70d" } as SimState;
    expect(digest(serialize(v26))).toBe("19504:9334083718722ed8");
    expect(digest(serializeDetached(v26))).toBe("19480:2199f4673d2afec5");
    // #341's strip tiers, version 28, moved them again: taken out, with the version set back, the bytes are main's.
    const v27 = { ...withoutGrace(withoutTiers(old)), version: 27, balance: "5f9aaa58dfbdf70d" } as SimState;
    expect(digest(serialize(v27))).toBe("19544:8605f32d704923f8");
    expect(digest(serializeDetached(v27))).toBe("19520:bb3141d10113b7d0");
    // #361's days of grace, version 29, moved them again: taken out, with the version and #353's stamp set back, the bytes are main's.
    const v28 = { ...withoutGrace(old), version: 28, balance: "ee59f5383ffe4031" } as SimState;
    expect(digest(serialize(v28))).toBe("19824:f332e77b26fa3d95");
    expect(digest(serializeDetached(v28))).toBe("19800:25cde55808090ce1");
    // #376's economy.json moved the stamp: with #358's stamp set back, the bytes are main's.
    const v29 = { ...old, balance: "b4bf13924505f870" } as SimState;
    expect(digest(serialize(v29))).toBe("20216:79e42e6b91dbf347");
    expect(digest(serializeDetached(v29))).toBe("20192:1f85133032e1067d");
    expect(digest(serialize(old))).toBe("20216:263e43c5690bf011");
    expect(digest(serializeDetached(old))).toBe("20192:21d7d9a8cfeb65bf");
    expect(() => serializeStepsOf(state, null, Number.NaN)).toThrow(RangeError);
  });

  it("refuses a bad state on the first part", () => {
    const state = withRoads();
    state.tick = -1;
    expect(() => serializeDetachedSteps(state).next()).toThrow(RangeError);
  });

  it("captures a state that a save can be written from while the city changes", () => {
    const state = withRoads();
    state.undo = [{ playerId: "p1", entry: 0, type: "BuildRoad", ops: [{ op: "addNode", id: 1, grown: true }], zones: new Int32Array(0) }];
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
      state.undo = [...state.undo, { playerId: "p2", entry: n, type: "BuildRoad", ops: [], zones: new Int32Array(0) }];
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

  it("writes the same bytes into buffers kept from one save to the next (issue #158)", () => {
    const state = withRoads();
    const keep = createCaptureBuffers();
    const into: SnapshotBuffer = { buffer: null };
    const saveKept = (): Uint8Array => {
      const steps = serializeDetachedSteps(captureState(state, keep), into);
      for (;;) {
        const part = steps.next();
        if (part.done) return part.value;
      }
    };
    const grow = (n: number): void => {
      const r = state.roads;
      for (let k = 0; k < n; k++) {
        const a = addNode(r, 100 + k * 13, 200 + n, 1);
        const b = addNode(r, 140 + k * 13, 260 + n, 2);
        addSegment(r, a, b, { type: 0 });
      }
      submit(state, { seq: 1000 + n, playerId: "p1", type: "NoOp", payload: { note: "x".repeat(n * 7) } });
      step(state);
    };
    const first = saveKept();
    expect(toHex(first)).toBe(toHex(serializeDetached(state)));
    const firstBuffer = into.buffer;
    // The city grows past what the kept arrays and buffer hold, then a
    // smaller change: each save matches a fresh one byte for byte, with
    // nothing left over from the larger save before it.
    for (const n of [1, 40, 2, 0, 300, 3]) {
      grow(n);
      const kept = saveKept();
      expect(toHex(kept), `after growing by ${n}`).toBe(toHex(serializeDetached(state)));
      // A view into a larger buffer reads back as the city.
      expect(kept.buffer.byteLength).toBeGreaterThanOrEqual(kept.byteLength);
      expect(hashState(deserialize(kept).state)).toBe(hashState(deserialize(serializeDetached(state)).state));
    }
    // The buffers were reused, not made afresh each time.
    expect(into.buffer).not.toBeNull();
    expect(keep.arrays.size).toBeGreaterThan(5);
    expect(firstBuffer).not.toBe(into.buffer);
  });

  it("a capture into kept buffers hashes as the state does", () => {
    const state = withRoads();
    const keep = createCaptureBuffers();
    expect(hashState(captureState(state, keep))).toBe(hashState(state));
    state.roads.nodeX[0] = 1234;
    expect(hashState(captureState(state, keep))).toBe(hashState(state));
  });

  it("serialises, deserialises and hashes the same", () => {
    const state = withRoads();
    // The roads were changed by hand, not by a step, so lay their cells out first.
    syncCells(state);
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
