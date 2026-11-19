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
import { buildingsDrawn, canvasShot, frames, openCity, settle } from "./helpers";
import { frameTime, mb, memory, perfFigures } from "./measure";
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

export async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

export async function stats(page: Page): Promise<BuildingStats> {
  const s = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  if (!s) throw new Error("no building layer");
  return s;
}

/** The canvas without the UI over it, attached to the test as `name`. */
export async function attachCanvas(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await canvasShot(page));
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The fixture or scale town, opened and drawn with the graphics preset settled, and the notes hidden. */
export async function openFixture(page: Page, query: string, name: string, bytes: Uint8Array): Promise<void> {
  await openCity(page, bytes, { query, name, presetSettled: true, timeout: 120_000 });
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
  await settle(page, { timeout: 300_000 });
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
    await attachCanvas(page, testInfo, `scale city with buildings, ${band} band, ${preset}`);
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

/** Each band's frame time and draw calls, for the perf run's table (issue #225). */
export function bandFigures(name: string, title: string, bands: Record<string, BandReport>): void {
  perfFigures(
    name,
    title,
    Object.fromEntries(
      Object.entries(bands).flatMap(([band, b]) => [
        [`${band} band (ms)`, b.frameMs],
        [`${band} band, draw calls`, b.drawCalls],
      ]),
    ),
  );
}

/** Back to `MEASURE_VIEWPORT` from waiting small: two frames drawn at full size. */
export async function fullSize(page: Page): Promise<void> {
  await page.setViewportSize(MEASURE_VIEWPORT);
  await frames(page);
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
  await openFixture(page, "webgl&preset=low", "Town", bytes);
  // Every chunk read from the mirror. Players see a snapshot fill in over
  // frames, at least one chunk a frame, which on the town is 576 frames; the
  // flush reads them all at once (issue #223).
  await settle(page, { timeout: 300_000 });
  await buildingsDrawn(page, town.buildings, 60_000);
}
