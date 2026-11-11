import { expect, test, type Page } from "@playwright/test";

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string; seed: number; terrainMs: number; buildMs: number; readyMs: number } | null;
    view: Promise<{
      setCamera(position: Vec3, target: Vec3): void;
      lodCounts(): number[];
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

async function ready(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
  const status = await page.evaluate(() => window.cityCouncil.renderStatus());
  if (!status) throw new Error("render status missing after ready");
  return status;
}

async function setCamera(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.view).setCamera(p, t), [position, target] as const);
}

async function lodCounts(page: Page): Promise<number[]> {
  // Wait two frames so the LODs have updated for the new camera.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  return page.evaluate(async () => (await window.cityCouncil.view).lodCounts());
}

for (const { name, url, backend } of [
  { name: "default backend", url: "/", backend: /^(webgpu|webgl2)$/ },
  { name: "?webgl", url: "/?webgl", backend: /^webgl2$/ },
]) {
  test(`the whole map renders in chunks (${name})`, async ({ page }, testInfo) => {
    const status = await ready(page, url);
    expect(status.backend).toMatch(backend);
    // M0 exit test: the map is on screen within 5 seconds of opening the page.
    expect(status.readyMs).toBeLessThan(5000);
    await expect(page.locator("#render-backend")).toHaveText(status.backend === "webgpu" ? "WebGPU" : "WebGL 2");
    await expect(page.locator("#render-frame")).toHaveText(/ms \(\d+ fps\)/);
    // 576 chunks plus the water, all in view from the default camera.
    await expect(page.locator("#render-draws")).toHaveText(/^5[0-9]{2}, \d+k triangles$/);
    expect(await lodCounts(page)).toEqual([0, 0, 576]);
    console.log(`${name}: ${status.backend}, terrain ${status.terrainMs.toFixed(0)} ms, meshes ${status.buildMs.toFixed(0)} ms, ready at ${status.readyMs.toFixed(0)} ms`);
    await testInfo.attach(`whole map, ${status.backend}`, { body: await page.screenshot(), contentType: "image/png" });
  });
}

test("chunks near the camera switch to full detail", async ({ page }, testInfo) => {
  await ready(page, "/?webgl");
  await setCamera(page, [3000, 250, 9000], [4500, 60, 7500]);
  const [near = 0, mid = 0, far = 0] = await lodCounts(page);
  expect(near).toBeGreaterThan(0);
  expect(mid).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  expect(near + mid + far).toBe(576);
  await testInfo.attach("low view across chunk seams", { body: await page.screenshot(), contentType: "image/png" });
});

test("the canvas follows the window size", async ({ page }) => {
  await ready(page, "/?webgl");
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => page.locator("#view").evaluate((c: { width: number }) => c.width)).toBe(900);
  const height = await page.locator("#view").evaluate((c: { height: number }) => c.height);
  expect(height).toBe(600);
});
