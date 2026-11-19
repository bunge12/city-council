import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { frameTime, perfFigures } from "./measure";
import { scaleCity } from "./road-fixtures";

// Issue M1-06 at scale: a 30,000 segment network in the city band, against
// the empty map at the same pose, on WebGL 2. In the perf project (issue
// #225), which reports and does not gate a merge. The road meshes
// themselves are roads.spec.ts.

type Vec3 = [number, number, number];
interface RoadStats {
  chunks: number;
  segmentPieces: number;
  lastBuildMs: number;
}
declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    view: Promise<{ roadStats(): RoadStats | null; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });

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
  perfFigures("roads-scale", `30,000 segments, city band, ${backend}`, { "empty map (ms)": empty, "30,000 segments (ms)": roads, "mesh build (ms)": stats.lastBuildMs });
  expect(stats.segmentPieces).toBeGreaterThan(30_000);
  // A machine with a GPU draws this at the display's rate. CI runners have
  // no GPU and draw in software, where the roads add 45 to 55 percent to the
  // empty map's frame from one run to the next, so a tight ratio only
  // measures the runner. There the check only catches a gross regression,
  // such as roads drawn without merged chunk meshes: the frame stays under
  // three times the empty map's. The numbers are logged above either way.
  expect(roads).toBeLessThan(Math.max(1000 / 55, empty * 3));
});
