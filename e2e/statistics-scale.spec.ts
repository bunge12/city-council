import { expect, test } from "@playwright/test";
import { HISTORY_LENGTH, STAT_TOTALS, deserialize, sampleCount, serialize } from "../packages/sim/src/index";
import { writeReport, openFixture, scaleCity } from "./building-lod-helpers";
import { perfFigures } from "./measure";

// Issue M3-16: opening the statistics panel on the scale town, about 54,000
// buildings, with every total's history full at 1,200 samples and wrapped,
// takes under 100 ms. The time is from the click on the top bar's button
// until the panel is laid out with its graph drawn at 100 years, the
// longest range: React's render and commit, which it runs in a microtask
// the click queues, style and layout, read back with a forced layout, and
// the next frame, which paints the panel and its 1,200-point line. The time
// to layout alone is reported beside it. Drawing the city is stopped while it measures,
// since in software WebGL one frame of the town is a task of about half a
// second of its own, which is the map's cost and not the panel's.
//
// The history is written in Node, not stepped: a hundred game years of the
// scale town would take hours. Each sample is a ramp up to the total's
// value today with a wobble, so the line has 1,200 distinct points.

declare const window: {
  cityCouncil: { view: Promise<{ renderer: { render: (...args: unknown[]) => void } }> };
};
interface PageElement {
  click(): void;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): unknown;
}
declare const document: { querySelector(selector: string): PageElement | null };
declare const performance: { now(): number };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
// Building the town takes about half a minute, and loading it into software WebGL a few more, as in zone-open-scale.spec.ts.
test.setTimeout(600_000);

/** The issue's budget for opening the panel. */
const OPEN_MS = 100;
/** Times the panel is opened; the slowest, to the frame that paints it, is held to the budget. */
const RUNS = 5;

function townWithFullHistory(): Uint8Array {
  // A copy: the fixture's bytes are a Buffer, which can start part way into a shared one.
  const state = deserialize(new Uint8Array(scaleCity().bytes)).state;
  const stats = state.stats;
  STAT_TOTALS.forEach((name, i) => {
    const top = Math.max(stats.totals[name] ?? 0, 1000 * (i + 1));
    const series = new Int32Array(HISTORY_LENGTH);
    for (let m = 0; m < HISTORY_LENGTH; m++) series[m] = Math.round((top * (m + 1)) / HISTORY_LENGTH) + ((m * 37) % 23);
    stats.history[name] = series;
  });
  // Wrapped: the next sample overwrites the middle of the arrays.
  stats.next = HISTORY_LENGTH / 2 + 7;
  expect(sampleCount(stats)).toBe(HISTORY_LENGTH);
  return serialize(state);
}

test("opening the statistics panel on the scale town with a full history takes under 100 ms", async ({ page }, testInfo) => {
  const { town } = scaleCity();
  await openFixture(page, "webgl&preset=low", "Town", townWithFullHistory());
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    view.renderer.render = () => undefined;
  });
  const toggle = page.locator("#stats-toggle");
  // The longest range, so the graph draws all 1,200 samples.
  await toggle.click();
  await page.locator("#stats-range-100").click();
  await expect(page.locator("#stats-graph")).toHaveAttribute("data-samples", String(HISTORY_LENGTH));
  await toggle.click();
  await expect(page.locator("#stats-panel")).toBeHidden();

  /** Click to the next frame painted, and click to layout. */
  const times: number[] = [];
  const layouts: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const ms = await page.evaluate(async () => {
      const button = document.querySelector("#stats-toggle");
      if (!button) throw new Error("no statistics button");
      const t0 = performance.now();
      button.click();
      // React renders a click's update in a microtask queued by the click; a few turns of the microtask queue let it commit.
      for (let i = 0; i < 10 && document.querySelector("#stats-graph")?.getAttribute("data-samples") !== "1200"; i++) await Promise.resolve();
      if (document.querySelector("#stats-graph")?.getAttribute("data-samples") !== "1200") throw new Error("the graph did not draw");
      // Reading a size lays the page out.
      document.querySelector("#stats-panel")?.getBoundingClientRect();
      const laidOut = performance.now() - t0;
      // And the next frame paints it, the 1,200-point line included.
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const painted = performance.now() - t0;
      button.click();
      return { laidOut, painted };
    });
    times.push(ms.painted);
    layouts.push(ms.laidOut);
    await expect(page.locator("#stats-panel")).toBeHidden();
    await page.waitForTimeout(200);
  }
  const slowest = Math.max(...times);
  const median = [...times].sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? slowest;
  await writeReport(testInfo, "M3-16 statistics panel opening on the scale town", "statistics-open-report.json", {
    buildings: town.buildings,
    samples: HISTORY_LENGTH,
    runsToPaintMs: times.map((t) => Math.round(t * 10) / 10),
    runsToLayoutMs: layouts.map((t) => Math.round(t * 10) / 10),
    medianMs: Math.round(median * 10) / 10,
    slowestMs: Math.round(slowest * 10) / 10,
  });
  perfFigures("statistics-open", "scale town, statistics panel opening, full history", { "median (ms)": median, "slowest (ms)": slowest });
  expect(slowest).toBeLessThan(OPEN_MS);
});
