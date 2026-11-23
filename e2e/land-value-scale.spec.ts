import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MEASURE_STATE } from "./browser-state";
import { attachCanvas, openFixture, scaleCity, setPose } from "./building-lod-helpers";
import { buildingsDrawn, settle } from "./helpers";

// Issue M3-18: turning the land value overlay on over the scale town,
// 54,163 buildings on 2.9 million cells, takes no frame over 100 ms. The
// overlay reuses the zoning overlay's cell meshes, built a few chunks a
// frame within a budget, and a chunk built for land value skips the lot
// marks, so the first time it is turned on costs no more than the zoning
// overlay. Turned on over the zoning overlay, it only writes each chunk's
// colours again.
//
// As in zone-open-scale.spec.ts, drawing stops while the check measures, so
// it times the page's own work on a runner with no GPU, and every
// main-thread task is read from a Chromium trace. With drawing stopped a
// frame is one task, so the longest task is the longest frame of the page's
// own work. The figures go to test-results/land-value-scale-report.json
// for the pull request. Then the overlay is drawn in each zoom band.

interface Task {
  /** Milliseconds from the start of the trace. */
  at: number;
  ms: number;
}
declare const window: {
  cityCouncil: { view: Promise<{ renderer: { render: (...args: unknown[]) => void }; cellStats(): { lastBuildMs: number; slowestFrameMs: number; totalRecoloured: number } | null }> };
  landValueRender: ((...args: unknown[]) => void) | null;
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
// Times the page's own work and stubs out drawing: every frame at the real settings (issue #226).
test.use({ storageState: MEASURE_STATE });
// Building the town takes about half a minute, and loading it into software WebGL a few more, as in zone-open-scale.spec.ts.
test.setTimeout(600_000);

/** The issue's budget for any one frame while the overlay turns on. */
const FRAME_MS = 100;

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
}

/** Runs `during` under a trace and returns every task the page's main thread ran meanwhile. */
async function mainThreadTasks(browser: Browser, page: Page, during: () => Promise<void>): Promise<Task[]> {
  await browser.startTracing(page, { categories: ["toplevel"] });
  await during();
  const { traceEvents } = JSON.parse((await browser.stopTracing()).toString("utf8")) as { traceEvents: TraceEvent[] };
  const main = new Set(traceEvents.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const tasks = traceEvents.filter((e) => e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && main.has(`${e.pid}:${e.tid}`));
  // Chromium can nest one task event in the other; only the outermost counts.
  tasks.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const outer: TraceEvent[] = [];
  const ends = new Map<string, number>();
  for (const e of tasks) {
    const thread = `${e.pid}:${e.tid}`;
    if (e.ts < (ends.get(thread) ?? -Infinity)) continue;
    outer.push(e);
    ends.set(thread, e.ts + (e.dur ?? 0));
  }
  const t0 = Math.min(...outer.map((e) => e.ts));
  return outer.map((e) => ({ at: Math.round((e.ts - t0) / 1000), ms: Math.round((e.dur ?? 0) / 100) / 10 }));
}

const longest = (tasks: readonly Task[], n: number): Task[] => [...tasks].sort((a, b) => b.ms - a.ms).slice(0, n);

async function stopDrawing(page: Page, stop: boolean): Promise<void> {
  await page.evaluate(async (stop) => {
    const view = await window.cityCouncil.view;
    if (stop) {
      window.landValueRender = view.renderer.render;
      view.renderer.render = () => undefined;
    } else if (window.landValueRender) view.renderer.render = window.landValueRender;
  }, stop);
}

/** Presses `key` and traces until the overlay shows `overlay` with every chunk built and coloured. */
async function turnOn(browser: Browser, page: Page, key: string, overlay: string): Promise<Task[]> {
  return mainThreadTasks(browser, page, async () => {
    await page.keyboard.press(key);
    await page.waitForFunction((o) => document.body.dataset["overlay"] === o && document.body.dataset["cellsPending"] === "0", overlay, { timeout: 300_000 });
    await page.waitForTimeout(300);
  });
}

const summary = (tasks: readonly Task[]) => ({ tasks: tasks.length, overLimit: tasks.filter((t) => t.ms > FRAME_MS).length, longestMs: Math.max(0, ...tasks.map((t) => t.ms)), longest: longest(tasks, 5) });

test("turning the land value overlay on over the scale town takes no frame over 100 ms", async ({ page, browser }, testInfo) => {
  const { town, bands, bytes } = scaleCity();
  await openFixture(page, "webgl&preset=low", "Town", bytes);
  await buildingsDrawn(page, town.buildings, 300_000);
  const street = bands.find((b) => b.band === "street");
  if (!street) throw new Error("no street band pose");
  await setPose(page, street.position, street.target);
  await settle(page, { timeout: 300_000 });
  await page.mouse.move(5, 400);

  await stopDrawing(page, true);
  // From nothing: every chunk built for land value.
  const fromNothing = await turnOn(browser, page, "KeyO", "landValue");
  const built = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  await page.keyboard.press("KeyO");
  // From zoning: every chunk built already, coloured again in place. The zone tool brings zoning, and builds the lot marks land value skipped.
  await page.keyboard.press("KeyK");
  await page.waitForFunction(() => document.body.dataset["overlay"] === "zoning" && document.body.dataset["cellsPending"] === "0", null, { timeout: 300_000 });
  const overZoning = await turnOn(browser, page, "KeyO", "landValue");
  const recoloured = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
  await page.keyboard.press("KeyK");
  await stopDrawing(page, false);

  const report = {
    city: town,
    fromNothing: { ...summary(fromNothing), buildMs: built?.lastBuildMs ?? null, slowestBuildFrameMs: built?.slowestFrameMs ?? null },
    overZoning: { ...summary(overZoning), chunksRecoloured: recoloured?.totalRecoloured ?? null },
  };
  console.log(`Issue M3-18 land value overlay on the scale town: ${JSON.stringify(report, null, 2)}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/land-value-scale-report.json", `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("land value overlay report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });

  // The overlay in each zoom band.
  await page.keyboard.press("KeyO");
  for (const b of bands) {
    await setPose(page, b.position, b.target);
    await settle(page, { timeout: 300_000 });
    await attachCanvas(page, testInfo, `scale town, land value overlay, ${b.band} band`);
  }

  expect(fromNothing.filter((t) => t.ms > FRAME_MS)).toEqual([]);
  expect(overZoning.filter((t) => t.ms > FRAME_MS)).toEqual([]);
});
