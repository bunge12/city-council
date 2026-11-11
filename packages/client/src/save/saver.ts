// Saves the hosted city. Runs next to the SimHost in the worker: the host
// owns the real state, so the snapshot is taken there and written straight
// to IndexedDB without a trip through the page.

import type { SimHost } from "../protocol/host";
import {
  SAVES_CHANNEL,
  parseSaveRequest,
  type LoadedFrom,
  type SaveReason,
  type SaveStatus,
  type WorkerSaveTransport,
} from "./channel";
import type { CityStore } from "./store";

export interface SaverOptions {
  /** Null when IndexedDB could not be opened; saves then report why. */
  store: CityStore | null;
  /** Why the store is null, shown with every failed save. */
  storeError?: string;
  host: SimHost;
  transport: WorkerSaveTransport;
  city: { id: string; name: string };
  loadedFrom: LoadedFrom;
  problem: string | null;
  /** Wall clock, for the last-saved time. */
  wallClock: () => number;
}

export class Saver {
  private readonly options: SaverOptions;
  private status: SaveStatus;
  /** Saves run one at a time, in the order asked, so the latest is written last. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SaverOptions) {
    this.options = options;
    const { host, city, loadedFrom, problem } = options;
    this.status = {
      city: { ...city, seed: host.seed },
      loadedFrom,
      loadedTick: host.tick,
      lastSave: null,
      problem,
      saveError: null,
      cities: [],
    };
    options.transport.onMessage((raw) => {
      const request = parseSaveRequest(raw);
      if (request) void this.save(request.reason, request.requestId);
    });
  }

  /** Sends the current status, with the city list. */
  async announce(): Promise<void> {
    await this.refreshList();
    this.send(null);
  }

  /**
   * Snapshots the city now and writes it. The snapshot is taken when this
   * is called, between steps, so a save is always a whole tick.
   */
  save(reason: SaveReason, requestId: number | null = null): Promise<void> {
    const { host } = this.options;
    const tick = host.tick;
    let bytes: Uint8Array | null = null;
    let snapshotError: string | null = null;
    try {
      bytes = host.snapshotBytes();
    } catch (error) {
      snapshotError = String(error);
    }
    const job = this.queue.then(() => this.write(reason, tick, bytes, snapshotError, requestId));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async write(
    reason: SaveReason,
    tick: number,
    bytes: Uint8Array | null,
    snapshotError: string | null,
    requestId: number | null,
  ): Promise<void> {
    const { store, storeError, city, host, wallClock } = this.options;
    try {
      if (!store) throw new Error(storeError ?? "saving is not available in this browser");
      if (!bytes) throw new Error(snapshotError ?? "the city could not be written out");
      const savedAt = wallClock();
      await store.save({ id: city.id, name: city.name, seed: host.seed, tick, savedAt }, bytes);
      this.status = { ...this.status, lastSave: { tick, savedAt, reason }, saveError: null };
      await this.refreshList();
    } catch (error) {
      this.status = { ...this.status, saveError: `Saving failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.send(requestId);
  }

  private async refreshList(): Promise<void> {
    if (!this.options.store) return;
    try {
      this.status = { ...this.status, cities: await this.options.store.list() };
    } catch {
      // The list is for show; a failed read leaves the old one.
    }
  }

  private send(requestId: number | null): void {
    this.options.transport.send({ channel: SAVES_CHANNEL, type: "status", status: this.status, requestId });
  }
}
