# M0-08: Snapshot format, save and load

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 04.

## Goal

A city survives a page reload, and the format can change later without breaking old saves.

## Scope

- A snapshot format: a small header with magic bytes, format version, sim version, seed and tick, followed by named typed array sections
- `serialize(state)` and `deserialize(bytes)` in `sim`, used unchanged for local saves, city files and later for sending a city to a joining player
- A migration registry keyed by version, with a no-op first entry and a test that loads a committed version 1 fixture
- IndexedDB storage in the client with a list of cities, each with a name, seed, tick and last-saved time
- Autosave on an interval and when the tab is hidden, plus a manual save
- A call to `navigator.storage.persist()` and a visible note when the browser declines
- On load, terrain is regenerated from the seed and the state resumes at the saved tick

## Out of scope

- Compression beyond what is trivial to add
- Cloud saves and accounts

## Done when

- [x] Round trip test: serialize then deserialize gives a state with the same hash
- [x] Playwright test: run for a few seconds, reload, and the tick resumes from the saved value with the activity log intact
- [x] A snapshot with an unknown newer version is refused with a clear message and does not overwrite anything
- [x] A corrupted snapshot is detected and reported, and the previous good save is kept
- [x] Follow-up from issue 03: the activity log (`log`, `logOffset`) and the entries the host has read out of live state survive a round trip, and the full log still replays to the saved hash

Issue 03 already bumped `SNAPSHOT_VERSION` to 2 and added `migrateState` in `packages/sim/src/migrate.ts` with a version 1 to 2 step. Build the migration registry on that.
