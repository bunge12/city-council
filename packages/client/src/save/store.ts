// Saved cities in IndexedDB. Two object stores: "cities" holds a small
// record per city for the list, "snapshots" holds the bytes. Each city keeps
// its latest snapshot and the one before it, so a damaged latest save still
// leaves a good one to go back to.

import { readSnapshotHeader } from "@city-council/sim";
import { SAVE_DB_NAME } from "./config";

/** One saved city, as the list shows it. */
export interface CityMeta {
  id: string;
  name: string;
  seed: number;
  tick: number;
  /** Wall time of the last save, in milliseconds since 1970. */
  savedAt: number;
}

/** A city's stored snapshots. */
export interface CitySnapshots {
  latest: Uint8Array;
  /** The latest good snapshot before `latest`, if there was one. */
  previous: Uint8Array | null;
}

interface SnapshotRecord {
  id: string;
  latest: ArrayBuffer;
  previous: ArrayBuffer | null;
}

const DB_VERSION = 1;
const CITIES = "cities";
const SNAPSHOTS = "snapshots";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/** Whether stored bytes pass the header and checksum check. */
function isGood(bytes: ArrayBuffer | null | undefined): boolean {
  if (!bytes) return false;
  try {
    readSnapshotHeader(new Uint8Array(bytes));
    return true;
  } catch {
    return false;
  }
}

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export class CityStore {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Opens the save database, creating it on first use. */
  static async open(factory: IDBFactory = indexedDB, name: string = SAVE_DB_NAME): Promise<CityStore> {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CITIES)) db.createObjectStore(CITIES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "id" });
    };
    return new CityStore(await request(req));
  }

  /** Every saved city, most recently saved first. */
  async list(): Promise<CityMeta[]> {
    const tx = this.db.transaction(CITIES, "readonly");
    const all = (await request(tx.objectStore(CITIES).getAll())) as CityMeta[];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  /** A city's snapshots, or null if there is no such city. */
  async read(id: string): Promise<CitySnapshots | null> {
    const tx = this.db.transaction(SNAPSHOTS, "readonly");
    const record = (await request(tx.objectStore(SNAPSHOTS).get(id))) as SnapshotRecord | undefined;
    if (!record) return null;
    return {
      latest: new Uint8Array(record.latest),
      previous: record.previous ? new Uint8Array(record.previous) : null,
    };
  }

  /**
   * Stores `bytes` as the city's latest snapshot and updates its list entry,
   * in one transaction. The old latest becomes the previous one if it is
   * good; if it is damaged, the previous good one is kept instead.
   */
  async save(meta: CityMeta, bytes: Uint8Array): Promise<void> {
    const tx = this.db.transaction([CITIES, SNAPSHOTS], "readwrite");
    const finished = done(tx);
    const snapshots = tx.objectStore(SNAPSHOTS);
    const old = (await request(snapshots.get(meta.id))) as SnapshotRecord | undefined;
    const record: SnapshotRecord = {
      id: meta.id,
      latest: ownBuffer(bytes),
      previous: isGood(old?.latest) ? (old?.latest ?? null) : (old?.previous ?? null),
    };
    snapshots.put(record);
    tx.objectStore(CITIES).put({ ...meta });
    await finished;
  }

  close(): void {
    this.db.close();
  }
}
