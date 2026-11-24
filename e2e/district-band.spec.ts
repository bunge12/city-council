import { expect, test } from "@playwright/test";
import { MEASURE_VIEWPORT, type Vec3, attachCanvas, drawnNow, openTown, poseAndSettle, scaleCity, stats, writeReport } from "./building-lod-helpers";
import { heightAt } from "../packages/sim/src/index";
import { frames, settle } from "./helpers";
import { frameTime, perfFigures } from "./measure";
import budgets from "../packages/client/src/render/frame-budgets.json" with { type: "json" };

// Issue #165: the district band's workload on the scale town, split by
// layer, and held to the Low reference class's budget in
// packages/client/src/render/frame-budgets.json. No reference machine is to
// hand, and software WebGL's frame time says little about a GPU, so the
// budget is on what the frame asks of the GPU: draw calls and triangles,
// which are the same on every machine. For each layer the spec hides it,
// draws, and reports what the frame lost: its draw calls and its triangles.
// Software frame time per layer was tried and was noise, 15 percent either
// way between runs, so only the whole frame is timed. It measures at 1,300 m
// at Low with the zoning overlay off and on and at Balanced, whose shadow
// pass draws the casters a second time, and near the top of the band at Low.
// The budget leaves out fill: on integrated graphics a frame at 1280 x 800
// can be limited by the pixels it shades, which no count here holds. Written
// to test-results/district-band-report.json.

declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    view: Promise<{
      setPreset(preset: string): Promise<void>;
      scene: SceneNode;
      renderer: { getContext?(): unknown; backend?: { gl?: WebGLContext } };
    }>;
  };
};
interface SceneNode {
  name: string;
  visible: boolean;
  isMesh?: boolean;
  layers: { enable(n: number): void; disable(n: number): void };
  children: SceneNode[];
}
interface WebGLContext {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
}
declare const document: { body: { dataset: Record<string, string | undefined> }; querySelector(s: string): unknown };

test.use({ viewport: MEASURE_VIEWPORT });

interface LayerCost {
  meshes: number;
  drawCalls: number;
  triangles: number;
}
interface Workload {
  frameMs: number;
  drawCalls: number;
  triangles: number;
  layers: Record<string, LayerCost>;
  unassigned: { drawCalls: number; triangles: number };
}

/** A layer's name for a mesh: its own name without chunk numbers, or the nearest named parent's. Terrain chunks are LODs named "chunk i,j" over unnamed meshes. */
const LAYER_OF = `(node, inherited) => (node.name.replace(/[\\d,\\s]+$/, "") || inherited)`;

/** Shown meshes by layer, each with how many it has. */
async function layers(page: import("@playwright/test").Page): Promise<Record<string, number>> {
  return page.evaluate(async (layerOf) => {
    const of = new Function(`return ${layerOf}`)() as (node: SceneNode, inherited: string) => string;
    const view = await window.cityCouncil.view;
    const out: Record<string, number> = {};
    const walk = (node: SceneNode, inherited: string) => {
      if (!node.visible) return;
      const layer = of(node, inherited);
      if (node.isMesh) out[layer] = (out[layer] ?? 0) + 1;
      for (const c of node.children) walk(c, layer);
    };
    walk(view.scene, "unnamed");
    return out;
  }, LAYER_OF);
}

/**
 * Takes every shown mesh of `layer` off the camera's render layer, or with
 * null puts back the ones taken off. Not `visible`: the terrain's LODs and
 * the building layer set that themselves each frame. Cheap frames would not
 * draw again for it, since the frame signature does not see layers, so this
 * needs the perf project's every-frame drawing (MEASURE_STATE).
 */
async function hide(page: import("@playwright/test").Page, layer: string | null): Promise<void> {
  await page.evaluate(
    async ([layer, layerOf]) => {
      const of = new Function(`return ${layerOf}`)() as (node: SceneNode, inherited: string) => string;
      const view = await window.cityCouncil.view;
      const w = window as unknown as { hidden165?: SceneNode[] };
      for (const m of w.hidden165 ?? []) m.layers.enable(0);
      w.hidden165 = [];
      if (layer === null) return;
      const walk = (node: SceneNode, inherited: string) => {
        if (!node.visible) return;
        const name = of(node, inherited);
        if (node.isMesh && name === layer) {
          node.layers.disable(0);
          w.hidden165?.push(node);
        }
        for (const c of node.children) walk(c, name);
      };
      walk(view.scene, "unnamed");
    },
    [layer, LAYER_OF] as const,
  );
  await frames(page, 3);
}

/**
 * The frame's workload, and with `split` what each layer adds to it: what
 * the frame loses when the layer is hidden. `unassigned` is what no layer
 * accounts for, which the test holds to the output pass alone, so a drawable
 * that is not a mesh, or a layer that hides another, shows.
 */
