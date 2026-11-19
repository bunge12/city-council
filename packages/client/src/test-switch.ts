// The test-only switch (issue #226). Playwright's chromium project turns it
// on through the browser storage each test starts with (see
// e2e/browser-state.ts). A player never has the key, so a player's page
// draws and saves as it always has.
//
// - `cheapFrames`: no antialiasing, a pixel ratio of 1, and a frame drawn
//   only when something on screen changed or is animating. Every frame in
//   CI is drawn in software, where a frame costs 0.4 to 0.8 s.
// - `autosave`: the worker's autosave on its 30 s interval. Off, the city is
//   saved only when the page asks, so a save does not land in the middle of
//   a frame or memory measurement.

/** The localStorage key that holds the switch, as JSON. */
export const TEST_SWITCH_KEY = "city-council:test";

export interface TestSwitch {
  cheapFrames: boolean;
  autosave: boolean;
}

/** What a player gets: every frame drawn at the real settings, and autosave on. */
export const PLAYER_SETTINGS: TestSwitch = { cheapFrames: false, autosave: true };

/** The switch stored in `storage`, with each missing or unreadable field as a player has it. */
export function readTestSwitch(storage: Pick<Storage, "getItem"> | null): TestSwitch {
  let raw: string | null;
  try {
    raw = storage?.getItem(TEST_SWITCH_KEY) ?? null;
  } catch {
    return PLAYER_SETTINGS;
  }
  if (raw === null) return PLAYER_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PLAYER_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null) return PLAYER_SETTINGS;
  const value = parsed as Partial<Record<keyof TestSwitch, unknown>>;
  return {
    cheapFrames: typeof value.cheapFrames === "boolean" ? value.cheapFrames : PLAYER_SETTINGS.cheapFrames,
    autosave: typeof value.autosave === "boolean" ? value.autosave : PLAYER_SETTINGS.autosave,
  };
}
