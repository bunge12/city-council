import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { buildScaleCity, createState, heightAt, generateTerrain, serialize } from "../packages/sim/src/index";

// The M1 scale check in the browser (issue M1-17): the city `buildScaleCity`
// makes through commands, 30,000 road segments of street grids, curves and
// bridges on seed 2026, loaded as a city file. Measures the frame time in
// each zoom band against the empty map at the same pose, and the tab's
// memory, and writes them to test-results/scale-report.json for the pull
// request. The sim side, tick times included, is measured by
// `pnpm bench` (scale.bench.ts) and `pnpm soak`.
//
// CI runners have no GPU and draw in software, so the checks here only
// catch a gross regression; the numbers are the point.

type Vec3 = readonly [number, number, number];
interface RoadStats {
  chunks: number;
  segmentPieces: number;
  lastBuildMs: number;
}
declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    mirror: { state: { roads: { segFlags: ArrayLike<number> } } | null };
    view: Promise<{ roadStats(): RoadStats | null; decorCounts(): unknown }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const performance: { now(): number };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(300_000);

const scale = buildScaleCity();
const terrain = generateTerrain(scale.state.seed);

/** The grid nearest the middle of the map, so every band has roads all round. */
const centre = scale.grids.reduce((best, g) => (Math.hypot(g.x - 6000, g.z - 6000) < Math.hypot(best.x - 6000, best.z - 6000) ? g : best));
const focus = { x: centre.x + 288, z: centre.z + 288 };
const ground = heightAt(terrain, focus.x, focus.z);

/** A camera pose per zoom band, as in roads.spec.ts, over the middle grid. */
const BANDS: { band: string; position: Vec3; target: Vec3 }[] = [
  { band: "street", position: [focus.x, ground + 190, focus.z + 170], target: [focus.x, ground, focus.z] },
  { band: "district", position: [focus.x, ground + 1300, focus.z + 900], target: [focus.x, ground, focus.z] },
  { band: "city", position: [6000, 8400, 15_800], target: [6000, 0, 5600] },
];

/**
 * The address the city opens at. CI measures `?webgl` at the Low preset the
 * test browser keeps. For the per-preset numbers in a pull request set
 * SCALE_PRESET to low, balanced or high, and SCALE_WEBGPU=1 to leave out
 * `?webgl` (issue M2-02), in the `roads` project for headed WebGPU.
 */
const scalePreset = process.env["SCALE_PRESET"];
const scaleQuery = [process.env["SCALE_WEBGPU"] ? "" : "webgl", scalePreset ? `preset=${scalePreset}` : ""].filter(Boolean).join("&");
const reportName = `scale-report${scalePreset ? `-${scalePreset}` : ""}${process.env["SCALE_WEBGPU"] ? "-webgpu" : ""}.json`;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 120_000 });
}

/** Opens the page, imports `bytes` as a city and waits for it to be drawn. */
async function openCity(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.goto(`/?${scaleQuery}`);
  await ready(page);
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/** Waits until decoration near the camera has finished building: its counts hold for ten frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let last = "";
    let steady = 0;
    for (let f = 0; f < 120 && steady < 10; f++) {
      await frame();
      const now = JSON.stringify(view.decorCounts());
      steady = now === last ? steady + 1 : 0;
      last = now;
    }
  });
}

/** Mean time between `frames` animation frames, in ms. */
async function frameTime(page: Page, frames: number): Promise<number> {
  return page.evaluate(async (frames) => {
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      let last = -1;
      const tick = (now: number) => {
        if (last >= 0) times.push(now - last);
        last = now;
        if (times.length < frames) requestAnimationFrame(() => tick(performance.now()));
        else resolve();
      };
      requestAnimationFrame(() => tick(performance.now()));
    });
    return times.reduce((a, b) => a + b, 0) / times.length;
  }, frames);
}

