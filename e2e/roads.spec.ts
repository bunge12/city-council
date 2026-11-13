import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { decodePng, type Image } from "./png";
import { CURVED_JUNCTION, FIVE_WAY, curvedCity, fixtureCity, groundAt, scaleCity } from "./road-fixtures";

// Issue M1-06: roads in the mirror appear on the map. It runs in the `roads`
// project, headed with WebGPU on where the browser has an adapter (see
// playwright.config.ts), so the WebGPU path and `?webgl` are both drawn and
// compared with the same screenshots.
//
// The city comes from road-fixtures.ts as a city file, so every run draws
// the same roads on the same map.

type Vec3 = [number, number, number];
interface RoadStats {
  chunks: number;
  segmentPieces: number;
  lastRebuilt: number;
  totalRebuilt: number;
  lastBuildMs: number;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    renderStatus(): { backend: string } | null;
    view: Promise<{
      roadStats(): RoadStats | null;
      decorCounts(): { trees: number; grass: number };
    }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
// Several page loads with the whole map, on a machine that may have no GPU.
test.setTimeout(240_000);

const BACKENDS = [
  { name: "default backend", query: "" },
  { name: "?webgl", query: "?webgl" },
] as const;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

/** Opens the page, then imports `bytes` as a city and waits for it to be drawn. */
async function openCity(page: Page, query: string, name: string, bytes: Buffer): Promise<string> {
  await page.goto(`/${query}`);
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  const status = await page.evaluate(() => window.cityCouncil.renderStatus());
  return status?.backend ?? "none";
}

async function roadStats(page: Page): Promise<RoadStats> {
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).roadStats());
  if (!stats) throw new Error("no road layer");
  return stats;
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/** Waits until decoration has finished building near the camera: its counts hold for ten frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let last = "";
    let steady = 0;
    for (let f = 0; f < 600 && steady < 10; f++) {
      await frame();
      const now = JSON.stringify(view.decorCounts());
      steady = now === last ? steady + 1 : 0;
      last = now;
    }
  });
}

/** Attaches a screenshot, kept as a file in the test's output folder. */
async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The canvas alone, without the page's panels over it. */
async function canvasShot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  return page.locator("#view").screenshot();
}

const ground = groundAt(4400, 4700);

/** A camera pose per zoom band, each with the fixture in view. */
const BANDS: { band: string; position: Vec3; target: Vec3 }[] = [
  { band: "street", position: [FIVE_WAY.x - 40, ground + 190, FIVE_WAY.z + 170], target: [FIVE_WAY.x - 70, ground, FIVE_WAY.z + 40] },
  { band: "district", position: [4400, ground + 1300, 5500], target: [4400, ground, 4700] },
  { band: "city", position: [4400, ground + 4200, 6400], target: [4400, ground, 4700] },
];

for (const { name, query } of BACKENDS) {
  test(`the fixture city draws the same in every zoom band (${name})`, async ({ page }, testInfo) => {
    const backend = await openCity(page, query, "Roads", fixtureCity().bytes);
    if (query === "?webgl") expect(backend).toBe("webgl2");
    testInfo.annotations.push({ type: "backend", description: backend });
    const stats = await roadStats(page);
    // Three chunks: the grid and avenue cross the lines x = 4500 and z = 4500.
    // Plus one for each of the two outside connection stubs at the map edge.
    expect(stats.chunks).toBe(3 + 2);
    for (const { band, position, target } of BANDS) {
      await setPose(page, position, target);
      await settle(page);
      await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      const shot = await canvasShot(page);
      await attach(testInfo, `${band} band, ${backend}`, shot);
      // One baseline per band, shared by both backends: they must draw the same picture.
      expect(shot).toMatchSnapshot(`roads-${band}.png`, { maxDiffPixelRatio: 0.01, threshold: 0.25 });
    }
  });
}

