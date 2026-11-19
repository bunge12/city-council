import { test } from "@playwright/test";
import { MEASURE_STATE } from "./browser-state";
import { MEASURE_VIEWPORT, checkBands, measureBands, openTown, writeReport } from "./building-lod-helpers";

// Issue M2-13: building-lod-scale.spec.ts at the Balanced preset, with
// shadows. A file of its own so CI deals it to another runner (issue #217),
// written to test-results/building-lod-report-balanced.json.

declare const window: { cityCouncil: { renderStatus(): { backend: string } | null } };

test.use({ viewport: MEASURE_VIEWPORT });
// Times frames: every frame drawn at the real settings (issue #226).
test.use({ storageState: MEASURE_STATE });

// About 4 minutes on a fast CI runner and up to 8 on a slow one (issue #217), so 20 leaves twice the headroom #154 asks for.
test.setTimeout(1_200_000);

test("frame time, draw calls and memory in each band, at Balanced", async ({ page }, testInfo) => {
  await openTown(page);
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const balanced = await measureBands(page, testInfo, "balanced");
  await writeReport(testInfo, "M2-13 scale city with buildings, at Balanced", "building-lod-report-balanced.json", { backend, balanced });
  checkBands(balanced);
});
