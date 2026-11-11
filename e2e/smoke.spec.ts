import { expect, test } from "@playwright/test";

test("placeholder page loads and shows a value from the sim", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "City Council" })).toBeVisible();
  await expect(page.locator("#sim-info")).toHaveText("city-council sim, tick 100 ms");
});
