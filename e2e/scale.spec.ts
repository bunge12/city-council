import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { buildScaleCity, createState, heightAt, generateTerrain, serialize } from "../packages/sim/src/index";
import { canvasShot, openCity, settle } from "./helpers";
import { frameTime, memory, perfFigures } from "./measure";

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

test.use({ viewport: { width: 1280, height: 800 } });
// Two cities, three bands each, drawn in software on a CI runner at about
// 2 fps. On main it took 294.7 s of the old 300 s (run 43548591694), so the
// wait for the graphics preset (issue M2-02) tipped it over. Seven minutes
// leaves room without hiding a real slowdown: the frame-time asserts do that.
test.setTimeout(420_000);

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

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/** Frame time in each band, after the view settles there, with a screenshot of each when `testInfo` is given. */
async function bandTimes(page: Page, testInfo?: TestInfo): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { band, position, target } of BANDS) {
    await setPose(page, position, target);
    await settle(page, { maxFrames: 120 });
    expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
    out[band] = Math.round((await frameTime(page, 40)) * 10) / 10;
    if (testInfo) await attach(page, testInfo, `scale city, ${band} band`);
  }
  return out;
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await canvasShot(page));
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the M1 scale city: frame time in each zoom band, and the tab's memory", async ({ page }, testInfo) => {
  const t0 = Date.now();
  const lap = (what: string) => console.log(`scale spec: ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await openCity(page, createState(scale.state.seed), { query: scaleQuery, name: "Empty", presetSettled: true, timeout: 120_000 });
  lap("empty city open");
  const empty = await bandTimes(page);
  const emptyMemory = await memory(page);
  lap("empty city measured");

  const bytes = serialize(scale.state);
  await openCity(page, bytes, { query: scaleQuery, name: "Scale", presetSettled: true, timeout: 120_000 });
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
  perfFigures(reportName.replace(/\.json$/, ""), `M1 scale city, ${backend}, ${report.preset ?? "?"}`, {
    ...Object.fromEntries(BANDS.flatMap(({ band }) => [
      [`${band} band, empty map (ms)`, empty[band]],
      [`${band} band, 30,000 segments (ms)`, roads[band]],
    ])),
    "tab memory, city (MB)": cityMemory.pageMb + (cityMemory.workerMb ?? 0),
  });

  expect(stats?.segmentPieces ?? 0).toBeGreaterThan(30_000);
  // Gross regressions only: no band's frame more than three times the
  // empty map's at the same pose, or over the 55 fps line if that is
  // looser, as roads.spec.ts holds the city band. The PRD budgets 500 MB
  // for the tab at full size; M1's roads are a small part of it.
  for (const { band } of BANDS) expect(roads[band] ?? 0, band).toBeLessThan(Math.max(1000 / 55, (empty[band] ?? 0) * 3));
  expect(cityMemory.pageMb + (cityMemory.workerMb ?? 0)).toBeLessThan(500);
});
