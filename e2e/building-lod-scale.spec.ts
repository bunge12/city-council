import { expect, test } from "@playwright/test";
import { ZONING_BALANCE } from "../packages/sim/src/index";
import { MEASURE_VIEWPORT, bandFigures, checkBands, fullSize, measureBands, openTown, scaleCity, writeReport } from "./building-lod-helpers";

// Issue M2-13: the M1 scale city filled with buildings through commands and
// the grower (growScaleCity). Frame time, draw calls, what each level of
// detail drew and the tab's memory in each zoom band at Low, written to
// test-results/building-lod-report.json for the pull request. Since M2-17 it
// also checks the top bar's homes figure against the town and times a save
// of it from the page, the snapshot and the write to IndexedDB together.
// The same bands at Balanced are in building-lod-scale-balanced.spec.ts, and
// the zoning overlay over the town in building-lod-overlay.spec.ts: each
// loads the town on a CI runner of its own (issue #217). CI runners have no
// GPU and draw in software, so the frame times only catch a gross
// regression; the numbers are the point.

declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    saveNow(): Promise<{ lastSave: { tick: number } | null; saveError: string | null }>;
  };
};
declare const performance: { now(): number };

test.use({ viewport: MEASURE_VIEWPORT });
// About 4 minutes on a fast CI runner and up to 8 on a slow one (issue #217). 15 is a third of the perf job's
// 45 minutes (issue #228, scripts/check-e2e-timeouts.mjs), and the perf project does not retry.
test.setTimeout(900_000);

test("frame time, draw calls and memory in each band, at Low", async ({ page }, testInfo) => {
  const { city, town, bytes } = scaleCity();
  await openTown(page);
  // The saves are timed at full size, as before issue #217: page-side time, which shares the main thread with the frames.
  await fullSize(page);
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const report: Record<string, unknown> = { backend, city: { ...city.counts, ...town, fileBytes: bytes.byteLength } };
  // The top bar's homes (M2-18): every residential building of the town.
  const residential = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;
  const homes = city.state.buildings.zone.reduce((n, zone, id) => n + (city.state.buildings.flags[id] && zone === residential ? 1 : 0), 0);
  await expect(page.locator("#homes-count")).toHaveText(homes.toLocaleString("en-US"));
  // A save of the whole town from the page: the snapshot in the worker and the write to IndexedDB. The first compiles the code.
  const saveMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    saveMs.push(
      await page.evaluate(async () => {
        const t0 = performance.now();
        const status = await window.cityCouncil.saveNow();
        if (status.saveError || !status.lastSave) throw new Error(status.saveError ?? "not saved");
        return Math.round(performance.now() - t0);
      }),
    );
  }
  report["homes"] = homes;
  report["saveMs"] = saveMs;
  const low = await measureBands(page, testInfo, "low");
  report["low"] = low;
  await writeReport(testInfo, "M2-13 scale city with buildings, at Low", "building-lod-report.json", report);
  bandFigures("building-lod-low", `scale town, Low, ${backend}`, low);
  checkBands(low);
});
