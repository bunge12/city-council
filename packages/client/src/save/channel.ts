// Messages between the page and the save code in the worker. This is local
// hosting, not the sim protocol: in multiplayer the server saves on its own.
// The messages share the worker's port with the sim protocol and are told
// apart by `channel`.

import type { CityMeta } from "./store";
import type { SimTransport } from "../protocol/transport";

export const SAVES_CHANNEL = "saves";

/** What prompted a save. */
export type SaveReason = "manual" | "autosave" | "hidden" | "new city" | "switching city";

/** Where the running city came from when the worker started. */
export type LoadedFrom = "latest save" | "previous save" | "new city";

/** The page's view of saving, sent by the worker after every change. */
export interface SaveStatus {
  /** The running city, or when `openElsewhere` is true the city this tab could not run. */
  city: { id: string; name: string; seed: number };
  /**
   * True when another tab is running `city`, so this tab runs nothing: no
   * sim, no saves. The player can start or open a different city here.
   */
  openElsewhere: boolean;
  loadedFrom: LoadedFrom;
  /** Tick the city resumed at. */
  loadedTick: number;
  /** The most recent save that was written, if any. */
  lastSave: { tick: number; savedAt: number; reason: SaveReason } | null;
  /**
   * Something the player should know about loading, such as a damaged or
   * too-new save that was left alone. Null when all went well.
   */
  problem: string | null;
  /** Why the most recent save failed, or null if it worked. */
  saveError: string | null;
  /** Every saved city, most recently saved first. */
  cities: CityMeta[];
}

/** Page to worker: save the running city now. */
export interface SaveRequest {
  channel: typeof SAVES_CHANNEL;
  type: "save";
  reason: SaveReason;
  /** Echoed in the status that follows the save, so the page can wait for it. */
  requestId: number;
}

/** Page to worker: write the running city out as file bytes. */
export interface ExportRequest {
  channel: typeof SAVES_CHANNEL;
  type: "export";
  requestId: number;
}

/**
 * Page to worker: check a city file and store it as a new city, then mark it
 * to be opened next. Nothing is stored if the file is not a good city.
 */
export interface ImportRequest {
  channel: typeof SAVES_CHANNEL;
  type: "import";
  requestId: number;
  /** The name of the file the player picked; the city is named after it. */
  fileName: string;
  bytes: ArrayBuffer;
}

/**
 * Page to worker: store a new city made from `seed` and mark it to be opened
 * next. The running city is saved first.
 */
export interface NewCityRequest {
  channel: typeof SAVES_CHANNEL;
  type: "new";
  requestId: number;
  /** The name to give it; made unique if a city already has it. */
  name: string;
  seed: number;
}

/**
 * Page to worker: mark the saved city `id` to be opened next. The running
 * city is saved first.
 */
export interface OpenCityRequest {
  channel: typeof SAVES_CHANNEL;
  type: "open";
  requestId: number;
  id: string;
}

/**
 * Page to worker, once, when the page was opened with a city file's address
 * (`?load=`): the file, for the worker to store and open in place of the
 * city it would otherwise open, so the page does not reload into it. `bytes`
 * is null when the page could not fetch the file, and `error` says why. A
 * worker started with `workerName(_, true)` waits for this before it opens
 * any city.
 */
export interface LoadFileMessage {
  channel: typeof SAVES_CHANNEL;
  type: "load";
  fileName: string;
  bytes: ArrayBuffer | null;
  error: string | null;
}

/** Checks a `LoadFileMessage`. */
export function parseLoadFile(raw: unknown): LoadFileMessage | null {
  if (!isSaveMessage(raw)) return null;
  const message = raw as Record<string, unknown>;
  const { type, fileName, bytes, error } = message;
  if (type !== "load" || typeof fileName !== "string") return null;
  if (!(bytes === null || bytes instanceof ArrayBuffer) || !(error === null || typeof error === "string")) return null;
  return { channel: SAVES_CHANNEL, type: "load", fileName, bytes, error };
}

export type ToSaver = SaveRequest | ExportRequest | ImportRequest | NewCityRequest | OpenCityRequest;

/** Worker to page. */
export interface StatusMessage {
  channel: typeof SAVES_CHANNEL;
  type: "status";
  status: SaveStatus;
  /** Set when this status answers a `SaveRequest`. */
  requestId: number | null;
}

/** Worker to page: the answer to an `ExportRequest`. */
export interface ExportReply {
  channel: typeof SAVES_CHANNEL;
  type: "exported";
  requestId: number;
  result: { ok: true; fileName: string; tick: number; bytes: ArrayBuffer } | { ok: false; error: string };
}

/** Worker to page: the answer to an `ImportRequest`. */
export interface ImportReply {
  channel: typeof SAVES_CHANNEL;
  type: "imported";
  requestId: number;
  result: { ok: true; city: CityMeta } | { ok: false; error: string };
}

/**
 * Worker to page: the answer to a `NewCityRequest` or `OpenCityRequest`. On
 * success the page reloads, and the worker then opens `city`.
 */
export interface SwitchReply {
  channel: typeof SAVES_CHANNEL;
  type: "switched";
  requestId: number;
  result: { ok: true; city: CityMeta } | { ok: false; error: string };
}

/**
 * Worker to page: the seed of the city the worker is opening, sent before
 * the worker generates its terrain. Terrain is rebuilt from the seed on each
 * side, so the page starts its own copy now instead of after the snapshot,
 * and the two run at once (#203). A new city that replaces a save that
 * could not be opened sends a second one.
 */
export interface OpeningMessage {
  channel: typeof SAVES_CHANNEL;
  type: "opening";
  seed: number;
  requestId: null;
}

export type FromSaver = StatusMessage | ExportReply | ImportReply | SwitchReply | OpeningMessage;

export type PageSaveTransport = SimTransport<ToSaver | LoadFileMessage, FromSaver>;
export type WorkerSaveTransport = SimTransport<FromSaver, unknown>;

export function isSaveMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { channel?: unknown }).channel === SAVES_CHANNEL;
}

/** Checks a message the worker received on the saves channel. */
export function parseSaveRequest(raw: unknown): ToSaver | null {
  if (!isSaveMessage(raw)) return null;
  const message = raw as Record<string, unknown>;
  const requestId = message["requestId"];
  if (typeof requestId !== "number") return null;
  switch (message["type"]) {
    case "save": {
      const reasons: readonly unknown[] = ["manual", "autosave", "hidden", "new city", "switching city"];
      if (!reasons.includes(message["reason"])) return null;
      return { channel: SAVES_CHANNEL, type: "save", reason: message["reason"] as SaveReason, requestId };
    }
    case "export":
      return { channel: SAVES_CHANNEL, type: "export", requestId };
    case "import": {
      const { fileName, bytes } = message;
      if (typeof fileName !== "string" || !(bytes instanceof ArrayBuffer)) return null;
      return { channel: SAVES_CHANNEL, type: "import", requestId, fileName, bytes };
    }
    case "new": {
      const { name, seed } = message;
      if (typeof name !== "string" || typeof seed !== "number") return null;
      return { channel: SAVES_CHANNEL, type: "new", requestId, name, seed };
    }
    case "open": {
      const { id } = message;
      if (typeof id !== "string") return null;
      return { channel: SAVES_CHANNEL, type: "open", requestId, id };
    }
    default:
      return null;
  }
}
