import { test } from "@playwright/test";
import { MEASURE_VIEWPORT, bandFigures, checkBands, measureBands, openTown, writeReport } from "./building-lod-helpers";

// Issue M2-13: building-lod-scale.spec.ts at the Balanced preset, with
// shadows. A file of its own so CI deals it to another runner (issue #217),
// written to test-results/building-lod-report-balanced.json.

declare const window: { cityCouncil: { renderStatus(): { backend: string } | null } };

test.use({ viewport: MEASURE_VIEWPORT });
// About 4 minutes on a fast CI runner and up to 8 on a slow one (issue #217). 15 is a third of the perf job's
// 45 minutes (issue #228, scripts/check-e2e-timeouts.mjs), and the perf project does not retry.
test.setTimeout(900_000);

test("frame time, draw calls and memory in each band, at Balanced", async ({ page }, testInfo) => {
  await openTown(page);
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const balanced = await measureBands(page, testInfo, "balanced");
  await writeReport(testInfo, "M2-13 scale city with buildings, at Balanced", "building-lod-report-balanced.json", { backend, balanced });
  bandFigures("building-lod-balanced", `scale town, Balanced, ${backend}`, balanced);
  checkBands(balanced);
});
