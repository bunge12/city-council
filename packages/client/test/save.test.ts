// Local saves against an in-memory IndexedDB, with the same SimHost the
// worker runs.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  SNAPSHOT_VERSION,
  createState,
  deserialize,
  hashState,
  replay,
  serialize,
  type FromSimMessage,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { bufferUntilListening, memoryTransportPair, type SimTransport } from "../src/protocol/transport";
import { SAVES_CHANNEL, parseSaveRequest, type FromSaver, type SaveStatus } from "../src/save/channel";
import { NEW_CITY_SEED } from "../src/save/config";
import { openLatestCity } from "../src/save/load";
import { Saver } from "../src/save/saver";
import { CityStore, type CityMeta } from "../src/save/store";

const openStore = () => CityStore.open(new IDBFactory());

function meta(id: string, tick: number, savedAt: number, name = id): CityMeta {
  return { id, name, seed: 4, tick, savedAt };
}

function snapshotAt(tick: number, seed = 4): Uint8Array {
  const state = createState(seed);
  state.tick = tick;
  return serialize(state);
}

function damaged(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[copy.length - 3] = (copy[copy.length - 3] ?? 0) ^ 0xff;
  return copy;
}

function newer(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(6, SNAPSHOT_VERSION + 1, true);
  return copy;
}

let ids = 0;
const nextId = () => `new-${++ids}`;

