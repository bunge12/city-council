import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { openSettings, ready } from "./helpers";

// Issue M2-02: graphics presets. The first-run benchmark, which runs once
// per browser, and the settings that change the preset and keep the choice.
// The same forest edge at Low, Balanced and High is presets-forest.spec.ts,
// in the evidence project (issue #225); which lighting each preset gets is
// packages/client/test/presets.test.ts. No preset changes the sim: lint
// keeps the render code that applies one from importing what writes state
// and from calling sendCommand (rule 8, issue #225), in place of a test of
// the state hash.
//
// playwright.config.ts starts every test with Low kept in the browser. The
// tests here that need a first visit clear it.

declare const window: {
  cityCouncil: { view: Promise<{ lighting(): { preset: string } }> };
  localStorage: { getItem(key: string): string | null };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
// Page loads of the whole map, drawn in software on a CI runner.
test.setTimeout(240_000);

/** Waits until the preset on screen is the one wanted and no benchmark runs. */
async function presetSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 120_000 });
}

async function lighting(page: Page): Promise<{ preset: string }> {
  return page.evaluate(async () => (await window.cityCouncil.view).lighting());
}

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("a browser with no preset kept", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the first visit runs the benchmark and shows its choice; the second does not run it", async ({ page }, testInfo) => {
    await page.goto("/?webgl&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("true");
    const readout = page.locator("#render-preset");
    await expect(readout).toHaveText(/^(Low|Balanced|High) \(picked by the benchmark on this visit: [\d.]+ ms per draw on WebGL 2\)$/);
    const first = await readout.textContent();
    const picked = (await lighting(page)).preset;
    await expect(page.locator("#graphics-preset")).toHaveValue(picked);
    const kept = JSON.parse((await page.evaluate(() => window.localStorage.getItem("city-council:graphics"))) ?? "null") as {
      preset: string;
      source: string;
      benchmarkMs: number;
    };
    expect(kept).toMatchObject({ preset: picked, source: "benchmark" });
    console.log(`benchmark on this machine: ${first}`);
    await attach(testInfo, "debug panel after the benchmark", await page.screenshot());

    await page.reload();
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    expect((await lighting(page)).preset).toBe(picked);
    await expect(readout).toHaveText(new RegExp(`picked by the benchmark on an earlier visit: ${kept.benchmarkMs.toFixed(1).replace(".", "\\.")} ms per draw`));
  });

  test("the settings change the preset, and the choice is kept", async ({ page }) => {
    await page.goto("/?webgl&preset=low&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    // The preset is in the settings menu under the top bar's Settings button (issue #332).
    await openSettings(page);
    await page.locator("#graphics-preset").selectOption("high");
    await presetSettled(page);
    expect((await lighting(page)).preset).toBe("high");
    await expect(page.locator("#render-preset")).toHaveText(/^High \(chosen in settings/);

    // Without ?preset= the kept choice applies, and the benchmark does not run.
    await page.goto("/?webgl&debug");
    await ready(page);
    await presetSettled(page);
    expect(await page.evaluate(() => document.body.dataset["benchmarkRan"])).toBe("false");
    expect((await lighting(page)).preset).toBe("high");
    await expect(page.locator("#graphics-preset")).toHaveValue("high");
  });
});
