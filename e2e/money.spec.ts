import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { MILESTONES, TIME_BALANCE, formatMoneyShort } from "../packages/sim/src/index";
import { MILESTONE_NOTICE_DAYS } from "../packages/client/src/ui/config";
import { cityReady, hideNotes, openCity, settingsButton } from "./helpers";
import { NEW_STREET, milestoneEveCity, overdrawnCity } from "./money-fixtures";

// Issue M4-14: the treasury in the time card, money in the activity log, and
// the money and milestone sounds. The town is a day short of its first
// milestone (money-fixtures.ts). The page holds the worker's clock
// (`?heldclock`), so the sim steps only when the spec says and no figure
// moves while one is read: the outcome is the same on a slow runner and a
// fast one.
//
// Headless Chromium has an audio context but nothing listens, so the spec
// reads the sound engine's test hook (window.cityCouncil.sound) rather than
// the speakers.

interface CueRecord {
  cue: string;
  outcome: string;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { tick: number; budget: { treasury: number }; log: { seq: number; type: string }[]; logSpent: number[]; milestones: ArrayLike<number> } | null };
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    advance(steps: number): Promise<number>;
    saveNow(): Promise<unknown>;
    sound: { cues(): CueRecord[]; clear(): void };
  };
};

declare function getComputedStyle(element: unknown): { color: string };
declare const document: { querySelector(selector: string): unknown };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const DAY = TIME_BALANCE.ticksPerDay;
/** Days the spec steps the town for, at most, before it gives up on the milestone: it is reached a day in. */
const DAYS_TO_MILESTONE = 3;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["MONEY_EVIDENCE_DIR"];

/**
 * A screenshot for the pull request: the page, or `what` with `above` CSS
 * pixels of the page over it and to its left, where its tooltip opens.
 */