describe("CityStore", () => {
  it("lists cities most recently saved first", async () => {
    const store = await openStore();
    await store.save(meta("a", 1, 100), snapshotAt(1));
    await store.save(meta("b", 1, 300), snapshotAt(1));
    await store.save(meta("c", 1, 200), snapshotAt(1));
    expect((await store.list()).map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the latest snapshot and the one before it", async () => {
    const store = await openStore();
    for (const tick of [10, 20, 30]) await store.save(meta("a", tick, tick), snapshotAt(tick));
    const snapshots = await store.read("a");
    expect(deserialize(snapshots?.latest ?? new Uint8Array()).state.tick).toBe(30);
    expect(deserialize(snapshots?.previous ?? new Uint8Array()).state.tick).toBe(20);
    expect((await store.list())[0]).toEqual(meta("a", 30, 30));
    expect(await store.read("missing")).toBeNull();
  });

  it("does not let a damaged latest snapshot push out the good one before it", async () => {
    const store = await openStore();
    await store.save(meta("a", 10, 1), snapshotAt(10));
    await store.save(meta("a", 20, 2), damaged(snapshotAt(20)));
    await store.save(meta("a", 30, 3), snapshotAt(30));
    const snapshots = await store.read("a");
    expect(deserialize(snapshots?.latest ?? new Uint8Array()).state.tick).toBe(30);
    expect(deserialize(snapshots?.previous ?? new Uint8Array()).state.tick).toBe(10);
  });
});

describe("openLatestCity", () => {
  it("starts a new city when nothing is saved", async () => {
    const city = await openLatestCity(await openStore(), nextId);
    expect(city.from).toBe("new city");
    expect(city.state.seed).toBe(NEW_CITY_SEED);
    expect(city.problem).toBeNull();
  });

  it("opens the most recently saved city at its saved tick", async () => {
    const store = await openStore();
    await store.save(meta("old", 5, 1), snapshotAt(5));
    await store.save(meta("recent", 77, 2, "Riverside"), snapshotAt(77));
    const city = await openLatestCity(store, nextId);
    expect(city).toMatchObject({ id: "recent", name: "Riverside", from: "latest save", problem: null });
    expect(city.state.tick).toBe(77);
  });

  it("reports a damaged latest save and goes back to the previous good one", async () => {
    const store = await openStore();
    await store.save(meta("a", 10, 1, "Harbour"), snapshotAt(10));
    await store.save(meta("a", 20, 2, "Harbour"), damaged(snapshotAt(20)));
    const city = await openLatestCity(store, nextId);
    expect(city.from).toBe("previous save");
    expect(city.id).toBe("a");
    expect(city.state.tick).toBe(10);
    expect(city.problem).toMatch(/latest save of "Harbour" could not be used/);
    expect(city.problem).toMatch(/damaged/);
    expect(city.problem).toMatch(/from tick 10/);
    // Both snapshots are still there until the next save replaces the damaged one.
    const snapshots = await store.read("a");
    expect(deserialize(snapshots?.previous ?? new Uint8Array()).state.tick).toBe(10);
  });

  it("refuses a save from a newer version and leaves it untouched", async () => {
    const store = await openStore();
    await store.save(meta("a", 10, 1, "Harbour"), snapshotAt(10));
    const fromTheFuture = newer(snapshotAt(20));
    await store.save(meta("a", 20, 2, "Harbour"), fromTheFuture);
    const before = await store.read("a");
    const city = await openLatestCity(store, nextId);
    expect(city.from).toBe("new city");
    expect(city.id).not.toBe("a");
    expect(city.problem).toMatch(/Could not open "Harbour"\. This save is from a newer version of the game/);
    expect(city.problem).toMatch(/left as it is/);
    expect(await store.read("a")).toEqual(before);
    expect(Array.from((await store.read("a"))?.latest ?? [])).toEqual(Array.from(fromTheFuture));
  });

  it("starts a new city when there is no good snapshot, and leaves the damaged one alone", async () => {
    const store = await openStore();
    await store.save(meta("a", 10, 1), damaged(snapshotAt(10)));
    // The store never keeps a damaged snapshot as the previous one.
    await store.save(meta("a", 20, 2), damaged(snapshotAt(20)));
    const before = await store.read("a");
    expect(before?.previous).toBeNull();
    const city = await openLatestCity(store, nextId);
    expect(city.from).toBe("new city");
    expect(city.id).not.toBe("a");
    expect(city.problem).toMatch(/Could not open "a"\. This save is damaged/);
    expect(await store.read("a")).toEqual(before);
  });
});

/** A host and saver wired as the worker wires them, with a fake clock. */
async function hostCity(store: CityStore, wall = { now: 1_000 }) {
  const city = await openLatestCity(store, nextId);
  const sim = memoryTransportPair();
  const saves = pair<FromSaver>();
  let now = 0;
  const host = new SimHost(city.state, sim.host, () => now, city.pagedLog);
  const statuses: SaveStatus[] = [];
  saves.page.onMessage((m) => statuses.push(m.status));
  const saver = new Saver({
    store,
    host,
    transport: saves.worker,
    city: { id: city.id, name: city.name },
    loadedFrom: city.from,
    problem: city.problem,
    wallClock: () => wall.now,
  });
  const messages: FromSimMessage[] = [];
  sim.client.onMessage((m) => messages.push(m));
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const command = (seq: number, type = "NoOp", payload: unknown = {}) =>
    sim.client.send({ v: 1, type: "command", command: { seq, playerId: "p1", type, payload } });
  return { city, host, saver, saves, statuses, run, command, messages };
}

/** Two synchronous ends for the saves channel. */
function pair<FromWorker>() {
  const toWorker = new Set<(m: unknown) => void>();
  const toPage = new Set<(m: FromWorker) => void>();
  const page: SimTransport<unknown, FromWorker> = {
    send: (m) => toWorker.forEach((h) => h(structuredClone(m))),
    onMessage: (h) => (toPage.add(h), () => void toPage.delete(h)),
  };
  const worker: SimTransport<FromWorker, unknown> = {
    send: (m) => toPage.forEach((h) => h(structuredClone(m))),
    onMessage: (h) => (toWorker.add(h), () => void toWorker.delete(h)),
  };
  return { page, worker };
}

describe("saving and loading a hosted city", () => {
  it("resumes at the saved tick with the activity log intact", async () => {
    const store = await openStore();
    const first = await hostCity(store);
    first.command(1);
    first.run(1000);
    first.command(2, "SetSpeed", { speed: 2 });
    first.run(1000);
    await first.saver.save("manual");
    const savedTick = first.host.tick;
    const savedLog = structuredClone(first.host.fullLog);
    expect(savedTick).toBe(29);
    expect(savedLog.map((e) => e.type)).toEqual(["NoOp", "SetSpeed"]);
    expect(first.statuses.at(-1)?.lastSave).toEqual({ tick: savedTick, savedAt: 1_000, reason: "manual" });

    const second = await hostCity(store);
    expect(second.city.from).toBe("latest save");
    expect(second.host.tick).toBe(savedTick);
    expect(second.host.fullLog).toEqual(savedLog);
    const snapshot = second.messages.find((m) => m.type === "snapshot");
    expect(snapshot).toBeUndefined(); // nothing asked yet
  });

  it("keeps the entries the host read out of live state, and they replay to the saved hash", async () => {
    const store = await openStore();
    const first = await hostCity(store);
    let seq = 1;
    while (first.host.fullLog.length <= LOG_LIVE_LIMIT + 50) {
      for (let i = 0; i < MAX_PENDING_COMMANDS; i++) first.command(seq++);
      first.run(100);
    }
    await first.saver.save("autosave");
    const fullLog = structuredClone(first.host.fullLog);

    const second = await hostCity(store);
    expect(second.host.fullLog).toEqual(fullLog);
    const bytes = (await store.read(second.city.id))?.latest ?? new Uint8Array();
    const { state } = deserialize(bytes);
    expect(state.logOffset).toBeGreaterThan(0);
    expect(hashState(replay(state.seed, second.host.fullLog, state.tick))).toBe(hashState(state));
  });

  it("serialises saves so the latest one is written last", async () => {
    const store = await openStore();
    const { saver, run, host } = await hostCity(store);
    const a = saver.save("autosave");
    run(500);
    const b = saver.save("manual");
    await Promise.all([a, b]);
    expect((await store.list())[0]?.tick).toBe(host.tick);
  });

  it("answers a save request from the page with the status after the write", async () => {
    const store = await openStore();
    const { saves, run } = await hostCity(store);
    run(300);
    const answer = new Promise<FromSaver>((resolve) => saves.page.onMessage((m) => m.requestId === 7 && resolve(m)));
    saves.page.send({ channel: SAVES_CHANNEL, type: "save", reason: "hidden", requestId: 7 });
    const message = await answer;
    expect(message.status.lastSave).toMatchObject({ tick: 3, reason: "hidden" });
    expect(message.status.cities).toHaveLength(1);
  });

  it("reports a failed save and keeps going", async () => {
    const store = await openStore();
    const { saver, statuses } = await hostCity(store);
    store.close();
    await saver.save("manual");
    expect(statuses.at(-1)?.saveError).toMatch(/^Saving failed:/);
  });
});

describe("worker plumbing", () => {
  it("holds messages until something listens", () => {
    const { client, host } = memoryTransportPair();
    const buffered = bufferUntilListening(host);
    client.send({ v: 1, type: "requestSnapshot" });
    client.send({ v: 1, type: "requestSnapshot" });
    const seen: unknown[] = [];
    buffered.onMessage((m) => seen.push(m));
    client.send({ v: 1, type: "command", command: { seq: 1, playerId: "p", type: "NoOp", payload: {} } });
    expect(seen.map((m) => (m as { type: string }).type)).toEqual(["requestSnapshot", "requestSnapshot", "command"]);
  });

  it("parses only well-formed save requests", () => {
    expect(parseSaveRequest({ channel: "saves", type: "save", reason: "manual", requestId: 1 })).not.toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "save", reason: "whenever", requestId: 1 })).toBeNull();
    expect(parseSaveRequest({ v: 1, type: "requestSnapshot" })).toBeNull();
  });

  it("refuses a host whose paged log does not match the state", () => {
    const state = createState(1);
    state.logOffset = 3;
    expect(() => new SimHost(state, memoryTransportPair().host, () => 0, [])).toThrow(/pagedLog has 0 entries/);
  });
});
