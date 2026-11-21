// Drives the full client-to-sim protocol with an in-memory transport and a
// fake clock: the same SimHost the worker runs, with no worker.
import { describe, expect, it } from "vitest";
import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  PROTOCOL_VERSION,
  createBareState,
  createState,
  STAT_TOTALS,
  TIME_BALANCE,
  createStats,
  encodeStatsDelta,
  sampleCount,
  deserialize,
  hashState,
  nextFloat,
  nextInt,
  replay,
  seedRng,
  type FromSimMessage,
  segmentEnds,
  segmentTypeId,
} from "@city-council/sim";
import { MAX_CATCH_UP_STEPS, PUMP_INTERVAL_MS, SimHost, typedArrayBuffers } from "../src/protocol/host";
import { SimMirror, type MirrorUpdate } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";

function setup(seed = 7) {
  const { client, host: hostEnd } = memoryTransportPair();
  const received: FromSimMessage[] = [];
  client.onMessage((m) => received.push(m));
  let now = 0;
  const host = new SimHost(createBareState(seed), hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  /** Advances real time in pump-sized steps, as the worker's timer would. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const stall = (ms: number) => {
    now += ms;
    host.pump();
  };
  return { host, client, mirror, received, run, stall };
}

describe("SimMirror and SimHost over an in-memory transport", () => {
  it("gets a snapshot on connect", () => {
    const { mirror, received } = setup();
    expect(received.map((m) => m.type)).toEqual(["snapshot"]);
    expect(mirror.state?.tick).toBe(0);
    expect(mirror.state?.seed).toBe(7);
  });

  it("follows the tick through deltas, 10 ticks per real second at 1x", () => {
    const { mirror, run } = setup();
    run(1000);
    expect(mirror.state?.tick).toBe(10);
    run(2000);
    expect(mirror.state?.tick).toBe(30);
  });

  it("round-trips a NoOp to an ok commandResult and logs it with the player id", async () => {
    const { mirror, run, received } = setup();
    const result = mirror.sendCommand("NoOp");
    await expect(result).resolves.toEqual({ ok: true });
    expect(received.find((m) => m.type === "commandResult")).toMatchObject({
      v: PROTOCOL_VERSION,
      seq: 1,
      playerId: "p1",
      result: { ok: true },
    });
    run(100);
    expect(mirror.state?.log).toEqual([{ tick: 0, seq: 1, playerId: "p1", type: "NoOp", payload: {} }]);
  });

  it("returns the reason for a refused command", async () => {
    const { mirror } = setup();
    await expect(mirror.sendCommand("Nope")).resolves.toEqual({
      ok: false,
      reason: 'unknown command type "Nope"',
    });
  });

  it("stops the tick while paused and still applies the command that unpauses", async () => {
    const { mirror, run } = setup();
    run(500);
    await mirror.sendCommand("SetSpeed", { speed: 0 });
    run(100);
    const pausedAt = mirror.state?.tick;
    expect(mirror.state?.speed).toBe(0);
    run(2000);
    expect(mirror.state?.tick).toBe(pausedAt);
    await mirror.sendCommand("SetSpeed", { speed: 1 });
    run(1000);
    expect(mirror.state?.speed).toBe(1);
    expect(mirror.state?.tick).toBeGreaterThan(pausedAt ?? 0);
  });

  it("runs 2x and 4x at two and four times the 1x rate", async () => {
    const rates: number[] = [];
    for (const speed of [1, 2, 4] as const) {
      const { mirror, run } = setup();
      await mirror.sendCommand("SetSpeed", { speed });
      run(100); // apply it
      const from = mirror.state?.tick ?? 0;
      run(2000);
      rates.push(((mirror.state?.tick ?? 0) - from) / 2);
    }
    expect(rates).toEqual([10, 20, 40]);
  });

  it("catches up by at most a few steps after a stall", () => {
    const { mirror, run, stall } = setup();
    run(1000);
    stall(60_000);
    expect(mirror.state?.tick).toBe(10 + MAX_CATCH_UP_STEPS);
    // And carries on at the normal rate afterwards.
    run(1000);
    expect(mirror.state?.tick).toBe(20 + MAX_CATCH_UP_STEPS);
  });

  describe("a held clock (issue #224)", () => {
    it("steps nothing on its own, however much real time passes, and runs exactly the steps asked for", async () => {
      const { host, mirror, run, stall } = setup();
      run(500);
      host.hold();
      run(5000);
      stall(60_000);
      expect(mirror.state?.tick).toBe(5);
      await mirror.sendCommand("SetSpeed", { speed: 4 });
      host.advance(1);
      expect(mirror.state?.speed).toBe(4);
      expect(mirror.state?.tick).toBe(6);
      host.advance(200);
      expect(mirror.state?.tick).toBe(206);
    });

    it("applies queued commands only when it advances, and leaves the tick alone while paused", async () => {
      const { host, mirror, run } = setup();
      host.hold();
      const settled = mirror.sendCommandSettled("SetSpeed", { speed: 0 });
      run(1000);
      expect(mirror.state?.speed).toBe(1);
      host.advance(1);
      await expect(settled).resolves.toEqual({ ok: true });
      host.advance(50);
      expect(mirror.state?.tick).toBe(0);
    });

    it("lands on the same state as the clock for the same number of steps", async () => {
      const clocked = setup(11);
      const held = setup(11);
      held.host.hold();
      for (const { mirror } of [clocked, held]) await mirror.sendCommand("SetSpeed", { speed: 4 });
      clocked.run(10_000);
      const ticks = clocked.mirror.state?.tick ?? 0;
      expect(ticks).toBeGreaterThan(390);
      held.host.advance(ticks);
      expect(held.mirror.state?.tick).toBe(ticks);
      const [a, b] = [held.mirror.state, clocked.mirror.state];
      if (!a || !b) throw new Error("no state");
      expect(hashState(a)).toBe(hashState(b));
    });

    it("carries on from now when released, without catching up the held time", () => {
      const { host, mirror, run } = setup();
      host.hold();
      run(5000);
      host.release();
      run(1000);
      expect(mirror.state?.tick).toBe(10);
    });
  });

  it("sends deltas only when something changed, carrying only tick, speed, the generator, the grower's plan, the cell count, the city centre, the statistics and new log", async () => {
    const { mirror, run, received } = setup();
    await mirror.sendCommand("SetSpeed", { speed: 0 });
    run(100);
    const before = received.length;
    run(1000);
    expect(received.length).toBe(before);
    const delta = received.filter((m) => m.type === "delta").at(-1);
    expect(delta && Object.keys(delta).sort()).toEqual(
      ["cellReads", "centre", "growth", "log", "logFrom", "rng", "seq", "speed", "stats", "steps", "tick", "timings", "type", "v"].sort(),
    );
    // No month began since the last delta, so it carries no sample.
    expect(delta?.type === "delta" && delta.stats.samples.length).toBe(0);
  });

  it("reports per-system timings from the host", () => {
    const { mirror, run } = setup();
    run(100);
    expect(mirror.stats.timings.map((t) => t.system)).toEqual(["buildings", "commands", "cells", "stats", "pops", "landValue", "grower"]);
    expect(mirror.stats.timings[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps the mirror equal to the host's state", async () => {
    const { mirror, run, received } = setup();
    for (let i = 0; i < 5; i++) {
      await mirror.sendCommand("NoOp");
      await mirror.sendCommand("SetSpeed", { speed: ([1, 2, 4] as const)[i % 3] });
      run(300);
    }
    const mirrored = hashState(mirror.state);
    mirror.requestSnapshot();
    const snap = received.at(-1);
    expect(snap?.type).toBe("snapshot");
    expect(snap?.type === "snapshot" && hashState(snap.state)).toBe(mirrored);
  });

  it("keeps the mirror's statistics and their monthly history equal to the host's across month starts", async () => {
    const { mirror, run, received } = setup();
    await mirror.sendCommand("SetSpeed", { speed: 4 });
    // January and February at 4x: samples on 1 January, 1 February and 1 March.
    const ticks = (31 + 28) * TIME_BALANCE.ticksPerDay + 1;
    run((ticks * 100) / 4 + 1000);
    const state = mirror.state;
    if (!state) throw new Error("no state");
    expect(state.tick).toBeGreaterThanOrEqual(ticks);
    expect(sampleCount(state.stats)).toBe(3);
    const mirrored = hashState(state);
    mirror.requestSnapshot();
    const snap = received.at(-1);
    expect(snap?.type === "snapshot" && hashState(snap.state)).toBe(mirrored);
    expect(snap?.type === "snapshot" && snap.state.stats.history).toEqual(state.stats.history);
  });

  it("keeps the host's full log after live state pages entries out", () => {
    const { host, mirror, run } = setup();
    const count = LOG_LIVE_LIMIT + 200;
    // A full queue each tick, the most one step may apply.
    for (let sent = 0; sent < count; sent += MAX_PENDING_COMMANDS) {
      for (let i = sent; i < Math.min(count, sent + MAX_PENDING_COMMANDS); i++) {
        void mirror.sendCommand("NoOp");
      }
      run(100);
    }
    expect(host.fullLog).toHaveLength(count);
    expect((mirror.state?.logOffset ?? 0) + (mirror.state?.log.length ?? 0)).toBe(count);
  });

  it("refuses commands past a full queue instead of losing log entries", async () => {
    const { mirror } = setup();
    const results = [];
    for (let i = 0; i <= MAX_PENDING_COMMANDS; i++) results.push(mirror.sendCommand("NoOp"));
    const last = await results.at(-1);
    expect(last).toMatchObject({ ok: false });
  });

  it("asks for a new snapshot when a delta does not line up", () => {
    const { mirror, received } = setup();
    const before = received.length;
    // A delta from a host the mirror is out of step with.
    (mirror as unknown as { receive(m: FromSimMessage): void }).receive({
      v: PROTOCOL_VERSION,
      type: "delta",
      seq: 0,
      tick: 3,
      speed: 1,
      logFrom: 99,
      log: [],
      rng: new Uint32Array(4),
      growth: { quota: 0, day: -1, deadline: 0, free: 0, used: 0 },
      stats: encodeStatsDelta(createStats(), 0),
      cellReads: 0,
      centre: { x: 0, z: 0, weight: 0, due: 0 },
      pending: [],
      steps: 1,
      timings: [],
    });
    expect(mirror.state?.tick).toBe(0);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)?.type).toBe("snapshot");
  });
});

describe("road deltas", () => {
  // Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
  // The sim's build-road tests check it is still there.
  const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };
  const TYPES = ["street", "avenue", "oneway"];

  /** A host and mirror where the test picks which host messages reach the mirror. */
  function roadSetup() {
    const { client, host: hostEnd } = memoryTransportPair();
    const received: FromSimMessage[] = [];
    let drop: (m: FromSimMessage) => boolean = () => false;
    // Sit between the host and the mirror so a test can lose a message.
    const filtered: typeof client = {
      send: (m, t) => client.send(m, t),
      onMessage: (handler) =>
        client.onMessage((m) => {
          received.push(m);
          if (!drop(m)) handler(m);
        }),
    };
    let now = 0;
    const host = new SimHost(createBareState(2026), hostEnd, () => now);
    const mirror = new SimMirror(filtered, "p1");
    const updates: MirrorUpdate[] = [];
    mirror.subscribe((u) => updates.push(u));
    const tick = () => {
      for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
        now += PUMP_INTERVAL_MS;
        host.pump();
      }
    };
    /** The host's network now, from a snapshot that goes only to the test. */
    const hostRoads = () => {
      const before = drop;
      drop = () => true;
      filtered.send({ v: PROTOCOL_VERSION, type: "requestSnapshot" });
      drop = before;
      const snap = received.at(-1);
      if (snap?.type !== "snapshot") throw new Error("no snapshot");
      return snap.state.roads;
    };
    /**
     * Another player on the same host. The host here trusts the id each
     * message claims, as a server trusts the id it stamps on a connection.
     */
    const join = (playerId: string) =>
      // Its own copy of each message, as its own connection would give it.
      new SimMirror({ send: (m, t) => client.send(m, t), onMessage: (h) => client.onMessage((m) => h(structuredClone(m))) }, playerId);
    return { mirror, received, updates, tick, hostRoads, join, setDrop: (f: typeof drop) => (drop = f) };
  }

  const arrays = (net: unknown) =>
    Object.fromEntries(Object.entries(net as object).map(([k, a]) => [k, Array.from(a as ArrayLike<number>)]));

  const road = (from: [number, number], to: [number, number], type = "street") => ({
    from: { x: from[0], z: from[1] },
    to: { x: to[0], z: to[1] },
    type,
  });

  it("keeps the mirror's network equal to the sim's through 1,000 ticks of random road commands", () => {
    const { mirror, tick, hostRoads } = roadSetup();
    const rng = seedRng(31);
    const point = (): [number, number] => {
      // Mostly inside the flat square, where roads are accepted and cross.
      if (nextFloat(rng) < 0.85) {
        return [FLAT.x0 + nextFloat(rng) * (FLAT.x1 - FLAT.x0), FLAT.z0 + nextFloat(rng) * (FLAT.z1 - FLAT.z0)];
      }
      return [nextFloat(rng) * 12_000, nextFloat(rng) * 12_000];
    };
    for (let t = 0; t < 1000; t++) {
      const commands = nextInt(rng, 3);
      for (let i = 0; i < commands; i++) {
        void mirror.sendCommand("BuildRoad", road(point(), point(), TYPES[nextInt(rng, 3)]));
      }
      tick();
      if (t % 250 === 249) expect(arrays(mirror.state?.roads)).toEqual(arrays(hostRoads()));
    }
    const roads = hostRoads();
    expect(arrays(mirror.state?.roads)).toEqual(arrays(roads));
    // Enough happened for this to mean something: splits removed and reused ids.
    expect(roads.segFlags.length).toBeGreaterThan(200);
    expect(mirror.state?.tick).toBe(1000);
  });

  it("adds no road data to a delta on a tick with no road changes", async () => {
    const { mirror, received, tick } = roadSetup();
    await mirror.sendCommand("NoOp");
    tick();
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    tick();
    const deltas = received.filter((m) => m.type === "delta");
    expect(deltas.map((d) => d.roads !== undefined)).toEqual([false, true, false]);
    expect(deltas.every((d) => d.type === "delta" && (d.roads === undefined) === !("roads" in d))).toBe(true);
  });

  it("tells listeners which chunks and rows changed", async () => {
    const { mirror, updates, tick } = roadSetup();
    const chunk = (x: number, z: number) => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);
    // Inside one chunk, then across the line z = 4500 between two.
    await mirror.sendCommand("BuildRoad", road([4200, 4510], [4200, 4590]));
    tick();
    tick();
    await mirror.sendCommand("BuildRoad", road([4300, 4450], [4300, 4550]));
    tick();
    mirror.requestSnapshot();
    expect(updates).toEqual([
      { kind: "delta", roadChunks: [chunk(4200, 4510)], roadNodes: [0, 1], roadSegs: [0], cellChunks: [], buildingChunks: [], buildingIds: [], steps: 1 },
      { kind: "delta", roadChunks: [], roadNodes: [], roadSegs: [], cellChunks: [], buildingChunks: [], buildingIds: [], steps: 1 },
      { kind: "delta", roadChunks: [chunk(4300, 4450), chunk(4300, 4550)], roadNodes: [2, 3], roadSegs: [1], cellChunks: [], buildingChunks: [], buildingIds: [], steps: 1 },
      { kind: "snapshot" },
    ]);
  });

  it("spots a missed delta, asks for a snapshot and catches up", async () => {
    const { mirror, received, tick, hostRoads, setDrop } = roadSetup();
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    // Lose the delta that carries the second road.
    let lost = false;
    setDrop((m) => {
      if (lost || m.type !== "delta" || !m.roads) return false;
      lost = true;
      return true;
    });
    await mirror.sendCommand("BuildRoad", road([4400, 4420], [4400, 4900]));
    tick();
    expect(lost).toBe(true);
    setDrop(() => false);
    const before = received.filter((m) => m.type === "snapshot").length;
    tick();
    expect(received.filter((m) => m.type === "snapshot").length).toBe(before + 1);
    tick();
    expect(arrays(mirror.state?.roads)).toEqual(arrays(hostRoads()));
    expect(mirror.state?.roads.segFlags.length).toBe(4);
  });

  it("delivers a segment removed and its id reused in the same tick as the new segment", async () => {
    const { mirror, received, tick, hostRoads } = roadSetup();
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    const old = { a: mirror.state?.roads.segA[0], b: mirror.state?.roads.segB[0] };
    // Crossing it splits segment 0: it is removed and its first piece takes id 0.
    await mirror.sendCommand("BuildRoad", road([4400, 4420], [4400, 4900]));
    tick();
    const delta = received.filter((m) => m.type === "delta").at(-1);
    expect(delta?.type === "delta" && Array.from(delta.roads?.segIds ?? [])).toContain(0);
    const roads = hostRoads();
    expect({ a: roads.segA[0], b: roads.segB[0] }).not.toEqual(old);
    expect(mirror.state?.roads.segA[0]).toBe(roads.segA[0]);
    expect(mirror.state?.roads.segB[0]).toBe(roads.segB[0]);
    expect(mirror.state?.roads.segLength[0]).toBe(roads.segLength[0]);
    expect(arrays(mirror.state?.roads)).toEqual(arrays(roads));
  });

  it("keeps the mirror's network and undo history equal to the sim's through random builds, edits and undos", () => {
    const { mirror, tick, hostRoads, received } = roadSetup();
    const rng = seedRng(47);
    const point = (): [number, number] => [FLAT.x0 + nextFloat(rng) * (FLAT.x1 - FLAT.x0), FLAT.z0 + nextFloat(rng) * (FLAT.z1 - FLAT.z0)];
    const live = () => {
      const roads = mirror.state?.roads;
      const out: number[] = [];
      for (let id = 0; roads && id < roads.segFlags.length; id++) if ((roads.segFlags[id] ?? 0) & 1) out.push(id);
      return out;
    };
    /** A bulldoze or upgrade payload naming segment `seg`, with its ends as the copy has them. */
    const picked = (seg: number | undefined) => {
      const roads = mirror.state?.roads;
      const known = roads && seg !== undefined;
      return { segments: [seg], ends: known ? [segmentEnds(roads, seg)] : [], types: known ? [segmentTypeId(roads, seg)] : [] };
    };
    for (let t = 0; t < 400; t++) {
      const roll = nextInt(rng, 10);
      const segs = live();
      if (roll < 4 || segs.length === 0) void mirror.sendCommand("BuildRoad", road(point(), point(), TYPES[nextInt(rng, 3)]));
      else if (roll < 5) void mirror.sendCommand("BulldozeRoad", picked(segs[nextInt(rng, segs.length)]));
      else if (roll < 6) void mirror.sendCommand("UpgradeRoad", { ...picked(segs[nextInt(rng, segs.length)]), type: "avenue" });
      else void mirror.sendCommand("Undo");
      tick();
      if (t % 100 === 99) expect(arrays(mirror.state?.roads)).toEqual(arrays(hostRoads()));
    }
    expect(arrays(mirror.state?.roads)).toEqual(arrays(hostRoads()));
    const snap = received.filter((m) => m.type === "snapshot").at(-1);
    expect(snap?.type === "snapshot" && snap.state.undo).toEqual(mirror.state?.undo);
    // Enough happened for this to mean something.
    expect(mirror.state?.log.filter((e) => e.type === "Undo").length).toBeGreaterThan(50);
  });

  it("sends the undo history only in a delta where it changed", async () => {
    const { mirror, received, tick } = roadSetup();
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    const deltas = () => received.filter((m): m is Extract<FromSimMessage, { type: "delta" }> => m.type === "delta");
    expect(deltas().some((d) => d.undo?.added.length === 1 && d.undo.kept.length === 0)).toBe(true);
    expect(mirror.state?.undo.map((r) => r.playerId)).toEqual(["p1"]);
    const before = deltas().length;
    tick();
    expect(deltas().slice(before).every((d) => d.undo === undefined)).toBe(true);
    expect(await mirror.sendCommand("Undo")).toEqual({ ok: true });
    tick();
    expect(mirror.state?.undo).toEqual([]);
    expect(mirror.state?.roads.segFlags.length).toBe(0);
    expect(await mirror.sendCommand("Undo")).toEqual({ ok: false, reason: "Nothing to undo" });
  });

  it("sends the records the history kept by place and only the new ones whole", async () => {
    const { mirror, received, tick } = roadSetup();
    const deltas = () => received.filter((m): m is Extract<FromSimMessage, { type: "delta" }> => m.type === "delta");
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    const first = mirror.state?.undo[0];
    let before = deltas().length;
    await mirror.sendCommand("BuildRoad", road([4200, 4700], [4600, 4700]));
    tick();
    const built = deltas().slice(before).flatMap((d) => (d.undo ? [d.undo] : []));
    expect(built.map((u) => [[...u.kept], u.added.length])).toEqual([[[0], 1]]);
    // The copy keeps its own record object for the one it already had.
    expect(mirror.state?.undo[0]).toBe(first);
    expect(mirror.state?.undo.length).toBe(2);
    before = deltas().length;
    expect(await mirror.sendCommand("Undo")).toEqual({ ok: true });
    tick();
    const undone = deltas().slice(before).flatMap((d) => (d.undo ? [d.undo] : []));
    expect(undone.map((u) => [[...u.kept], u.added.length])).toEqual([[[0], 0]]);
    expect(mirror.state?.undo).toEqual([first]);
  });

  it("carries the whole network in a snapshot", async () => {
    const { mirror, tick, hostRoads } = roadSetup();
    await mirror.sendCommand("BuildRoad", road([4200, 4500], [4600, 4500]));
    tick();
    mirror.requestSnapshot();
    expect(arrays(mirror.state?.roads)).toEqual(arrays(hostRoads()));
    expect(mirror.state?.roads.segFlags.length).toBe(1);
  });

  describe("two players in one tick (issue 94)", () => {
    it("tells the second player its command was dropped at the step, and why", async () => {
      const { mirror, received, tick, join } = roadSetup();
      const other = join("p2");
      // The same street from both players. Each is valid when it arrives, so both are queued.
      const first = mirror.sendCommandSettled("BuildRoad", road([4200, 4600], [4500, 4600]));
      const second = other.sendCommandSettled("BuildRoad", road([4200, 4600], [4500, 4600]));
      const queued = received.filter((m) => m.type === "commandResult").map((m) => [m.playerId, m.result]);
      expect(queued).toEqual([
        ["p1", { ok: true }],
        ["p2", { ok: true }],
      ]);
      tick();
      await expect(first).resolves.toEqual({ ok: true });
      const result = await second;
      expect(result.ok).toBe(false);
      // The reason is the sim's, the one the second player would get had it arrived after the first was built.
      const late = await other.sendCommand("BuildRoad", road([4200, 4600], [4500, 4600]));
      expect(result).toEqual(late);
      const delta = received.find((m) => m.type === "delta" && m.dropped);
      expect(delta?.type === "delta" && delta.dropped).toEqual([
        { seq: 1, playerId: "p2", type: "BuildRoad", reason: late.ok ? "" : late.reason },
      ]);
      // Only the first is in the log. The first player hears nothing about the second's.
      expect(other.state?.log.map((e) => [e.playerId, e.seq])).toEqual([["p1", 1]]);
    });

    it("starts a reloaded page's seqs past those of its player still in the city", async () => {
      const { mirror, received, tick, join } = roadSetup();
      void mirror.sendCommand("NoOp");
      tick();
      void mirror.sendCommand("NoOp");
      // A new page for the same player, as after a reload, while seq 2 is still queued.
      const again = join("p1");
      await again.sendCommand("NoOp");
      const seqs = received.filter((m) => m.type === "commandResult").map((m) => m.seq);
      expect(seqs).toEqual([1, 2, 3]);
    });

    it("still answers a plain sendCommand at the queue, before the step", async () => {
      const { mirror, join } = roadSetup();
      const other = join("p2");
      void mirror.sendCommand("BuildRoad", road([4200, 4600], [4500, 4600]));
      await expect(other.sendCommand("BuildRoad", road([4200, 4600], [4500, 4600]))).resolves.toEqual({ ok: true });
    });

    it("settles a command whose delta went missing from the snapshot that follows", async () => {
      const { mirror, join, tick, setDrop } = roadSetup();
      const other = join("p2");
      const built = mirror.sendCommandSettled("BuildRoad", road([4200, 4600], [4500, 4600]));
      const dropped = other.sendCommandSettled("BuildRoad", road([4200, 4600], [4500, 4600]));
      // The first player's mirror loses the delta, then the next one does not line up and it asks for a snapshot.
      let lost = false;
      setDrop((m) => {
        if (m.type !== "delta" || lost) return false;
        lost = true;
        return true;
      });
      tick();
      await expect(dropped).resolves.toMatchObject({ ok: false });
      void mirror.sendCommand("NoOp");
      tick();
      await expect(built).resolves.toEqual({ ok: true });
      expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoad", "NoOp"]);
    });
  });
});