async function attach(page: Page, testInfo: TestInfo, name: string, what?: Locator, above = 0): Promise<void> {
  const file = `${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const box = what ? await what.boundingBox() : null;
  const clip = box ? { x: Math.max(0, box.x - above), y: Math.max(0, box.y - above), width: box.width + Math.min(above, box.x), height: box.height + Math.min(above, box.y) } : undefined;
  const shot = await page.screenshot(clip ? { clip } : {});
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, shot);
  }
}

const cues = (page: Page) => page.evaluate(() => window.cityCouncil.sound.cues().map((c) => c.cue));
const treasury = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.budget.treasury ?? null);

/** Sends a command and steps the held clock once, so the sim applies it, and resolves with what it settled as. */
function sendAndStep(page: Page, type: string, payload: unknown) {
  return page.evaluate(
    async ([type, payload]) => {
      const settled = window.cityCouncil.sendCommand(type, payload);
      await window.cityCouncil.advance(1);
      return settled;
    },
    [type, payload] as const,
  );
}

test("the treasury falls by a street's price, the log names it, money spent sounds, and the first milestone brings its notice and sound", async ({ page }, testInfo) => {
  const eve = milestoneEveCity();
  const first = MILESTONES[0];
  if (!first) throw new Error("no milestones");
  await openCity(page, eve.bytes, { query: "webgl&heldclock", name: "Money" });
  const card = page.locator("#game-clock");
  const shown = page.locator("#treasury");

  // The treasury in short form in the time card, with the month so far in its tooltip.
  await expect(shown).toHaveText(formatMoneyShort(eve.state.budget.treasury));
  await expect(shown).toHaveAttribute("data-treasury", String(eve.state.budget.treasury));
  await expect(shown).not.toHaveClass(/overdrawn/);
  await shown.hover();
  await expect(page.getByRole("tooltip")).toContainText("This month so far:");
  await expect(page.getByRole("tooltip")).toContainText("Net");
  await attach(page, testInfo, "treasury-with-tooltip", card, 120);
  // A click starts audio, as the player's first one does.
  await page.locator("#game-date").click();

  // A street east of the houses, on open ground: the price the road tool shows comes out of the treasury, once.
  await page.evaluate(() => window.cityCouncil.sound.clear());
  const before = await treasury(page);
  const built = await sendAndStep(page, "BuildRoad", NEW_STREET);
  expect(built).toEqual({ ok: true });
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))).toBe(eve.streetPrice);
  // Paused, so nothing else moved the treasury in the step.
  expect(await treasury(page)).toBe((before ?? 0) - eve.streetPrice);
  await expect(shown).toHaveText(formatMoneyShort((before ?? 0) - eve.streetPrice));
  await expect.poll(() => cues(page)).toEqual(["road", "money"]);

  // The log names the player and the amount.
  await settingsButton(page, "Log");
  await page.locator("#settings-toggle").click();
  /** The street's row: the player's own road, among the fixture's. */
  const row = page.locator("#activity-log tbody tr").filter({ hasText: "local" }).filter({ hasText: "BuildRoad" });
  await expect(row).toHaveCount(1);
  // Newest first, so it heads the log.
  await expect(page.locator("#activity-log tbody tr").first()).toContainText("BuildRoad");
  await expect(row.locator("td.money")).toHaveText(formatMoneyShort(eve.streetPrice));
  await expect(row).toHaveAttribute("data-spent", String(eve.streetPrice));
  await attach(page, testInfo, "log-names-the-amount", page.locator("#activity-log"));

  // A command that moves no money makes no money sound.
  await page.evaluate(() => window.cityCouncil.sound.clear());
  expect(await sendAndStep(page, "NoOp", {})).toEqual({ ok: true });
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))).toBe(0);
  expect(await cues(page)).toEqual([]);

  // Run the town until its population passes the first milestone: a day, by the fixture, and a few at most.
  expect(await sendAndStep(page, "SetSpeed", { speed: 1 })).toMatchObject({ ok: true });
  await page.evaluate(() => window.cityCouncil.sound.clear());
  const grantFrom = await treasury(page);
  for (let day = 0; day < DAYS_TO_MILESTONE; day++) {
    if (((await page.evaluate(() => window.cityCouncil.mirror.state?.milestones.length)) ?? 0) > 0) break;
    await page.evaluate((steps) => window.cityCouncil.advance(steps), DAY);
  }
  const milestones = await page.evaluate(() => Array.from(window.cityCouncil.mirror.state?.milestones ?? []));
  expect(milestones).toHaveLength(1);
  expect(milestones[0]).toBeGreaterThan(0);
  const notice = page.locator("#milestone-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`${first.name} reached`);
  await expect(notice).toContainText(`Grant of ${formatMoneyShort(first.grant)} paid`);
  await expect(notice).toContainText("Unlocked: Medium density and City Hall");
  await expect.poll(async () => (await cues(page)).filter((c) => c === "milestone")).toEqual(["milestone"]);
  // The grant went into the treasury with the day's taxes and upkeep.
  expect((await treasury(page)) ?? 0).toBeGreaterThan((grantFrom ?? 0) + first.grant / 2);
  await expect(shown).toHaveText(formatMoneyShort((await treasury(page)) ?? 0));
  await page.locator("#activity-log").evaluate((el) => el.setAttribute("hidden", ""));
  await attach(page, testInfo, "milestone-notice");
  await attach(page, testInfo, "milestone-notice-card", notice);
  // It stays while the clock is held, however long the page takes, and goes by itself a few game days on.
  await expect(notice).toBeVisible();
  await page.evaluate((steps) => window.cityCouncil.advance(steps), MILESTONE_NOTICE_DAYS * DAY);
  await expect(notice).toBeHidden();

  // The figures survive a reload, and the milestone, reached before it, makes no second notice or sound.
  const kept = await treasury(page);
  await page.evaluate(() => window.cityCouncil.saveNow());
  await page.reload();
  await cityReady(page);
  await hideNotes(page);
  expect(await treasury(page)).toBe(kept);
  await expect(shown).toHaveText(formatMoneyShort(kept ?? 0));
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.milestones.length)).toBe(1);
  // A delta after the snapshot, which would bring a notice if the milestone counted as new.
  await page.evaluate((steps) => window.cityCouncil.advance(steps), DAY);
  await expect(notice).toBeHidden();
  await settingsButton(page, "Log");
  await expect(row.locator("td.money")).toHaveText(formatMoneyShort(eve.streetPrice));
  expect(await cues(page)).toEqual([]);
});

test("a treasury below zero shows in the warning colour", async ({ page }, testInfo) => {
  const city = overdrawnCity();
  await openCity(page, city.bytes, { query: "webgl&heldclock", name: "Overdrawn" });
  const shown = page.locator("#treasury");
  await expect(shown).toHaveText(formatMoneyShort(city.treasury));
  expect(city.treasury).toBeLessThan(0);
  await expect(shown).toHaveClass(/overdrawn/);
  // The warning colour, the same red as the other problems the page shows.
  const colours = await shown.evaluate((el) => ({ shown: getComputedStyle(el).color, date: getComputedStyle(document.querySelector("#game-date")).color }));
  expect(colours.shown).toBe("rgb(122, 23, 18)");
  expect(colours.shown).not.toBe(colours.date);
  await shown.hover();
  await expect(page.getByRole("tooltip")).toContainText("overdrawn");
  await attach(page, testInfo, "treasury-below-zero", page.locator("#game-clock"), 120);
});
