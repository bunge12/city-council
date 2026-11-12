// Settings for local saves. Host behaviour, not game balance, so they live
// with the client rather than in packages/sim/balance.

/** Real milliseconds between autosaves while the tab is open. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** IndexedDB database that holds saved cities. */
export const SAVE_DB_NAME = "city-council";

/** Seed and name for the city made when there is nothing to load. */
export const NEW_CITY_SEED = 1;
export const NEW_CITY_NAME = "New city";

/**
 * Real milliseconds a city can go without being downloaded as a file before
 * the page suggests downloading a copy. Counted from the last download, or
 * from when the city was first stored if it never has been.
 */
export const EXPORT_REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

/** Extension of a city file. */
export const CITY_FILE_EXTENSION = ".city";