describe("a host that knows who is on its connection", () => {
  it("stamps that player on every command, whatever id the message claims", () => {
    const { client, host: hostEnd } = memoryTransportPair();
    const received: FromSimMessage[] = [];
    client.onMessage((m) => received.push(m));
    let now = 0;
    const host = new SimHost(createBareState(3), hostEnd, () => now, [], "local");
    client.send({ v: PROTOCOL_VERSION, type: "command", command: { seq: 1, playerId: "someone else", type: "NoOp", payload: {} } });
    client.send({ v: PROTOCOL_VERSION, type: "command", command: { seq: 2, playerId: "", type: "NoOp", payload: {} } });
    now += 100;
    host.pump();
    expect(received.filter((m) => m.type === "commandResult")).toEqual([
      { v: PROTOCOL_VERSION, type: "commandResult", seq: 1, playerId: "local", result: { ok: true } },
      { v: PROTOCOL_VERSION, type: "commandResult", seq: 2, playerId: "local", result: { ok: true } },
    ]);
    expect(host.fullLog.map((e) => e.playerId)).toEqual(["local", "local"]);
  });
});

describe("a host resumed from its own save", () => {
  // Drives a host for `ms` of real time from `from`, sending commands that
  // depend only on the time, enough of them to page entries out of live
  // state before the save.
  function drive(host: SimHost, inject: (message: unknown) => void, clock: { now: number }, from: number, ms: number): void {
    for (let t = from; t < from + ms; t += PUMP_INTERVAL_MS) {
      if (t % 100 === 0) {
        for (let i = 0; i < 10; i++) {
          inject({ v: PROTOCOL_VERSION, type: "command", command: { seq: t + i, playerId: i % 2 ? "a" : "b", type: "NoOp", payload: { t, i } } });
        }
      }
      if (t % 7000 === 0) {
        const speed = ([1, 2, 0, 4] as const)[(t / 7000) % 4];
        inject({ v: PROTOCOL_VERSION, type: "command", command: { seq: t, playerId: "a", type: "SetSpeed", payload: { speed } } });
      }
      clock.now += PUMP_INTERVAL_MS;
      host.pump();
    }
  }

  function start(bytes?: Uint8Array) {
    const { client, host: hostEnd } = memoryTransportPair();
    const clock = { now: 0 };
    const saved = bytes ? deserialize(bytes) : null;
    const host = new SimHost(saved?.state ?? createState(9), hostEnd, () => clock.now, saved?.pagedLog ?? []);
    return { host, clock, inject: (message: unknown) => client.send(message as never) };
  }

  it("ends on the same hash and the same full log as a host that never stopped", () => {
    const HALF_MS = 50_000;
    const straight = start();
    drive(straight.host, straight.inject, straight.clock, 0, 2 * HALF_MS);

    const first = start();
    drive(first.host, first.inject, first.clock, 0, HALF_MS);
    const second = start(first.host.snapshotBytes());
    drive(second.host, second.inject, second.clock, HALF_MS, HALF_MS);

    const a = deserialize(straight.host.snapshotBytes());
    const b = deserialize(second.host.snapshotBytes());
    expect(a.pagedLog.length).toBeGreaterThan(0);
    expect(deserialize(first.host.snapshotBytes()).pagedLog.length).toBeGreaterThan(0);
    expect(b.state.tick).toBe(a.state.tick);
    expect(a.state.tick).toBeGreaterThan(1000);
    expect(hashState(b.state)).toBe(hashState(a.state));
    expect(second.host.fullLog).toEqual(straight.host.fullLog);
    expect(hashState(replay(9, second.host.fullLog, second.host.tick))).toBe(hashState(a.state));
  });
});

