import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-15: the debug panel's route tool. A player picks two points, sees
// the route highlighted with its length and time, bulldozes the only link
// between them and sees "no route".
//
// The city is built in Node with the sim and imported as a city file, so
// every run routes over the same roads.

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

/** Two north-south streets joined by one east-west link along z = 4600. */
const LINK_Z = 4600;

function linkedCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [
    [[4150, 4450], [4150, 4750], "street"],
    [[4550, 4450], [4550, 4750], "street"],
    [[4150, LINK_Z], [4550, LINK_Z], "street"],
  ]);
  return state;
}

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl&debug");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  const buffer = Buffer.from(serialize(state));
  await page.locator("#import-file").setInputFiles({ name: "Route.city", mimeType: "application/octet-stream", buffer });
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

test("picks two points, sees the route, bulldozes the only link and sees no route", async ({ page }, testInfo) => {
  await openCity(page, linkedCity());
  // Off centre to the east, so the debug panel on the right covers none of the roads.
  await look(page, 4480, LINK_Z, 520);
  const readout = page.locator("#route-readout");
  await expect(readout).toHaveText("off");

  await page.locator("#route-tool").click();
  await expect(page.locator("#route-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(readout).toHaveText("click the start");
  await click(page, 4160, 4500);
  await expect(readout).toHaveText("click the end");
  await click(page, 4540, 4700);
  // 100 m down the west street, 400 m along the link, 100 m up the east one, at 50 km/h.
  await expect(readout).toHaveText("600 m, 43 s, 3 segments");
  await expect(readout).toHaveAttribute("data-found", "true");
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "1 the route between two points is highlighted");

  // Bulldoze the link with the bulldoze tool. The points stay set.
  const before = await liveSegments(page);
  await page.keyboard.press("KeyN");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  await click(page, 4350, LINK_Z);
  await expect.poll(() => liveSegments(page)).toBe(before - 1);
  await expect(readout).toHaveText("no route");
  await expect(readout).toHaveAttribute("data-found", "false");
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "2 the only link bulldozed: no route");
});
