import type { FromSimMessage, ToSimMessage } from "@city-council/sim";

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
 */
export function portTransport<Send, Receive>(port: MessagePortLike): SimTransport<Send, Receive> {
  return {
    send(message, transfer = []) {
      port.postMessage(message, transfer);
    },
    onMessage(handler) {
      const listener = (event: MessageEvent): void => handler(event.data as Receive);
      port.addEventListener("message", listener);
      return () => port.removeEventListener("message", listener);
    },
  };
}

/** Starts the sim in a Web Worker and returns the client's end of it. */
export function createWorkerTransport(): ClientTransport & { terminate(): void } {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "sim",
  });
  return { ...portTransport<ToSimMessage, FromSimMessage>(worker), terminate: () => worker.terminate() };
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
