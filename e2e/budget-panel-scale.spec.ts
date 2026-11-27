import { test } from "@playwright/test";
import { writeReport } from "./building-lod-helpers";
import { openCity } from "./helpers";
import { perfFigures } from "./measure";
import { scaleCityFile } from "./scale-city-files";

// Issue M4-15: how long the budget panel takes to open on the scale city of
// 500,000 residents, for the pull request. The aim is under 100 ms, and no
// test holds it: the time is the runner's as much as the panel's. Measured
// as the statistics panel's opening is (statistics-scale.spec.ts): from the
// click on the treasury until the panel is laid out, and until the next
// frame paints it. Drawing the city is stopped while it measures, since in
// software WebGL one frame of the city is a task of its own, which is the
// map's cost and not the panel's. The clock is held, so no delta lands in
// the middle of a run.

declare const window: {
  cityCouncil: { view: Promise<{ renderer: { render: (...args: unknown[]) => void } }> };
};
interface PageElement {
  click(): void;
  getBoundingClientRect(): unknown;
}
declare const document: { querySelector(selector: string): PageElement | null };
declare const performance: { now(): number };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });

/** How long the page may take to open the city before the test gives up: it stops a hang and holds no speed. */
const OPEN_TIMEOUT_MS = 900_000;
/** Times the panel is opened. */
const RUNS = 5;
const RESIDENTS = 500_000;

test("opening the budget panel on the scale city of 500,000 residents", async ({ page }, testInfo) => {
  const { bytes, totals } = scaleCityFile(RESIDENTS);
  await openCity(page, bytes, { query: "webgl&preset=low&heldclock", name: "Budget scale", timeout: OPEN_TIMEOUT_MS });
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    view.renderer.render = () => undefined;
  });
  const panel = page.locator("#budget-panel");
  // Once open and shut, so the first measured run is not the page's first look at the code.
  await page.locator("#treasury").click();
  await panel.locator("#budget-ledger").waitFor();
  await page.locator("#treasury").click();
  await panel.waitFor({ state: "hidden" });

  const times: number[] = [];
  const layouts: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const ms = await page.evaluate(async () => {
      const button = document.querySelector("#treasury");
      if (!button) throw new Error("no treasury");
      const t0 = performance.now();
      button.click();
      // React renders a click's update in a microtask queued by the click; a few turns of the queue let it commit.
      for (let i = 0; i < 10 && !document.querySelector("#budget-ledger"); i++) await Promise.resolve();
      if (!document.querySelector("#budget-ledger")) throw new Error("the panel did not draw");
      document.querySelector("#budget-panel")?.getBoundingClientRect();
      const laidOut = performance.now() - t0;
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const painted = performance.now() - t0;
      button.click();
      return { laidOut, painted };
    });
    times.push(ms.painted);
    layouts.push(ms.laidOut);
    await panel.waitFor({ state: "hidden" });
    await page.waitForTimeout(200);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(RUNS / 2)] ?? 0;
  const slowest = sorted.at(-1) ?? 0;
  await writeReport(testInfo, "M4-15 budget panel opening on the 500,000 city", "budget-open-report.json", {
    residents: totals,
    runsToPaintMs: times.map((t) => Math.round(t * 10) / 10),
    runsToLayoutMs: layouts.map((t) => Math.round(t * 10) / 10),
    medianMs: Math.round(median * 10) / 10,
    slowestMs: Math.round(slowest * 10) / 10,
  });
  perfFigures("budget-open", "500,000 city, budget panel opening", { "median (ms)": median, "slowest (ms)": slowest });
});
