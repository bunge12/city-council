// Messages between the page and the save code in the worker. This is local
// hosting, not the sim protocol: in multiplayer the server saves on its own.
// The messages share the worker's port with the sim protocol and are told
// apart by `channel`.

import type { CityMeta } from "./store";
import type { SimTransport } from "../protocol/transport";

export const SAVES_CHANNEL = "saves";

/** What prompted a save. */
export type SaveReason = "manual" | "autosave" | "hidden" | "new city";

/** Where the running city came from when the worker started. */
export type LoadedFrom = "latest save" | "previous save" | "new city";

/** The page's view of saving, sent by the worker after every change. */
export interface SaveStatus {
  /** The running city. */
  city: { id: string; name: string; seed: number };
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

export type ToSaver = SaveRequest;

/** Worker to page. */
export interface StatusMessage {
  channel: typeof SAVES_CHANNEL;
  type: "status";
  status: SaveStatus;
  /** Set when this status answers a `SaveRequest`. */
  requestId: number | null;
}

export type FromSaver = StatusMessage;

export type PageSaveTransport = SimTransport<ToSaver, FromSaver>;
export type WorkerSaveTransport = SimTransport<FromSaver, unknown>;

export function isSaveMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { channel?: unknown }).channel === SAVES_CHANNEL;
}

/** Checks a message the worker received on the saves channel. */
export function parseSaveRequest(raw: unknown): SaveRequest | null {
  if (!isSaveMessage(raw)) return null;
  const message = raw as Record<string, unknown>;
  const reasons: readonly unknown[] = ["manual", "autosave", "hidden", "new city"];
  if (message["type"] !== "save" || !reasons.includes(message["reason"])) return null;
  const requestId = message["requestId"];
  if (typeof requestId !== "number") return null;
  return { channel: SAVES_CHANNEL, type: "save", reason: message["reason"] as SaveReason, requestId };
}
