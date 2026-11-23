import { expect, test } from "@playwright/test";
import { buildingCount, deserialize, serialize } from "../packages/sim/src/index";
import { MEASURE_VIEWPORT, bandFigures, checkBands, measureBands, openTown, scaleCity, writeReport } from "./building-lod-helpers";
import { setBuildingUse } from "./building-fixtures";

// Issue M3-17: the scale town with a tenth of its buildings abandoned, every
// building whose id is a multiple of ten. A vacant or abandoned building is
// drawn as a tint of the forms it already had, so the draw calls in each
// band must be the plain town's and the frame time within a few percent of
// it (building-lod-scale.spec.ts and building-lod-scale-balanced.spec.ts),
// written to test-results/building-use-report-<preset>.json for the pull
// request. CI runners have no GPU and draw in software, so the frame times
// only catch a gross regression; the numbers are the point.

declare const window: { cityCouncil: { renderStatus(): { backend: string } | null; view: Promise<{ buildingUse(id: number): number | null }> } };

test.use({ viewport: MEASURE_VIEWPORT });
// As building-lod-scale.spec.ts: about 4 minutes on a fast CI runner and up to 8 on a slow one.
test.setTimeout(900_000);

/** The scale town with every tenth building abandoned, made once. */
let built: { bytes: Uint8Array; abandoned: number[] } | null = null;
function abandonedTown(): { bytes: Uint8Array; abandoned: number[] } {
  if (built) return built;
  // A copy at offset 0: the town's bytes are a Node Buffer, which the reader does not take as it is.
  const { state, pagedLog } = deserialize(new Uint8Array(scaleCity().bytes));
  const abandoned: number[] = [];
  state.buildings.flags.forEach((f, id) => {
    if ((f & 1) === 0 || id % 10 !== 0) return;
    setBuildingUse(state, id, "abandoned");
    abandoned.push(id);
  });
  expect(abandoned.length).toBeGreaterThan(buildingCount(state.buildings) / 11);
  built = { bytes: serialize(state, pagedLog), abandoned };
  return built;
}

for (const preset of ["low", "balanced"] as const) {
  test(`frame time and draw calls in each band with a tenth abandoned, at ${preset}`, async ({ page }, testInfo) => {
    const { bytes, abandoned } = abandonedTown();
    await openTown(page, bytes);
    expect(await page.evaluate(async (id) => (await window.cityCouncil.view).buildingUse(id), abandoned[0] ?? -1)).toBe(2);
    const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
    const bands = await measureBands(page, testInfo, preset);
    await writeReport(testInfo, `M3-17 scale town, a tenth abandoned, at ${preset}`, `building-use-report-${preset}.json`, { backend, abandoned: abandoned.length, [preset]: bands });
    bandFigures(`building-use-${preset}`, `scale town, a tenth abandoned, ${preset}, ${backend}`, bands);
    checkBands(bands);
  });
}
