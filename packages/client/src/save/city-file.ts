// City files: a snapshot in a file the player keeps, named after the city.
// The bytes are exactly what `serialize` writes, the same as a local save.

import { SnapshotError, deserialize, type Snapshot } from "@city-council/sim";
import { CITY_FILE_EXTENSION } from "./config";
import type { CityMeta, CityStore } from "./store";

/** Characters that are not allowed in a file name on at least one common system. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/** The file name a city downloads under, such as `Riverside.city`. */
export function cityFileName(name: string): string {
  const safe = name.replace(UNSAFE, "-").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  return `${safe || "city"}${CITY_FILE_EXTENSION}`;
}

/** The city name an imported file gets: its file name without the extension. */
export function cityNameFromFile(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const lower = base.toLowerCase();
  const name = lower.endsWith(CITY_FILE_EXTENSION) ? base.slice(0, -CITY_FILE_EXTENSION.length) : base;
  return name.trim() || "Imported city";
}

/**
 * `name`, or `name 2`, `name 3` and so on if a city already has it, so the
 * same file imported twice shows up as two cities that can be told apart.
 */
export function uniqueCityName(name: string, taken: readonly string[]): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * Whether to suggest downloading a copy of `city`: true when it has not been
 * downloaded for `intervalMs`, counted from its first save if it never has.
 * A city with neither time, as saves from before city files have until their
 * next save, gets no reminder yet.
 */
export function wantsExportReminder(city: CityMeta, now: number, intervalMs: number): boolean {
  const since = city.exportedAt ?? city.createdAt;
  return since !== undefined && now - since >= intervalMs;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks city file `bytes` and stores it as a new city under a new id,
 * named after `fileName` and marked as opened at `now`, so it opens next. A
 * file that is not a good city is refused with the reason, and nothing is
 * written. `storeError` says why `store` is null, when it is.
 */
export async function storeCityFile(
  store: CityStore | null,
  storeError: string | undefined,
  fileName: string,
  bytes: Uint8Array,
  now: number,
  makeId: () => string = () => crypto.randomUUID(),
): Promise<{ ok: true; city: CityMeta } | { ok: false; error: string }> {
  const cannot = `Could not import "${fileName}".`;
  let snapshot: Snapshot;
  try {
    // Decode the whole file, not just the header, so nothing that cannot
    // be opened is ever stored.
    snapshot = deserialize(bytes);
  } catch (error) {
    const why = error instanceof SnapshotError ? error.message.replace(/^This save/, "This file") : `It could not be read: ${message(error)}.`;
    return { ok: false, error: `${cannot} ${why}` };
  }
  if (!store) return { ok: false, error: `${cannot} ${storeError ?? "Saving is not available in this browser"}.` };
  try {
    const taken = (await store.list()).map((c) => c.name);
    const city: CityMeta = {
      id: makeId(),
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
    return { ok: true, city };
  } catch (error) {
    return { ok: false, error: `${cannot} It could not be stored: ${message(error)}.` };
  }
}
