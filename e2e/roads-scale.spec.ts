import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { canvasShot, openCity, settle } from "./helpers";
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
    view: Promise<{ roadStats(): RoadStats | null }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

// Headed in the full Chromium build, as it ran in the roads project before
// issue #225, under `xvfb-run` on Linux. Headless, this city's frames came
// slower in software: on the development container the cells test ran out
// of its ten minutes twice headless and took 9.4 minutes headed.
test.use({ viewport: { width: 1280, height: 800 }, headless: false, channel: "chromium" });

async function roadStats(page: Page): Promise<RoadStats> {
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).roadStats());
  if (!stats) throw new Error("no road layer");
  return stats;
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("a 30,000 segment network in the city band", async ({ page }, testInfo: TestInfo) => {
  const whole: { position: Vec3; target: Vec3 } = { position: [6000, 8400, 15_800], target: [6000, 0, 5600] };
  const query = "?webgl";

  await openCity(page, scaleCity(0), { query, name: "Empty" });
  await setPose(page, whole.position, whole.target);
  await settle(page);
  const empty = await frameTime(page, 120);

  const backend = await openCity(page, scaleCity(30_000), { query, name: "Thirty thousand" });
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