describe("snapshot transfer", () => {
  it("lists the state's typed array buffers so a worker can move them", () => {
    const state = createBareState(3);
    // Every road field but the build order counter, which is a number.
    const roadBuffers = Object.values(state.roads).flatMap((value) => (ArrayBuffer.isView(value) ? [value.buffer] : []));
    const cellBuffers = [state.cells.offset.buffer, state.cells.zone.buffer, state.cells.density.buffer];
    const buildingBuffers = Object.values(state.buildings).map((value) => value.buffer);
    // Every pop field but the sweep's limit, which is a number.
    const popBuffers = Object.values(state.pops).flatMap((value) => (ArrayBuffer.isView(value) ? [value.buffer] : []));
    // One history series a total.
    const statBuffers = Object.values(state.stats.history).map((value) => value.buffer);
    expect(typedArrayBuffers(state)).toEqual([
      state.rng.buffer,
      ...roadBuffers,
      state.connections.buffer,
      ...cellBuffers,
      ...buildingBuffers,
      ...popBuffers,
      ...statBuffers,
    ]);
    expect(buildingBuffers).toHaveLength(19);
    expect(popBuffers).toHaveLength(9);
    expect(statBuffers).toHaveLength(STAT_TOTALS.length);
    expect(roadBuffers.length).toBeGreaterThan(10);
  });
});

