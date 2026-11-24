import { expect, test, type Page } from "@playwright/test";
import { createState } from "../packages/sim/src/index";
import { cityReady, openCity, openPage } from "./helpers";

// Issue #327: a saved city or a city file opens behind a loading screen with
// a progress bar over reading the save, building the derived data and
// drawing the start view. A new city opens with none. The scale cities'
// screen is timed in scale-cities-load.spec.ts.

interface LoadingReport {
  stages: { stage: string; at: number }[];
  doneAt: number | null;
}
declare const window: { cityCouncil: { loading(): LoadingReport; renderStatus(): { readyMs: number } | null } };
declare const document: { body: { dataset: Record<string, string | undefined> }; querySelector(selector: string): unknown };

const EVERY_STAGE = "reading,terrain,roads,cells,buildings,travel,openings,map,view";

/** The stages the screen showed, in order, and whether it is still up. */
async function screen(page: Page) {
  return page.evaluate(() => ({
    stages: document.body.dataset["loadingStages"] ?? null,
    stage: document.body.dataset["loadingStage"] ?? null,
    up: document.querySelector(".loading") !== null,
    report: window.cityCouncil.loading(),
    readyMs: window.cityCouncil.renderStatus()?.readyMs ?? null,
  }));
}

test("a city file opens behind the loading screen, through every stage, and the screen comes down with the first frame", async ({ page }) => {
  await openCity(page, createState(2026), { name: "Loading" });
  const shown = await screen(page);
  expect(shown.stages).toBe(EVERY_STAGE);
  expect(shown.stage).toBe("");
  expect(shown.up).toBe(false);
  expect(shown.report.stages.map((s) => s.stage).join(",")).toBe(EVERY_STAGE);
  // It came down in the frame the page counts as ready, not before.
  expect(shown.readyMs).not.toBeNull();
  expect(shown.report.doneAt).toBeGreaterThanOrEqual(shown.readyMs ?? Infinity);
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
});

test("a saved city opens behind it after a reload", async ({ page }) => {
  // A new city is saved as soon as it starts, so the reload opens a save.
  await openPage(page);
  await cityReady(page);
  expect((await screen(page)).stages).toBeNull();
  await page.reload();
  await cityReady(page);
  const shown = await screen(page);
  expect(shown.stages).toBe(EVERY_STAGE);
  expect(shown.up).toBe(false);
});

test("a new city opens with no loading screen", async ({ page }) => {
  await openPage(page);
  await cityReady(page);
  const shown = await screen(page);
  expect(shown.stages).toBeNull();
  expect(shown.up).toBe(false);
  expect(shown.report.stages).toEqual([]);
});
