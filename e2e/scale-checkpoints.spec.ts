import { expect, test } from "@playwright/test";
import { bandPoses, checkBands, fullSize, measureBands, writeReport, WAIT_VIEWPORT, bandFigures, type BandReport } from "./building-lod-helpers";
import { openCity, settle } from "./helpers";
import { SCALE_CITY_RESIDENTS, moneyScaleCityFile } from "./scale-city-files";
import { buildScaleCity, generateTerrain } from "../packages/sim/src/index";

// M3-22: the scale checkpoints in the browser, on each scale city of M3-20
// (50,000, 200,000 and 500,000 residents). Per city: the time to open its
// file, the worker's time per tick at 4x as the page reads it from each
// delta, three saves from the page, and frame time, draw calls and the
// tab's memory in each zoom band at Low and at Balanced. Since M4-20 each
// city has money in it (`moneyScaleCityFile`: a treasury, tax rates off
// their defaults, City Hall and a loan), and the spec also times the
// budget overlay's figures and the budget panel's opening. The figures go
// to test-results/scale-checkpoints-<residents>.json for the pull request
// and the PRD's "M3 exit numbers" and "M4 exit numbers". The sim's side of
// the checkpoints (each system, a BulldozeBuilding at its cap, the travel
// rebuild after a road, a day's deltas and an autosave's parts) is in the
// client's scale-cities.bench.ts.
//
// In the perf project: CI runners have no GPU and draw in software, so the
// figures are the runner's and only a gross regression fails. checkBands
// holds the tab to the PRD's 500 MB.

interface SystemTiming {
  system: string;
  ms: number;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { tick: number } | null; stats: { timings: readonly SystemTiming[] } };
    view: Promise<{ renderer: unknown }>;
    sendCommand(type: string, payload: unknown): { ok: boolean };
    saveNow(): Promise<{ lastSave: { tick: number } | null; saveError: string | null }>;
  };
};
interface PageElement {
  click(): void;
  getBoundingClientRect(): unknown;
}
declare const document: { body: { dataset: Record<string, string | undefined> }; querySelector(selector: string): PageElement | null };
declare const performance: { now(): number };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: WAIT_VIEWPORT });

/** How long the page may take to open one city: it stops a hang and holds no speed. */
const OPEN_TIMEOUT_MS = 900_000;
/** How long the worker's ticks are sampled at 4x. */
const SAMPLE_MS = 20_000;

let poses: ReturnType<typeof bandPoses> | null = null;
/** The band poses, over the middle grid of the M1 scale city every scale city is built on. */
function scalePoses(): ReturnType<typeof bandPoses> {
  if (poses) return poses;
  const { state, grids } = buildScaleCity();
  return (poses = bandPoses(generateTerrain(state.seed), grids));
}

