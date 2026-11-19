import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { zonedScaleCity } from "./cell-fixtures";
import { canvasShot, openCity } from "./helpers";
import { frameTime, perfFigures } from "./measure";
import { groundAt, scaleCity } from "./road-fixtures";

// Issue M2-06 at scale: a 30,000 segment city with every cell zoned, the
// overlay filling in while the camera pans, then each zoom band against the
// same roads with nothing zoned, on WebGL 2. In the perf project (issue
// #225), which reports and does not gate a merge. The overlay itself is
// cells.spec.ts.

type Vec3 = [number, number, number];
interface CellStats {
  zoned: number;
  unzoned: number;
  marked: number;
  chunks: number;
  lastBuildMs: number;
  firstMarksMs: number;
  firstFrameMs: number;
  slowestMarksMs: number;
  slowestFrameMs: number;
}
declare const window: {
  cityCouncil: {
    view: Promise<{ cellStats(): CellStats | null }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;
declare const performance: { now(): number };

// Headed in the full Chromium build, as it ran in the roads project before
// issue #225, under `xvfb-run` on Linux. Headless, this city's frames came
// slower in software: on the development container the cells test ran out
// of its ten minutes twice headless and took 9.4 minutes headed.
test.use({ viewport: { width: 1280, height: 800 }, headless: false, channel: "chromium" });

async function cellStats(page: Page): Promise<CellStats> {
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  if (!stats) throw new Error("no cell layer");
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

test("a 30,000 segment city with every cell zoned, overlay on, in each zoom band", async ({ page }, testInfo: TestInfo) => {
  // Ten minutes: since issue #164 the overlay fills in while the camera
  // pans the district band, which takes this test from about 2.8 to 3.6
  // minutes on the development container, and an EPYC 7763 runner, the
  // slowest CI has, ran past the seven it had before.
  test.setTimeout(600_000);
  const query = "?webgl";
  const scaleGround = groundAt(6000, 6000);
  const poses: { band: string; position: Vec3; target: Vec3 }[] = [
    { band: "street", position: [6000, scaleGround + 300, 6300], target: [6000, scaleGround, 6000] },
    { band: "district", position: [6000, scaleGround + 1600, 7400], target: [6000, scaleGround, 6000] },
    { band: "city", position: [6000, 8400, 15_800], target: [6000, 0, 5600] },
  ];
  // The same roads with nothing zoned and the overlay off, for comparison.
  await openCity(page, scaleCity(30_000), { query, name: "Thirty thousand" });
  // Fixed short waits, not `settle`: in software a frame of this city takes
  // half a second, and waiting for the trees to settle took a minute a pose.
  const plain: Record<string, number> = {};
  for (const { band, position, target } of poses) {
    await setPose(page, position, target);
    await frameTime(page, 5);
    plain[band] = await frameTime(page, 20);
  }
  const city = zonedScaleCity(30_000);
  const backend = await openCity(page, city.bytes, { query, name: "Thirty thousand zoned" });
  // The overlay goes on in the district band, and the camera pans across
  // the band while it fills in (issue #164). Every free zoned cell is ground
  // the lot finder has to look at, and the zones change from one segment to
  // the next, so there are marks all over. The pan is short and the rest of
  // the fill, a chunk a frame, goes on from the city band, whose frames are
  // the cheapest in software: on a slow runner the whole fill in the
  // district band ran past the test's time. The gaps between frames: the
  // longest is how long the page stood still.
  const district = poses.find((p) => p.band === "district");
  const cityBand = poses.find((p) => p.band === "city");
  if (!district || !cityBand) throw new Error("no district or city pose");
  await setPose(page, district.position, district.target);
  await frameTime(page, 3);
  await page.evaluate(async ([position, target, cityPosition, cityTarget]) => {
    const w = window as unknown as { gaps: number[]; recording: boolean };
    const { rig } = await window.cityCouncil.camera;
    w.gaps = [];
    w.recording = true;
    let last = performance.now();
    let frame = 0;
    const tick = () => {
      // Once the fill is done the test sets its own poses, and a frame still queued must not move the camera back (issue #163 made the fill shorter than the pan).
      if (!w.recording) return;
      const now = performance.now();
      w.gaps.push(now - last);
      last = now;
      // 2 km east and back, 40 m a frame, over its first 100 frames, then up to the city band.
      if (frame <= 100) {
        const dx = 40 * (frame < 50 ? frame : 100 - frame);
        rig.setPose([position[0] - 1000 + dx, position[1], position[2]], [target[0] - 1000 + dx, target[1], target[2]]);
      } else if (frame === 101) {
        rig.setPose(cityPosition, cityTarget);
      }
      frame++;
      if (w.recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [district.position, district.target, cityBand.position, cityBand.target] as const);
  const start = Date.now();
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
  // Slower than `cellsBuilt` allows: the pan's frames build terrain and trees as well.
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 300_000 });
  const firstShowMs = Date.now() - start;
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { gaps: number[]; recording: boolean };
    w.recording = false;
    return [...w.gaps].sort((a, b) => b - a);
  });
  const longestFramesMs = gaps.slice(0, 3).map((g) => Math.round(g));
  const stats = await cellStats(page);
  expect(stats.zoned).toBe(city.zoned);
  expect(stats.marked, "cells hatched").toBeGreaterThan(0);
  const overlay: Record<string, number> = {};
  for (const { band, position, target } of poses) {
    await setPose(page, position, target);
    await frameTime(page, 5);
    expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
    overlay[band] = await frameTime(page, 20);
    await attach(testInfo, `30,000 segments, every cell zoned, ${band} band`, await canvasShot(page));
  }
  const report = {
    backend,
    zonedCells: stats.zoned,
    unzonedCells: stats.unzoned,
    markedCells: stats.marked,
    chunks: stats.chunks,
    buildMs: stats.lastBuildMs,
    // The first chunk and frame build indexes on the mirror once (CellStats), apart from the rest.
    firstChunkMarksMs: Math.round(stats.firstMarksMs * 100) / 100,
    firstOverlayFrameMs: Math.round(stats.firstFrameMs * 100) / 100,
    slowestChunkMarksMs: Math.round(stats.slowestMarksMs * 100) / 100,
    slowestOverlayFrameMs: Math.round(stats.slowestFrameMs * 100) / 100,
    firstShowMs,
    longestFramesMs,
    framesWhileFilling: gaps.length,
    plainFrameMs: plain,
    overlayFrameMs: overlay,
  };
  console.log(`30,000 segments, every cell zoned: ${JSON.stringify(report)}`);
  await testInfo.attach("frame times", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  perfFigures("cells-scale", `30,000 segments, every cell zoned, overlay on, ${backend}`, {
    ...Object.fromEntries(poses.flatMap(({ band }) => [
      [`${band} band, nothing zoned (ms)`, plain[band]],
      [`${band} band, overlay (ms)`, overlay[band]],
    ])),
    "overlay filled in (ms)": firstShowMs,
    "slowest chunk's lot marks (ms)": stats.slowestMarksMs,
  });
  // As with the roads' scale check (roads.spec.ts): a machine with a GPU
  // holds the display's rate, a CI runner draws in software, so this only
  // catches a gross regression, such as one mesh per cell. The numbers are
  // logged above either way.
  for (const { band } of poses) expect(overlay[band] ?? Infinity).toBeLessThan(Math.max(1000 / 55, (plain[band] ?? 0) * 3));
  // Issue #164: no chunk's lot marks take a frame at 60 fps. They took 50 to 90 ms on the densest chunks here before.
  // About 2 ms on the development container, so the bound only catches the old cost coming back, not a slow runner.
  expect(stats.slowestMarksMs).toBeLessThan(16);
});
