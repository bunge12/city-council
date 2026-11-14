import { expect, test, type Page } from "@playwright/test";
import { zonedFixtureCity } from "./cell-fixtures";

// Issue M2-10: the grower. Buildings are not drawn until issue 12, so this
// checks what the page can show now: buildings arrive in the page's copy of
// the city over game time, and the debug panel times the grower as its own
// system.
//
// The city is the road fixture with every zone at every density painted
// along its streets (cell-fixtures.ts), imported as a city file.

declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: { state: { tick: number; buildings: { flags: Uint8Array; residents: Int32Array } } | null };
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

/** Live buildings in the page's copy of the city, and the residents they hold room for. */
async function grown(page: Page): Promise<{ buildings: number; residents: number }> {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.buildings;
    let buildings = 0;
    let residents = 0;
    b?.flags.forEach((f, id) => {
      if (f === 0) return;
      buildings++;
      residents += b.residents[id] ?? 0;
    });
    return { buildings, residents };
  });
}

test("buildings grow on zoned cells over game time, and the debug panel times the grower", async ({ page }, info) => {
  const { bytes } = zonedFixtureCity();
  await page.goto("/?debug&webgl&preset=low");
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "zoned.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  expect(await grown(page)).toEqual({ buildings: 0, residents: 0 });

  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  // One building a game day: a day is 100 ticks, 2.5 s at 4x.
  await expect.poll(async () => (await grown(page)).buildings, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const { buildings, residents } = await grown(page);
  expect(residents).toBeGreaterThan(0);

  const timings = page.locator("#sim-timings");
  await expect(timings).toContainText("grower");
  const debug = page.getByRole("region", { name: "Debug panel" });
  await debug.screenshot({ path: info.outputPath("debug-panel.png") });
  await page.screenshot({ path: info.outputPath("page.png") });
  await info.attach("grown", { body: JSON.stringify({ buildings, residents }), contentType: "application/json" });
});
