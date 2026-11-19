import { expect, test } from "@playwright/test";
import { MEASURE_STATE } from "./browser-state";
import { MEASURE_VIEWPORT, WAIT_VIEWPORT, canvasShot, drawnNow, openTown, poseAndSettle, scaleCity, writeReport } from "./building-lod-helpers";
import { frameTime } from "./measure";

// Issue #133: the zoning overlay over the whole scale town in the city band,
// at Low. Every cell is zoned, the built ones hidden under their blocks. It
// reports the frame, the draw calls, the meshes each layer shows and what
// the overlay built, to test-results/building-lod-overlay-report.json. A
// file of its own (issue #217): it was the last step of
// building-lod-scale.spec.ts, which then ran past its 15 minutes on slow
// runners.
//
// The overlay builds at least one 500 m chunk a frame, and a chunk of the
// scale town takes longer than the 6 ms budget, so filling in its 576 chunks
// takes 576 frames, however fast the machine. It is turned on once every
// building is drawn, so built cells are hidden under them from the start,
// and fills in at `WAIT_VIEWPORT`, where a frame costs least.

declare const window: { cityCouncil: { renderStatus(): { backend: string } | null; view: Promise<{ cellStats(): unknown }> } };
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: MEASURE_VIEWPORT });
// Times frames: every frame drawn at the real settings (issue #226).
test.use({ storageState: MEASURE_STATE });

// About 4 minutes on a fast CI runner and up to 8 on a slow one (issue #217), so 20 leaves twice the headroom #154 asks for.
test.setTimeout(1_200_000);

test("the zoning overlay over the whole town in the city band", async ({ page }, testInfo) => {
  const { bands } = scaleCity();
  const city = bands.find((b) => b.band === "city");
  if (!city) throw new Error("no city band pose");
  await openTown(page);
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await page.waitForFunction(() => document.body.dataset["zoningOverlay"] === "true");
  expect(page.viewportSize()).toEqual(WAIT_VIEWPORT);
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 900_000 });
  await poseAndSettle(page, city.position, city.target);
  expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe("city");
  // The town is saved paused, so nothing grows and this holds at once, unless the pose asked for cells of its own.
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 300_000 });
  const frameMs = Math.round((await frameTime(page, 30)) * 10) / 10;
  const drawn = await drawnNow(page);
  const cells = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  await canvasShot(page, testInfo, "scale city with buildings, city band, low, zoning overlay");
  await writeReport(testInfo, "#133 zoning overlay over the scale town, city band, Low", "building-lod-overlay-report.json", { backend, cityOverlay: { frameMs, ...drawn, cells } });
});
