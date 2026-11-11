// The page's side of saving: asks the worker to save and keeps the latest
// status for the UI. It never touches state or IndexedDB itself.

import { SAVES_CHANNEL, type PageSaveTransport, type SaveReason, type SaveStatus } from "./channel";

type Listener = (status: SaveStatus) => void;

export class SaveClient {
  private readonly transport: PageSaveTransport;
  private current: SaveStatus | null = null;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (status: SaveStatus) => void>();
  private readonly listeners = new Set<Listener>();

  constructor(transport: PageSaveTransport) {
    this.transport = transport;
    transport.onMessage((message) => {
      if (message.type !== "status") return;
      this.current = message.status;
      for (const listener of this.listeners) listener(message.status);
      if (message.requestId !== null) {
        this.waiting.get(message.requestId)?.(message.status);
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
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.waiting.set(requestId, resolve);
      this.transport.send({ channel: SAVES_CHANNEL, type: "save", reason, requestId });
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
