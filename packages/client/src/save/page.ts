// The page's side of saving: asks the worker to save, to write a city file
// and to take one in, and keeps the latest status for the UI. It never
// touches state or IndexedDB itself.

import type { DerivedStage } from "@city-council/sim";
import {
  SAVES_CHANNEL,
  isDerivedStage,
  type ExportReply,
  type FromSaver,
  type ImportReply,
  type LoadFileMessage,
  type PageSaveTransport,
  type SaveReason,
  type SaveStatus,
  type SwitchReply,
} from "./channel";

type Listener = (status: SaveStatus) => void;
type OpeningListener = (seed: number, saved: boolean) => void;
type LoadingListener = (stage: DerivedStage) => void;
type ReadingListener = (step: string) => void;

export class SaveClient {
  private readonly transport: PageSaveTransport;
  private current: SaveStatus | null = null;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (message: FromSaver) => void>();
  private readonly listeners = new Set<Listener>();
  private readonly openingListeners = new Set<OpeningListener>();
  private readonly loadingListeners = new Set<LoadingListener>();
  private readonly readingListeners = new Set<ReadingListener>();

  constructor(transport: PageSaveTransport) {
    this.transport = transport;
    transport.onMessage((message) => {
      if (message.type === "status") {
        this.current = message.status;
        for (const listener of this.listeners) listener(message.status);
      }
      if (message.type === "opening") for (const listener of this.openingListeners) listener(message.seed, message.saved === true);
      if (message.type === "loading" && isDerivedStage(message.stage)) for (const listener of this.loadingListeners) listener(message.stage);
      if (message.type === "reading" && typeof message.step === "string") for (const listener of this.readingListeners) listener(message.step);
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

  /** Called with the seed of each city the worker starts to open, before its snapshot, and whether it is a saved city. */
  onOpening(listener: OpeningListener): () => void {
    this.openingListeners.add(listener);
    return () => void this.openingListeners.delete(listener);
  }

  /** Called as the worker starts each part of the opening city's derived data, before its snapshot (#327). */
  onLoading(listener: LoadingListener): () => void {
    this.loadingListeners.add(listener);
    return () => void this.loadingListeners.delete(listener);
  }

  /** Called as the worker passes each step of reading the save, before `onOpening` (#450). */
  onReading(listener: ReadingListener): () => void {
    this.readingListeners.add(listener);
    return () => void this.readingListeners.delete(listener);
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

/** `text` with its percent escapes decoded, or as it is when they are malformed. */
function decodeOr(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The `?load=` address in query string `search`, and `search` without it.
 * The page takes it out of its own address once read, so a reload goes back
 * to the city the tab is running rather than loading the file again.
 */
export function takeLoadAddress(search: string): { address: string | null; rest: string } {
  let address: string | null = null;
  const rest = search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => {
      if (!part.startsWith("load=")) return part !== "";
      address = decodeOr(part.slice("load=".length).replace(/\+/g, " "));
      return false;
    })
    .join("&");
  return { address, rest: rest ? `?${rest}` : "" };
}

/**
 * Fetches the city file at `address` for the worker to open
 * (`LoadFileMessage`). Only an address on `base`'s own origin is fetched.
 * Never rejects: a file that cannot be had comes back with no bytes and the
 * reason, since the worker waits for this message before it opens anything.
 */
export async function fetchCityFile(address: string, base: string, fetcher: typeof fetch = fetch): Promise<LoadFileMessage> {
  const failed = (fileName: string, error: string): LoadFileMessage => ({ channel: SAVES_CHANNEL, type: "load", fileName, bytes: null, error });
  let url: URL;
  try {
    url = new URL(address, base);
  } catch {
    return failed(address, "Its address is not valid.");
  }
  const fileName = decodeOr(url.pathname.split("/").pop() ?? "") || "City.city";
  if (url.origin !== new URL(base).origin) return failed(fileName, "Only a city file on this site can be opened from the address.");
  try {
    const response = await fetcher(url);
    if (!response.ok) return failed(fileName, `The server answered ${response.status}.`);
    return { channel: SAVES_CHANNEL, type: "load", fileName, bytes: await response.arrayBuffer(), error: null };
  } catch (error) {
    return failed(fileName, `It could not be fetched: ${error instanceof Error ? error.message : String(error)}.`);
  }
}
