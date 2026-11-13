import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-11: a street drawn across the water becomes a bridge without a
// bridge tool. The preview marks the bridge and puts it in the cost, the
// built bridge stands on piers over the water, and a second bridge across
// the first, or a road that would end in the water, is refused with the
// reason.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string }[]; roads: { segLevel: ArrayLike<number>; segFlags: ArrayLike<number> } } | null };
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

/** Seed 2026's inlet: water from x = 3488 to 3600 along z = 6600, low banks either side. */
const RIVER = { x0: 3400, x1: 3700, z: 6600, mid: 3545 };

async function openCity(page: Page, bytes: Buffer): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Bridges.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Looks at (x, z) from `height` metres up and to the south, `back` times as far south as up. */
async function look(page: Page, x: number, z: number, height: number, back = 0.75): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * back],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

/** Levels of the live segments, in id order. */
async function levels(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    const out: number[] = [];
    if (!net) return out;
    // Live segments the player built: alive (1) and not an outside connection's fixed stub (2).
    for (let s = 0; s < net.segFlags.length; s++) if (((net.segFlags[s] ?? 0) & 3) === 1) out.push(net.segLevel[s] ?? 0);
    return out;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function band(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.body.dataset["zoomBand"]);
}

test("a street drawn across the river becomes a bridge, shown in the preview, the cost and both near bands", async ({ page }, testInfo) => {
  await openCity(page, Buffer.from(serialize(createState(SEED))));
  await look(page, RIVER.mid, RIVER.z, 260);
  await page.keyboard.press("KeyB");
  await click(page, RIVER.x0, RIVER.z);
  await hover(page, RIVER.x1, RIVER.z);

  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(page.locator("#road-bridge")).toContainText(/^Bridge, \d+ m$/);
  const bridge = Number(await readout.getAttribute("data-bridge"));
  const length = Number(await readout.getAttribute("data-length"));
  // The water is 112 m wide; the bridge takes in a ramp on each bank as well.
  expect(bridge).toBeGreaterThan(112);
  expect(bridge).toBeLessThan(length);
  // The bridge costs more a metre than the street on the ground.
  const cost = Number(await readout.getAttribute("data-cost"));
  expect(cost).toBeGreaterThan(length * 1400 * 1.5);
  await attach(page, testInfo, "1 preview marks the bridge");

  await click(page, RIVER.x1, RIVER.z);
  await expect.poll(() => logLength(page)).toBe(1);
  // Ground, bridge, ground.
  expect(await levels(page)).toEqual([0, 1, 0]);
  await page.keyboard.press("Escape");
  await page.mouse.move(20, 400);

  // Street band: low and from the side, to see the railings and the piers.
  await look(page, RIVER.mid, RIVER.z, 45, 2.2);
  await expect.poll(() => band(page)).toBe("street");
  await attach(page, testInfo, "2 bridge in the street band");
  await look(page, RIVER.mid, RIVER.z, 120, 1.2);
  await attach(page, testInfo, "3 bridge in the street band, from higher");

  // District band: the deck still reads over the water.
  await look(page, RIVER.mid, RIVER.z, 700, 0.6);
  await expect.poll(() => band(page)).toBe("district");
  await attach(page, testInfo, "4 bridge in the district band");
});

test("a second bridge across the first, and a road that ends in the water, are refused with the reason", async ({ page }, testInfo) => {
  const state = createState(SEED);
  buildRoads(state, [[[RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z], "street"]]);
  await openCity(page, Buffer.from(serialize(state)));
  await look(page, RIVER.mid, RIVER.z, 300);
  await page.keyboard.press("KeyB");
  const readout = page.locator("#road-readout");

  // From the north-west bank to the south-east one, across the bridge over the water.
  await click(page, 3420, 6480);
  await hover(page, 3680, 6720);
  await expect(readout).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#road-reason")).toHaveText("The road would cross a bridge, and roads cannot pass over or under each other yet");
  await attach(page, testInfo, "5 a bridge across the bridge is refused");

  await page.keyboard.press("Escape");
  await click(page, RIVER.x0, 6500);
  await hover(page, RIVER.mid, 6620);
  await expect(readout).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#road-reason")).toHaveText("A road cannot start or end in water");
  await attach(page, testInfo, "6 a road that ends in the water is refused");
  expect(await logLength(page)).toBe(1);
});
