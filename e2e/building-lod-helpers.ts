// Shared by the M2-13 building level of detail specs: building-lod.spec.ts
// (the fixture city in all three bands), building-lod-scale.spec.ts (frame
// time and memory on the scale city with buildings) and
// building-lod-memory.spec.ts (flying a loop twice). Split in three so CI
// can deal them to different runners.

import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { CHUNKS_PER_SIDE, CHUNK_SIZE, buildScaleCity, generateTerrain, growScaleCity, heightAt, serialize } from "../packages/sim/src/index";

export type Vec3 = readonly [number, number, number];
export type Form = "full" | "simple" | "flat";
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
  mergedBytes: number;
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
    }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
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

export async function canvasShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.locator("#view").screenshot());
  await page.addStyleTag({ content: "#ui { display: block !important; }" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export const chunkAt = (x: number, z: number): number => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);

/** Built once, by the first test that needs it, so the fixture's tests do not wait for it. */
let built: ReturnType<typeof scaleTown> | null = null;
function scaleTown() {
  const city = buildScaleCity();
  const town = growScaleCity(city);
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
