import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, serialize } from "../packages/sim/src/index";
import { SEED, fixtureRoads } from "./road-fixtures";

// Issue M2-02: graphics presets, the sun and shadows. The same view at Low,
// Balanced and High; the same commands at two presets giving the same state
// hash; and the first-run benchmark, which runs once per browser.
//
// playwright.config.ts starts every test with Low kept in the browser. The
// tests here that need a first visit clear it.

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
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    downloadCity(): Promise<{ hash: string; tick: number }>;
    view: Promise<{ lighting(): LightingReport; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      terrain: { samples: number; spacing: number; heights: Float32Array; forest: Uint8Array; waterLevel: number };
    }>;
  };
  localStorage: { getItem(key: string): string | null };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
// Three page loads of the whole map, drawn in software on a CI runner.
test.setTimeout(240_000);

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

/** Opens the page with `query` and imports `bytes` as a city. */
async function openCity(page: Page, query: string, bytes: Buffer): Promise<void> {
  await page.goto(`/${query}`);
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Presets.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
}

// On `?webgl`: the chromium project is headless, where the default backend is
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
    // The M0 number: the map is on screen within 5 seconds, whatever the preset.
    // The first frame is lit as Low and waits for no shadow shaders.
    expect(status.readyMs, `${preset}: first frame with terrain`).toBeLessThan(5000);
    await presetSettled(page);
    await expect(page.locator("#graphics-preset")).toHaveValue(preset);
    target = await lookAtForestEdge(page, 60, 120);
    await settle(page);
    const report = await lighting(page);
    reports[preset] = report;
    expect(report.preset).toBe(preset);
    await attach(testInfo, `forest edge, ${preset}, ${status.backend}`, await canvasShot(page));
  }
  const { low, balanced, high } = reports;
  expect(low?.shadows).toBe(false);
  expect(low?.softAmbient).toBe(false);
  expect(balanced?.shadows).toBe(true);
  expect(balanced?.softAmbient).toBe(true);
  expect(high?.shadows).toBe(true);
  // Near the camera: the shadow map centres on the ground the camera looks at.
  for (const report of [balanced, high]) {
    const f = report?.focus ?? [Infinity, Infinity, Infinity];
    expect(Math.hypot(f[0] - target[0], f[2] - target[2]), `${report?.preset} shadow focus`).toBeLessThan(30);
  }
  expect(high?.shadowRange ?? 0).toBeGreaterThan(balanced?.shadowRange ?? Infinity);
  expect(high?.shadowMapSize ?? 0).toBeGreaterThan(balanced?.shadowMapSize ?? Infinity);
});

test("the same commands at two presets give the same state hash", async ({ page }) => {
  // Paused, so the commands land on the same tick however fast the page runs.
  const state = createState(SEED);
  state.speed = 0;
  const bytes = Buffer.from(serialize(state));
  const hashes: Record<string, string> = {};
  for (const preset of ["low", "high"]) {
    await openCity(page, `?webgl&preset=${preset}`, bytes);
    await presetSettled(page);
    for (const [from, to, type] of fixtureRoads()) {
      const result = await page.evaluate(
        ([from, to, type]) => window.cityCouncil.sendCommand("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type }),
        [from, to, type] as const,
      );
      expect(result.ok, result.reason).toBe(true);
    }
    const downloaded = await page.evaluate(() => window.cityCouncil.downloadCity());
    expect(downloaded.tick).toBe(0);
    hashes[preset] = downloaded.hash;
  }
  expect(hashes["high"]).toBe(hashes["low"]);
});

test.describe("a browser with no preset kept", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the first visit runs the benchmark and shows its choice; the second does not run it", async ({ page }, testInfo) => {
    await page.goto("/?webgl&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("true");
    const readout = page.locator("#render-preset");
    await expect(readout).toHaveText(/^(Low|Balanced|High) \(picked by the benchmark on this visit: [\d.]+ ms per draw on WebGL 2\)$/);
    const first = await readout.textContent();
    const picked = (await lighting(page)).preset;
    await expect(page.locator("#graphics-preset")).toHaveValue(picked);
    const kept = JSON.parse((await page.evaluate(() => window.localStorage.getItem("city-council:graphics"))) ?? "null") as {
      preset: string;
      source: string;
      benchmarkMs: number;
    };
    expect(kept).toMatchObject({ preset: picked, source: "benchmark" });
    console.log(`benchmark on this machine: ${first}`);
    await attach(testInfo, "debug panel after the benchmark", await page.screenshot());

    await page.reload();
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    expect((await lighting(page)).preset).toBe(picked);
    await expect(readout).toHaveText(new RegExp(`picked by the benchmark on an earlier visit: ${kept.benchmarkMs.toFixed(1).replace(".", "\\.")} ms per draw`));
  });

  test("the settings change the preset, and the choice is kept", async ({ page }) => {
    await page.goto("/?webgl&preset=low&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    await page.locator("#graphics-preset").selectOption("high");
    await presetSettled(page);
    expect((await lighting(page)).preset).toBe("high");
    await expect(page.locator("#render-preset")).toHaveText(/^High \(chosen in settings/);

    // Without ?preset= the kept choice applies, and the benchmark does not run.
    await page.goto("/?webgl&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    expect((await lighting(page)).preset).toBe("high");
    await expect(page.locator("#graphics-preset")).toHaveValue("high");
  });
});
