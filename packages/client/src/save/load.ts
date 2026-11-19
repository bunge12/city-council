// Picks the city the worker starts with: the one most recently opened,
// imported or saved, or a new city when there is none or it cannot be opened. A save that cannot be
// opened is never written over.

import {
  LOG_PAGE_SIZE,
  SnapshotError,
  createState,
  deserialize,
  isLogEntry,
  type LogEntry,
  type SimState,
} from "@city-council/sim";
import { NEW_CITY_NAME, NEW_CITY_SEED } from "./config";
import type { LoadFileMessage, LoadedFrom } from "./channel";
import { storeCityFile } from "./city-file";
import { lastOpened, type CityMeta, type CityStore } from "./store";

export interface OpenedCity {
  id: string;
  name: string;
  state: SimState;
  pagedLog: LogEntry[];
  /** Log pages of this city already in the store, which a save need not write again. */
  logPagesStored: number;
  from: LoadedFrom;
  /** A message for the player when loading did not go to plan. */
  problem: string | null;
}

function reason(error: unknown): string {
  if (error instanceof SnapshotError) return error.message;
  return `This save could not be read: ${error instanceof Error ? error.message : String(error)}.`;
}

const randomId = (): string => crypto.randomUUID();

/**
 * Told the seed of the city about to open, before its terrain is generated,
 * so the page can generate its own copy at the same time (#203).
 */
export type OpeningSeed = (seed: number) => void;

/** A new city under a fresh id, with a message saying why if there is one. */
export function newCityFallback(problem: string | null, makeId: () => string = randomId, opening: OpeningSeed = () => undefined): OpenedCity {
  opening(NEW_CITY_SEED);
  return {
    id: makeId(),
    name: NEW_CITY_NAME,
    state: createState(NEW_CITY_SEED),
    pagedLog: [],
    logPagesStored: 0,
    from: "new city",
    problem,
  };
}

/**
 * Opens the city most recently opened or imported, or for saves that never
 * recorded that, the most recently saved one. If its latest snapshot is damaged,
 * falls back to the one before it. If it was written by a newer version of
 * the game, or both snapshots are damaged, it is left as it is and a new
 * city starts under a new id, so nothing overwrites it.
 *
 * `preferredId` is the city this tab ran last. When it is still saved it is
 * opened in place of the most recently opened one, so a reload keeps a tab
 * on its own city whatever other tabs have opened since.
 */
export async function openLatestCity(
  store: CityStore,
  makeId: () => string = randomId,
  preferredId: string | null = null,
  opening: OpeningSeed = () => undefined,
): Promise<OpenedCity> {
  const cities = await store.list();
  const preferred = preferredId === null ? undefined : cities.find((c) => c.id === preferredId);
  if (preferred) return openCity(store, preferred, makeId, opening);
  // Ties go to the most recently saved, which `list` puts first.
  const meta = cities.reduce<CityMeta | undefined>((best, c) => (!best || lastOpened(c) > lastOpened(best) ? c : best), undefined);
  if (!meta) return newCityFallback(null, makeId, opening);
  return openCity(store, meta, makeId, opening);
}

/**
 * Stores the city file the page fetched from its `?load=` address as a new
 * city and opens it, as an import does but without the reload. A file that
 * could not be fetched or is not a good city is reported in `problem`, and
 * the city the worker would have opened opens instead.
 */
export async function openLoadedFile(
  store: CityStore,
  file: LoadFileMessage,
  now: number,
  makeId: () => string = randomId,
  preferredId: string | null = null,
  opening: OpeningSeed = () => undefined,
): Promise<OpenedCity> {
  const stored = file.bytes
    ? await storeCityFile(store, undefined, file.fileName, new Uint8Array(file.bytes), now, makeId)
    : { ok: false as const, error: `Could not open "${file.fileName}". ${file.error ?? "It could not be fetched."}` };
  const city = await openLatestCity(store, makeId, stored.ok ? stored.city.id : preferredId, opening);
  if (stored.ok) return city;
  return { ...city, problem: city.problem ? `${stored.error} ${city.problem}` : stored.error };
}

interface Decoded {
  state: SimState;
  pagedLog: LogEntry[];
  logPagesStored: number;
}

/**
 * Decodes stored snapshot bytes and, when the snapshot was saved without
 * its paged log, reads those entries from the city's log pages. A snapshot
 * whose pages are missing or malformed is refused like any damaged save.
 */
async function decode(store: CityStore, id: string, bytes: Uint8Array): Promise<Decoded> {
  const snapshot = deserialize(bytes);
  if (!snapshot.logDetached) return { state: snapshot.state, pagedLog: snapshot.pagedLog, logPagesStored: 0 };
  const { logOffset } = snapshot.state;
  const damaged = (what: string) => new SnapshotError("corrupt", `This save is damaged: ${what}.`);
  if (logOffset % LOG_PAGE_SIZE !== 0) throw damaged("its log offset is not a whole number of pages");
  const count = logOffset / LOG_PAGE_SIZE;
  const pages = await store.readLogPages(id, count);
  if (!pages) throw damaged("part of its activity log is missing");
  const pagedLog: LogEntry[] = [];
  for (const page of pages) {
    if (!Array.isArray(page.entries) || page.entries.length !== LOG_PAGE_SIZE || !page.entries.every(isLogEntry)) {
      throw damaged(`page ${page.index} of its activity log is malformed`);
    }
    for (const entry of page.entries) pagedLog.push(entry);
  }
  return { state: snapshot.state, pagedLog, logPagesStored: count };
}

async function openCity(store: CityStore, meta: CityMeta, makeId: () => string, opening: OpeningSeed): Promise<OpenedCity> {
  // The host generates the terrain once the save is decoded (prepareDerived).
  opening(meta.seed);
  const left = `"${meta.name}" was left as it is, and a new city was started.`;
  const snapshots = await store.read(meta.id);
  if (!snapshots) return newCityFallback(`The save of "${meta.name}" is missing. ${left}`, makeId, opening);
  const opened = (snapshot: Decoded, from: LoadedFrom, problem: string | null) => ({
    id: meta.id,
    name: meta.name,
    ...snapshot,
    from,
    problem,
  });
  try {
    return opened(await decode(store, meta.id, snapshots.latest), "latest save", null);
  } catch (error) {
    if (error instanceof SnapshotError && error.code === "newer-version") {
      return newCityFallback(`Could not open "${meta.name}". ${error.message} ${left}`, makeId, opening);
    }
    const latestProblem = reason(error);
    if (snapshots.previous) {
      try {
        const previous = await decode(store, meta.id, snapshots.previous);
        return opened(
          previous,
          "previous save",
          `The latest save of "${meta.name}" could not be used. ${latestProblem} ` +
            `Loaded the save before it, from tick ${previous.state.tick}.`,
        );
      } catch (previousError) {
        return newCityFallback(
          `Could not open "${meta.name}". ${latestProblem} The save before it could not be used either. ` +
            `${reason(previousError)} ${left}`,
          makeId,
          opening,
        );
      }
    }
    return newCityFallback(`Could not open "${meta.name}". ${latestProblem} ${left}`, makeId, opening);
  }
}