for (const residents of SCALE_CITY_RESIDENTS) {
  const label = residents.toLocaleString("en");
  test(`the scale checkpoints on the city of ${label} residents`, async ({ page }, testInfo) => {
    const { bytes, totals, economy } = moneyScaleCityFile(residents);
    const bands = scalePoses();
    const t0 = Date.now();
    await openCity(page, bytes, { query: "webgl&preset=low", name: `Scale ${residents}`, timeout: OPEN_TIMEOUT_MS, presetSettled: true });
    const openMs = Date.now() - t0;
    await settle(page, { timeout: 300_000 });

    // The worker's step time at 4x: each delta carries the per-system times
    // of the last step before it, and the page reads it once a frame, so
    // this samples about one step in two or three, and leaves out the work
    // of building the delta. The sim's bench times every tick in full.
    expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
    await expect(page.locator("#sim-speed")).toHaveText("4x");
    const worker = await page.evaluate(async (ms) => {
      const samples: number[] = [];
      const bySystem: Record<string, number> = {};
      let lastTick = window.cityCouncil.mirror.state?.tick ?? 0;
      const firstTick = lastTick;
      const end = performance.now() + ms;
      await new Promise<void>((resolve) => {
        const look = () => {
          const tick = window.cityCouncil.mirror.state?.tick ?? 0;
          if (tick !== lastTick) {
            lastTick = tick;
            const timings = window.cityCouncil.mirror.stats.timings;
            samples.push(timings.reduce((n, t) => n + t.ms, 0));
            for (const t of timings) bySystem[t.system] = Math.max(bySystem[t.system] ?? 0, t.ms);
          }
          if (performance.now() < end) requestAnimationFrame(look);
          else resolve();
        };
        requestAnimationFrame(look);
      });
      const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
      return { ticks: lastTick - firstTick, samples: samples.length, meanMs: Math.round(mean * 100) / 100, worstMs: Math.round(Math.max(0, ...samples) * 100) / 100, worstBySystem: bySystem };
    }, SAMPLE_MS);
    expect(worker.ticks).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
    await expect(page.locator("#sim-speed")).toHaveText("paused");

    // A save from the page, the snapshot in the worker and the write to IndexedDB together. The first compiles the code.
    await fullSize(page);
    const saveMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      saveMs.push(
        await page.evaluate(async () => {
          const s0 = performance.now();
          const status = await window.cityCouncil.saveNow();
          if (status.saveError || !status.lastSave) throw new Error(status.saveError ?? "not saved");
          return Math.round(performance.now() - s0);
        }),
      );
    }

    // The budget overlay: its figures for every block, worked out on the page's main thread from the mirror (M4-18).
    await page.locator("#view").focus();
    const overlayMs: number[] = [];
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => {
        delete document.body.dataset["budgetMs"];
      });
      await page.keyboard.press("KeyN");
      await expect(page.locator("#overlay-budget")).toHaveAttribute("aria-pressed", "true");
      await page.waitForFunction(() => document.body.dataset["budgetMs"] !== undefined, null, { timeout: 120_000 });
      overlayMs.push(Number(await page.evaluate(() => document.body.dataset["budgetMs"])));
      await page.keyboard.press("KeyN");
      await expect(page.locator("#overlay-budget")).toHaveAttribute("aria-pressed", "false");
    }

    // The budget panel's opening, as budget-panel-scale.spec.ts times it on the 500,000 city: from the click on the
    // treasury until the panel is laid out, and until the next frame paints it, with drawing the city stopped meanwhile,
    // since in software WebGL one frame of the city is a task of its own, the map's cost and not the panel's.
    await page.evaluate(async () => {
      const view = await window.cityCouncil.view;
      const r = view.renderer as unknown as { render: (...args: unknown[]) => void; kept?: (...args: unknown[]) => void };
      r.kept = r.render;
      r.render = () => undefined;
    });
    const panelMs: { laidOut: number; painted: number }[] = [];
    for (let run = 0; run < 4; run++) {
      const t = await page.evaluate(async () => {
        const button = document.querySelector("#treasury");
        if (!button) throw new Error("no treasury");
        const t0 = performance.now();
        button.click();
        for (let i = 0; i < 10 && !document.querySelector("#budget-ledger"); i++) await Promise.resolve();
        if (!document.querySelector("#budget-ledger")) throw new Error("the panel did not draw");
        document.querySelector("#budget-panel")?.getBoundingClientRect();
        const laidOut = Math.round((performance.now() - t0) * 10) / 10;
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const painted = Math.round((performance.now() - t0) * 10) / 10;
        button.click();
        return { laidOut, painted };
      });
      await expect(page.locator("#budget-panel")).toBeHidden();
      // The first is the page's first look at the panel's code.
      if (run > 0) panelMs.push(t);
    }
    await page.evaluate(async () => {
      const view = await window.cityCouncil.view;
      const r = view.renderer as unknown as { render: (...args: unknown[]) => void; kept?: (...args: unknown[]) => void };
      if (r.kept) r.render = r.kept;
    });

    const name = `scale city of ${label}`;
    const low: Record<string, BandReport> = await measureBands(page, testInfo, "low", bands, name);
    const balanced: Record<string, BandReport> = await measureBands(page, testInfo, "balanced", bands, name);
    const report = { residents: totals.population, pops: totals.pops, buildings: totals.buildings, economy, fileBytes: bytes.byteLength, openMs, worker, saveMs, overlayMs, panelMs, low, balanced };
    await writeReport(testInfo, `M4-20 scale checkpoints, ${label} residents`, `scale-checkpoints-${residents}.json`, report);
    bandFigures(`scale-checkpoints-${residents}-low`, `scale city of ${label}, Low`, low);
    bandFigures(`scale-checkpoints-${residents}-balanced`, `scale city of ${label}, Balanced`, balanced);
    checkBands(low);
    checkBands(balanced);
  });
}
