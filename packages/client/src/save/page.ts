// The page's side of saving: asks the worker to save, to write a city file
// and to take one in, and keeps the latest status for the UI. It never
// touches state or IndexedDB itself.

import {
  SAVES_CHANNEL,
  type ExportReply,
  type FromSaver,
  type ImportReply,
  type PageSaveTransport,
  type SaveReason,
  type SaveStatus,
  type SwitchReply,
} from "./channel";

type Listener = (status: SaveStatus) => void;

export class SaveClient {
  private readonly transport: PageSaveTransport;
  private current: SaveStatus | null = null;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (message: FromSaver) => void>();
  private readonly listeners = new Set<Listener>();

  constructor(transport: PageSaveTransport) {
    this.transport = transport;
    transport.onMessage((message) => {
      if (message.type === "status") {
        this.current = message.status;
        for (const listener of this.listeners) listener(message.status);
      }
      if (message.requestId !== null) {
        this.waiting.get(message.requestId)?.(message);
        this.waiting.delete(message.requestId);
      }
    });
  }

  /** The latest status from the worker, or null before the city has loaded. */
  get status(): SaveStatus | null {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Asks the worker to save now. Resolves with the status after the write. */
  save(reason: SaveReason): Promise<SaveStatus> {
    return this.ask<SaveStatus>((requestId) => {
      this.transport.send({ channel: SAVES_CHANNEL, type: "save", reason, requestId });
    }, (m) => (m.type === "status" ? m.status : null));
  }

  /** Asks the worker for the running city as city file bytes. */
  exportCity(): Promise<ExportReply["result"]> {
    return this.ask((requestId) => {
      this.transport.send({ channel: SAVES_CHANNEL, type: "export", requestId });
    }, (m) => (m.type === "exported" ? m.result : null));
  }

  /**
   * Hands a city file to the worker, which checks it and stores it as a new
   * city to open next. `bytes` is given up to the worker.
   */
  importCity(fileName: string, bytes: ArrayBuffer): Promise<ImportReply["result"]> {
    return this.ask((requestId) => {
      this.transport.send({ channel: SAVES_CHANNEL, type: "import", requestId, fileName, bytes }, [bytes]);
    }, (m) => (m.type === "imported" ? m.result : null));
  }

  /** Asks the worker to store a new city from `seed`, to open next. */
  newCity(name: string, seed: number): Promise<SwitchReply["result"]> {
    return this.ask((requestId) => {
      this.transport.send({ channel: SAVES_CHANNEL, type: "new", requestId, name, seed });
    }, (m) => (m.type === "switched" ? m.result : null));
  }

  /** Asks the worker to mark saved city `id` to open next. */
  openCity(id: string): Promise<SwitchReply["result"]> {
    return this.ask((requestId) => {
      this.transport.send({ channel: SAVES_CHANNEL, type: "open", requestId, id });
    }, (m) => (m.type === "switched" ? m.result : null));
  }

  private ask<T>(send: (requestId: number) => void, pick: (message: FromSaver) => T | null): Promise<T> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.waiting.set(requestId, (message) => {
        const value = pick(message);
        if (value === null) reject(new Error(`unexpected ${message.type} answer to request ${requestId}`));
        else resolve(value);
      });
      send(requestId);
    });
  }
}

/** What the browser said about keeping saved cities. */
export type PersistenceResult = "persisted" | "declined" | "unsupported";

/**
 * Asks the browser not to clear saved cities when space runs low. Browsers
 * may decline, and then saves can be evicted.
 */
export async function requestPersistence(storage: StorageManager | undefined = navigator.storage): Promise<PersistenceResult> {
  if (!storage?.persist) return "unsupported";
  try {
    if (await storage.persisted()) return "persisted";
    return (await storage.persist()) ? "persisted" : "declined";
  } catch {
    return "declined";
  }
}
