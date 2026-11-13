import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-14: undo. A player draws a street across one that came with the
// city, upgrades one of its pieces and bulldozes another, then takes all
// three back one step at a time: Ctrl+Z, the undo button and Cmd+Z. The
// network ends exactly as the city file had it, the button goes grey, and an
// undo with nothing left shows the sim's reason.
//
// The city is built in Node with the sim and imported as a city file. Its
// street was built by another player id, so this player cannot undo it.

type Vec3 = readonly [number, number, number];
interface Net {
  segFlags: ArrayLike<number>;
  segType: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  segCX: ArrayLike<number>;
  segCZ: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string; playerId: string }[]; roads: Net & Record<string, ArrayLike<number>> } | null };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);

/** A north-south street at x = 4350 from z = 4500 to 4700, built by another player. */
function startCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4350, 4500], [4350, 4700], "street"]]);
  return state;
}

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  const buffer = Buffer.from(serialize(state));
  await page.locator("#import-file").setInputFiles({ name: "Undo.city", mimeType: "application/octet-stream", buffer });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  // Hide the import note so screenshots show the map.
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
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

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const h = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

/** Moves the pointer off the map so no preview shows in a screenshot. */
async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page);
}

/** Every road array of the mirror's copy, as plain lists, to compare whole networks. */
async function roads(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return Object.fromEntries(Object.entries(net).map(([k, a]) => [k, Array.from(a)]));
  });
}

async function logTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => e.type) ?? []);
}

/** The live segment whose middle is nearest (x, z) in the mirror, and its type. */
async function segmentNear(page: Page, x: number, z: number): Promise<{ id: number; type: number }> {
  return page.evaluate(
    ([x, z]) => {
      const net = window.cityCouncil.mirror.state?.roads;
      if (!net) throw new Error("no state");
      let best = { id: -1, type: -1 };
      let bestD = Infinity;
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
        const a = net.segA[s] ?? 0;
        const b = net.segB[s] ?? 0;
        const mx = ((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0) + 2 * (net.segCX[s] ?? 0)) / 4;
        const mz = ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0) + 2 * (net.segCZ[s] ?? 0)) / 4;
        const d = Math.hypot(mx - x, mz - z);
        if (d < bestD) {
          best = { id: s, type: net.segType[s] ?? -1 };
          bestD = d;
        }
      }
      return bestD < 5 ? best : { id: -1, type: -1 };
    },
    [x, z] as const,
  );
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("builds, upgrades and bulldozes, then undoes all three one step at a time", async ({ page }, testInfo) => {
  await openCity(page, startCity());
  await look(page, 4350, 4600, 260);
  await page.keyboard.press("KeyL");
  await expect(page.locator("#activity-log")).toBeVisible();
  const undoButton = page.locator("#undo");
  const note = page.locator("#undo-note");
  const start = await roads(page);
  const startLog = (await logTypes(page)).length;
  // The street came with the city, built by someone else: nothing to undo.
  await expect(undoButton).toBeDisabled();
  await attach(page, testInfo, "1 a street from the city file, nothing to undo");

  // Draw a street west to east across it. It splits the street it crosses.
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyZ");
  await click(page, 4220, 4600);
  await click(page, 4480, 4600);
  await expect.poll(async () => (await logTypes(page)).length).toBe(startLog + 1);
  await page.keyboard.press("KeyB");
  await expect(undoButton).toBeEnabled();
  const built = await roads(page);
  const west = await segmentNear(page, 4285, 4600);
  const east = await segmentNear(page, 4415, 4600);
  expect(west.id).toBeGreaterThanOrEqual(0);
  expect(east.id).toBeGreaterThanOrEqual(0);
  await away(page);
  await attach(page, testInfo, "2 built a street across it");

  // Upgrade the west piece to an avenue.
  await page.keyboard.press("KeyV");
  await page.keyboard.press("KeyX");
  await click(page, 4285, 4600);
  await expect.poll(async () => (await segmentNear(page, 4285, 4600)).type).toBe(1);
  const upgraded = await roads(page);
  await away(page);
  await attach(page, testInfo, "3 upgraded the west piece to an avenue");

  // Bulldoze the east piece.
  await page.keyboard.press("KeyN");
  await click(page, 4415, 4600);
  await expect.poll(async () => (await segmentNear(page, 4415, 4600)).id).toBe(-1);
  await page.keyboard.press("KeyN");
  await away(page);
  await attach(page, testInfo, "4 bulldozed the east piece");
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoad", "UpgradeRoad", "BulldozeRoad"]);

  // Ctrl+Z brings the east piece back, under the same id.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(async () => (await segmentNear(page, 4415, 4600)).id).toBe(east.id);
  expect(await roads(page)).toEqual(upgraded);
  await away(page);
  await attach(page, testInfo, "5 Ctrl+Z put the bulldozed piece back");

  // The button takes back the upgrade.
  await undoButton.click();
  await expect.poll(async () => (await segmentNear(page, 4285, 4600)).type).toBe(0);
  expect(await roads(page)).toEqual(built);
  await away(page);
  await attach(page, testInfo, "6 the undo button turned the avenue back into a street");

  // Cmd+Z takes back the build and rejoins the street it split.
  await page.keyboard.press("Meta+KeyZ");
  await expect.poll(async () => roads(page)).toEqual(start);
  await expect(undoButton).toBeDisabled();
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoad", "UpgradeRoad", "BulldozeRoad", "Undo", "Undo", "Undo"]);
  await expect(page.locator("#activity-log")).toContainText("Undo");
  await away(page);
  await attach(page, testInfo, "7 Cmd+Z took back the build, the network is as the file had it");

  // One more press, with nothing left: the sim refuses and says why.
  await page.keyboard.press("Control+KeyZ");
  await expect(note).toHaveText("Nothing to undo");
  expect((await logTypes(page)).slice(startLog)).toHaveLength(6);
  await attach(page, testInfo, "8 nothing left to undo, and the reason shown");
});
