import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MEASURE_STATE } from "./browser-state";
import { canvasShot, openCity, scaleCity, setPose, settle } from "./building-lod-helpers";

// Issue #163: opening the zone tool on the scale town, 54,163 buildings on
// 2.9 million cells, must not stop the page. Every main-thread task from
// the key press until the overlay has filled in, and while the pointer
// moves over the streets with the tool on, is under 50 ms. The cell index,
// the building index and the block index are built when the city loads,
// and the overlay fills in a few chunks a frame.
//
// CI runners have no GPU. In software WebGL one frame of this city is a
// task of about half a second on its own, so the check stops drawing while
// it measures and times only the page's own work: the key press, the zone
// tool and the overlay's chunks. Uploading the chunks to the GPU, which
// happens while drawing, is not counted. Tasks are read from a Chromium
// trace of the page's main thread, so the longest is known even when it is
// under 50 ms. The figures go to test-results/zone-open-report.json for the
// pull request. Pull request CI only reports the 50 ms budget and holds a
// stall (`ENFORCE_TASK_BUDGET`).

interface Task {
  /** Milliseconds from the start of the trace. */
  at: number;
  ms: number;
}
declare const window: {
  cityCouncil: { view: Promise<{ renderer: { render: (...args: unknown[]) => void } }> };
  zoneOpenRender: ((...args: unknown[]) => void) | null;
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
// Times the page's own work and stubs out drawing: every frame at the real settings (issue #226).
test.use({ storageState: MEASURE_STATE });
// Building the town takes about half a minute, and loading it into software WebGL a few more.
test.setTimeout(900_000);

/** The issue's budget for any one main-thread task while the tool opens. */
const LONG_TASK_MS = 50;
/**
 * Whether the check holds every task to LONG_TASK_MS. On the development
 * container the longest task while the tool opens is 24 to 30 ms, and with
 * no tool on the page already runs tasks of up to about 30 ms. Runners differ
 * by up to two times (issue #152), so the slowest leave the budget less
 * than the two times headroom a required check needs (PRD, "Time budgets on
 * CI"). Pull request CI sets E2E_TASK_BUDGET=report: there a task over the
 * budget is printed and annotated, and only one over STALL_MS fails. Local
 * runs and the nightly run (nightly.yml) hold the budget.
 */
const ENFORCE_TASK_BUDGET = process.env["E2E_TASK_BUDGET"] !== "report";
/** A stall, held everywhere: four times the budget, so the slowest runner leaves it twice its own longest task. The 4 to 6 s stall this issue fixed is far over it. */
const STALL_MS = 4 * LONG_TASK_MS;

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

test("opening the zone tool on the scale town runs no main-thread task over 50 ms", async ({ page, browser }, testInfo) => {
  const { town, bands, bytes } = scaleCity();
  await openCity(page, "webgl&preset=low", "Town", bytes);
  await page.waitForFunction((n) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(n), town.buildings, { timeout: 300_000 });
  const street = bands.find((b) => b.band === "street");
  if (!street) throw new Error("no street band pose");
  await setPose(page, street.position, street.target);
  // Buildings and decoration near the camera finish building first: that work comes with the move, not the tool.
  await settle(page, 300_000);
  await page.locator("#view").hover({ position: { x: 640, y: 400 } });

  // Drawing stops.
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    window.zoneOpenRender = view.renderer.render;
    view.renderer.render = () => undefined;
  });
  // A quiet second first, to show what the page runs with no tool on.
  const idle = await mainThreadTasks(browser, page, () => page.waitForTimeout(1000));

  const opening = await mainThreadTasks(browser, page, async () => {
    await page.keyboard.press("KeyK");
    await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
    await page.waitForFunction(() => document.body.dataset["zoningOverlay"] === "true" && document.body.dataset["cellsPending"] === "0", null, { timeout: 300_000 });
    // The pointer moves over the streets, so the tool's preview and the note on why nothing grows are worked out too.
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(340 + i * 30, 250 + (i % 5) * 60);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);
  });

  const report = {
    city: town,
    idle: { tasks: idle.length, longest: longest(idle, 5) },
    opening: { tasks: opening.length, overLimit: opening.filter((t) => t.ms > LONG_TASK_MS).length, longest: longest(opening, 10) },
    longestMs: Math.max(0, ...opening.map((t) => t.ms)),
  };
  console.log(`Issue #163 zone tool opening: ${JSON.stringify(report, null, 2)}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/zone-open-report.json", `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("zone tool opening report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });

  // Drawing again, for the screenshot of the overlay filled in.
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    if (window.zoneOpenRender) view.renderer.render = window.zoneOpenRender;
  });
  await canvasShot(page, testInfo, "scale town with the zone tool open, street band");

  const over = opening.filter((t) => t.ms > LONG_TASK_MS);
  if (ENFORCE_TASK_BUDGET) expect(over).toEqual([]);
  else if (over.length > 0) {
    const note = `${over.length} main-thread tasks over ${LONG_TASK_MS} ms while the zone tool opened, the longest ${report.longestMs} ms, reported only (E2E_TASK_BUDGET=report)`;
    testInfo.annotations.push({ type: "over budget", description: note });
    console.log(note);
  }
  expect(opening.filter((t) => t.ms > STALL_MS)).toEqual([]);
});
