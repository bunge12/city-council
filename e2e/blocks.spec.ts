import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-18: the debug panel's block overlay. A player closes a loop of
// streets with the road tool, sees the block outlined with its area,
// bulldozes one side and sees the block go.
//
// Three sides of the loop are built in Node with the sim and imported as a
// city file, so every run starts from the same roads. The fourth is drawn
// in the page.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: { state: { roads: { segFlags: ArrayLike<number> } } | null };
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

/** Three sides of a 200 m square from (4200, 4500) to (4400, 4700): north, east and south. */
function openLoop(): SimState {
  const state = createState(SEED);
  buildRoads(state, [
    [[4200, 4500], [4400, 4500], "street"],
    [[4400, 4500], [4400, 4700], "street"],
    [[4400, 4700], [4200, 4700], "street"],
  ]);
  return state;
}

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl&debug");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  const buffer = Buffer.from(serialize(state));
  await page.locator("#import-file").setInputFiles({ name: "Blocks.city", mimeType: "application/octet-stream", buffer });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
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
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

async function liveSegments(page: Page): Promise<number> {
  return page.evaluate(() => {
    const flags = window.cityCouncil.mirror.state?.roads.segFlags;
    let n = 0;
    for (let s = 0; s < (flags?.length ?? 0); s++) if ((flags?.[s] ?? 0) & 1) n++;
    return n;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("closes a loop of streets, sees the block and its area, bulldozes a side and sees it go", async ({ page }, testInfo) => {
  await openCity(page, openLoop());
  // Off centre to the east, so the debug panel on the right covers none of the roads.
  await look(page, 4400, 4600, 560);
  const readout = page.locator("#blocks-readout");
  await expect(readout).toHaveText("off");

  // Three sides enclose nothing.
  await page.locator("#blocks-toggle").click();
  await expect(page.locator("#blocks-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(readout).toHaveText("no blocks");
  await expect(page.locator(".block-label")).toHaveCount(0);

  // Close the loop with the road tool: a street up the west side.
  const before = await liveSegments(page);
  await page.keyboard.press("KeyB");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyZ");
  await click(page, 4200, 4700);
  await click(page, 4200, 4500);
  await expect.poll(() => liveSegments(page)).toBe(before + 1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "false");

  // One block of 200 by 200 m, outlined, with its area over it.
  await expect(readout).toHaveText("1 block");
  await expect(readout).toHaveAttribute("data-count", "1");
  const label = page.locator(".block-label");
  await expect(label).toHaveCount(1);
  await expect(label).toHaveText("40,000 m²");
  await expect(label).toHaveAttribute("data-area", "40000");
  // The label sits over the middle of the block.
  const middle = await screenAt(page, 4300, 4600);
  const box = await label.boundingBox();
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - middle.x)).toBeLessThan(12);
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - middle.y)).toBeLessThan(12);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "1 the closed loop's block outlined with its area");

  // Bulldoze the east side. The block goes.
  await page.keyboard.press("KeyN");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  await click(page, 4400, 4600);
  await expect.poll(() => liveSegments(page)).toBe(before);
  await expect(readout).toHaveText("no blocks");
  await expect(page.locator(".block-label")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "2 one side bulldozed: no block");
});
