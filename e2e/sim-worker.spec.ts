import { expect, test, type Page } from "@playwright/test";

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    mirror: { state: { log: unknown[]; rng: unknown } | null };
    holdClock(): Promise<number>;
    advance(steps: number): Promise<number>;
    releaseClock(): Promise<number>;
  };
};

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

/** Sends SetSpeed with the clock held and runs the one step that applies it. */
async function setSpeedHeld(page: Page, speed: number): Promise<unknown> {
  return page.evaluate(async (speed) => {
    const settled = window.cityCouncil.sendCommand("SetSpeed", { speed });
    const tick = await window.cityCouncil.advance(1);
    return { ...((await settled) as object), tick };
  }, speed);
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

// The tick rate and the 1x to 4x ratio are checked exactly in
// packages/client/test/protocol.test.ts, against a fake clock, and roughly
// against the real one in the M0 walkthrough. Here the clock is held and
// stepped by hand, so nothing depends on how fast the runner is (issue #224).
test("with the clock held, paused steps leave the tick alone and each step at 4x is one tick", async ({ page }) => {
  const held = await page.evaluate(() => window.cityCouncil.holdClock());
  await expect(page.locator("#sim-tick")).toHaveText(String(held));

  expect(await setSpeedHeld(page, 0)).toEqual({ ok: true, tick: held });
  await expect(page.locator("#sim-speed")).toHaveText("paused");
  expect(await page.evaluate(() => window.cityCouncil.advance(50))).toBe(held);

  expect(await setSpeedHeld(page, 4)).toEqual({ ok: true, tick: held + 1 });
  expect(await page.evaluate(() => window.cityCouncil.advance(40))).toBe(held + 41);
  await expect(page.locator("#sim-tick")).toHaveText(String(held + 41));
  await expect(page.locator("#sim-speed")).toHaveText("4x");

  // Released, the worker's clock steps it again.
  await page.evaluate(() => window.cityCouncil.releaseClock());
  await expect.poll(() => tick(page)).toBeGreaterThan(held + 41);
});
