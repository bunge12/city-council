import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Issue M2-02: the sun and shadows. The same forest edge at Low, Balanced
// and High, for the pull request: no shadows, shadows near the camera,
// shadows further out. In the evidence project (issue #225), which takes
// pictures and does not gate a merge. The benchmark and the settings are
// presets.spec.ts.

type Vec3 = [number, number, number];
interface LightingReport {
  preset: string;
  shadows: boolean;
  shadowRange: number;
  shadowMapSize: number;
  softAmbient: boolean;
  focus: Vec3 | null;
}
declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string; readyMs: number } | null;
    view: Promise<{ lighting(): LightingReport; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      terrain: { samples: number; spacing: number; heights: Float32Array; forest: Uint8Array; waterLevel: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });

const PRESETS = ["low", "balanced", "high"] as const;

async function ready(page: Page): Promise<{ backend: string; readyMs: number }> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const status = await page.evaluate(() => window.cityCouncil.renderStatus());
  if (!status) throw new Error("render status missing after ready");
  return status;
}

/** Waits until the preset on screen is the one wanted and no benchmark runs. */
async function presetSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
}

async function lighting(page: Page): Promise<LightingReport> {
  return page.evaluate(async () => (await window.cityCouncil.view).lighting());
}

/** Waits until decoration near the camera is built: its counts hold for ten frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
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
  });
}

/** Looks at the lowland forest edge nearest the middle of the map, from `height` metres up and `back` metres south. */
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

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The canvas alone, without the page's panels over it. */
async function canvasShot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  return page.locator("#view").screenshot();
}

// On `?webgl`: the evidence project is headless, where the default backend is
// WebGL 2 as well. WebGPU's frame times per preset come from scale.spec.ts.
test("the same forest edge at each preset: no shadows, shadows near the camera, shadows further out", async ({ page }, testInfo) => {
  // Three page loads, each building a forest at a few frames a second on a runner without a GPU.
  test.setTimeout(360_000);
  const query = "webgl&";
  const reports: Record<string, LightingReport> = {};
  let target: Vec3 = [0, 0, 0];
  for (const preset of PRESETS) {
    await page.goto(`/?${query}preset=${preset}`);
    const status = await ready(page);
    testInfo.annotations.push({ type: `${preset} backend`, description: status.backend });
    // The first frame is lit as Low and waits for no shadow shaders, so it
    // comes as soon at every preset. Printed, not held to the M0 exit test's
    // 5 seconds: walkthrough.spec.ts step 1 is that test (issue #154).
    console.log(`${preset}: first frame with terrain at ${status.readyMs.toFixed(0)} ms (${status.backend})`);
    await presetSettled(page);
    await expect(page.locator("#graphics-preset")).toHaveValue(preset);
    target = await lookAtForestEdge(page, 60, 120);
    await settle(page);
    const report = await lighting(page);
    reports[preset] = report;
    expect(report.preset).toBe(preset);
    await attach(testInfo, `forest edge, ${preset}, ${status.backend}`, await canvasShot(page));
  }
  // Which preset turns shadows and soft ambient on, and High's longer range
  // and larger map, are unit tests (packages/client/test/presets.test.ts).
  const { balanced, high } = reports;
  // Near the camera: the shadow map centres on the ground the camera looks at.
  for (const report of [balanced, high]) {
    const f = report?.focus ?? [Infinity, Infinity, Infinity];
    expect(Math.hypot(f[0] - target[0], f[2] - target[2]), `${report?.preset} shadow focus`).toBeLessThan(30);
  }
});
