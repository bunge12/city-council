import { expect, test } from "@playwright/test";
import { builtFixtureCity } from "./building-fixtures";
import { attachCanvas, chunkAt, openFixture, setPose, stats, type Form, type Vec3 } from "./building-lod-helpers";
import { settle } from "./helpers";
import { groundAt } from "./road-fixtures";

// Issue M2-13: buildings across the zoom bands. Full models near the camera
// in the street band, simplified models merged per chunk within 2 km in the
// street and district bands and boxes beyond, and flat blocks coloured by zone
// in the city band. The
// fixture city with every building type: the same district in all three
// bands, screenshotted, at Balanced and at Low. The scale city's numbers
// are in building-lod-scale.spec.ts, building-lod-scale-balanced.spec.ts,
// building-lod-overlay.spec.ts and building-lod-memory.spec.ts.

declare const window: { cityCouncil: { view: Promise<{ buildingForm(chunk: number): Form | null }> } };
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });

test.describe("the fixture city", () => {
  test.setTimeout(240_000);
  const fixture = builtFixtureCity();
  const GRID = { x: 4250, z: 4600 };
  const ground = groundAt(GRID.x, GRID.z);
  const target: Vec3 = [GRID.x + 20, ground, GRID.z + 10];
  /** One district, the middle of the fixture's street grid, from each band's height. */
  const BANDS: { band: string; position: Vec3; form: Form }[] = [
    { band: "street", position: [GRID.x - 60, ground + 210, GRID.z + 230], form: "full" },
    { band: "district", position: [GRID.x - 300, ground + 900, GRID.z + 1100], form: "simple" },
    { band: "city", position: [GRID.x - 800, ground + 3600, GRID.z + 3000], form: "flat" },
  ];

  for (const preset of ["balanced", "low"] as const) {
    test(`the same district in all three bands, at ${preset}`, async ({ page }, testInfo) => {
      await openFixture(page, `webgl&debug&preset=${preset}`, "Built", fixture.bytes);
      const chunk = chunkAt(target[0], target[2]);
      for (const { band, position, form } of BANDS) {
        await setPose(page, position, target);
        await settle(page, { buildings: true });
        expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
        expect(await page.evaluate(async (c) => (await window.cityCouncil.view).buildingForm(c), chunk)).toBe(form);
        const s = await stats(page);
        expect(s.buildings).toBe(fixture.buildings);
        // Each band draws its own form and none of the others.
        for (const other of ["full", "simple", "box", "flat"] as const) {
          if (other === form) expect(s.forms[other].buildings, `${band}: ${other}`).toBeGreaterThan(0);
          else if (other !== "simple" || band !== "street") expect(s.forms[other].meshes, `${band}: ${other}`).toBe(0);
        }
        await attachCanvas(page, testInfo, `${band} band, ${preset}`);
        if (band === "street") {
          await page.getByRole("region", { name: "Debug panel" }).screenshot({ path: testInfo.outputPath("debug-panel.png") });
          await testInfo.attach(`debug panel, ${band} band`, { path: testInfo.outputPath("debug-panel.png"), contentType: "image/png" });
          await expect(page.locator("#building-forms")).toHaveText(/^full \d+ in \d+ meshes, simple \d+ in \d+ mesh(es)?, boxes 0 in 0 meshes, blocks 0 in 0 meshes$/);
        }
      }
    });
  }
});
