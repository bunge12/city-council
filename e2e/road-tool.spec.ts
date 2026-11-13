import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ROAD_TYPES, createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { formatMoneyShort } from "../packages/client/src/ui/format";
import { FLAT, SEED, groundAt } from "./road-fixtures";
import { MENU_SHIFT } from "./dock";

// Issue M1-07: the straight road tool. A player draws a street, crosses it
// with an avenue and sees a four-way junction and two log entries, then
// tries a road into water and sees the reason and no new entry.
//
// The city is an empty one on the fixture seed, imported as a city file, so
// every run draws on the same ground.

type Vec3 = [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segFlags: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string; playerId: string; tick: number }[]; roads: Net } | null };
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
const street = ROAD_TYPES.find((t) => t.id === "street");
const avenue = ROAD_TYPES.find((t) => t.id === "avenue");

/** An empty city on the fixture seed, as a city file. */
function emptyCity(): Buffer {
  return Buffer.from(serialize(createState(SEED)));
}

/**
 * A road that starts on dry, gentle ground and runs into water: walk from
 * the flat square toward the nearest water and stop 120 m short of the shore.
 */
function roadIntoWater(): { from: { x: number; z: number }; to: { x: number; z: number } } {
  let water: { x: number; z: number } | null = null;
  let best = Infinity;
  for (let x = 0; x < 12_000; x += 50) {
    for (let z = 0; z < 12_000; z += 50) {
      const d = Math.hypot(x - 4400, z - 4700);
      if (d < best && heightAt(terrain, x, z) <= terrain.waterLevel) {
        best = d;
        water = { x, z };
      }
    }
  }
  if (!water) throw new Error("no water on the fixture map");
  const ux = (water.x - 4400) / best;
  const uz = (water.z - 4700) / best;
  let shore = 0;
  while (heightAt(terrain, 4400 + ux * shore, 4700 + uz * shore) > terrain.waterLevel) shore += 1;
  const at = (d: number) => ({ x: 4400 + ux * d, z: 4700 + uz * d });
  return { from: at(shore - 120), to: at(shore + 60) };
}

async function openEmptyCity(page: Page): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Empty.city", mimeType: "application/octet-stream", buffer: emptyCity() });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  // Issue 47: the road menu covers the bottom middle of the screen, so the
  // view sits a quarter of its height further back and the work area higher up.
  const back = (position[1] - target[1]) * MENU_SHIFT;
  const p: Vec3 = [position[0], position[1], position[2] + back];
  const t: Vec3 = [target[0], target[1], target[2] + back];
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [p, t] as const);
  await frames(page);
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Where ground point (x, z) is drawn on screen. */
async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
}

