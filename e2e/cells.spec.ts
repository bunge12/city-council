import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CELL_OPEN, CHUNKS_PER_SIDE, CHUNK_SIZE, ZONING_BALANCE, cellShapesInChunk, generateTerrain, heightAt } from "../packages/sim/src/index";
import { zonedFixtureCity } from "./cell-fixtures";
import { decodePng, type Image } from "./png";
import { SEED, groundAt } from "./road-fixtures";
import { canvasShot, frames, openCity, settle } from "./helpers";

// Issue M2-06: the zoning overlay. It runs in the `roads` project, headed
// with WebGPU on where the browser has an adapter (see playwright.config.ts),
// so the WebGPU path and `?webgl` are drawn and compared with the same
// screenshots.
//
// The city is the road fixture with every zone at every density painted
// along its streets (cell-fixtures.ts), imported as a city file. The overlay
// over a 30,000 segment city is cells-scale.spec.ts, in the perf project
// (issue #225).

type Vec3 = [number, number, number];
interface CellStats {
  visible: boolean;
  chunks: number;
  zoned: number;
  unzoned: number;
  marked: number;
  lastRebuilt: number;
  totalRebuilt: number;
  lastBuildMs: number;
  firstMarksMs: number;
  firstFrameMs: number;
  slowestMarksMs: number;
  slowestFrameMs: number;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    renderStatus(): { backend: string } | null;
    view: Promise<{ cellStats(): CellStats | null; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>;
};
declare function getComputedStyle(element: unknown): { backgroundColor: string };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const BACKENDS = [
  { name: "default backend", query: "?preset=low" },
  { name: "?webgl", query: "?webgl&preset=low" },
] as const;

async function cellStats(page: Page): Promise<CellStats> {
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  if (!stats) throw new Error("no cell layer");
  return stats;
}

/** Waits until every chunk the overlay has to build is built: they go a few a frame. */
async function cellsBuilt(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 120_000 });
}

/** Turns the overlay on with the zone tool's shortcut and waits until it is drawn. */
async function overlayOn(page: Page): Promise<void> {
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
  await cellsBuilt(page);
}

