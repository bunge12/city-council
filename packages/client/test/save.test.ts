// Local saves against an in-memory IndexedDB, with the same SimHost the
// worker runs.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  LOG_PAGE_SIZE,
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
import { cityFileName, cityNameFromFile, uniqueCityName, wantsExportReminder } from "../src/save/city-file";
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
    expect((await store.list())[0]).toEqual({ ...meta("a", 30, 30), createdAt: 10 });
    expect(await store.read("missing")).toBeNull();
  });

  it("keeps list fields a save leaves out, and records when a city was first stored", async () => {
    const store = await openStore();
    await store.save(meta("a", 1, 100), snapshotAt(1));
    await store.touch("a", { exportedAt: 150, openedAt: 120 });
    await store.save(meta("a", 2, 200), snapshotAt(2));
    expect((await store.list())[0]).toEqual({ ...meta("a", 2, 200), createdAt: 100, exportedAt: 150, openedAt: 120 });
    await store.touch("missing", { openedAt: 1 });
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses to add a city under an id that is taken", async () => {
    const store = await openStore();
    await store.save(meta("a", 1, 100), snapshotAt(1));
    await expect(store.add(meta("a", 9, 900), snapshotAt(9))).rejects.toBeTruthy();
    expect((await store.list())[0]?.tick).toBe(1);
    expect(deserialize((await store.read("a"))?.latest ?? new Uint8Array()).state.tick).toBe(1);
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

  it("opens the most recently opened city, not the most recently saved", async () => {
    const store = await openStore();
    await store.save(meta("imported", 5, 10), snapshotAt(5));
    await store.touch("imported", { openedAt: 50 });
    // The tab that imported it saves its old city on the way out.
    await store.save({ ...meta("old", 9, 60), openedAt: 1 }, snapshotAt(9));
    expect((await openLatestCity(store, nextId)).id).toBe("imported");
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
  saves.page.onMessage((m) => m.type === "status" && statuses.push(m.status));
  const saver = new Saver({
    store,
    host,
    transport: saves.worker,
    city: { id: city.id, name: city.name },
    logPagesStored: city.logPagesStored,
    loadedFrom: city.from,
    problem: city.problem,
    wallClock: () => wall.now,
    makeId: nextId,
  });
  const messages: FromSimMessage[] = [];
  sim.client.onMessage((m) => messages.push(m));
  await saver.start();
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

  /** Sends full queues of NoOps until `pages` log pages have left live state. */
  function fillPages(city: Awaited<ReturnType<typeof hostCity>>, pages: number, from = 1): number {
    let seq = from;
    while (city.host.fullLog.length < LOG_LIVE_LIMIT + 1 + (pages - 1) * LOG_PAGE_SIZE) {
      for (let i = 0; i < MAX_PENDING_COMMANDS; i++) city.command(seq++);
      city.run(100);
    }
    return seq;
  }

  it("writes each log page once, and a save holds only the live part of the log", async () => {
    const store = await openStore();
    const city = await hostCity(store);
    const seq = fillPages(city, 1);
    await city.saver.save("autosave");
    const first = (await store.read(city.city.id))?.latest ?? new Uint8Array();
    expect(deserialize(first)).toMatchObject({ logDetached: true, pagedLog: [] });
    expect(deserialize(first).state.logOffset).toBe(LOG_PAGE_SIZE);
    const page0 = await store.readLogPages(city.city.id, 1);
    expect(page0?.[0]?.entries).toEqual(city.host.fullLog.slice(0, LOG_PAGE_SIZE));

    // Two more pages leave live state. The save is no bigger for it, and
    // the next save hands the store only the two new pages.
    fillPages(city, 3, seq);
    const written: number[] = [];
    const save = store.save.bind(store);
    store.save = (meta, bytes, pages = []) => {
      written.push(...pages.map((p) => p.index));
      return save(meta, bytes, pages);
    };
    await city.saver.save("autosave");
    await city.saver.save("autosave");
    expect(written).toEqual([1, 2]);
    const third = (await store.read(city.city.id))?.latest ?? new Uint8Array();
    expect(deserialize(third).state.logOffset).toBe(3 * LOG_PAGE_SIZE);
    expect(third.byteLength).toBeLessThan(first.byteLength * 1.1);
    expect(third.byteLength).toBeLessThan(city.host.snapshotBytes().byteLength / 1.5);

    const again = await hostCity(store);
    expect(again.city.from).toBe("latest save");
    expect(again.city.logPagesStored).toBe(3);
    expect(again.host.fullLog).toEqual(city.host.fullLog);
  });

  it("goes back to the save before when a log page is missing", async () => {
    const store = await openStore();
    const city = await hostCity(store);
    const seq = fillPages(city, 1);
    await city.saver.save("autosave");
    const goodTick = city.host.tick;
    const goodLog = structuredClone(city.host.fullLog);
    fillPages(city, 2, seq);
    await city.saver.save("autosave");
    // Lose page 1, which only the latest save needs.
    const read = store.readLogPages.bind(store);
    store.readLogPages = async (id, count) => (count > 1 ? null : read(id, count));

    const again = await hostCity(store);
    expect(again.city.from).toBe("previous save");
    expect(again.city.problem).toMatch(/part of its activity log is missing/);
    expect(again.host.tick).toBe(goodTick);
    expect(again.host.fullLog).toEqual(goodLog);
  });

  it("opens a save that still has its paged log inside, and moves it to pages on the next save", async () => {
    const store = await openStore();
    const city = await hostCity(store);
    fillPages(city, 2);
    // As a build from before log pages wrote it, and as an imported file is stored.
    await store.save(meta(city.city.id, city.host.tick, 5_000, city.city.name), city.host.snapshotBytes());

    const again = await hostCity(store);
    expect(again.city.logPagesStored).toBe(0);
    expect(again.host.fullLog).toEqual(city.host.fullLog);
    await again.saver.save("manual");
    expect(deserialize((await store.read(city.city.id))?.latest ?? new Uint8Array()).logDetached).toBe(true);
    expect(await store.readLogPages(city.city.id, 2)).toHaveLength(2);

    const third = await hostCity(store);
    expect(third.city.logPagesStored).toBe(2);
    expect(third.host.fullLog).toEqual(city.host.fullLog);
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
    if (message.type !== "status") throw new Error("expected a status");
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

/** Sends an export or import request and waits for its reply. */
function ask(saves: ReturnType<typeof pair<FromSaver>>, message: Record<string, unknown> & { requestId: number }) {
  return new Promise<FromSaver>((resolve) => {
    const off = saves.page.onMessage((m) => {
      if (m.requestId !== message.requestId || m.type === "status") return;
      off();
      resolve(m);
    });
    saves.page.send({ channel: SAVES_CHANNEL, ...message });
  });
}

async function exported(saves: ReturnType<typeof pair<FromSaver>>, requestId: number) {
  const reply = await ask(saves, { type: "export", requestId });
  if (reply.type !== "exported" || !reply.result.ok) throw new Error(`export failed: ${JSON.stringify(reply)}`);
  return reply.result;
}

async function imported(saves: ReturnType<typeof pair<FromSaver>>, requestId: number, fileName: string, bytes: Uint8Array) {
  const reply = await ask(saves, { type: "import", requestId, fileName, bytes: bytes.slice().buffer });
  if (reply.type !== "imported") throw new Error("expected an import reply");
  return reply.result;
}

const hashOf = (bytes: ArrayBuffer | Uint8Array) => hashState(deserialize(new Uint8Array(bytes)).state);

describe("city files", () => {
  it("names files after the city, and cities after the file", () => {
    expect(cityFileName("Riverside")).toBe("Riverside.city");
    expect(cityFileName('North/South: "Twin" Cities?')).toBe("North-South- -Twin- Cities-.city");
    expect(cityFileName("  ..  ")).toBe("city.city");
    expect(cityNameFromFile("Riverside.city")).toBe("Riverside");
    expect(cityNameFromFile("Riverside.CITY")).toBe("Riverside");
    expect(cityNameFromFile("backup.bin")).toBe("backup.bin");
    expect(cityNameFromFile(".city")).toBe("Imported city");
    expect(uniqueCityName("Riverside", ["Harbour"])).toBe("Riverside");
    expect(uniqueCityName("Riverside", ["Riverside", "Riverside 2"])).toBe("Riverside 3");
  });

  it("reminds after the interval since the last download, or since the city was made", () => {
    const day = 86_400_000;
    const city = { id: "a", name: "a", seed: 1, tick: 0, savedAt: 10 * day };
    expect(wantsExportReminder(city, 20 * day, day)).toBe(false); // nothing to count from yet
    expect(wantsExportReminder({ ...city, createdAt: 9 * day }, 9.5 * day, day)).toBe(false);
    expect(wantsExportReminder({ ...city, createdAt: 9 * day }, 10 * day, day)).toBe(true);
    expect(wantsExportReminder({ ...city, createdAt: 1 * day, exportedAt: 9.5 * day }, 10 * day, day)).toBe(false);
  });

  it("downloads the running city with the same hash and records when", async () => {
    const store = await openStore();
    const wall = { now: 1_000 };
    const { saves, run, command, host, city } = await hostCity(store, wall);
    command(1);
    run(700);
    wall.now = 5_000;
    const file = await exported(saves, 1);
    expect(file.fileName).toBe("New city.city");
    expect(file.tick).toBe(host.tick);
    expect(hashOf(file.bytes)).toBe(hashOf(host.snapshotBytes()));
    const meta = (await store.list()).find((c) => c.id === city.id);
    expect(meta).toMatchObject({ exportedAt: 5_000, createdAt: 1_000 });
  });

  it("downloads even when local saves are not available", async () => {
    const city = await openLatestCity(await openStore(), nextId);
    const saves = pair<FromSaver>();
    const host = new SimHost(city.state, memoryTransportPair().host, () => 0, city.pagedLog);
    new Saver({ store: null, host, transport: saves.worker, city, loadedFrom: city.from, problem: null, wallClock: () => 0 });
    expect(hashOf((await exported(saves, 1)).bytes)).toBe(hashOf(host.snapshotBytes()));
  });

  it("imports a file as a new city that opens next, with the same hash", async () => {
    const store = await openStore();
    const wall = { now: 1_000 };
    const first = await hostCity(store, wall);
    first.command(1, "NoOp", { note: "export me" });
    first.run(1_200);
    const file = await exported(first.saves, 1);

    // Another city is running and saving when the file comes back.
    wall.now = 2_000;
    const result = await imported(first.saves, 2, "My town.city", new Uint8Array(file.bytes));
    if (!result.ok) throw new Error(result.error);
    expect(result.city).toMatchObject({ name: "My town", tick: file.tick, openedAt: 2_000, exportedAt: 2_000 });
    expect(result.city.id).not.toBe(first.city.id);
    wall.now = 3_000;
    await first.saver.save("hidden");

    const second = await hostCity(store, wall);
    expect(second.city).toMatchObject({ id: result.city.id, name: "My town", from: "latest save" });
    expect(hashOf(second.host.snapshotBytes())).toBe(hashOf(file.bytes));
    expect(second.host.fullLog.map((e) => e.type)).toEqual(["NoOp"]);
  });

  it("imports the same file twice as two separate cities", async () => {
    const store = await openStore();
    const { saves } = await hostCity(store);
    const file = new Uint8Array((await exported(saves, 1)).bytes);
    const a = await imported(saves, 2, "Harbour.city", file);
    const b = await imported(saves, 3, "Harbour.city", file);
    if (!a.ok || !b.ok) throw new Error("import failed");
    expect(a.city.id).not.toBe(b.city.id);
    expect([a.city.name, b.city.name]).toEqual(["Harbour", "Harbour 2"]);
    expect(await store.list()).toHaveLength(3);
    expect(hashOf((await store.read(a.city.id))?.latest ?? new Uint8Array())).toBe(hashOf(file));
    expect(hashOf((await store.read(b.city.id))?.latest ?? new Uint8Array())).toBe(hashOf(file));
  });

  it.each([
    ["not a city", new TextEncoder().encode("hello, this is a text file"), /not a City Council save/],
    ["empty", new Uint8Array(), /not a City Council save/],
    ["truncated", "truncated", /cut short/],
    ["damaged", "damaged", /This file is damaged/],
    ["newer", "newer", /newer version of the game/],
  ] as const)("refuses a file that is %s and changes nothing", async (_, input, error) => {
    const store = await openStore();
    const { saves, statuses } = await hostCity(store);
    const good = new Uint8Array((await exported(saves, 1)).bytes);
    const bytes =
      input === "truncated" ? good.slice(0, good.length - 40)
      : input === "damaged" ? damaged(good)
      : input === "newer" ? newer(good)
      : input;
    const listBefore = await store.list();
    const statusesBefore = statuses.length;
    const result = await imported(saves, 2, "Riverside.city", bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Could not import "Riverside\.city"\./);
    expect(result.error).toMatch(error);
    expect(await store.list()).toEqual(listBefore);
    expect(statuses.length).toBe(statusesBefore);
  });
});

async function switched(saves: ReturnType<typeof pair<FromSaver>>, request: Record<string, unknown> & { requestId: number }) {
  const reply = await ask(saves, request);
  if (reply.type !== "switched") throw new Error("expected a switched reply");
  return reply.result;
}

describe("switching cities from the city menu", () => {
  it("saves the running city and stores a new city from a seed that opens next", async () => {
    const store = await openStore();
    const wall = { now: 1_000 };
    const first = await hostCity(store, wall);
    first.run(800);
    const tickBefore = first.host.tick;
    wall.now = 2_000;
    const result = await switched(first.saves, { type: "new", requestId: 1, name: "  Harbour  ", seed: 4242 });
    if (!result.ok) throw new Error(result.error);
    expect(result.city).toMatchObject({ name: "Harbour", seed: 4242, tick: 0, openedAt: 2_000 });
    const list = await store.list();
    expect(list.find((c) => c.id === first.city.id)?.tick).toBe(tickBefore);
    // The tab closing saves the old city again on its way out.
    wall.now = 3_000;
    await first.saver.save("hidden");

    const second = await hostCity(store, wall);
    expect(second.city).toMatchObject({ id: result.city.id, name: "Harbour", from: "latest save" });
    expect(second.host.seed).toBe(4242);
    expect(second.host.tick).toBe(0);
    expect(hashOf(second.host.snapshotBytes())).toBe(hashState(createState(4242)));
  });

  it("names a new city uniquely and refuses a seed that is not a 32-bit integer", async () => {
    const store = await openStore();
    const { saves } = await hostCity(store);
    const a = await switched(saves, { type: "new", requestId: 1, name: "New city", seed: 1 });
    const b = await switched(saves, { type: "new", requestId: 2, name: "", seed: 2 });
    if (!a.ok || !b.ok) throw new Error("new city failed");
    expect([a.city.name, b.city.name]).toEqual(["New city 2", "New city 3"]);
    const listBefore = await store.list();
    for (const seed of [-1, 2 ** 32, 1.5]) {
      const bad = await switched(saves, { type: "new", requestId: 3, name: "Bad", seed });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toMatch(/^Could not start a new city: seed must be an integer/);
    }
    expect((await store.list()).map((c) => c.id).sort()).toEqual(listBefore.map((c) => c.id).sort());
  });

  it("opens a saved city next, and refuses one that is not saved", async () => {
    const store = await openStore();
    const wall = { now: 1_000 };
    const first = await hostCity(store, wall);
    wall.now = 2_000;
    const made = await switched(first.saves, { type: "new", requestId: 1, name: "Harbour", seed: 9 });
    if (!made.ok) throw new Error(made.error);
    const second = await hostCity(store, wall);
    expect(second.city.id).toBe(made.city.id);

    wall.now = 3_000;
    const back = await switched(second.saves, { type: "open", requestId: 1, id: first.city.id });
    expect(back).toMatchObject({ ok: true, city: { id: first.city.id, openedAt: 3_000 } });
    expect((await hostCity(store, wall)).city.id).toBe(first.city.id);

    const missing = await switched(second.saves, { type: "open", requestId: 2, id: "nope" });
    expect(missing).toEqual({ ok: false, error: "Could not open the city: it is no longer saved in this browser." });
  });

  it("refuses to switch when local saves are not available", async () => {
    const city = await openLatestCity(await openStore(), nextId);
    const saves = pair<FromSaver>();
    const host = new SimHost(city.state, memoryTransportPair().host, () => 0, city.pagedLog);
    new Saver({ store: null, storeError: "no IndexedDB", host, transport: saves.worker, city, loadedFrom: city.from, problem: null, wallClock: () => 0 });
    expect(await switched(saves, { type: "new", requestId: 1, name: "x", seed: 1 })).toEqual({ ok: false, error: "Could not start a new city. no IndexedDB." });
    expect(await switched(saves, { type: "open", requestId: 2, id: "x" })).toEqual({ ok: false, error: "Could not open the city. no IndexedDB." });
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
    expect(parseSaveRequest({ channel: "saves", type: "export", requestId: 1 })).not.toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "import", requestId: 1, fileName: "a.city", bytes: new ArrayBuffer(4) })).not.toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "import", requestId: 1, fileName: "a.city", bytes: "nope" })).toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "export" })).toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "save", reason: "whenever", requestId: 1 })).toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "new", requestId: 1, name: "a", seed: 3 })).not.toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "new", requestId: 1, name: "a", seed: "3" })).toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "open", requestId: 1, id: "a" })).not.toBeNull();
    expect(parseSaveRequest({ channel: "saves", type: "open", requestId: 1 })).toBeNull();
    expect(parseSaveRequest({ v: 1, type: "requestSnapshot" })).toBeNull();
  });

  it("refuses a host whose paged log does not match the state", () => {
    const state = createState(1);
    state.logOffset = 3;
    expect(() => new SimHost(state, memoryTransportPair().host, () => 0, [])).toThrow(/pagedLog has 0 entries/);
  });
});
