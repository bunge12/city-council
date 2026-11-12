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
import type { LoadedFrom } from "./channel";
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

/** A new city under a fresh id, with a message saying why if there is one. */
export function newCityFallback(problem: string | null, makeId: () => string = randomId): OpenedCity {
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
 */
export async function openLatestCity(
  store: CityStore,
  makeId: () => string = randomId,
): Promise<OpenedCity> {
  const cities = await store.list();
  // Ties go to the most recently saved, which `list` puts first.
  const meta = cities.reduce<CityMeta | undefined>((best, c) => (!best || lastOpened(c) > lastOpened(best) ? c : best), undefined);
  if (!meta) return newCityFallback(null, makeId);
  return openCity(store, meta, makeId);
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

async function openCity(store: CityStore, meta: CityMeta, makeId: () => string): Promise<OpenedCity> {
  const left = `"${meta.name}" was left as it is, and a new city was started.`;
  const snapshots = await store.read(meta.id);
  if (!snapshots) return newCityFallback(`The save of "${meta.name}" is missing. ${left}`, makeId);
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
      return newCityFallback(`Could not open "${meta.name}". ${error.message} ${left}`, makeId);
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
        );
      }
    }
    return newCityFallback(`Could not open "${meta.name}". ${latestProblem} ${left}`, makeId);
  }
}
