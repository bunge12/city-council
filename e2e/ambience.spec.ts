import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ZONING_BALANCE, buildingCount, createState, serialize, type SimState } from "../packages/sim/src/index";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { buildEverySide, zoneSides } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M3-19: ambient sound. The wind plays everywhere and grows louder as
// the camera pulls out from the street band to the city band, and stops
// with the ambience volume at zero. Houses going up in view at street zoom
// make construction sounds, which stop once they are finished.
//
// Headless Chromium has an audio context but nothing listens, so the test
// reads the hook (window.cityCouncil.sound.ambience) rather than the speakers.

type Vec3 = readonly [number, number, number];
interface AmbienceReport {
  wind: { level: number; playing: boolean };
  construction: { level: number; sites: number; playing: boolean; played: number; last: string | null; pan: number | null };
  blocked: string | null;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: { state: { tick: number } | null };
    sound: { unlocked(): boolean; ambience(): AmbienceReport };
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

/** Screenshots and the hook's readings also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["AMBIENCE_EVIDENCE_DIR"];
const STREET: Vec3 = [4300, 0, 4600];
const RESIDENTIAL_LOW = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") * ZONING_BALANCE.densities.length;

/**
 * A short street with houses along both sides, all built on the tick the
 * city is saved at, so they are going up when it opens. It is saved paused,
 * with no zoning left, so the grower adds nothing.
 */
function housesGoingUp(): { state: SimState; houses: number } {
  const state = createState(SEED);
  buildRoads(state, [[[STREET[0] - 24, STREET[2]], [STREET[0] + 24, STREET[2]], "street"]]);
  zoneSides(state, 0, [RESIDENTIAL_LOW]);
  buildEverySide(state);
  state.tick = 1000;
  state.buildings.builtAt.fill(state.tick);
  state.cells.zone.fill(0);
  state.cells.density.fill(0);
  state.speed = 0;
  return { state, houses: buildingCount(state.buildings) };
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await frames(page, 4);
}

const ambience = (page: Page) => page.evaluate(() => window.cityCouncil.sound.ambience());
const dataset = (page: Page, key: string) => page.evaluate((key) => document.body.dataset[key], key);

/** Opens the sound settings: the click is the first, so it starts audio. */
async function startSound(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.cityCouncil.sound.unlocked())).toBe(false);
  await page.locator("#sound-settings summary").click();
  await expect.poll(() => page.evaluate(() => window.cityCouncil.sound.unlocked())).toBe(true);
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

test("the wind grows from street to city zoom, and nothing plays with the ambience volume at zero", async ({ page }, testInfo) => {
  const { state } = housesGoingUp();
  state.buildings.builtAt.fill(0);
  await openCity(page, serialize(state), { name: "Wind" });
  await look(page, STREET[0], STREET[2], 150);
  expect(await ambience(page)).toMatchObject({ blocked: "locked", wind: { playing: false } });
  await startSound(page);

  const readings: { band: string; height: number; report: AmbienceReport }[] = [];
  for (const [band, height] of [
    ["street", 150],
    ["district", 1200],
    ["city", 5000],
  ] as const) {
    await look(page, STREET[0], STREET[2], height);
    await expect.poll(() => dataset(page, "zoomBand")).toBe(band);
    await expect.poll(async () => (await ambience(page)).wind.playing).toBe(true);
    const report = await ambience(page);
    readings.push({ band, height, report });
    await attach(page, testInfo, `wind ${readings.length} ${band} band, level ${report.wind.level.toFixed(2)}`);
  }
  const levels = readings.map((r) => r.report.wind.level);
  expect(levels[0]).toBeLessThan(levels[1] ?? 0);
  expect(levels[1]).toBeLessThan(levels[2] ?? 0);
  // Out of the street band no construction is heard, whatever is going up.
  expect(readings[2]?.report.construction.level).toBe(0);

  // Ambience volume to zero: the wind stops and nothing is scheduled.
  await page.locator("#sound-ambience").fill("0");
  await expect.poll(() => ambience(page)).toMatchObject({ blocked: "silent", wind: { playing: false } });
  await attach(page, testInfo, "wind 4 ambience volume at zero, nothing playing");
  // Back up, and it plays again.
  await page.locator("#sound-ambience").fill("50");
  await expect.poll(async () => (await ambience(page)).wind.playing).toBe(true);
  keepEvidence("wind-readings.json", { readings, atZero: "blocked: silent, wind not playing" });
});

test("houses going up at street zoom make construction sounds, which stop when they are finished", async ({ page }, testInfo) => {
  const { state, houses } = housesGoingUp();
  expect(houses).toBeGreaterThan(0);
  await openCity(page, serialize(state), { name: "Construction" });
  await look(page, STREET[0], STREET[2] + 5, 70);
  await page.waitForFunction((n) => document.body.dataset["buildingsDrawn"] === String(n), houses, { timeout: 60_000 });
  expect(await dataset(page, "zoomBand")).toBe("street");
  await startSound(page);
  await page.locator("#sound-settings summary").click();

  // Paused on the tick they were built: nothing has gone up yet, and nothing is heard.
  await expect.poll(async () => (await ambience(page)).construction.sites).toBe(houses);
  expect((await ambience(page)).construction).toMatchObject({ playing: false, played: 0 });
  await attach(page, testInfo, "construction 1 paused, just begun, silent");

  // Running at 1x: the construction layer starts.
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 1 }))).toEqual({ ok: true });
  await expect.poll(async () => (await ambience(page)).construction.playing).toBe(true);
  // A few sounds in, a third of the way up, the scaffolding stands.
  await expect.poll(async () => (await ambience(page)).construction.played, { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
  const during = await ambience(page);
  expect(during.construction.level).toBeGreaterThan(0);
  expect(Math.abs(during.construction.pan ?? 9)).toBeLessThanOrEqual(1);
  await attach(page, testInfo, `construction 2 going up, ${during.construction.played} sounds so far`);

  // Once every house is finished, it stops.
  await expect.poll(() => dataset(page, "buildingsUnderConstruction"), { timeout: (CONSTRUCTION.ticks / 10) * 1000 + 30_000 }).toBe("0");
  await expect.poll(async () => (await ambience(page)).construction.playing).toBe(false);
  const after = await ambience(page);
  expect(after.construction.sites).toBe(0);
  const played = after.construction.played;
  await frames(page, 30);
  expect((await ambience(page)).construction.played).toBe(played);
  await attach(page, testInfo, `construction 3 finished, silent after ${played} sounds`);
  keepEvidence("construction-readings.json", { houses, during, after });
});