/** Turns the overlay on or off with the zone tool's shortcut, if it is not that way already. */
async function setOverlay(page: Page, on: boolean): Promise<void> {
  if ((await page.evaluate(() => document.body.dataset["zoningOverlay"])) === String(on)) return;
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe(String(on));
  if (on) await cellsBuilt(page);
  // The next frame draws it.
  await frames(page);
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const ground = groundAt(4250, 4600);
/** The middle of the fixture's street grid, where every pair of zone and density is painted. */
const GRID = { x: 4250, z: 4600 };

/** A camera pose per zoom band, each with the zoned grid in view. */
const BANDS: { band: string; position: Vec3; target: Vec3 }[] = [
  { band: "street", position: [GRID.x - 30, ground + 260, GRID.z + 230], target: [GRID.x, ground, GRID.z] },
  { band: "district", position: [GRID.x + 100, ground + 1100, GRID.z + 900], target: [GRID.x + 100, ground, GRID.z + 100] },
  { band: "city", position: [GRID.x + 150, ground + 3200, GRID.z + 1500], target: [GRID.x + 150, ground, GRID.z + 100] },
];

const fixture = zonedFixtureCity();

test("the fixture paints every zone at every density", () => {
  const pairs = ZONING_BALANCE.zones.length * ZONING_BALANCE.densities.length;
  expect(fixture.counts.slice(0, pairs).every((n) => n > 0)).toBe(true);
});

for (const { name, query } of BACKENDS) {
  test(`the zoning overlay draws the same in every zoom band (${name})`, async ({ page }, testInfo) => {
    const backend = await openCity(page, fixture.bytes, { query, name: "Zoned" });
    if (query.startsWith("?webgl")) expect(backend).toBe("webgl2");
    else if (process.env["CI"]) expect(backend).toBe("webgpu");
    testInfo.annotations.push({ type: "backend", description: backend });
    // Off until asked for, and nothing is built for it.
    expect((await cellStats(page)).totalRebuilt).toBe(0);
    await expect(page.locator("#zone-legend")).toHaveCount(0);
    await overlayOn(page);
    await expect(page.locator("#zone-legend")).toBeVisible();
    await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
    const stats = await cellStats(page);
    expect(stats.zoned).toBe(fixture.counts.reduce((a, b) => a + b, 0));
    expect(stats.unzoned).toBeGreaterThan(0);
    for (const { band, position, target } of BANDS) {
      await setPose(page, position, target);
      await settle(page);
      await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      const shot = await canvasShot(page);
      await attach(testInfo, `${band} band, ${backend}`, shot);
      // One baseline per band, shared by both backends: they must draw the same picture.
      expect(shot).toMatchSnapshot(`cells-${band}.png`, { maxDiffPixelRatio: 0.01, threshold: 0.1 });
    }
    // The page with its legend, for the pull request.
    const street = BANDS[0];
    if (street) await setPose(page, street.position, street.target);
    await settle(page);
    await attach(testInfo, `street band with the legend, ${backend}`, await page.screenshot());
  });
}

test("painting one strip rebuilds only the chunks it touches and their neighbours", async ({ page }, testInfo) => {
  await openCity(page, fixture.bytes, { query: "?webgl&debug", name: "Zoned" });
  await overlayOn(page);
  const paint = async (from: [number, number], to: [number, number]) => {
    const result = await page.evaluate(
      ([from, to]) =>
        window.cityCouncil.sendCommand("ZoneCells", { zone: "office", density: 2, rects: [{ from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, width: 30 }] }),
      [from, to] as const,
    );
    expect(result).toEqual({ ok: true });
  };
  const total = (await cellStats(page)).totalRebuilt;
  // East of the street x = 4150, inside chunk (8, 9), and the eight around
  // it, since a lot mark there can follow from ground across the line (M2-15).
  await paint([4170, 4560], [4170, 4640]);
  await expect(page.locator("#cell-rebuilds")).toHaveText(new RegExp(`^9 last, ${total + 9} total,`));
  // The same street across the chunk line z = 4500: two chunks, and the twelve round them both.
  await paint([4170, 4470], [4170, 4530]);
  await expect(page.locator("#cell-rebuilds")).toHaveText(new RegExp(`^12 last, ${total + 21} total,`));
  await setPose(page, [4250, ground + 300, 4700], [4180, ground, 4520]);
  await settle(page);
  await attach(testInfo, "two painted strips, debug panel open", await page.screenshot());
});

/** The sRGB colour a CSS colour string such as "rgb(234, 224, 57)" names. */
function rgbOf(css: string): [number, number, number] {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Share of `points` drawn within `tolerance` of `colour` on each channel. */
function shareOf(image: Image, points: { x: number; y: number; colour: [number, number, number] }[], tolerance: number): number {
  let hits = 0;
  for (const p of points) {
    const k = (Math.round(p.y) * image.width + Math.round(p.x)) * 4;
    const [r, g, b] = p.colour;
    if (Math.abs((image.rgba[k] ?? 0) - r) <= tolerance && Math.abs((image.rgba[k + 1] ?? 0) - g) <= tolerance && Math.abs((image.rgba[k + 2] ?? 0) - b) <= tolerance) hits++;
  }
  return points.length === 0 ? 0 : hits / points.length;
}

/** Centres of the zoned open cells in the grid's chunk, with their zone and density. */
function zonedCentres(): { x: number; z: number; zone: number; density: number }[] {
  const chunk = Math.floor(GRID.z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(GRID.x / CHUNK_SIZE);
  const shapes = cellShapesInChunk(fixture.state, chunk);
  const out: { x: number; z: number; zone: number; density: number }[] = [];
  for (let k = 0; k < shapes.slots.length; k++) {
    const slot = shapes.slots[k] ?? 0;
    const zone = fixture.state.cells.zone[slot] ?? 0;
    if (shapes.statuses[k] !== CELL_OPEN || zone === 0) continue;
    const c = shapes.corners.subarray(k * 8, k * 8 + 8);
    out.push({ x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4, z: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4, zone, density: fixture.state.cells.density[slot] ?? 0 });
  }
  return out;
}

/**
 * Asphalt: grey, with little difference between channels. No zone colour is
 * grey, so a cell drawn over a road fails.
 */
const asphalt = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) < 40 && g < 150;

for (const preset of ["low", "high"] as const) {
  test(`cells show the legend's colours, unlit and unshaded, over the ground and under the roads (${preset})`, async ({ page }, testInfo) => {
    await openCity(page, fixture.bytes, { query: `?webgl&preset=${preset}`, name: "Zoned" });
    await expect.poll(() => page.evaluate(() => document.body.dataset["presetSettled"])).toBe("true");
    await overlayOn(page);
    // The legend's swatches, by "zone,density", as the page draws them.
    const legend = await page.evaluate(() => {
      const out: Record<string, string> = {};
      const rows = document.querySelectorAll("#zone-legend tbody tr .swatch");
      for (let i = 0; i < rows.length; i++) out[String(i)] = getComputedStyle(rows[i]).backgroundColor;
      return out;
    });
    const densities = ZONING_BALANCE.densities.length;
    const colourOf = (zone: number, density: number) => rgbOf(legend[String((zone - 1) * densities + density - 1)] ?? "");
    const cells = zonedCentres();
    // One terrain for every point: `groundAt` generates the map afresh each call.
    const terrain = generateTerrain(SEED);
    const centres = cells.map((c) => [c.x, heightAt(terrain, c.x, c.z), c.z] as Vec3);
    // Points in one lane of the grid's streets, clear of the dashed centre line, between junctions.
    const road: Vec3[] = [];
    for (const x of [4150, 4250, 4350]) {
      for (let z = 4470; z <= 4730; z += 10) if ((z - 4450) % 100 > 15 && (z - 4450) % 100 < 85) road.push([x + 2.5, heightAt(terrain, x + 2.5, z), z]);
    }
    const results: string[] = [];
    for (const height of [3500, 1500, 600, 250, 120]) {
      await setPose(page, [GRID.x + height * 0.3, ground + height, GRID.z + height * 0.6], [GRID.x, ground, GRID.z]);
      await settle(page);
      const band = await page.evaluate(() => document.body.dataset["zoomBand"]);
      const project = (pts: Vec3[]) =>
        page.evaluate(async (pts) => {
          const camera = await window.cityCouncil.camera;
          return pts.map(([x, y, z]) => camera.project(x, y, z));
        }, pts);
      const inView = (p: { x: number; y: number }) => p.x > 2 && p.y > 2 && p.x < 1278 && p.y < 798;
      const cellPoints = (await project(centres))
        .map((p, i) => ({ ...p, colour: colourOf(cells[i]?.zone ?? 1, cells[i]?.density ?? 1) }))
        .filter(inView);
      const roadPoints = (await project(road)).filter(inView);
      const isAsphalt = (image: Image, x: number, y: number) => {
        const k = (y * image.width + x) * 4;
        return asphalt(image.rgba[k] ?? 0, image.rgba[k + 1] ?? 0, image.rgba[k + 2] ?? 0);
      };
      // The road points well inside a road with the overlay off: the pixel and
      // its eight neighbours are all asphalt. From high up a lane is a pixel
      // or two wide, and a point at its edge blends with whatever lies
      // beside the road, grass or a cell, without either covering it.
      await setOverlay(page, false);
      const offShot = decodePng(await canvasShot(page));
      const inside = roadPoints
        .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
        .filter((p) => [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => isAsphalt(offShot, p.x + dx, p.y + dy))));
      await setOverlay(page, true);
      // Two frames apart, so a surface that fights the terrain shows up in one or the other.
      for (const frame of [0, 1]) {
        const shot = await canvasShot(page);
        if (frame === 0) await attach(testInfo, `${height} m up, ${band}, ${preset}`, shot);
        const image = decodePng(shot);
        // Only where a cell is several pixels across does its centre sit clear of its lines.
        if (height <= 600) results.push(`${height} m, ${band}, frame ${frame}, cells: ${shareOf(image, cellPoints, 6).toFixed(3)}`);
        // Every one of them is still road with the overlay on.
        const hidden = inside.filter((p) => !isAsphalt(image, p.x, p.y)).length;
        results.push(`${height} m, ${band}, frame ${frame}, roads hidden: ${hidden} of ${inside.length}`);
      }
    }
    console.log(results.join("\n"));
    // A cell centre is its legend colour to within a few levels on each
    // channel: no light, no shadow and no terrain showing through. The
    // decorative trees still stand on zoned ground until buildings take it
    // (issue M2-12), and they hide about one centre in eight from these
    // poses, the same at every preset.
    expect(results.filter((r) => r.includes("cells:") && Number(r.split(": ")[1]) < 0.8), results.join("\n")).toEqual([]);
    expect(results.filter((r) => r.includes("roads hidden:") && !r.includes("hidden: 0 of")), results.join("\n")).toEqual([]);
    // Enough road was in view to tell: the street band shows it wide.
    expect(results.some((r) => /street, frame 0, roads hidden: 0 of [1-9]\d/.test(r)), results.join("\n")).toBe(true);
  });
}
