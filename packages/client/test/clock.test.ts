// The clock channel that lets a test hold the worker's clock and step the
// sim by hand (issue #224), over an in-memory pair of ports.
import { describe, expect, it } from "vitest";
import { createBareState } from "@city-council/sim";
import { ClockClient, parseClockRequest, serveClock, type FromClock, type ToClock } from "../src/protocol/clock";
import { SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { isSimMessage, memoryTransportPair, portTransport, type MessagePortLike, type SimTransport } from "../src/protocol/transport";
import type { FromSimMessage, ToSimMessage } from "@city-council/sim";

/** Two ends of a clock channel, delivering synchronously. */
function clockPair(): { page: SimTransport<ToClock, FromClock>; worker: SimTransport<FromClock, unknown> } {
  const toWorker = new Set<(m: unknown) => void>();
  const toPage = new Set<(m: FromClock) => void>();
  return {
    page: { send: (m) => toWorker.forEach((h) => h(structuredClone(m))), onMessage: (h) => (toPage.add(h), () => void toPage.delete(h)) },
    worker: { send: (m) => toPage.forEach((h) => h(structuredClone(m))), onMessage: (h) => (toWorker.add(h), () => void toWorker.delete(h)) },
  };
}

/**
 * Two ends of one port, like a worker's: each message is delivered on its
 * own later task, in the order sent, to every listener on the other end.
 */
function portPair(): { page: MessagePortLike; worker: MessagePortLike } {
  const end = () => new Set<(event: MessageEvent) => void>();
  const pageListeners = end();
  const workerListeners = end();
  const port = (to: Set<(event: MessageEvent) => void>, own: Set<(event: MessageEvent) => void>): MessagePortLike => ({
    postMessage: (data) => {
      const copy: unknown = structuredClone(data);
      setTimeout(() => to.forEach((l) => l({ data: copy } as MessageEvent)), 0);
    },
    addEventListener: (_type, listener) => void own.add(listener),
    removeEventListener: (_type, listener) => void own.delete(listener),
  });
  return { page: port(workerListeners, pageListeners), worker: port(pageListeners, workerListeners) };
}

describe("the clock channel", () => {
  it("over one port shared with the sim protocol, applies a command sent before an advance and has its delta in the copy when the advance resolves", async () => {
    const ports = portPair();
    const host = new SimHost(createBareState(5), portTransport(ports.worker, isSimMessage), () => 0);
    serveClock(host, portTransport(ports.worker, (d) => !isSimMessage(d) && (d as { channel?: string }).channel === "clock"));
    const mirror = new SimMirror(portTransport<ToSimMessage, FromSimMessage>(ports.page, isSimMessage), "p1");
    const clock = new ClockClient(portTransport(ports.page, (d) => !isSimMessage(d)));
    await clock.hold();
    const settled = mirror.sendCommandSettled("SetSpeed", { speed: 4 });
    const tick = await clock.advance(10);
    expect(tick).toBe(10);
    expect(mirror.state?.tick).toBe(10);
    expect(mirror.state?.speed).toBe(4);
    await expect(settled).resolves.toEqual({ ok: true });
  });


  it("holds the host, runs the steps asked for with the delta in the copy first, and releases it", async () => {
    const { client, host: hostEnd } = memoryTransportPair();
    let now = 0;
    const host = new SimHost(createBareState(3), hostEnd, () => now);
    const mirror = new SimMirror(client, "p1");
    const { page, worker } = clockPair();
    serveClock(host, worker);
    const clock = new ClockClient(page);

    await expect(clock.hold()).resolves.toBe(0);
    now += 10_000;
    host.pump();
    expect(mirror.state?.tick).toBe(0);
    await expect(clock.advance(25)).resolves.toBe(25);
    expect(mirror.state?.tick).toBe(25);
    await expect(clock.release()).resolves.toBe(25);
    for (let i = 0; i < 10; i++) {
      now += 100;
      host.pump();
    }
    expect(mirror.state?.tick).toBe(35);
  });

  it("refuses every request in a tab that hosts no city", async () => {
    const { page, worker } = clockPair();
    serveClock(null, worker);
    await expect(new ClockClient(page).advance(1)).rejects.toThrow("hosts no city");
  });

  it("ignores requests that are not whole, non-negative step counts", () => {
    for (const steps of [-1, 1.5, "3", Number.NaN]) {
      expect(parseClockRequest({ channel: "clock", type: "advance", steps, requestId: 1 })).toBeNull();
    }
    expect(parseClockRequest({ channel: "saves", type: "hold", requestId: 1 })).toBeNull();
    expect(parseClockRequest({ channel: "clock", type: "advance", steps: 0, requestId: 1 })).toEqual({ channel: "clock", type: "advance", steps: 0, requestId: 1 });
  });
});
