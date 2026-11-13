import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Issue 47: the build dock. With no tool on it shows only the tool buttons.
// The road tool's options open in a menu above its button, in labelled
// groups, and bulldoze and upgrade are actions in that menu. The grid tool's
// options open above its own button.

declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });

async function open(page: Page): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Group labels of the menu, top to bottom. */
async function groups(page: Page, menu: string): Promise<string[]> {
  return page.locator(`${menu} .menu-group`).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
}

test("the dock hides tool options until a tool is on, and opens them above its button", async ({ page }, testInfo) => {
  await open(page);
  await expect(page.locator("#road-tool")).toBeVisible();
  await expect(page.locator("#grid-tool")).toBeVisible();
  for (const id of ["#road-menu", "#grid-menu", "#road-type-street", "#draw-mode-straight", "#guide-angle", "#bulldoze-tool"]) {
    await expect(page.locator(id)).toHaveCount(0);
  }
  await attach(page, testInfo, "1 the dock with no tool on");

  // The road tool: four groups, in a menu that sits above the road button.
  await page.locator("#road-tool").click();
  await expect(page.locator("#road-menu")).toBeVisible();
  expect(await groups(page, "#road-menu")).toEqual(["Actions", "Road type", "Build mode", "Snapping"]);
  const menu = await page.locator("#road-menu").boundingBox();
  const button = await page.locator("#road-tool").boundingBox();
  if (!menu || !button) throw new Error("menu or button not laid out");
  expect(menu.y + menu.height).toBeLessThanOrEqual(button.y);
  expect(menu.x).toBeLessThanOrEqual(button.x);
  expect(menu.x + menu.width).toBeGreaterThan(button.x + button.width);
  await attach(page, testInfo, "2 the road menu above the road button");

  // Bulldoze keeps the menu open with only the actions; pressing it again goes back to drawing.
  await page.locator("#bulldoze-tool").click();
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-expanded", "true");
  expect(await groups(page, "#road-menu")).toEqual(["Actions"]);
  await attach(page, testInfo, "3 bulldoze on");
  await page.locator("#bulldoze-tool").click();
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");

  // Upgrade shows the road type it upgrades to.
  await page.keyboard.press("KeyV");
  expect(await groups(page, "#road-menu")).toEqual(["Actions", "Road type"]);

  // The grid tool's menu replaces it, above the grid button.
  await page.keyboard.press("KeyG");
  await expect(page.locator("#road-menu")).toHaveCount(0);
  await expect(page.locator("#grid-menu")).toBeVisible();
  await expect(page.locator("#grid-panel")).toBeVisible();
  const gridMenu = await page.locator("#grid-menu").boundingBox();
  const gridButton = await page.locator("#grid-tool").boundingBox();
  if (!gridMenu || !gridButton) throw new Error("grid menu not laid out");
  expect(gridMenu.y + gridMenu.height).toBeLessThanOrEqual(gridButton.y);
  await attach(page, testInfo, "4 the grid menu");

  // Escape closes it, and the dock is clean again.
  await page.keyboard.press("Escape");
  await expect(page.locator("#grid-menu")).toHaveCount(0);
  await expect(page.locator("#road-menu")).toHaveCount(0);
});

test("a city opens in the district band", async ({ page }, testInfo) => {
  await open(page);
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe("district");
  await attach(page, testInfo, "a new city opens in the district band");
});
