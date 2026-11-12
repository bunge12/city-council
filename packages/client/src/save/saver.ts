// Saves the hosted city, writes it out as a city file and takes city files
// in. Runs next to the SimHost in the worker: the host owns the real state,
// so the snapshot is taken there and written straight to IndexedDB without
// a trip through the page.

import { SnapshotError, deserialize, type Snapshot } from "@city-council/sim";
import type { SimHost } from "../protocol/host";
import {
  SAVES_CHANNEL,
  parseSaveRequest,
  type ExportReply,
  type ImportReply,
  type LoadedFrom,
  type SaveReason,
  type SaveStatus,
  type WorkerSaveTransport,
} from "./channel";
import { cityFileName, cityNameFromFile, uniqueCityName } from "./city-file";
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
  /** Makes the id of an imported city. */
  makeId?: () => string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (!request) return;
      switch (request.type) {
        case "save":
          void this.save(request.reason, request.requestId);
          return;
        case "export":
          void this.exportCity(request.requestId);
          return;
        case "import":
          void this.importCity(request.fileName, new Uint8Array(request.bytes), request.requestId);
          return;
      }
    });
  }

  /** Runs `job` after every earlier save, export and import. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Writes the running city out as file bytes for the page to download, and
   * records the time so the reminder can wait. The snapshot is taken when
   * this is called. A download still works when local saves do not, since
   * then it is the only copy the player can keep.
   */
  exportCity(requestId: number): Promise<void> {
    const { host, city } = this.options;
    const tick = host.tick;
    let bytes: Uint8Array;
    try {
      bytes = host.snapshotBytes();
    } catch (error) {
      this.reply({ channel: SAVES_CHANNEL, type: "exported", requestId, result: { ok: false, error: `The city could not be written out: ${message(error)}` } });
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const { store, wallClock } = this.options;
      if (store) {
        try {
          await store.touch(city.id, { exportedAt: wallClock() });
          await this.refreshList();
        } catch {
          // The time is only for the reminder; the file is what matters.
        }
      }
      const buffer = bytes.slice().buffer;
      this.reply(
        { channel: SAVES_CHANNEL, type: "exported", requestId, result: { ok: true, fileName: cityFileName(city.name), tick, bytes: buffer } },
        [buffer],
      );
      this.send(null);
    });
  }

  /**
   * Checks a city file and stores it as a new city under a new id, marked to
   * open next. A file that is not a good city is refused and nothing is
   * written. The running city is left as it is.
   */
  importCity(fileName: string, bytes: Uint8Array, requestId: number): Promise<void> {
    return this.enqueue(async () => {
      const { store, storeError, wallClock } = this.options;
      const refuse = (error: string): void =>
        this.reply({ channel: SAVES_CHANNEL, type: "imported", requestId, result: { ok: false, error } });
      const cannot = `Could not import "${fileName}".`;
      let snapshot: Snapshot;
      try {
        // Decode the whole file, not just the header, so nothing that cannot
        // be opened is ever stored.
        snapshot = deserialize(bytes);
      } catch (error) {
        refuse(`${cannot} ${error instanceof SnapshotError ? error.message.replace(/^This save/, "This file") : `It could not be read: ${message(error)}.`}`);
        return;
      }
      if (!store) {
        refuse(`${cannot} ${storeError ?? "Saving is not available in this browser"}.`);
        return;
      }
      try {
        const taken = (await store.list()).map((c) => c.name);
        const now = wallClock();
        const city = {
          id: (this.options.makeId ?? (() => crypto.randomUUID()))(),
          name: uniqueCityName(cityNameFromFile(fileName), taken),
          seed: snapshot.state.seed,
          tick: snapshot.state.tick,
          savedAt: now,
          createdAt: now,
          openedAt: now,
          // The player has this city as a file already.
          exportedAt: now,
        };
        await store.add(city, bytes);
        await this.refreshList();
        this.reply({ channel: SAVES_CHANNEL, type: "imported", requestId, result: { ok: true, city } });
        this.send(null);
      } catch (error) {
        refuse(`${cannot} It could not be stored: ${message(error)}.`);
      }
    });
  }

  /**
   * Runs once the city is hosted. A new city is saved at once so it is in
   * the list from the start. The city is then marked as the one to open next
   * time, so a save of another city from a tab closing elsewhere, such as
   * the tab that just imported this one, does not take its place.
   */
  async start(): Promise<void> {
    const { store, loadedFrom, city, wallClock } = this.options;
    if (loadedFrom === "new city" && store) await this.save("new city");
    await store?.touch(city.id, { openedAt: wallClock() }).catch(() => undefined);
    await this.announce();
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
    return this.enqueue(() => this.write(reason, tick, bytes, snapshotError, requestId));
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

  private reply(message: ExportReply | ImportReply, transfer: Transferable[] = []): void {
    this.options.transport.send(message, transfer);
  }
}
