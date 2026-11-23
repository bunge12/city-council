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
  pending: number;
  lastBuildMs: number;
  firstMarksMs: number;
  firstFrameMs: number;
  slowestMarksMs: number;
  slowestFrameMs: number;
}
declare const window: {
  cityCouncil: {
    view: Promise<{ cellStats(): CellStats | null; flush?: () => void }>;
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
  // Eighteen minutes, a third of the perf job's 54 (issue #228). Since issue
  // #225 it runs headed in the perf project, at every frame's real cost
  // (#226): 4.2 to 7 minutes on CI's faster runners. It used to wait for
  // the whole fill at a chunk a frame, and on slower runners that ran past
  // fifteen minutes (issue #259); see the pan below. Since sidewalks and
  // street lights (#279, #264) a street-band frame takes 3.5 s on an AMD
  // EPYC 7763 and the test 14.3 to 15.1 minutes there, past the old 15
  // (issue #294).
  test.setTimeout(1_080_000);
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
    await frameTime(page, 3);
    plain[band] = await frameTime(page, 10);
  }
  const city = zonedScaleCity(30_000);
  const backend = await openCity(page, city.bytes, { query, name: "Thirty thousand zoned" });
  // The overlay goes on in the district band, and the camera pans across
  // the band while it fills in (issue #164). Every free zoned cell is ground
  // the lot finder has to look at, and the zones change from one segment to
  // the next, so there are marks all over. The gaps between frames: the
  // longest is how long the page stood still.
  //
  // The fill builds chunks for 6 ms a frame and at least one, so in
  // software, at half a second to a second and a half a frame, it takes
  // one frame for each of the 576 chunks. A slower runner then has both
  // slower frames and fewer chunks a frame: the fill took 1.5 to 2 minutes
  // on the faster runners and ran out of the test's time on the slower ones (issue
  // #259). So the test measures the frames of the pan only, 50, and builds
  // whatever is left with `view.flush()`. With the flush it still took 765
  // of its 900 s on a slow runner, most of it in frames: 100 in the pan and
  // 25 a band, twice over. Halving them brings it to about ten minutes.
  const district = poses.find((p) => p.band === "district");
  const cityBand = poses.find((p) => p.band === "city");
  if (!district || !cityBand) throw new Error("no district or city pose");
  await setPose(page, district.position, district.target);
  await frameTime(page, 3);
  await page.evaluate(async ([position, target, cityPosition, cityTarget]) => {
    const w = window as unknown as { gaps: number[]; recording: boolean; panFrames: number };
    const { rig } = await window.cityCouncil.camera;
    w.gaps = [];
    w.recording = true;
    w.panFrames = 0;
    let last = performance.now();
    let frame = 0;
    const tick = () => {
      // Once the fill is done the test sets its own poses, and a frame still queued must not move the camera back (issue #163 made the fill shorter than the pan).
      if (!w.recording) return;
      const now = performance.now();
      w.gaps.push(now - last);
      last = now;
      w.panFrames = frame;
      // 2 km east and back, 80 m a frame, over its first 50 frames, then up to the city band.
      if (frame <= 50) {
        const dx = 80 * (frame < 25 ? frame : 50 - frame);
        rig.setPose([position[0] - 1000 + dx, position[1], position[2]], [target[0] - 1000 + dx, target[1], target[2]]);
      } else if (frame === 51) {
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
  // Until the pan is over and the camera is in the city band, or the fill
  // is done first. 50 frames, about a minute and a half on a slow runner.
  await page.waitForFunction(
    () => (window as unknown as { panFrames: number }).panFrames > 51 || document.body.dataset["cellsPending"] === "0",
    null,
    { timeout: 300_000 },
  );
  const panMs = Date.now() - start;
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { gaps: number[]; recording: boolean };
    w.recording = false;
    return [...w.gaps].sort((a, b) => b - a);
  });
  const longestFramesMs = gaps.slice(0, 3).map((g) => Math.round(g));
  // The frame figures come from the pan: the flush builds every chunk left in one go, which is no frame a player sees.
  const panStats = await cellStats(page);
  await page.evaluate(async () => (await window.cityCouncil.view).flush?.());
  expect(await page.evaluate(() => document.body.dataset["cellsPending"])).toBe("0");
  const stats = await cellStats(page);
  expect(stats.zoned).toBe(city.zoned);
  expect(stats.marked, "cells hatched").toBeGreaterThan(0);
  const overlay: Record<string, number> = {};
  for (const { band, position, target } of poses) {
    await setPose(page, position, target);
    await frameTime(page, 3);
    expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
    overlay[band] = await frameTime(page, 10);
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
    slowestOverlayFrameMs: Math.round(panStats.slowestFrameMs * 100) / 100,
    panMs,
    chunksLeftAfterPan: panStats.pending,
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
    "pan while filling in (ms)": panMs,
    "slowest chunk's lot marks (ms)": stats.slowestMarksMs,
  });
  // As with the roads' scale check (roads.spec.ts): a machine with a GPU
  // holds the display's rate, a CI runner draws in software, so this only
  // catches a gross regression, such as one mesh per cell. The numbers are
  // logged above either way.
  for (const { band } of poses) expect(overlay[band] ?? Infinity).toBeLessThan(Math.max(1000 / 55, (plain[band] ?? 0) * 3));
  // Issue #164: the lot marks cost does not come back. They took 50 to 90 ms on every dense chunk here before.
  // About 2 ms on the development container and 2 to 6 ms on CI, but this is the wall-clock maximum over
  // some 350 chunks, so one GC pause or main-thread stall sets it: 26.1 and 16.4 ms on an AMD EPYC 7763
  // (issues #298, #300). 40 ms clears those stalls and still fails on the old cost on any runner.
  expect(stats.slowestMarksMs).toBeLessThan(40);
});
