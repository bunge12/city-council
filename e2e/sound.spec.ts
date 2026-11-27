import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { cityReady, frames, hideNotes, openCity, openSettings } from "./helpers";

// Issue M3-02: interface sounds. A player places a road, paints a zone,
// bulldozes, undoes and sends a command the sim refuses, and the engine's
// test hook reports one cue for each, in order, each played once the sim's
// answer came back. Then the interface volume goes to zero, survives a
// reload, and a cue asked for after it is not scheduled.
//
// Headless Chromium has an audio context but nothing listens, so the test
// reads the hook (window.cityCouncil.sound) rather than the speakers.

type Vec3 = readonly [number, number, number];
interface CueRecord {
  cue: string;
  outcome: string;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string }[]; logSpent: number[]; cells: { zone: ArrayLike<number> } } | null };
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    sound: { cues(): CueRecord[]; clear(): void; unlocked(): boolean };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      pickSegmentAt(sx: number, sy: number): number;
    }>;
  };
  localStorage: { getItem(key: string): string | null };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);
/** Screenshots and the hook's output also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["SOUND_EVIDENCE_DIR"];

/** A north-south street at x = 4350 from z = 4500 to 4700. */
function startCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4350, 4500], [4350, 4700], "street"]]);
  return state;
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * 0.75],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  const h = heightAt(terrain, x, z);
  const p = await page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

/**
 * The cues the newest command makes: its own, then "money" when it took
 * money from the treasury (M4-14), as its log entry's amount says.
 */
async function heardFor(page: Page, cue: string): Promise<string[]> {
  const spent = await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1) ?? 0);
  return spent > 0 ? [cue, "money"] : [cue];
}

async function cues(page: Page): Promise<CueRecord[]> {
  return page.evaluate(() => window.cityCouncil.sound.cues());
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const shot = await page.screenshot();
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, shot);
  }
}

function keepEvidence(name: string, value: unknown): void {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(`${EVIDENCE}/${name}`, JSON.stringify(value, null, 2));
}

test("each tool makes its cue when the sim answers, and a zero interface volume is kept across a reload", async ({ page }, testInfo) => {
  await openCity(page, startCity(), { name: "Sound" });
  await look(page, 4350, 4600, 260);

  // Nothing has been clicked yet, so the engine has not started.
  expect(await page.evaluate(() => window.cityCouncil.sound.unlocked())).toBe(false);
  // Pausing is the first click. It starts audio, and a change of speed makes no cue.
  await page.getByRole("button", { name: "Pause" }).click();
  expect(await page.evaluate(() => window.cityCouncil.sound.unlocked())).toBe(true);
  await expect.poll(() => cues(page)).toEqual([]);

  // A road.
  const start = await logLength(page);
  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyZ");
  await click(page, 4220, 4600);
  await click(page, 4480, 4600);
  await expect.poll(() => logLength(page)).toBe(start + 1);
  await page.keyboard.press("KeyR");
  const heard = await heardFor(page, "road");
  // A street costs money.
  expect(heard).toEqual(["road", "money"]);
  await expect.poll(async () => (await cues(page)).map((c) => c.cue)).toEqual(heard);

  // A zone, painted with the tool's defaults along the north side of the east piece.
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
  await click(page, 4415, 4596);
  await expect.poll(() => logLength(page)).toBe(start + 2);
  await page.keyboard.press("KeyK");
  // Zoning is free.
  heard.push(...(await heardFor(page, "zone")));
  expect(heard.at(-1)).toBe("zone");
  await expect.poll(async () => (await cues(page)).map((c) => c.cue)).toEqual(heard);

  // A bulldoze of the east piece. Shift takes the whole piece.
  await page.keyboard.press("KeyB");
  await page.keyboard.down("Shift");
  await click(page, 4415, 4600);
  await page.keyboard.up("Shift");
  await expect.poll(() => logLength(page)).toBe(start + 3);
  await page.keyboard.press("KeyB");
  heard.push(...(await heardFor(page, "bulldoze")));
  await expect.poll(async () => (await cues(page)).map((c) => c.cue)).toEqual(heard);

  // An undo.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(() => logLength(page)).toBe(start + 4);
  heard.push(...(await heardFor(page, "undo")));
  await expect.poll(async () => (await cues(page)).map((c) => c.cue)).toEqual(heard);

  // A command the sim refuses: a road with no points. It sounds like a refusal, not a road.
  const refused = await page.evaluate(() => window.cityCouncil.sendCommand("BuildRoad", {}));
  expect(refused.ok).toBe(false);
  expect(await logLength(page)).toBe(start + 4);
  const played = await cues(page);
  expect(played).toEqual([...heard, "reject"].map((cue) => ({ cue, outcome: "played" })));
  keepEvidence("cues-before-reload.json", played);

  // The sound settings, in the settings menu under the top bar's Settings button.
  await openSettings(page);
  await expect(page.locator("#sound-interface")).toBeVisible();
  await expect(page.locator("#sound-interface")).toHaveValue("50");
  await expect(page.locator("#sound-ambience")).toHaveValue("50");
  await expect(page.locator("#sound-mute")).not.toBeChecked();
  await attach(page, testInfo, "1 the sound settings at their defaults");

  // Interface volume to zero. It is kept in this browser.
  await page.locator("#sound-interface").fill("0");
  await expect(page.locator("#sound-interface")).toHaveValue("0");
  const kept = await page.evaluate(() => window.localStorage.getItem("city-council:sound"));
  expect(JSON.parse(kept ?? "null")).toEqual({ interface: 0, ambience: 0.5, muted: false });
  await attach(page, testInfo, "2 interface volume at zero");

  // Reload: the setting comes back.
  await page.reload();
  await cityReady(page);
  await hideNotes(page);
  await openSettings(page);
  await expect(page.locator("#sound-interface")).toHaveValue("0");
  await expect(page.locator("#sound-ambience")).toHaveValue("50");
  await attach(page, testInfo, "3 after a reload the interface volume is still zero");

  // The click on the settings started audio. A refusal now asks for its cue, and nothing is scheduled.
  expect(await page.evaluate(() => window.cityCouncil.sound.unlocked())).toBe(true);
  const again = await page.evaluate(() => window.cityCouncil.sendCommand("BuildRoad", {}));
  expect(again.ok).toBe(false);
  const after = await cues(page);
  expect(after).toEqual([{ cue: "reject", outcome: "silent" }]);
  keepEvidence("cues-after-reload.json", after);

  // Mute is kept too.
  await page.locator("#sound-mute").check();
  await expect(page.locator("#sound-mute")).toBeChecked();
  const muted = await page.evaluate(() => window.localStorage.getItem("city-council:sound"));
  expect(JSON.parse(muted ?? "null")).toEqual({ interface: 0, ambience: 0.5, muted: true });
});
