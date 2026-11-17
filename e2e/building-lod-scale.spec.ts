import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CHUNKS_PER_SIDE, ZONING_BALANCE } from "../packages/sim/src/index";
import { canvasShot, openCity, scaleCity, setPose, settle, type BuildingStats, type Form, type FormStats } from "./building-lod-helpers";
import { frameTime, mb, memory } from "./measure";

// Issue M2-13: the M1 scale city filled with buildings through commands and
// the grower (growScaleCity). Frame time, draw calls, what each level of
// detail drew and the tab's memory in each zoom band, at Low and at
// Balanced, written to test-results/building-lod-report.json for the pull
// request. Since M2-17 it also checks the top bar's homes figure against the
// town and times a save of it from the page, the snapshot and the write to
// IndexedDB together. CI runners have no GPU and draw in software, so the frame times
// only catch a gross regression; the numbers are the point.

declare const window: {
  cityCouncil: {
    renderStatus(): { backend: string } | null;
    saveNow(): Promise<{ lastSave: { tick: number } | null; saveError: string | null }>;
    mirror: { state: { buildings: { flags: Uint8Array; zone: Uint8Array } } | null };
    view: Promise<{
      buildingStats(): BuildingStats | null;
      setPreset(preset: string): Promise<void>;
      lighting(): { preset: string; shadows: boolean };
      renderer: { info: { render: { drawCalls: number; triangles: number } } };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const performance: { now(): number };

test.use({ viewport: { width: 1280, height: 800 } });
// A city of 30,000 segments and tens of thousands of buildings in software WebGL, about 2 fps on a CI runner.
test.setTimeout(900_000);

test("frame time, draw calls and memory in each band, at Low and at Balanced", async ({ page }, testInfo) => {
  const { city, town, bands: BANDS, bytes } = scaleCity();
  await openCity(page, "webgl&preset=low", "Town", bytes);
  // Every chunk read from the mirror: a snapshot fills in over frames.
  await page.waitForFunction((n) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(n), town.buildings, { timeout: 300_000 });
  const backend = (await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend ?? "none";
  const report: Record<string, unknown> = { backend, city: { ...city.counts, ...town, fileBytes: bytes.byteLength } };
  // The top bar's homes (M2-18): every residential building of the town.
  const residential = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;
  const homes = city.state.buildings.zone.reduce((n, zone, id) => n + (city.state.buildings.flags[id] && zone === residential ? 1 : 0), 0);
  await expect(page.locator("#homes-count")).toHaveText(homes.toLocaleString("en-US"));
  // A save of the whole town from the page: the snapshot in the worker and the write to IndexedDB. The first compiles the code.
  const saveMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    saveMs.push(
      await page.evaluate(async () => {
        const t0 = performance.now();
        const status = await window.cityCouncil.saveNow();
        if (status.saveError || !status.lastSave) throw new Error(status.saveError ?? "not saved");
        return Math.round(performance.now() - t0);
      }),
    );
  }
  report["homes"] = homes;
  report["saveMs"] = saveMs;
  for (const preset of ["low", "balanced"] as const) {
    await page.evaluate(async (p) => (await window.cityCouncil.view).setPreset(p), preset);
    expect(await page.evaluate(async () => (await window.cityCouncil.view).lighting().shadows)).toBe(preset !== "low");
    const bands: Record<string, unknown> = {};
    for (const { band, position, target } of BANDS) {
      await setPose(page, position, target);
      await settle(page, 300_000);
      expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      const frameMs = Math.round((await frameTime(page, 30)) * 10) / 10;
      const info = await page.evaluate(async () => {
        const view = await window.cityCouncil.view;
        const s = view.buildingStats();
        return { draws: view.renderer.info.render.drawCalls, triangles: view.renderer.info.render.triangles, forms: s?.forms, mergedBytes: s?.mergedBytes };
      });
      // The heap leaves out typed-array storage, so the merged meshes' geometry is reported on its own.
      const merged = { simpleMb: mb(info.mergedBytes?.simple ?? 0), boxMb: mb(info.mergedBytes?.box ?? 0), flatMb: mb(info.mergedBytes?.flat ?? 0) };
      bands[band] = { frameMs, drawCalls: info.draws, triangles: info.triangles, forms: info.forms, memoryMb: { ...(await memory(page)), merged } };
      await canvasShot(page, testInfo, `scale city with buildings, ${band} band, ${preset}`);
    }
    report[preset] = bands;
  }
  console.log(`M2-13 scale city with buildings: ${JSON.stringify(report, null, 2)}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/building-lod-report.json", `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("building LOD report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  for (const preset of ["low", "balanced"] as const) {
    const bands = report[preset] as Record<string, { frameMs: number; forms: Record<Form, FormStats>; memoryMb: { pageMb: number; workerMb: number | null; merged: { simpleMb: number; boxMb: number; flatMb: number } } }>;
    // The far bands draw no building in full, and the city band one cheap mesh per chunk at most.
    expect(bands["district"]?.forms.full.buildings).toBe(0);
    expect(bands["city"]?.forms.full.buildings).toBe(0);
    expect(bands["city"]?.forms.simple.meshes).toBe(0);
    expect(bands["city"]?.forms.box.meshes).toBe(0);
    expect(bands["city"]?.forms.flat.meshes).toBeLessThanOrEqual(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE);
    // The PRD budgets 500 MB for the tab at full size.
    const m = bands["city"]?.memoryMb;
    expect((m?.pageMb ?? 0) + (m?.workerMb ?? 0) + (m?.merged.simpleMb ?? 0) + (m?.merged.boxMb ?? 0) + (m?.merged.flatMb ?? 0)).toBeLessThan(500);
  }
});
