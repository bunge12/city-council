// The browser storage each test starts with, set per project in
// playwright.config.ts and overridden by a spec with `test.use({ storageState })`.
//
// Every test starts in a browser that already keeps the Low graphics preset
// (issue M2-02), as if the player had chosen it. Otherwise each test's fresh
// browser would run the first-run benchmark, which on a runner without a GPU
// takes seconds of drawing. Tests of the presets and the benchmark clear it.
//
// The chromium project also turns on the test switch
// (packages/client/src/test-switch.ts, issue #226): cheap frames and no
// autosave on an interval. The perf and evidence projects draw every frame
// at the real settings, with no autosave. The roads and walkthrough projects
// draw as a player's page does: roads compares WebGPU with WebGL 2 pixel for
// pixel.

import { TEST_SWITCH_KEY, type TestSwitch } from "../packages/client/src/test-switch";

const ORIGINS = ["http://localhost:5173", "http://localhost:4173"];
const lowPreset = JSON.stringify({ preset: "low", source: "player", benchmarkMs: null, benchmarkBackend: null });

/**
 * The public address's origin when the walkthroughs run against it
 * (BASE_URL, playwright.config.ts), or null. Only the M2 walkthrough's state
 * adds it: the M0 and M1 walkthroughs load the public page as a first-time
 * player does (issue #283).
 */
const remoteBase = process.env["BASE_URL"];
const REMOTE_ORIGIN = remoteBase ? new URL(remoteBase).origin : null;

function state(testSwitch: TestSwitch | null, origins: readonly string[] = ORIGINS) {
  return {
    cookies: [],
    origins: origins.map((origin) => ({
      origin,
      localStorage: [{ name: "city-council:graphics", value: lowPreset }, ...(testSwitch ? [{ name: TEST_SWITCH_KEY, value: JSON.stringify(testSwitch) }] : [])],
    })),
  };
}

/** The Low preset kept, and the page as a player has it. */
export const PLAYER_STATE = state(null);

/** The chromium project's default: cheap frames, and saves only when a test asks. */
export const TEST_STATE = state({ cheapFrames: true, autosave: false, heldDemand: null });

/**
 * For the perf and evidence projects, and a chromium spec that times the
 * page's work: every frame drawn, antialiased, at the real pixel ratio, so
 * figures compare with earlier runs and pictures look as a player sees them.
 * Autosave stays off, so a save does not land in a measurement.
 */
export const MEASURE_STATE = state({ cheapFrames: false, autosave: false, heldDemand: null });

/** For a spec about saving: cheap frames, and the worker's autosave on as a player has it. */
export const SAVING_STATE = state({ cheapFrames: true, autosave: true, heldDemand: null });

/** The bar the M2 walkthrough holds every demand bar at (M3-07). */
export const WALKTHROUGH_DEMAND = 25;

/**
 * For the M2 walkthrough (M3-07): the page as a player has it, but with
 * every demand bar held at `WALKTHROUGH_DEMAND`, so all five zones grow on
 * an empty city, houses slowly enough to be seen coming one by one. Against
 * a public BASE_URL its origin gets the switch too, or the bars follow the
 * empty city and step 4 waits in vain for shops and factories (issue #283).
 */
export const HELD_DEMAND_STATE = state(
  { cheapFrames: false, autosave: true, heldDemand: WALKTHROUGH_DEMAND },
  REMOTE_ORIGIN === null ? ORIGINS : [...ORIGINS, REMOTE_ORIGIN],
);
