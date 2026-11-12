import { expect, test, type Page } from "@playwright/test";

// One tab per city. Each tab has its own worker and its own copy of the sim,
// so a second tab on the same city must not run it: it would save over the
// first. The second tab says so and offers another city.

interface SaveStatus {
  city: { id: string; name: string; seed: number };
  openElsewhere: boolean;
  cities: { id: string; name: string }[];
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    saveNow(): Promise<SaveStatus>;
    saves: { status: SaveStatus | null };
    mirror: { state: { tick: number; log: { type: string; payload: unknown }[] } | null };
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
// Seven page loads with the whole map, two tabs drawing at once, on a
// machine that may have no GPU.
test.setTimeout(240_000);

async function status(page: Page): Promise<SaveStatus> {
  await page.waitForFunction(() => window.cityCouncil.saves.status !== null);
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

/** Waits for a tab that is running a city. */
async function running(page: Page): Promise<SaveStatus> {
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true");
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
  const value = await status(page);
  expect(value.openElsewhere).toBe(false);
  return value;
}

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

test("a second tab does not run a city that is open in another tab", async ({ page: first, context }) => {
  await first.goto("/");
  const a = await running(first);
  expect(await first.evaluate(() => window.cityCouncil.sendCommand("NoOp", { from: "first tab" }))).toEqual({ ok: true });
  await first.evaluate(() => window.cityCouncil.saveNow());

  // A second tab opens the same city, the most recently opened one.
  const second = await context.newPage();
  await second.goto("/");
  await second.waitForFunction(() => document.body.dataset["openElsewhere"] === "true");
  const blocked = await status(second);
  expect(blocked.city.id).toBe(a.city.id);
  const note = second.locator("#open-elsewhere");
  await expect(note).toBeVisible();
  await expect(note).toContainText(`"${a.city.name}" is open in another tab`);
  await expect(second.locator("#city-name")).toHaveText("No city open");
  // Nothing runs in it: no state, and nothing to save or download.
  expect(await second.evaluate(() => window.cityCouncil.mirror.state)).toBeNull();
  const menu = second.getByRole("region", { name: "City menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(menu.locator("#download-city")).toBeDisabled();
  await expect(menu.getByRole("list", { name: "Saved cities" })).toContainText("open in another tab");
  await second.screenshot({ path: "test-results/two-tabs-blocked.png" });

  // The first tab is untouched and still running.
  const before = await tick(first);
  await expect.poll(() => tick(first)).toBeGreaterThan(before + 3);

  // Trying again while the first tab is open changes nothing.
  await note.getByRole("button", { name: "Try again" }).click();
  await second.waitForFunction(() => document.body.dataset["openElsewhere"] === "true");

  // The second tab starts a city of its own and runs that.
  const form = second.getByRole("form", { name: "New city" });
  await form.getByLabel("Name").fill("Second city");
  await form.getByLabel("Seed").fill("42");
  const loaded = second.waitForEvent("load");
  await form.getByRole("button", { name: "Start new city" }).click();
  await loaded;
  const b = await running(second);
  expect(b.city.name).toBe("Second city");
  expect(b.city.id).not.toBe(a.city.id);
  await expect(second.locator("#open-elsewhere")).toBeHidden();
  await second.screenshot({ path: "test-results/two-tabs-second-city.png" });

  // Each tab comes back to its own city after a reload, though the other
  // city was opened more recently.
  await second.reload();
  expect((await running(second)).city.id).toBe(b.city.id);
  await first.evaluate(() => window.cityCouncil.saveNow());
  await first.reload();
  const a2 = await running(first);
  expect(a2.city.id).toBe(a.city.id);
  expect((await first.evaluate(() => window.cityCouncil.mirror.state?.log))?.[0]?.payload).toEqual({ from: "first tab" });

  // A new tab opens the most recently opened city, the first tab's. With
  // that tab closed the city is free.
  await first.close();
  const third = await context.newPage();
  await third.goto("/");
  expect((await running(third)).city.id).toBe(a.city.id);
});
