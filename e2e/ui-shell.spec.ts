import { expect, test, type Page } from "@playwright/test";

// The UI shell: top bar, speed controls and shortcuts, debug panel, activity
// log and city menu. Everything here goes through the page's own controls.

interface SaveStatus {
  city: { id: string; name: string; seed: number };
  loadedFrom: string;
  cities: { id: string; name: string }[];
}
declare const window: {
  cityCouncil: {
    saves: { status: SaveStatus | null };
    mirror: { state: { tick: number; seed: number } | null };
    camera: Promise<unknown>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

const VIEWPORT = { width: 1280, height: 800 };
test.use({ viewport: VIEWPORT });

async function ready(page: Page): Promise<void> {
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true");
}

async function open(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await ready(page);
}

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

async function status(page: Page): Promise<SaveStatus> {
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

const speedButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

test("the top bar shows the city and the game date, and the speed buttons send SetSpeed", async ({ page }, testInfo) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "City Council" })).toBeVisible();
  await expect(page.locator("#city-name")).toHaveText((await status(page)).city.name);
  await expect(page.locator("#game-date")).toHaveText(/^\d+ [A-Z][a-z]{2}, Year \d+$/);
  await expect(speedButton(page, "1x")).toHaveAttribute("aria-pressed", "true");

  await speedButton(page, "Pause").click();
  await expect(speedButton(page, "Pause")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sim-speed")).toHaveText("paused");
  const paused = await tick(page);
  await page.waitForTimeout(600);
  expect(await tick(page)).toBe(paused);

  await speedButton(page, "4x").click();
  await expect(speedButton(page, "4x")).toHaveAttribute("aria-pressed", "true");
  await expect(speedButton(page, "1x")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#sim-speed")).toHaveText("4x");
  // A game day is 100 ticks, so 4x turns the date in about 2.5 seconds.
  const date = await page.locator("#game-date").textContent();
  await expect(page.locator("#game-date")).not.toHaveText(date ?? "", { timeout: 10_000 });
  await testInfo.attach("top bar at 4x", { body: await page.screenshot(), contentType: "image/png" });
});

test("keyboard shortcuts change the speed and toggle the panels, and the debug panel lists them", async ({ page }, testInfo) => {
  await open(page);
  const debug = page.getByRole("region", { name: "Debug panel" });
  const log = page.getByRole("region", { name: "Activity log" });
  await expect(debug).toBeHidden();
  await page.keyboard.press("Backquote");
  await expect(debug).toBeVisible();
  await expect(debug.locator("#sim-info")).toHaveText("city-council sim, tick 100 ms");

  await page.keyboard.press("Digit2");
  await expect(page.locator("#sim-speed")).toHaveText("2x");
  await page.keyboard.press("Digit3");
  await expect(page.locator("#sim-speed")).toHaveText("4x");
  await page.keyboard.press("Space");
  await expect(page.locator("#sim-speed")).toHaveText("paused");
  // Space resumes at the speed it paused from.
  await page.keyboard.press("Space");
  await expect(page.locator("#sim-speed")).toHaveText("4x");
  await page.keyboard.press("Digit1");
  await expect(page.locator("#sim-speed")).toHaveText("1x");

  const keys = page.locator("#shortcut-list");
  for (const [key, what] of [
    ["Space", "pause or resume"],
    ["1", "speed 1x"],
    ["2", "speed 2x"],
    ["3", "speed 4x"],
    ["`", "show or hide this panel"],
    ["L", "show or hide the activity log"],
  ] as const) {
    await expect(keys.locator("kbd").getByText(key, { exact: true })).toBeVisible();
    await expect(keys).toContainText(what);
  }

  await page.keyboard.press("KeyL");
  await expect(log).toBeVisible();
  await testInfo.attach("debug panel and activity log open", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("KeyL");
  await expect(log).toBeHidden();
  await page.keyboard.press("Backquote");
  await expect(debug).toBeHidden();

  // Typing in a field does not trigger shortcuts.
  await page.getByRole("button", { name: "City" }).click();
  const name = page.getByLabel("Name");
  await name.fill("");
  await name.pressSequentially("3 L`");
  await expect(name).toHaveValue("3 L`");
  await expect(page.locator("#sim-speed")).toHaveText("1x");
  await expect(debug).toBeHidden();
});

test("the debug panel shows the tick rate, tick time against the budget and where the cursor is", async ({ page }, testInfo) => {
  await open(page, "/?debug");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
  const debug = page.getByRole("region", { name: "Debug panel" });
  await expect(debug).toBeVisible();
  await expect.poll(async () => Number(await page.locator("#sim-tps").textContent()), { timeout: 10_000 }).toBeGreaterThan(5);
  await expect(page.locator("#sim-timings")).toContainText("commands");
  await expect(page.locator("#sim-budget")).toHaveText(/^[\d.]+ of 20 ms \([\d.]+%\)$/);
  await expect(page.locator("#render-backend")).toHaveText(/^(WebGPU|WebGL 2)$/);
  await expect(page.locator("#render-frame")).toHaveText(/ms \(\d+ fps\)$/);
  await expect(page.locator("#memory")).toHaveText(/MB of \d+ MB heap|not reported/);
  await expect(page.locator("#cam-position")).toHaveText(/^\d+, \d+, \d+ m$/);
  await expect(page.locator("#cam-band")).toHaveText(/^(street|district|city)$/);

  // Click the ground in the middle of the screen, clear of the panels.
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await expect(page.locator("#cursor-world")).toHaveText(/^[\d.]+, [\d.]+, [\d.]+ m$/);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await expect(page.locator("#pick-world")).toHaveText(/^[\d.]+, [\d.]+, [\d.]+ m$/);
  await testInfo.attach("debug panel after a click on the ground", { body: await page.screenshot(), contentType: "image/png" });
});

test("the Send NoOp button lands a command in the activity log with its tick and player", async ({ page }, testInfo) => {
  await open(page);
  await page.getByRole("button", { name: "Log" }).click();
  const log = page.getByRole("region", { name: "Activity log" });
  await expect(log).toBeVisible();
  await expect(log).toContainText("No commands yet.");

  await log.getByRole("button", { name: "Send NoOp" }).click();
  await expect(page.locator("#sim-last-result")).toHaveText("NoOp: ok");
  const row = log.getByRole("row").nth(1);
  await expect(row).toContainText("NoOp");
  await expect(row.getByRole("cell").nth(1)).toHaveText("local");
  const loggedTick = Number(await row.getByRole("cell").first().textContent());
  expect(loggedTick).toBeGreaterThanOrEqual(0);
  expect(loggedTick).toBeLessThanOrEqual(await tick(page));

  await speedButton(page, "2x").click();
  // Newest first.
  await expect(log.getByRole("row").nth(1)).toContainText('SetSpeed {"speed":2}');
  await expect(log.getByRole("row").nth(2)).toContainText("NoOp");
  await expect(log).toContainText("2 applied");
  await testInfo.attach("activity log", { body: await page.screenshot(), contentType: "image/png" });
});

test("the city menu starts a new city from a seed and opens a saved one from the list", async ({ page }, testInfo) => {
  // Three page loads with the map on each.
  test.setTimeout(90_000);
  await open(page);
  const first = await status(page);
  await page.getByRole("button", { name: "City" }).click();
  const menu = page.getByRole("region", { name: "City menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("list", { name: "Saved cities" }).getByRole("listitem")).toHaveCount(first.cities.length);

  // A seed that is not a 32-bit whole number cannot be submitted.
  await menu.getByLabel("Seed").fill("-5");
  await expect(menu.getByRole("button", { name: "Start new city" })).toBeDisabled();
  await expect(menu).toContainText("A seed is a whole number");
  await menu.getByRole("button", { name: "Random" }).click();
  await expect(menu.getByLabel("Seed")).toHaveValue(/^\d+$/);

  await menu.getByLabel("Name").fill("Harbourside");
  await menu.getByLabel("Seed").fill("20261112");
  await testInfo.attach("city menu, new city form", { body: await page.screenshot(), contentType: "image/png" });
  const loaded = page.waitForEvent("load");
  await menu.getByRole("button", { name: "Start new city" }).click();
  await loaded;
  await ready(page);

  const second = await status(page);
  expect(second.city).toMatchObject({ name: "Harbourside", seed: 20261112 });
  expect(second.city.id).not.toBe(first.city.id);
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.seed)).toBe(20261112);
  await expect(page.locator("#city-name")).toHaveText("Harbourside");
  await expect(page.locator("#file-note")).toHaveText('Started "Harbourside" from seed 20261112.');
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });

  // The first city is in the list and opens again.
  await page.getByRole("button", { name: "City" }).click();
  const items = menu.getByRole("list", { name: "Saved cities" }).getByRole("listitem");
  await expect(items).toHaveCount(first.cities.length + 1);
  await expect(items.filter({ hasText: "Harbourside" })).toContainText("open now");
  await testInfo.attach("city menu, saved cities", { body: await page.screenshot(), contentType: "image/png" });
  const reopened = page.waitForEvent("load");
  await menu.getByRole("button", { name: `Open ${first.city.name}` }).click();
  await reopened;
  await ready(page);
  const third = await status(page);
  expect(third.city.id).toBe(first.city.id);
  expect(third.loadedFrom).toBe("latest save");
  await expect(page.locator("#file-note")).toContainText(`Opened "${first.city.name}"`);
});