async function workload(page: import("@playwright/test").Page, split: boolean): Promise<Workload> {
  const all = await drawnNow(page);
  const frameMs = Math.round((await frameTime(page, 20)) * 10) / 10;
  const out: Workload = { frameMs, drawCalls: all.drawCalls, triangles: all.triangles, layers: {}, unassigned: { drawCalls: 0, triangles: 0 } };
  if (!split) return out;
  for (const [layer, meshes] of Object.entries(await layers(page))) {
    await hide(page, layer);
    const without = await drawnNow(page);
    out.layers[layer] = { meshes, drawCalls: all.drawCalls - without.drawCalls, triangles: all.triangles - without.triangles };
  }
  await hide(page, null);
  const sum = (key: "drawCalls" | "triangles") => Object.values(out.layers).reduce((n, l) => n + l[key], 0);
  out.unassigned = { drawCalls: all.drawCalls - sum("drawCalls"), triangles: all.triangles - sum("triangles") };
  return out;
}

/** Turns the zoning overlay on or off, as the zone and road tools show it, and waits for its cells. */
async function overlay(page: import("@playwright/test").Page, on: boolean): Promise<void> {
  await page.locator("#view").focus();
  await page.keyboard.press("k");
  await page.waitForFunction((on) => document.body.dataset["zoningOverlay"] === String(on), on);
  await settle(page, { timeout: 300_000 });
}

/** The GPU the page draws on, from WEBGL_debug_renderer_info where the browser gives it. */
async function gpu(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const gl = view.renderer.backend?.gl;
    if (!gl) return "unknown";
    const info = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : 0x1f01));
  });
}

test("the district band's workload by layer, held to the Low reference class's budget", async ({ page }, testInfo) => {
  const { bands, terrain } = scaleCity();
  const district = bands.find((b) => b.band === "district");
  if (!district) throw new Error("no district band pose");
  // The band runs from 500 to 3,000 m. The spec's pose is at 1,300 m, under
  // the 1,400 m where lane markings stop; near the top more chunks are in
  // view, and terrain and roads are a mesh per chunk. So the top is held too,
  // at 2,700 m over the ground under the camera, looking at the same point.
  const [x, , z] = district.position;
  const [tx, ty, tz] = district.target;
  const topZ = tz + (z - tz) * (2700 / 1300);
  const top: Vec3 = [x, heightAt(terrain, x, topZ) + 2700, topZ];
  await openTown(page);
  await poseAndSettle(page, district.position, district.target);
  expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe("district");
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const report: Record<string, unknown> = { backend, gpu: await gpu(page), forms: (await stats(page)).forms };

  const low = await workload(page, true);
  report["low"] = low;
  await attachCanvas(page, testInfo, "scale town, district band, low");
  await overlay(page, true);
  const lowOverlay = await workload(page, true);
  report["lowOverlay"] = lowOverlay;
  await attachCanvas(page, testInfo, "scale town, district band, low, zoning overlay");
  await overlay(page, false);

  // Balanced: the shadow pass, no layer split.
  await page.evaluate(async () => (await window.cityCouncil.view).setPreset("balanced"));
  await settle(page, { timeout: 300_000 });
  const balanced = await workload(page, false);
  report["balanced"] = balanced;
  await attachCanvas(page, testInfo, "scale town, district band, balanced");
  await page.evaluate(async () => (await window.cityCouncil.view).setPreset("low"));

  // The top of the band, at Low, with the overlay off and on.
  await poseAndSettle(page, top, [tx, ty, tz]);
  expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe("district");
  const high = await workload(page, true);
  report["high"] = { position: top, ...high };
  await attachCanvas(page, testInfo, "scale town, top of the district band, low");
  await overlay(page, true);
  const highOverlay = await workload(page, false);
  report["highOverlay"] = highOverlay;

  await writeReport(testInfo, "#165 district band workload on the scale town", "district-band-report.json", report);
  perfFigures("district-band", `scale town, district band, ${backend}`, {
    "1,300 m, Low (ms)": low.frameMs,
    "1,300 m, Low, draw calls": low.drawCalls,
    "1,300 m, Low, triangles (k)": low.triangles / 1000,
    "1,300 m, Low with overlay, draw calls": lowOverlay.drawCalls,
    "1,300 m, Low with overlay, triangles (k)": lowOverlay.triangles / 1000,
    "1,300 m, Balanced (ms)": balanced.frameMs,
    "1,300 m, Balanced, draw calls": balanced.drawCalls,
    "1,300 m, Balanced, triangles (k)": balanced.triangles / 1000,
    "2,700 m, Low (ms)": high.frameMs,
    "2,700 m, Low, draw calls": high.drawCalls,
    "2,700 m, Low, triangles (k)": high.triangles / 1000,
    "2,700 m, Low with overlay, draw calls": highOverlay.drawCalls,
    "2,700 m, Low with overlay, triangles (k)": highOverlay.triangles / 1000,
  });

  // Every draw call and triangle is in some layer but one: three.js's output
  // pass, which draws the frame from its own target to the canvas as one
  // triangle over the screen, outside the scene. So the split is whole.
  for (const w of [low, lowOverlay, high]) expect(w.unassigned).toEqual({ drawCalls: 1, triangles: 1 });
  // The Low reference class's budget, after the report is written.
  const budget = budgets.districtBand.low;
  for (const w of [low, lowOverlay, high, highOverlay]) {
    expect(w.drawCalls).toBeLessThanOrEqual(budget.drawCalls);
    expect(w.triangles).toBeLessThanOrEqual(budget.triangles);
  }
});
