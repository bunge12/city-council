import { expect, test, type Page } from "@playwright/test";

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    mirror: { state: { log: unknown[]; rng: unknown } | null };
  };
};

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  const result = await page.evaluate((s) => window.cityCouncil.sendCommand("SetSpeed", { speed: s }), speed);
  expect(result).toEqual({ ok: true });
  await expect(page.locator("#sim-speed")).toHaveText(speed === 0 ? "paused" : `${speed}x`);
}

/** Ticks per real second over `ms`, measured from the page's own readout. */
async function rate(page: Page, ms: number): Promise<number> {
  const from = await tick(page);
  const start = Date.now();
  await page.waitForTimeout(ms);
  const to = await tick(page);
  return ((to - from) * 1000) / (Date.now() - start);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
});

test("the sim ticks in a worker and the page follows it", async ({ page }) => {
  const first = await tick(page);
  await expect.poll(() => tick(page)).toBeGreaterThan(first + 5);
  await expect(page.locator("#sim-speed")).toHaveText("1x");
  await expect(page.locator("#sim-timings")).toContainText("commands");
  // Typed arrays survive the move out of the worker.
  const rngType = await page.evaluate(() => window.cityCouncil.mirror.state?.rng?.constructor.name);
  expect(rngType).toBe("Uint32Array");
});

test("a NoOp round-trips to a commandResult and lands in the log", async ({ page }) => {
  await expect(page.locator("#sim-log-length")).toHaveText("0");
  const result = await page.evaluate(() => window.cityCouncil.sendCommand("NoOp"));
  expect(result).toEqual({ ok: true });
  await expect(page.locator("#sim-last-result")).toHaveText("NoOp: ok");
  await expect(page.locator("#sim-log-length")).toHaveText("1");
  const entry = await page.evaluate(() => window.cityCouncil.mirror.state?.log[0]);
  expect(entry).toMatchObject({ playerId: "local", type: "NoOp", seq: 1 });
});

test("pause stops the tick and 4x runs four times as fast as 1x", async ({ page }) => {
  await setSpeed(page, 0);
  const paused = await tick(page);
  await page.waitForTimeout(1000);
  expect(await tick(page)).toBe(paused);

  await setSpeed(page, 1);
  const oneX = await rate(page, 2000);
  await setSpeed(page, 4);
  const fourX = await rate(page, 2000);

  expect(oneX).toBeGreaterThan(8.5);
  expect(oneX).toBeLessThan(11.5);
  expect(fourX / oneX).toBeGreaterThan(3.4);
  expect(fourX / oneX).toBeLessThan(4.6);
});
