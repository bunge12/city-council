import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { YEAR_COUNTS, historyOf, sampleCount, type SimState } from "../packages/sim/src/index";
import { axisNumber } from "../packages/client/src/ui/stat-series";
import { openCity } from "./helpers";
import { STATS_CITY_YEARS, statsCity } from "./stats-fixtures";

// Issue M3-16: the statistics panel. A city stepped in Node for fifty game
// years, so its monthly history holds about 600 samples, is opened from a
// city file. The panel opens from the top bar and with P, graphs population
// at each range, lists the year's births, deaths, arrivals and departures
// as the sim counted them, and switches the graph to unemployment and back.

declare const window: {
  cityCouncil: { mirror: { state: { tick: number } | null } };
};

test.use({ viewport: { width: 1280, height: 800 } });
// Stepping the city takes about 25 s on the development container, and up to twice that on a slow runner.
test.setTimeout(180_000);

/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["STATS_EVIDENCE_DIR"];

let city: SimState | null = null;
const fixture = (): SimState => (city ??= statsCity());

let shotNo = 0;
async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const png = await page.locator("#stats-panel").screenshot();
  writeFileSync(path, png);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, png);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** How many points the graph's line has. */
async function linePoints(page: Page): Promise<number> {
  const d = (await page.locator("#stats-line").getAttribute("d")) ?? "";
  return (d.match(/[ML]/g) ?? []).length;
}

test("the statistics panel graphs fifty years of population, lists the year's people in and out, and switches to unemployment and back", async ({ page }, testInfo) => {
  const state = fixture();
  const samples = sampleCount(state.stats);
  // Fifty years of months, and the months of the year so far.
  expect(samples).toBeGreaterThanOrEqual(STATS_CITY_YEARS * 12);
  expect(samples).toBeLessThan(STATS_CITY_YEARS * 12 + 12);
  const population = historyOf(state.stats, "population");
  const unemployed = historyOf(state.stats, "workersUnemployed");
  // The city has a story to graph: it grew, and was out of work for a while.
  expect(Math.max(...population)).toBeGreaterThan(300);
  expect(Math.max(...unemployed)).toBeGreaterThan(50);

  await openCity(page, state, { name: "Fifty Years" });
  const panel = page.locator("#stats-panel");
  const graph = page.locator("#stats-graph");

  await test.step("the top bar's button opens and closes the panel", async () => {
    await expect(panel).toBeHidden();
    await page.locator("#stats-toggle").click();
    await expect(panel).toBeVisible();
    await expect(page.locator("#stats-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.locator("#stats-toggle").click();
    await expect(panel).toBeHidden();
  });

  await test.step("P opens it, on population over the last ten years", async () => {
    await page.locator("#view").focus();
    await page.keyboard.press("KeyP");
    await expect(panel).toBeVisible();
    await expect(page.locator("#stats-series-title")).toHaveText("Population");
    await expect(page.locator("#stats-range-10")).toHaveAttribute("aria-pressed", "true");
    await expect(graph).toHaveAttribute("data-series", "population");
  });

  await test.step("each range draws its months of the history, newest at the end", async () => {
    for (const [years, months] of [[1, 12], [10, 120], [100, samples]] as const) {
      await page.locator(`#stats-range-${years}`).click();
      await expect(page.locator(`#stats-range-${years}`)).toHaveAttribute("aria-pressed", "true");
      await expect(graph).toHaveAttribute("data-samples", String(months));
      expect(await linePoints(page)).toBe(months);
      await expect(page.locator("#stats-graph .stats-end")).toHaveText(axisNumber(population.at(-1) ?? 0));
      await attach(page, testInfo, `population, ${years} ${years === 1 ? "year" : "years"}`);
    }
  });

  await test.step("the year's figures match the sim's", async () => {
    for (const what of YEAR_COUNTS) {
      await expect(page.locator(`#stats-${what}-last`)).toHaveText(state.stats.lastYear[what].toLocaleString("en-US"));
      await expect(page.locator(`#stats-${what}-now`)).toHaveText(state.stats.year[what].toLocaleString("en-US"));
    }
    // A city fifty years old has had people come and go.
    expect(YEAR_COUNTS.reduce((sum, what) => sum + state.stats.lastYear[what], 0)).toBeGreaterThan(0);
    await expect(page.locator("#stat-population")).toHaveText((state.stats.totals["population"] ?? 0).toLocaleString("en-US"));
    await expect(page.locator("#stat-workersUnemployed")).toHaveText((state.stats.totals["workersUnemployed"] ?? 0).toLocaleString("en-US"));
  });

  await test.step("pointing at the graph gives the month and its value", async () => {
    // At one year the months are far enough apart to point at one.
    await page.locator("#stats-range-1").click();
    const box = await graph.boundingBox();
    if (!box) throw new Error("no graph");
    // The plot ends 44 of the graph's 336 units from its right edge, at the newest month.
    await page.mouse.move(box.x + (box.width * 290) / 336, box.y + box.height / 2);
    await expect(page.locator("#stats-tooltip")).toContainText(`${(population.at(-1) ?? 0).toLocaleString("en-US")} people`);
    await attach(page, testInfo, "pointing at the newest month");
    await page.mouse.move(640, 20);
    await expect(page.locator("#stats-tooltip")).toHaveCount(0);
    await page.locator("#stats-range-100").click();
  });

  await test.step("unemployment goes on the graph in place of population, and back", async () => {
    await page.locator("#stat-workersUnemployed").click();
    await expect(graph).toHaveAttribute("data-series", "workersUnemployed");
    await expect(page.locator("#stats-series-title")).toHaveText("Unemployed");
    await expect(page.locator("#stat-workersUnemployed")).toHaveAttribute("aria-pressed", "true");
    await expect(graph).toHaveAttribute("data-samples", String(samples));
    expect(await linePoints(page)).toBe(samples);
    await expect(page.locator("#stats-graph .stats-end")).toHaveText(axisNumber(unemployed.at(-1) ?? 0));
    await attach(page, testInfo, "unemployment, 100 years");
    await page.locator("#stats-back").click();
    await expect(graph).toHaveAttribute("data-series", "population");
    await expect(page.locator("#stats-series-title")).toHaveText("Population");
    await expect(page.locator("#stats-back")).toHaveCount(0);
  });

  await test.step("the copy held still: the city was saved paused", async () => {
    expect(await page.evaluate(() => window.cityCouncil.mirror.state?.tick)).toBe(state.tick);
    await page.keyboard.press("KeyP");
    await expect(panel).toBeHidden();
  });
});
