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

/** Prefix of the worker's name. */
const WORKER_NAME = "sim";
/** Flag in the worker's name when the page will send it a city file to open (`LoadFileMessage`). */
const LOAD_FLAG = "load";
/** Flag in the worker's name when the test switch turns autosave off (issue #226). */
const NO_AUTOSAVE_FLAG = "noautosave";
/** Flag in the worker's name, with `=` and a value, when a test holds the demand bars (M3-07). */
const DEMAND_FLAG = "demand";

/** What the page tells the worker in its name, before any message can reach it. */
export interface WorkerStart {
  /** The city this tab last ran, if any. */
  cityId: string | null;
  /** Whether the page will send a city file to open first. */
  loadsFile: boolean;
  /** Whether the worker saves on its interval. Off only under the test switch. */
  autosave: boolean;
  /** The value a test holds every demand bar at, from the test switch's `heldDemand`, or null for none (M3-07). */
  heldDemand: number | null;
}

/**
 * The name the page gives the worker: `sim`, then `+load`, `+noautosave`
 * and `+demand=` with the held value as they apply, then `:` and the city
 * this tab last ran, if any.
 */
export function workerName(cityId: string | null, loadsFile = false, autosave = true, heldDemand: number | null = null): string {
  const prefix =
    WORKER_NAME + (loadsFile ? `+${LOAD_FLAG}` : "") + (autosave ? "" : `+${NO_AUTOSAVE_FLAG}`) + (heldDemand === null ? "" : `+${DEMAND_FLAG}=${heldDemand}`);
  return cityId ? `${prefix}:${cityId}` : prefix;
}

/** What a worker name made by `workerName` carries. Any other name asks for no city and no file, with autosave on. */
export function startFromWorkerName(name: string): WorkerStart {
  const colon = name.indexOf(":");
  const prefix = colon < 0 ? name : name.slice(0, colon);
  const [base, ...flags] = prefix.split("+");
  if (base !== WORKER_NAME) return { cityId: null, loadsFile: false, autosave: true, heldDemand: null };
  const demand = flags.find((flag) => flag.startsWith(`${DEMAND_FLAG}=`));
  return {
    cityId: colon < 0 ? null : name.slice(colon + 1) || null,
    loadsFile: flags.includes(LOAD_FLAG),
    autosave: !flags.includes(NO_AUTOSAVE_FLAG),
    heldDemand: demand === undefined ? null : heldDemandValue(demand.slice(DEMAND_FLAG.length + 1)),
  };
}

/** A held demand value from text, or null unless it is a number from -100 to 100. */
export function heldDemandValue(text: string | null): number | null {
  if (text === null || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= -100 && value <= 100 ? value : null;
}

/** The city id in a worker name made by `workerName`, or null. */
export function cityFromWorkerName(name: string): string | null {
  return startFromWorkerName(name).cityId;
}

/** Whether a worker name made by `workerName` says a city file is on its way. */
export function loadsFileFromWorkerName(name: string): boolean {
  return startFromWorkerName(name).loadsFile;
}
