import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-21: the grid tool. A player drags a rectangle off a street that
// came with the city, confirms, and gets a grid joined to that street as
// one log entry, which one Ctrl+Z takes back. A rectangle over water shows
// its cut streets before the click and builds what it showed. A grid over
// the cap shows the reason and cannot be confirmed.
//
// The city is built in Node with the sim and imported as a city file. Its
// street was built by another player id, so Ctrl+Z only takes back the grid.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string }[]; roads: Record<string, ArrayLike<number>> } | null };
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

/** Dry land north of an inlet that widens to the south-west, as the sim's grid tests use it. */
const INLET = { x0: 3300, z0: 6400, x1: 3800, z1: 6800 };

/** A north-south street at x = 4350 from z = 4450 to 4750, built by another player. */
function startCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4350, 4450], [4350, 4750], "street"]]);
  return state;
}

async function openCity(page: Page, state: SimState): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  const buffer = Buffer.from(serialize(state));
  await page.locator("#import-file").setInputFiles({ name: "Grid.city", mimeType: "application/octet-stream", buffer });
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
  const h = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

/** Drags from one ground point to another with the left button, and leaves the pointer at the end. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await screenAt(page, from[0], from[1]);
  const b = await screenAt(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await frames(page);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 30 });
  await frames(page);
  await page.mouse.up();
  await frames(page);
}

/** Moves the pointer off the map. */
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

interface Seg {
  id: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** The live segments of a network read with `roads`. */
function segments(net: Record<string, number[]>): Seg[] {
  const out: Seg[] = [];
  const flags = net["segFlags"] ?? [];
  for (let s = 0; s < flags.length; s++) {
    if (((flags[s] ?? 0) & 1) === 0) continue;
    const a = net["segA"]?.[s] ?? 0;
    const b = net["segB"]?.[s] ?? 0;
    out.push({ id: s, ax: net["nodeX"]?.[a] ?? 0, az: net["nodeZ"]?.[a] ?? 0, bx: net["nodeX"]?.[b] ?? 0, bz: net["nodeZ"]?.[b] ?? 0 });
  }
  return out;
}

const key = (s: Seg): string => `${s.ax},${s.az},${s.bx},${s.bz}`;
const length = (s: Seg): number => Math.hypot(s.bx - s.ax, s.bz - s.az);

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("lays a grid off a street, joined to it, and one Ctrl+Z takes it all back", async ({ page }, testInfo) => {
  await openCity(page, startCity());
  await look(page, 4240, 4610, 420);
  await page.keyboard.press("KeyL");
  const start = await roads(page);
  const startLog = (await logTypes(page)).length;

  await page.keyboard.press("KeyG");
  await expect(page.locator("#grid-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#grid-depth")).toHaveValue("12");
  // From a point on the street, west and along it: the rectangle takes the street's angle.
  await drag(page, [4350, 4480], [4120, 4740]);
  const summary = page.locator("#grid-summary");
  await expect(summary).toHaveAttribute("data-ok", "true");
  const junctions = Number(await summary.getAttribute("data-junctions"));
  expect(junctions).toBeGreaterThanOrEqual(2);
  await expect(summary).toContainText(/\d+ streets, \d+ m · \$[\d.]+[KM]/);
  await expect(page.locator("#grid-confirm")).toBeEnabled();
  await away(page);
  await attach(page, testInfo, "1 the preview of a grid dragged off the street");

  await page.locator("#grid-confirm").click();
  await expect.poll(async () => (await logTypes(page)).length).toBe(startLog + 1);
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoadGrid"]);
  await expect(page.locator("#activity-log")).toContainText("BuildRoadGrid");
  await expect(summary).toHaveCount(0);
  const built = await roads(page);
  // Joined: the street is split where the grid's streets meet it, and nothing is built on top of it.
  const onStreet = segments(built).filter((s) => s.ax === 4350 && s.bx === 4350);
  expect(onStreet.length).toBe(junctions + 1);
  expect(onStreet.reduce((sum, s) => sum + length(s), 0)).toBeCloseTo(300, 6);
  const joinedAt = segments(built).filter((s) => (s.ax === 4350) !== (s.bx === 4350));
  expect(joinedAt.length).toBe(junctions);
  await frames(page);
  await attach(page, testInfo, "2 the grid built and joined to the street, one log entry");

  await page.keyboard.press("Control+KeyZ");
  await expect.poll(async () => roads(page)).toEqual(start);
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoadGrid", "Undo"]);
  await frames(page);
  await attach(page, testInfo, "3 one Ctrl+Z took the whole grid back");
});

test("shows where water cuts a grid's streets and builds what it showed", async ({ page }, testInfo) => {
  await openCity(page, createState(SEED));
  await look(page, 3550, 6620, 560);
  const before = new Set(segments(await roads(page)).map(key));
  const startLog = (await logTypes(page)).length;

  await page.keyboard.press("KeyG");
  await drag(page, [INLET.x0, INLET.z0], [INLET.x1, INLET.z1]);
  const summary = page.locator("#grid-summary");
  await expect(summary).toHaveAttribute("data-ok", "true");
  const cuts = Number(await summary.getAttribute("data-cuts"));
  expect(cuts).toBeGreaterThan(0);
  await expect(summary).toContainText(/street ends? cut by water or slope/);
  const planned = Number(await summary.getAttribute("data-length"));
  await away(page);
  await attach(page, testInfo, "4 the preview marks the streets the water cuts");

  await page.keyboard.press("Enter");
  await expect.poll(async () => (await logTypes(page)).length).toBe(startLog + 1);
  const added = segments(await roads(page)).filter((s) => !before.has(key(s)));
  expect(added.reduce((sum, s) => sum + length(s), 0)).toBeCloseTo(planned, 3);
  // Every new street ends on dry land.
  for (const s of added) {
    expect(heightAt(terrain, s.ax, s.az)).toBeGreaterThan(terrain.waterLevel);
    expect(heightAt(terrain, s.bx, s.bz)).toBeGreaterThan(terrain.waterLevel);
  }
  await frames(page);
  await attach(page, testInfo, "5 the grid built as the preview showed it");
});

test("a grid over the cap shows the reason and cannot be confirmed", async ({ page }, testInfo) => {
  await openCity(page, createState(SEED));
  await look(page, 4400, 4700, 480);
  const startLog = (await logTypes(page)).length;

  await page.keyboard.press("KeyG");
  await page.locator("#grid-depth").fill("4");
  await page.locator("#grid-width").fill("4");
  await drag(page, [4150, 4450], [4550, 4850]);
  const summary = page.locator("#grid-summary");
  await expect(summary).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#grid-reason")).toHaveText(/^Too many streets: the grid has \d+, and the most one grid can lay is 14$/);
  await expect(page.locator("#grid-confirm")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.body.dataset["gridPreview"])).toBe("refused");
  await away(page);
  await attach(page, testInfo, "6 a grid over the cap, refused with the reason");

  await page.keyboard.press("Enter");
  await expect(page.locator("#road-note")).toHaveText(/^Too many streets/);
  await page.waitForTimeout(500);
  expect((await logTypes(page)).length).toBe(startLog);

  // Escape drops the rectangle, and again leaves the tool.
  await page.keyboard.press("Escape");
  await expect(summary).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Off, the road menu closes and takes the grid button with it (issue 47).
  await expect(page.locator("#grid-tool")).toHaveCount(0);
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-expanded", "false");
});