/** Frame time in each band, after the view settles there, with a screenshot of each when `testInfo` is given. */
async function bandTimes(page: Page, testInfo?: TestInfo): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { band, position, target } of BANDS) {
    await setPose(page, position, target);
    await settle(page);
    expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
    out[band] = Math.round((await frameTime(page, 40)) * 10) / 10;
    if (testInfo) await attach(page, testInfo, `scale city, ${band} band`);
  }
  return out;
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * The tab's JS heap after a full collection: the page's and the sim
 * worker's, each read through the DevTools protocol. The worker is reached
 * by auto-attaching to the page's child targets.
 */
async function memory(page: Page): Promise<{ pageMb: number; workerMb: number | null }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;

  // Messages to the worker go through the page's session, by session id.
  const workers: string[] = [];
  cdp.on("Target.attachedToTarget", (e) => {
    if (e.targetInfo.type === "worker") workers.push(e.sessionId);
  });
  const replies = new Map<number, (result: Record<string, unknown>) => void>();
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    const message = JSON.parse(e.message) as { id?: number; result?: Record<string, unknown> };
    if (message.id !== undefined) replies.get(message.id)?.(message.result ?? {});
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  let id = 0;
  const ask = (sessionId: string, method: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const n = ++id;
      replies.set(n, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
      void cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method }) });
    });
  let worker: number | null = null;
  for (const sessionId of workers) {
    try {
      await ask(sessionId, "HeapProfiler.collectGarbage");
      const usage = await ask(sessionId, "Runtime.getHeapUsage");
      worker = (worker ?? 0) + Number(usage["usedSize"] ?? 0);
    } catch {
      // A worker that does not answer is left out; the report says null.
    }
  }
  await cdp.detach();
  return { pageMb: mb(used), workerMb: worker === null ? null : mb(worker) };
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.locator("#view").screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the M1 scale city: frame time in each zoom band, and the tab's memory", async ({ page }, testInfo) => {
  const t0 = Date.now();
  const lap = (what: string) => console.log(`scale spec: ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await openCity(page, "Empty", Buffer.from(serialize(createState(scale.state.seed))));
  lap("empty city open");
  const empty = await bandTimes(page);
  const emptyMemory = await memory(page);
  lap("empty city measured");

  const bytes = Buffer.from(serialize(scale.state));
  await openCity(page, "Scale", bytes);
  lap("scale city open");
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const segments = await page.evaluate(() => {
    const flags = window.cityCouncil.mirror.state?.roads.segFlags;
    let n = 0;
    for (let s = 0; s < (flags?.length ?? 0); s++) if ((flags?.[s] ?? 0) & 1) n++;
    return n;
  });
  expect(segments).toBe(scale.counts.segments);
  const roads = await bandTimes(page, testInfo);
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).roadStats());
  const cityMemory = await memory(page);
  lap("scale city measured");

  const report = {
    backend,
    preset: await page.evaluate(() => document.body.dataset["preset"]),
    city: { ...scale.counts, fileBytes: bytes.byteLength },
    frameMs: Object.fromEntries(BANDS.map(({ band }) => [band, { empty: empty[band], roads: roads[band] }])),
    roadMesh: stats,
    memoryMb: { empty: emptyMemory, city: cityMemory },
  };
  console.log(`M1 scale city in the browser: ${JSON.stringify(report, null, 2)}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync(`test-results/${reportName}`, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("scale report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });

  expect(stats?.segmentPieces ?? 0).toBeGreaterThan(30_000);
  // Gross regressions only: no band's frame more than three times the
  // empty map's at the same pose, or over the 55 fps line if that is
  // looser, as roads.spec.ts holds the city band. The PRD budgets 500 MB
  // for the tab at full size; M1's roads are a small part of it.
  for (const { band } of BANDS) expect(roads[band] ?? 0, band).toBeLessThan(Math.max(1000 / 55, (empty[band] ?? 0) * 3));
  expect(cityMemory.pageMb + (cityMemory.workerMb ?? 0)).toBeLessThan(500);
});
