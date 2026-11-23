import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { attachCanvas } from "./building-lod-helpers";
import { openCity } from "./helpers";
import { SCALE_CITY_RESIDENTS, scaleCityFile } from "./scale-city-files";

// M3-20: each scale city's file opens in the browser, and how long it
// takes, against "Opening a large city" under "Proposed targets" in the
// PRD: a city of 500,000 interactive within 30 s on the Low class, behind
// a loading screen. There is no loading screen yet; the PRD asks for an
// issue for one once a city takes more than about 2 s.
//
// Two times, from the page asked to open the file: until the page has
// drawn the city and the worker reports the file loaded (`openCity`), and
// until the sim's tick on screen moves, which is when a command sent would
// apply. The city is generated in Node before the clock starts. The figures
// go to test-results/scale-cities-load-report.json for the pull request.
//
// In the perf project: a load of the 500,000 city into software WebGL on a
// runner with no GPU takes minutes, and the time is the runner's, not held.

test.use({ viewport: { width: 1280, height: 800 } });

/** How long the page may take to open one city before the test gives up: it stops a hang and holds no speed. */
const OPEN_TIMEOUT_MS = 900_000;

const report: Record<string, unknown> = {};

for (const residents of SCALE_CITY_RESIDENTS) {
  const label = residents.toLocaleString("en");
  test(`the scale city of ${label} residents opens from its city file`, async ({ page }, testInfo) => {
    const { bytes, totals } = scaleCityFile(residents);
    const t0 = Date.now();
    await openCity(page, bytes, { query: "webgl&preset=low", name: `Scale ${residents}`, timeout: OPEN_TIMEOUT_MS });
    const openMs = Date.now() - t0;
    const tick = page.locator("#sim-tick");
    const first = (await tick.textContent()) ?? "";
    await expect(tick).not.toHaveText(first, { timeout: OPEN_TIMEOUT_MS });
    const steppingMs = Date.now() - t0;
    // The top bar shows the city's people.
    const shown = Number(((await page.locator("#population-count").textContent()) ?? "").replace(/[^\d]/g, ""));
    expect(Math.abs(shown - totals.population) / totals.population).toBeLessThan(0.01);
    await attachCanvas(page, testInfo, `scale city of ${label}`);
    report[String(residents)] = { residents: totals.population, pops: totals.pops, buildings: totals.buildings, fileBytes: bytes.byteLength, openMs, steppingMs, populationShown: shown };
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/scale-cities-load-report.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`scale city of ${label}: drawn and loaded ${openMs} ms, stepping ${steppingMs} ms, ${bytes.byteLength} bytes`);
  });
}