// Issue M1-09: curved roads, junctions with curved arms, a curve crossing a
// curve twice and a T-junction on a curve's body, at street level. The city
// band shot shows the avenue's line cut into fewer pieces; it is attached,
// not compared.
const curvedGround = groundAt(CURVED_JUNCTION.x, CURVED_JUNCTION.z);
for (const { name, query } of BACKENDS) {
  test(`the curved fixture city draws curves and curved junctions (${name})`, async ({ page }, testInfo) => {
    const backend = await openCity(page, query, "Curves", curvedCity().bytes);
    if (query === "?webgl") expect(backend).toBe("webgl2");
    testInfo.annotations.push({ type: "backend", description: backend });
    const { x, z } = CURVED_JUNCTION;
    await setPose(page, [x + 40, curvedGround + 210, z + 200], [x + 40, curvedGround, z + 30]);
    await settle(page);
    await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe("street");
    const shot = await canvasShot(page);
    await attach(testInfo, `curves, street band, ${backend}`, shot);
    expect(shot).toMatchSnapshot("roads-curves.png", { maxDiffPixelRatio: 0.01, threshold: 0.25 });
    await setPose(page, [x, curvedGround + 4200, z + 1700], [x, curvedGround, z]);
    await settle(page);
    await attach(testInfo, `curves, city band, ${backend}`, await canvasShot(page));
  });
}

test("adding one segment rebuilds only the chunks it touches", async ({ page }, testInfo) => {
  await openCity(page, "?webgl&debug", "Roads", fixtureCity().bytes);
  const before = await roadStats(page);
  const build = async (from: [number, number], to: [number, number]) => {
    const result = await page.evaluate(
      ([from, to]) => window.cityCouncil.sendCommand("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" }),
      [from, to] as const,
    );
    expect(result).toEqual({ ok: true });
  };

  // A street off the grid's west side, inside chunk (8, 9) and far from any line.
  await build([4150, 4700], [4110, 4700]);
  await expect(page.locator("#road-rebuilds")).toHaveText(/^1 last, 1 total,/);
  // A street across the chunk line z = 5000, joined to nothing: two chunks.
  await build([4250, 4960], [4250, 5040]);
  await expect(page.locator("#road-rebuilds")).toHaveText(/^2 last, 3 total,/);
  const after = await roadStats(page);
  expect(after.chunks).toBe(before.chunks + 1);
  await setPose(page, [4250, ground + 300, 5150], [4220, ground, 4900]);
  await settle(page);
  await attach(testInfo, "two new streets, debug panel open", await page.screenshot());
});

/**
 * Share of `points` drawn in a colour `match` accepts. With `reach`, a point
 * passes when any pixel within that many pixels of it does.
 */
function shareMatching(
  image: Image,
  points: { x: number; y: number }[],
  match: (r: number, g: number, b: number) => boolean,
  reach = 0,
): number {
  let hits = 0;
  for (const p of points) {
    let hit = false;
    for (let dy = -reach; dy <= reach && !hit; dy++) {
      for (let dx = -reach; dx <= reach && !hit; dx++) {
        const k = ((Math.round(p.y) + dy) * image.width + Math.round(p.x) + dx) * 4;
        hit = match(image.rgba[k] ?? 0, image.rgba[k + 1] ?? 0, image.rgba[k + 2] ?? 0);
      }
    }
    if (hit) hits++;
  }
  return points.length === 0 ? 0 : hits / points.length;
}

/** Asphalt: grey, with little difference between channels. Grass is green, so it fails. */
const asphalt = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) < 40 && g < 150;
/** City band line: orange, red well above blue. */
const orange = (r: number, _g: number, b: number) => r > 180 && r - b > 80;