async function clickGround(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

/** How many live road segments meet at each live node, by node position. */
async function degrees(page: Page): Promise<{ x: number; z: number; degree: number }[]> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) return [];
    const out: { x: number; z: number; degree: number }[] = [];
    for (let n = 0; n < net.nodeFlags.length; n++) {
      if (((net.nodeFlags[n] ?? 0) & 1) === 0) continue;
      // Not a node on an outside connection's fixed stub (segment flag 2).
      let onStub = false;
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 3) === 3 && (net.segA[s] === n || net.segB[s] === n)) onStub = true;
      }
      if (onStub) continue;
      let degree = 0;
      for (let s = 0; s < net.segFlags.length; s++) {
        if ((net.segFlags[s] ?? 0) & 1 && (net.segA[s] === n || net.segB[s] === n)) degree++;
      }
      out.push({ x: net.nodeX[n] ?? 0, z: net.nodeZ[n] ?? 0, degree });
    }
    return out;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("draws a street, crosses it with an avenue, and refuses a road into water", async ({ page }, testInfo) => {
  if (!street || !avenue) throw new Error("street and avenue are in the balance file");
  await openEmptyCity(page);
  // Hide the import note so screenshots show the map.
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
  const ground = groundAt(4350, 4600);
  await setPose(page, [4350, ground + 330, 4860], [4350, ground, 4600]);
  await page.keyboard.press("KeyL");
  await expect(page.locator("#activity-log")).toBeVisible();
  expect(await logLength(page)).toBe(0);

  // B turns the tool on; Z picks streets.
  await page.keyboard.press("KeyB");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyX");
  await expect(page.locator("#road-type-avenue")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyZ");
  await expect(page.locator("#road-type-street")).toHaveAttribute("aria-pressed", "true");

  // A street west to east. The preview shows the length and the cost.
  await clickGround(page, 4220, 4600);
  await hover(page, 4480, 4600);
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toHaveAttribute("data-type", "street");
  const length = Number(await readout.getAttribute("data-length"));
  const cost = Number(await readout.getAttribute("data-cost"));
  expect(length).toBeGreaterThan(255);
  expect(length).toBeLessThan(265);
  expect(cost).toBe(Math.round(length * street.buildCostPerMetre));
  await expect(page.locator("#road-cost")).toHaveText(formatMoneyShort(cost));
  await expect(readout).toContainText(`${length.toFixed(0)} m`);
  await attach(page, testInfo, "street preview with length and cost");

  // A drag that ends on the map moves the camera and places nothing.
  const end = await screenAt(page, 4480, 4600);
  await page.mouse.down();
  await page.mouse.move(end.x - 60, end.y - 20, { steps: 6 });
  await page.mouse.up();
  await frames(page);
  expect(await logLength(page)).toBe(0);
  await setPose(page, [4350, ground + 330, 4860], [4350, ground, 4600]);
  await expect(readout).toBeVisible();

  await clickGround(page, 4480, 4600);
  await expect.poll(() => logLength(page)).toBe(1);

  // An avenue north to south across it. A marker shows where they will meet.
  await page.keyboard.press("KeyX");
  await clickGround(page, 4350, 4470);
  await hover(page, 4350, 4730);
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toHaveAttribute("data-type", "avenue");
  await expect(readout).toContainText("1 junction");
  const avenueLength = Number(await readout.getAttribute("data-length"));
  expect(Number(await readout.getAttribute("data-cost"))).toBe(Math.round(avenueLength * avenue.buildCostPerMetre));
  await attach(page, testInfo, "avenue preview with the crossing marked");
  await clickGround(page, 4350, 4730);
  await expect.poll(() => logLength(page)).toBe(2);

  // A four-way junction where they cross, and two log entries.
  await expect.poll(async () => (await degrees(page)).filter((n) => n.degree === 4).length).toBe(1);
  const four = (await degrees(page)).find((n) => n.degree === 4);
  expect(Math.abs((four?.x ?? 0) - 4350)).toBeLessThan(2);
  expect(Math.abs((four?.z ?? 0) - 4600)).toBeLessThan(2);
  const rows = page.locator("#activity-log tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("BuildRoad");
  await expect(rows.nth(1)).toContainText("BuildRoad");
  await hover(page, 4300, 4520);
  await attach(page, testInfo, "four-way junction and two log entries");

  // A road into water: the preview says why, and a click sends nothing.
  await page.keyboard.press("KeyZ");
  const wet = roadIntoWater();
  const mid = { x: (wet.from.x + wet.to.x) / 2, z: (wet.from.z + wet.to.z) / 2 };
  const g = groundAt(mid.x, mid.z);
  await setPose(page, [mid.x, g + 300, mid.z + 260], [mid.x, g, mid.z]);
  await clickGround(page, wet.from.x, wet.from.z);
  await hover(page, wet.to.x, wet.to.z);
  await expect(readout).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#road-reason")).toContainText("water");
  await attach(page, testInfo, "road into water refused with the reason");
  await clickGround(page, wet.to.x, wet.to.z);
  await expect(page.locator("#road-note")).toContainText("water");
  await page.waitForTimeout(500);
  expect(await logLength(page)).toBe(2);
  await expect(rows).toHaveCount(2);

  // Right-click drops the road being drawn; Escape with nothing drawn leaves the tool.
  await page.mouse.click(640, 400, { button: "right" });
  await frames(page);
  await expect(readout).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "false");
});

test("Escape drops a road being drawn, and the keys are listed with the others", async ({ page }) => {
  await openEmptyCity(page);
  const ground = groundAt(4350, 4600);
  await setPose(page, [4350, ground + 330, 4860], [4350, ground, 4600]);
  await page.keyboard.press("KeyC");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await clickGround(page, FLAT.x0 + 100, 4600);
  await hover(page, FLAT.x0 + 300, 4600);
  await expect(page.locator("#road-readout")).toHaveAttribute("data-type", "oneWay");
  await page.keyboard.press("Escape");
  await expect(page.locator("#road-readout")).toHaveCount(0);
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "false");
  // B toggles the tool.
  await page.keyboard.press("KeyB");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyB");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Backquote");
  const keys = page.locator("#debug-panel");
  for (const text of ["road tool on or off", "draw streets", "draw avenues", "draw one-way roads", "drop the road being drawn"]) {
    await expect(keys).toContainText(text);
  }
});
