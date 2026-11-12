import type { FromSimMessage, ToSimMessage } from "@city-council/sim";
import { isSaveMessage, type FromSaver, type PageSaveTransport, type ToSaver } from "../save/channel";
import { workerName } from "../save/lock";

/**
 * A two-way message channel to or from the sim. Nothing above this knows
 * whether the other end is a worker, a socket or an in-memory stub.
 *
 * `transfer` lists buffers the sender gives up so a worker can move them
 * instead of copying. Transports that cannot move memory, such as a socket,
 * ignore it. Either way the sender must not touch those buffers again.
 */
export interface SimTransport<Send, Receive> {
  send(message: Send, transfer?: Transferable[]): void;
  /** Registers a handler for every message received. Returns an unsubscribe. */
  onMessage(handler: (message: Receive) => void): () => void;
}

/** The client's end: commands out, state in. */
export type ClientTransport = SimTransport<ToSimMessage, FromSimMessage>;
/** The host's end: state out, commands in. */
export type HostTransport = SimTransport<FromSimMessage, unknown>;

/** The part of `Worker`, `MessagePort` and a worker's `self` used here. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/**
 * A transport over anything with `postMessage`. Received data is passed on
 * as `Receive` unchecked, so the host side uses `unknown` and parses it.
 * `accept` picks which received messages this transport sees, so two
 * channels can share one port.
 */
export function portTransport<Send, Receive>(
  port: MessagePortLike,
  accept: (data: unknown) => boolean = () => true,
): SimTransport<Send, Receive> {
  return {
    send(message, transfer = []) {
      port.postMessage(message, transfer);
    },
    onMessage(handler) {
      const listener = (event: MessageEvent): void => {
        if (accept(event.data)) handler(event.data as Receive);
      };
      port.addEventListener("message", listener);
      return () => port.removeEventListener("message", listener);
    },
  };
}

/**
 * Holds received messages until something listens, then hands them over in
 * order. The worker loads its save before the host exists, and the client
 * asks for a snapshot the moment it starts.
 */
export function bufferUntilListening<Send, Receive>(inner: SimTransport<Send, Receive>): SimTransport<Send, Receive> {
  let held: Receive[] | null = [];
  const handlers = new Set<(message: Receive) => void>();
  inner.onMessage((message) => {
    if (held) held.push(message);
    else for (const handler of handlers) handler(message);
  });
  return {
    send: (message, transfer) => inner.send(message, transfer),
    onMessage(handler) {
      handlers.add(handler);
      if (held) {
        const queued = held;
        held = null;
        for (const message of queued) handler(message);
      }
      return () => void handlers.delete(handler);
    },
  };
}

/** The worker's two channels as the page sees them: the sim protocol and saves. */
export interface WorkerChannels {
  sim: ClientTransport;
  saves: PageSaveTransport;
  terminate(): void;
}

/**
 * Starts the sim in a Web Worker and returns the page's ends of it.
 * `cityId` is the city this tab last ran, which the worker opens if it is
 * still saved. It travels in the worker's name, so the worker has it before
 * any message arrives.
 */
export function createWorkerTransport(cityId: string | null = null): WorkerChannels {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: workerName(cityId),
  });
  return {
    sim: portTransport<ToSimMessage, FromSimMessage>(worker, (data) => !isSaveMessage(data)),
    saves: portTransport<ToSaver, FromSaver>(worker, isSaveMessage),
    terminate: () => worker.terminate(),
  };
}

/**
 * Two connected ends with no worker, for tests. Delivery is synchronous;
 * messages are passed through `structuredClone` so neither end can share
 * objects with the other, as with a real worker.
 */
export function memoryTransportPair(): { client: ClientTransport; host: HostTransport } {
  const toHost = new Set<(message: unknown) => void>();
  const toClient = new Set<(message: FromSimMessage) => void>();
  const subscribe =
    <T>(set: Set<(message: T) => void>) =>
    (handler: (message: T) => void) => {
      set.add(handler);
      return () => void set.delete(handler);
    };
  return {
    client: {
      send: (message) => {
        const copy = structuredClone(message);
        for (const handler of toHost) handler(copy);
      },
      onMessage: subscribe(toClient),
    },
    host: {
      send: (message) => {
        const copy = structuredClone(message);
        for (const handler of toClient) handler(copy);
      },
      onMessage: subscribe(toHost),
    },
  };
}
