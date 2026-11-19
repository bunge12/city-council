// Messages that hold the worker's clock and step the sim by hand, for tests
// (issue #224). Like saves, this is local hosting, not the sim protocol: the
// messages share the worker's port and are told apart by `channel`.
import type { SimHost } from "./host";
import type { SimTransport } from "./transport";

export const CLOCK_CHANNEL = "clock";

/** Page to worker. `hold` stops the clock stepping the sim, `advance` runs steps, `release` hands back to the clock. */
export type ToClock =
  | { channel: typeof CLOCK_CHANNEL; type: "hold"; requestId: number }
  | { channel: typeof CLOCK_CHANNEL; type: "release"; requestId: number }
  | { channel: typeof CLOCK_CHANNEL; type: "advance"; steps: number; requestId: number };

/**
 * Worker to page, after the request. `tick` is the sim's tick once it is
 * done. It is sent after the delta an `advance` produced, on the same port,
 * so the page's copy holds that delta when this arrives. `ok` is false when
 * this tab hosts no city.
 */
export interface FromClock {
  channel: typeof CLOCK_CHANNEL;
  type: "done";
  requestId: number;
  ok: boolean;
  tick: number;
}

export function isClockMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { channel?: unknown }).channel === CLOCK_CHANNEL;
}

/** Checks a message the worker received on the clock channel. */
export function parseClockRequest(raw: unknown): ToClock | null {
  if (!isClockMessage(raw)) return null;
  const message = raw as Record<string, unknown>;
  const requestId = message["requestId"];
  if (typeof requestId !== "number") return null;
  switch (message["type"]) {
    case "hold":
      return { channel: CLOCK_CHANNEL, type: "hold", requestId };
    case "release":
      return { channel: CLOCK_CHANNEL, type: "release", requestId };
    case "advance": {
      const steps = message["steps"];
      if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 0) return null;
      return { channel: CLOCK_CHANNEL, type: "advance", steps, requestId };
    }
    default:
      return null;
  }
}

/** The worker's end: answers clock requests for `host`, or refuses them all when this tab hosts nothing. */
export function serveClock(host: SimHost | null, transport: SimTransport<FromClock, unknown>): void {
  transport.onMessage((raw) => {
    const request = parseClockRequest(raw);
    if (!request) return;
    if (host) {
      if (request.type === "hold") host.hold();
      else if (request.type === "release") host.release();
      else host.advance(request.steps);
    }
    transport.send({ channel: CLOCK_CHANNEL, type: "done", requestId: request.requestId, ok: host !== null, tick: host?.tick ?? -1 });
  });
}

/**
 * The page's end. Each call resolves with the sim's tick once the worker has
 * done it. Requests keep their order with the sim protocol's messages once
 * the worker hosts the city; before that each channel is held in its own
 * buffer, so a test sends `advance` only once the page has its first snapshot.
 */
export class ClockClient {
  private readonly transport: SimTransport<ToClock, FromClock>;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (message: FromClock) => void>();
  private holding = false;

  constructor(transport: SimTransport<ToClock, FromClock>) {
    this.transport = transport;
    transport.onMessage((message) => {
      this.waiting.get(message.requestId)?.(message);
      this.waiting.delete(message.requestId);
    });
  }

  /** Stops the worker's clock: the sim steps only on `advance`, and commands wait for it. */
  hold(): Promise<number> {
    this.holding = true;
    return this.request({ type: "hold" });
  }

  /** True from a `hold` until the next `release`, as this page asked for them. */
  get held(): boolean {
    return this.holding;
  }

  /** Hands stepping back to the worker's clock. */
  release(): Promise<number> {
    this.holding = false;
    return this.request({ type: "release" });
  }

  /** Runs `steps` steps and resolves once their delta is in the page's copy. */
  advance(steps: number): Promise<number> {
    return this.request({ type: "advance", steps });
  }

  private request(body: { type: "hold" } | { type: "release" } | { type: "advance"; steps: number }): Promise<number> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.waiting.set(requestId, (message) => (message.ok ? resolve(message.tick) : reject(new Error("this tab hosts no city"))));
      this.transport.send({ channel: CLOCK_CHANNEL, requestId, ...body } as ToClock);
    });
  }
}