describe("autosave buffers (issue #158)", () => {
  const finish = (steps: ReturnType<SimHost["startSave"]>["steps"]): Uint8Array => {
    for (;;) {
      const part = steps.next();
      if (part.done) return part.value;
    }
  };

  it("writes the next save into the last one's buffers once it is released, and never into a save still held", () => {
    const { host, client, run } = setup(11);
    client.send({ v: PROTOCOL_VERSION, type: "command", command: { seq: 1, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4000, z: 4000 }, to: { x: 4200, z: 4000 }, type: "street" } } });
    run(200);
    const first = host.startSave(0);
    const firstBytes = finish(first.steps);
    const firstCopy = firstBytes.slice();
    expect(Array.from(firstCopy)).toEqual(Array.from(host.saveBytes(0).bytes));

    // Held: a second save gets buffers of its own and leaves the first one's bytes alone.
    client.send({ v: PROTOCOL_VERSION, type: "command", command: { seq: 2, playerId: "p1", type: "BuildRoad", payload: { from: { x: 4000, z: 4300 }, to: { x: 4200, z: 4300 }, type: "street" } } });
    run(200);
    const second = host.startSave(0);
    const secondBytes = finish(second.steps);
    expect(secondBytes.buffer).not.toBe(firstBytes.buffer);
    expect(Array.from(firstBytes)).toEqual(Array.from(firstCopy));
    expect(Array.from(secondBytes)).toEqual(Array.from(host.saveBytes(0).bytes));
    second.release();

    // Released: the next save reuses the first one's buffer and still writes the city as it is.
    first.release();
    first.release();
    const third = host.startSave(0);
    const thirdBytes = finish(third.steps);
    expect(thirdBytes.buffer).toBe(firstBytes.buffer);
    expect(Array.from(thirdBytes)).toEqual(Array.from(host.saveBytes(0).bytes));
    expect(hashState(deserialize(thirdBytes).state)).toBe(hashState(deserialize(host.saveBytes(0).bytes).state));
    third.release();
  });
});
