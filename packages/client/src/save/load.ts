// Picks the city the worker starts with: the one most recently opened,
// imported or saved, or a new city when there is none or it cannot be opened. A save that cannot be
// opened is never written over.

import { SnapshotError, createState, deserialize, type LogEntry, type SimState } from "@city-council/sim";
import { NEW_CITY_NAME, NEW_CITY_SEED } from "./config";
import type { LoadedFrom } from "./channel";
import { lastOpened, type CityMeta, type CityStore } from "./store";

export interface OpenedCity {
  id: string;
  name: string;
  state: SimState;
  pagedLog: LogEntry[];
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

async function openCity(store: CityStore, meta: CityMeta, makeId: () => string): Promise<OpenedCity> {
  const left = `"${meta.name}" was left as it is, and a new city was started.`;
  const snapshots = await store.read(meta.id);
  if (!snapshots) return newCityFallback(`The save of "${meta.name}" is missing. ${left}`, makeId);
  const opened = (snapshot: ReturnType<typeof deserialize>, from: LoadedFrom, problem: string | null) => ({
    id: meta.id,
    name: meta.name,
    state: snapshot.state,
    pagedLog: snapshot.pagedLog,
    from,
    problem,
  });
  try {
    return opened(deserialize(snapshots.latest), "latest save", null);
  } catch (error) {
    if (error instanceof SnapshotError && error.code === "newer-version") {
      return newCityFallback(`Could not open "${meta.name}". ${error.message} ${left}`, makeId);
    }
    const latestProblem = reason(error);
    if (snapshots.previous) {
      try {
        const previous = deserialize(snapshots.previous);
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
