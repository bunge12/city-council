// One tab per city. Each tab runs its own worker with its own copy of the
// sim, so two tabs on one city would each save over the other and the city
// would lose whatever the tab that saved first had done. The worker takes a
// Web Lock named after the city before it hosts it, and holds it for as long
// as it lives. The browser frees the lock when the tab closes or reloads.
//
// This is single player only. A shared city has one sim on a server and any
// number of tabs may join it.

/** Lock name for city `id`. */
export function cityLockName(id: string): string {
  return `city-council:city:${id}`;
}

/**
 * How long to wait for the lock before deciding another tab has the city.
 * A reload starts the new worker while the old one is still going away, so
 * the lock can be held for a moment by a worker that is already dead.
 */
export const CITY_LOCK_WAIT_MS = 1500;

/** The part of `navigator.locks` used here. */
export interface LockManagerLike {
  request(name: string, options: { signal: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Takes the lock for city `id` and keeps it for the life of this worker.
 * Resolves true once it is held, or false if another tab still holds it
 * after `waitMs`. A browser without Web Locks cannot guard, so it resolves
 * true and the city runs unguarded, as it did before.
 */
export function claimCity(id: string, locks: LockManagerLike | undefined, waitMs = CITY_LOCK_WAIT_MS): Promise<boolean> {
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), waitMs);
    locks
      .request(cityLockName(id), { signal: abort.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        // Never settles: the lock is held until the worker goes away.
        return new Promise<never>(() => undefined);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        // Giving up the wait means someone else has the city. Any other
        // failure means locks do not work here, so there is no guard.
        resolve(!(error instanceof Error && error.name === "AbortError"));
      });
  });
}

/** Prefix of the worker's name when the page asks for a city. */
const WORKER_NAME = "sim";
/** Prefix of the worker's name when the page will send it a city file to open (`LoadFileMessage`). */
const LOAD_WORKER_NAME = "sim+load";

/**
 * The name the page gives the worker, carrying the city this tab last ran,
 * if any. `loadsFile` says the page will send a city file to open first.
 */
export function workerName(cityId: string | null, loadsFile = false): string {
  const prefix = loadsFile ? LOAD_WORKER_NAME : WORKER_NAME;
  return cityId ? `${prefix}:${cityId}` : prefix;
}

/** The city id in a worker name made by `workerName`, or null. */
export function cityFromWorkerName(name: string): string | null {
  for (const prefix of [WORKER_NAME, LOAD_WORKER_NAME]) {
    if (name.startsWith(`${prefix}:`)) return name.slice(prefix.length + 1) || null;
  }
  return null;
}

/** Whether a worker name made by `workerName` says a city file is on its way. */
export function loadsFileFromWorkerName(name: string): boolean {
  return name === LOAD_WORKER_NAME || name.startsWith(`${LOAD_WORKER_NAME}:`);
}
