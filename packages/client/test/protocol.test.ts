// Drives the full client-to-sim protocol with an in-memory transport and a
// fake clock: the same SimHost the worker runs, with no worker.
import { describe, expect, it } from "vitest";
import {
  LOG_LIVE_LIMIT,
  MAX_PENDING_COMMANDS,
  PROTOCOL_VERSION,
  createState,
  hashState,
  type FromSimMessage,
} from "@city-council/sim";
import { MAX_CATCH_UP_STEPS, PUMP_INTERVAL_MS, SimHost, typedArrayBuffers } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";

function setup(seed = 7) {
  const { client, host: hostEnd } = memoryTransportPair();
  const received: FromSimMessage[] = [];
  client.onMessage((m) => received.push(m));
  let now = 0;
  const host = new SimHost(createState(seed), hostEnd, () => now);
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
  return { host, mirror, received, run, stall };
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

  it("sends deltas only when something changed, carrying only tick, speed and new log", async () => {
    const { mirror, run, received } = setup();
    await mirror.sendCommand("SetSpeed", { speed: 0 });
    run(100);
    const before = received.length;
    run(1000);
    expect(received.length).toBe(before);
    const delta = received.filter((m) => m.type === "delta").at(-1);
    expect(delta && Object.keys(delta).sort()).toEqual(
      ["log", "logFrom", "speed", "steps", "tick", "timings", "type", "v"].sort(),
    );
  });

  it("reports per-system timings from the host", () => {
    const { mirror, run } = setup();
    run(100);
    expect(mirror.stats.timings.map((t) => t.system)).toEqual(["commands"]);
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
      tick: 3,
      speed: 1,
      logFrom: 99,
      log: [],
      steps: 1,
      timings: [],
    });
    expect(mirror.state?.tick).toBe(0);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)?.type).toBe("snapshot");
  });
});

describe("snapshot transfer", () => {
  it("lists the state's typed array buffers so a worker can move them", () => {
    const state = createState(3);
    expect(typedArrayBuffers(state)).toEqual([state.rng.buffer]);
  });
});