for (const { name, query } of BACKENDS) {
  test(`roads stay on top of the terrain at every zoom (${name})`, async ({ page }, testInfo) => {
    await openCity(page, query, "Roads", fixtureCity().bytes);
    // Points on the avenue's centre line, between junctions, away from paint.
    const avenue: Vec3[] = [];
    for (let z = 4470; z <= 4830; z += 15) avenue.push([4450 + 3, groundAt(4453, z), z]);
    // Camera distance from far above down to the closest zoom, looking down the avenue at a slant.
    const results: string[] = [];
    for (const height of [12_000, 6000, 3500, 2500, 1500, 800, 400, 200, 100, 60]) {
      await setPose(page, [4450 + height * 0.35, ground + height, 4650 + height * 0.6], [4450, ground, 4650]);
      await settle(page);
      const band = await page.evaluate(() => document.body.dataset["zoomBand"]);
      const points = await page.evaluate(async (pts) => {
        const camera = await window.cityCouncil.camera;
        return pts.map(([x, y, z]) => camera.project(x, y, z));
      }, avenue);
      const inView = points.filter((p) => p.x > 2 && p.y > 2 && p.x < 1278 && p.y < 798);
      expect(inView.length).toBeGreaterThan(5);
      // Two frames apart, so a surface that fights the terrain shows up in one or the other.
      for (const frame of [0, 1]) {
        const shot = await canvasShot(page);
        if (frame === 0) await attach(testInfo, `${height} m up, ${band}`, shot);
        // Beyond the street band a road is a few pixels wide and sits a little
        // above the projected ground point, so a sample may land a pixel off.
        const reach = band === "street" ? 0 : 1;
        const share = shareMatching(decodePng(shot), inView, band === "city" ? orange : asphalt, reach);
        results.push(`${height} m, ${band}, frame ${frame}: ${share}`);
      }
    }
    expect(results.filter((r) => !r.endsWith(": 1")), results.join("\n")).toEqual([]);
  });
}

/** Mean time between `frames` animation frames, in ms. */
async function frameTime(page: Page, frames: number): Promise<number> {
  return page.evaluate(async (frames) => {
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      let last = -1;
      const tick = (now: number) => {
        if (last >= 0) times.push(now - last);
        last = now;
        if (times.length < frames) requestAnimationFrame(() => tick(performance.now()));
        else resolve();
      };
      requestAnimationFrame(() => tick(performance.now()));
    });
    return times.reduce((a, b) => a + b, 0) / times.length;
  }, frames);
}
declare const performance: { now(): number };

test("a 30,000 segment network in the city band", async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const whole: { position: Vec3; target: Vec3 } = { position: [6000, 8400, 15_800], target: [6000, 0, 5600] };
  const query = "?webgl";

  await openCity(page, query, "Empty", scaleCity(0));
  await setPose(page, whole.position, whole.target);
  await settle(page);
  const empty = await frameTime(page, 120);

  const backend = await openCity(page, query, "Thirty thousand", scaleCity(30_000));
  const stats = await roadStats(page);
  await setPose(page, whole.position, whole.target);
  await settle(page);
  expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe("city");
  const roads = await frameTime(page, 120);
  const report = { backend, emptyFrameMs: empty, roadsFrameMs: roads, buildMs: stats.lastBuildMs, chunks: stats.chunks, segmentPieces: stats.segmentPieces };
  console.log(`30,000 segments, city band: ${JSON.stringify(report)}`);
  await testInfo.attach("frame times", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  await attach(testInfo, "30,000 segments, city band", await canvasShot(page));
  expect(stats.segmentPieces).toBeGreaterThan(30_000);
  // A machine with a GPU draws this at the display's rate. CI runners have
  // no GPU and draw in software, where the roads add 45 to 55 percent to the
  // empty map's frame from one run to the next, so a tight ratio only
  // measures the runner. There the check only catches a gross regression,
  // such as roads drawn without merged chunk meshes: the frame stays under
  // three times the empty map's. The numbers are logged above either way.
  expect(roads).toBeLessThan(Math.max(1000 / 55, empty * 3));
});
