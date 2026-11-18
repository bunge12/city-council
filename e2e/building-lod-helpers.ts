// Shared by the M2-13 building level of detail specs: building-lod.spec.ts
// (the fixture city in all three bands), building-lod-scale.spec.ts and
// building-lod-scale-balanced.spec.ts (frame time and memory on the scale
// city with buildings, at Low and at Balanced), building-lod-overlay.spec.ts
// (the zoning overlay over it in the city band) and
// building-lod-memory.spec.ts (flying a loop twice). Split up so CI can deal
// them to different runners.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { finishConstruction } from "./building-fixtures";
import { frameTime, mb, memory } from "./measure";
import { BUILDINGS } from "../packages/client/src/render/config";
import { CHUNKS_PER_SIDE, CHUNK_SIZE, buildScaleCity, generateTerrain, growScaleCity, heightAt, serialize } from "../packages/sim/src/index";

export type Vec3 = readonly [number, number, number];
export type Form = "full" | "simple" | "box" | "flat";
export interface FormStats {
  chunks: number;
  buildings: number;
  meshes: number;
}
export interface BuildingStats {
  buildings: number;
  models: number;
  pending: number;
  totalWrites: number;
  totalMerged: number;
  mergedBytes: { simple: number; box: number; flat: number };
  forms: Record<Form, FormStats>;
  fading: number;
  waiting: number;
}
declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    view: Promise<{
      buildingStats(): BuildingStats | null;
      buildingForm(chunk: number): Form | null;
      decorCounts(): unknown;
      setPreset(preset: string): Promise<void>;
      lighting(): { preset: string; shadows: boolean };
      renderer: { info: { render: { drawCalls: number; triangles: number }; memory: { geometries: number; textures: number } } };
      scene: SceneNode;
    }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
/** Just enough of a three.js object to walk the scene. */
interface SceneNode {
  name: string;
  visible: boolean;
  isMesh?: boolean;
  children: SceneNode[];
}
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 120_000 });
}

/** Opens the page, imports `bytes` as a city and waits for it to be drawn. */
export async function openCity(page: Page, query: string, name: string, bytes: Buffer): Promise<void> {
  await page.goto(`/?${query}`);
  await ready(page);
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

export async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/**
 * Waits until every chunk of buildings shows the form it wants, with no fade
 * under way, and decoration near the camera has finished building: its
 * counts hold for ten frames.
 */
export async function settle(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["buildingsSettled"] === "true", null, { timeout });
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
  await page.waitForFunction(() => document.body.dataset["buildingsSettled"] === "true", null, { timeout });
}

export async function stats(page: Page): Promise<BuildingStats> {
  const s = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  if (!s) throw new Error("no building layer");
  return s;
}

/**
 * The canvas, which fills the page, without the UI over it. A screenshot of
 * the page, not of the canvas element: an element screenshot first waits
 * for the element to hold still over animation frames, which took about 10 s
 * on the scale town in software WebGL (issue #217), against 3 s for the page.
 */
export async function canvasShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await page.addStyleTag({ content: "#ui { display: block !important; }" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export const chunkAt = (x: number, z: number): number => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);

/** Built once, by the first test that needs it, so the fixture's tests do not wait for it. */
let built: ReturnType<typeof scaleTown> | null = null;
function scaleTown() {
  const city = buildScaleCity();
  const town = growScaleCity(city);
  // Past the construction animation (issue 136): every building was grown on one tick.
  finishConstruction(city.state);
  const terrain = generateTerrain(city.state.seed);
  const centre = city.grids.reduce((best, g) => (Math.hypot(g.x - 6000, g.z - 6000) < Math.hypot(best.x - 6000, best.z - 6000) ? g : best));
  const focus = { x: centre.x + 288, z: centre.z + 288 };
  const ground = heightAt(terrain, focus.x, focus.z);
  /** A camera pose per zoom band, as in scale.spec.ts, over the middle grid. */
  const bands: { band: string; position: Vec3; target: Vec3 }[] = [
    { band: "street", position: [focus.x, ground + 190, focus.z + 170], target: [focus.x, ground, focus.z] },
    { band: "district", position: [focus.x, ground + 1300, focus.z + 900], target: [focus.x, ground, focus.z] },
    { band: "city", position: [6000, 8400, 15_800], target: [6000, 0, 5600] },
  ];
  return { city, town, terrain, bands, bytes: Buffer.from(serialize(city.state)) };
}
export const scaleCity = () => (built ??= scaleTown());

/**
 * The scale town's specs take their figures and screenshots at
 * `MEASURE_VIEWPORT`, and wait for the town to fill in and settle at
 * `WAIT_VIEWPORT` (issue #217). Chunks of buildings, decoration and zoning
 * cells are built a few each frame, so the waits last a number of frames,
 * and in software WebGL a frame of the scale town at full size takes 0.4 to
 * 0.8 s. At 160 x 100 the town loads in about half the time. Nothing built
 * depends on the size: chunks are chosen by distance from the camera, and
 * the two sizes have the same aspect, so the camera sees the same frustum.
 */
export const MEASURE_VIEWPORT = { width: 1280, height: 800 } as const;
export const WAIT_VIEWPORT = { width: 160, height: 100 } as const;

/** Moves the camera and waits, small, until the buildings and decoration settle; then goes back to full size. */
export async function poseAndSettle(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.setViewportSize(WAIT_VIEWPORT);
  await setPose(page, position, target);
  await settle(page, 300_000);
  // A resize builds nothing: two frames drawn at full size, and the buildings still settled.
  await fullSize(page);
  await page.waitForFunction(() => document.body.dataset["buildingsSettled"] === "true", null, { timeout: 300_000 });
}

/** What the page draws now: draw calls, triangles and the meshes shown in each layer. */
export async function drawnNow(page: Page): Promise<{ drawCalls: number; triangles: number; meshesByLayer: Record<string, number> }> {
  return page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    // Meshes shown, by the layer they belong to: the scene's child they are under, its name without chunk numbers. Not culled to the view, so an upper bound on draw calls.
    const meshes: Record<string, number> = {};
    const walk = (node: SceneNode, layer: string) => {
      if (!node.visible) return;
      if (node.isMesh) meshes[layer] = (meshes[layer] ?? 0) + 1;
      for (const child of node.children) walk(child, layer);
    };
    for (const child of view.scene.children) walk(child, child.name.replace(/[\d,\s]+$/, "") || "unnamed");
    return { drawCalls: view.renderer.info.render.drawCalls, triangles: view.renderer.info.render.triangles, meshesByLayer: meshes };
  });
}

