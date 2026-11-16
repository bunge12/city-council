import { expect, test } from "@playwright/test";
import { heightAt } from "../packages/sim/src/index";
import { openCity, scaleCity, setPose, settle, stats } from "./building-lod-helpers";
import { memory } from "./measure";

// Issue M2-13: flying across the map does not grow memory without bound.
// The scale city filled with buildings, flown round a loop at street height
// twice: the second loop ends with no more memory, meshes or instances than
// the first.

declare const window: { cityCouncil: { view: Promise<{ renderer: { info: { memory: { geometries: number; textures: number } } } }> } };
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(900_000);

test("flying a loop twice ends with no more memory than flying it once", async ({ page }, testInfo) => {
  const { city, terrain, bytes } = scaleCity();
  await openCity(page, "webgl&preset=low", "Town", bytes);
  // A loop round the map at street height, over a grid at each stop.
  const stops = [0.1, 0.3, 0.5, 0.7, 0.9].flatMap((t) => {
    const g = city.grids[Math.floor(t * (city.grids.length - 1))];
    return g ? [{ x: g.x + 288, z: g.z + 288 }] : [];
  });
  const loop = [...stops, ...stops.slice(1, -1).reverse()];
  const fly = async () => {
    for (const s of loop) {
      const h = heightAt(terrain, s.x, s.z);
      await setPose(page, [s.x, h + 190, s.z + 170], [s.x, h, s.z]);
      await settle(page, 300_000);
      expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe("street");
    }
    const s = await stats(page);
    const gpu = await page.evaluate(async () => (await window.cityCouncil.view).renderer.info.memory);
    return { memory: await memory(page), models: s.models, full: s.forms.full, geometries: gpu.geometries };
  };
  const first = await fly();
  const second = await fly();
  const report = { stops: loop.length, first, second };
  console.log(`M2-13 flying a loop twice: ${JSON.stringify(report, null, 2)}`);
  await testInfo.attach("loop report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  // The same stops, so the same chunks in full at the end of each loop.
  expect(second.full).toEqual(first.full);
  expect(second.models).toBe(first.models);
  // Chunks left behind free their instances and model meshes. The
  // renderer's geometry count takes in every layer, and a road or cell
  // chunk drawn for the first time on the second loop adds one, so it may
  // move a little, but not by another loop's worth of buildings.
  expect(second.geometries).toBeLessThan(first.geometries * 1.03 + 5);
  // The heap may move by what a collection leaves, but not by another loop's worth.
  expect(second.memory.pageMb).toBeLessThan(first.memory.pageMb * 1.05 + 5);
});
