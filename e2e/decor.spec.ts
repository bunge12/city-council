import { expect, test, type Page } from "@playwright/test";

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
type Vec3 = [number, number, number];
interface Counts {
  trees: number;
  grass: number;
}
declare const window: {
  cityCouncil: {
    view: Promise<{ decorCounts(): Counts }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      terrain: { samples: number; spacing: number; heights: Float32Array; forest: Uint8Array; waterLevel: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });

async function ready(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
}

/** Decoration drawn once the layer has built every chunk in range: the counts hold for ten frames. */
async function settledCounts(page: Page): Promise<Counts> {
  return page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let last = "";
    let steady = 0;
    for (let f = 0; f < 600 && steady < 10; f++) {
      await frame();
      const now = JSON.stringify(view.decorCounts());
      steady = now === last ? steady + 1 : 0;
      last = now;
    }
    return view.decorCounts();
  });
}

/**
 * Points the camera, from `height` metres up, at the lowland forest edge
 * nearest the middle of the map: a forest sample with open land beside it.
 */
async function lookAtForestEdge(page: Page, height: number, back: number): Promise<Vec3> {
  return page.evaluate(
    async ([height, back]) => {
      const { rig, terrain } = await window.cityCouncil.camera;
      const n = terrain.samples;
      const mid = n / 2;
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let j = 2; j < n - 2; j++) {
        for (let i = 2; i < n - 2; i++) {
          const k = j * n + i;
          const above = (terrain.heights[k] ?? 0) - terrain.waterLevel;
          if (terrain.forest[k] !== 1 || above < 8 || above > 60 || terrain.forest[k + 2] !== 0) continue;
          const d = (i - mid) ** 2 + (j - mid) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [i, j];
          }
        }
      }
      if (!best) throw new Error("no lowland forest edge on this map");
      const x = best[0] * terrain.spacing;
      const z = best[1] * terrain.spacing;
      const y = terrain.heights[best[1] * n + best[0]] ?? 0;
      const target: Vec3 = [x, y, z];
      rig.setPose([x + back * 0.6, y + height, z + back], target);
      return target;
    },
    [height, back] as const,
  );
}

test("no trees or grass are drawn over the whole map", async ({ page }) => {
  await ready(page);
  // A new city opens on an outside connection (issue M1-16). Look at the whole map.
  await page.evaluate(async () => (await window.cityCouncil.camera).rig.setPose([6000, 8400, 15_840], [6000, 0, 5640]));
  expect(await settledCounts(page)).toEqual({ trees: 0, grass: 0 });
});

test("trees and grass stand on the land near the camera, the same after a reload", async ({ page }, testInfo) => {
  // Software WebGL on CI runners draws the forest at a few frames a second.
  // Alone on a fast machine the test takes about a minute, but on a CI
  // runner shared with a second worker it takes anywhere from 1.2 to over
  // 2.5 minutes, so it gets twice that.
  test.setTimeout(300_000);
  await ready(page, "/?webgl");
  await lookAtForestEdge(page, 160, 420);
  const first = await settledCounts(page);
  expect(first.trees).toBeGreaterThan(1000);
  expect(first.grass).toBeGreaterThan(1000);
  await testInfo.attach("forest edge from district height", { body: await page.screenshot(), contentType: "image/png" });

  await lookAtForestEdge(page, 40, 120);
  await settledCounts(page);
  const close = await page.screenshot();
  await testInfo.attach("trees and grass at street level", { body: close, contentType: "image/png" });

  await page.reload();
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
  await lookAtForestEdge(page, 40, 120);
  await settledCounts(page);
  await testInfo.attach("the same view after a reload", { body: await page.screenshot(), contentType: "image/png" });
  await lookAtForestEdge(page, 160, 420);
  expect(await settledCounts(page)).toEqual(first);
});