/** One band's figures in the report. */
export interface BandReport {
  frameMs: number;
  drawCalls: number;
  triangles: number;
  meshesByLayer: Record<string, number>;
  forms: Record<Form, FormStats> | undefined;
  memoryMb: { pageMb: number; workerMb: number | null; merged: { simpleMb: number; boxMb: number; flatMb: number } };
}

/**
 * Frame time, draw calls, what each level of detail drew and the tab's
 * memory in each zoom band at one graphics preset, with a screenshot of
 * each. `checkBands` checks them, after the report is written.
 */
export async function measureBands(page: Page, testInfo: TestInfo, preset: "low" | "balanced"): Promise<Record<string, BandReport>> {
  const { bands: BANDS } = scaleCity();
  await page.evaluate(async (p) => (await window.cityCouncil.view).setPreset(p), preset);
  expect(await page.evaluate(async () => (await window.cityCouncil.view).lighting().shadows)).toBe(preset !== "low");
  const bands: Record<string, BandReport> = {};
  for (const { band, position, target } of BANDS) {
    await poseAndSettle(page, position, target);
    expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
    const frameMs = Math.round((await frameTime(page, 30)) * 10) / 10;
    const drawn = await drawnNow(page);
    const s = await stats(page);
    // The heap leaves out typed-array storage, so the merged meshes' geometry is reported on its own.
    const merged = { simpleMb: mb(s.mergedBytes.simple), boxMb: mb(s.mergedBytes.box), flatMb: mb(s.mergedBytes.flat) };
    bands[band] = { frameMs, ...drawn, forms: s.forms, memoryMb: { ...(await memory(page)), merged } };
    await canvasShot(page, testInfo, `scale city with buildings, ${band} band, ${preset}`);
  }
  return bands;
}

/** The far bands draw no building in full, the city band merges its blocks, and the tab stays inside the PRD's 500 MB. */
export function checkBands(bands: Record<string, BandReport>): void {
  // The far bands draw no building in full, and the city band one cheap mesh per chunk at most.
  expect(bands["district"]?.forms?.full.buildings).toBe(0);
  expect(bands["city"]?.forms?.full.buildings).toBe(0);
  expect(bands["city"]?.forms?.simple.meshes).toBe(0);
  expect(bands["city"]?.forms?.box.meshes).toBe(0);
  // Flat blocks are merged by groups of chunks (issue #133): 36 meshes at most on the 12 km map.
  expect(bands["city"]?.forms?.flat.meshes).toBeLessThanOrEqual(Math.ceil(CHUNKS_PER_SIDE / BUILDINGS.flatGroup) ** 2);
  // The PRD budgets 500 MB for the tab at full size.
  const m = bands["city"]?.memoryMb;
  expect((m?.pageMb ?? 0) + (m?.workerMb ?? 0) + (m?.merged.simpleMb ?? 0) + (m?.merged.boxMb ?? 0) + (m?.merged.flatMb ?? 0)).toBeLessThan(500);
}

/** Back to `MEASURE_VIEWPORT` from waiting small: two frames drawn at full size. */
export async function fullSize(page: Page): Promise<void> {
  await page.setViewportSize(MEASURE_VIEWPORT);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Prints a scale town report, writes it to test-results/`file` for the pull request and attaches it. */
export async function writeReport(testInfo: TestInfo, title: string, file: string, report: unknown): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  console.log(`${title}: ${json}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync(`test-results/${file}`, `${json}\n`);
  await testInfo.attach(title, { body: json, contentType: "application/json" });
}

/** Opens the scale town at Low, small (see `WAIT_VIEWPORT`), and waits until every building is drawn. */
export async function openTown(page: Page): Promise<void> {
  const { town, bytes } = scaleCity();
  await page.setViewportSize(WAIT_VIEWPORT);
  await openCity(page, "webgl&preset=low", "Town", bytes);
  // Every chunk read from the mirror: a snapshot fills in over frames.
  await page.waitForFunction((n) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(n), town.buildings, { timeout: 300_000 });
}
