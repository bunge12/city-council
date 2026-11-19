import { expect, test } from "@playwright/test";
import { BUILDING_TYPES } from "../packages/sim/src/index";
import { downtownFixtureCity } from "./building-fixtures";
import { buildingsDrawn, openCity } from "./helpers";

// Issue #137: a downtown's towers are drawn in many shapes. The downtown
// fixture of towers, slabs and podiums at Low, with no pictures: every
// building drawn, and each tower type in several models. The pictures, at
// Balanced, are building-looks.spec.ts in the evidence project (issue #225),
// which does not gate a merge.

declare const window: {
  cityCouncil: { view: Promise<{ buildingStats(): { buildings: number; models: number } | null }> };
};

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

test("a downtown's towers are drawn in many models", async ({ page }, testInfo) => {
  const city = downtownFixtureCity();
  await openCity(page, city.bytes, { query: "webgl&preset=low", name: "Downtown" });
  await buildingsDrawn(page, city.buildings);
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  expect(stats?.buildings).toBe(city.buildings);
  // Many models in use: each type's buildings draw several of its shapes.
  const towers = BUILDING_TYPES.filter((t) => t.density === 3 && t.zone !== "industrial" && !t.throughLot && (city.counts[t.index] ?? 0) > 0);
  expect(towers.length).toBeGreaterThan(8);
  expect(stats?.models ?? 0).toBeGreaterThan(towers.length * 2);
  testInfo.annotations.push({ type: "downtown", description: `${city.buildings} buildings of ${towers.length} types in ${stats?.models} models` });
});
