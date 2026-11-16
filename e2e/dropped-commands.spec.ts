import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { MENU_SHIFT } from "./dock";

// Issue 94: a command the sim queued can still be dropped at the step,
// because a command ahead of it in the same tick made it invalid, and a
// bulldoze or upgrade can name a segment that changed after the player
// picked it. With one player in a tab the window is one tick, so each test
// makes it happen: it holds the mouse button down on the click, then sends
// the other command and lets the button up in one go, so both reach the
// worker one after the other, before its next step. The rival command comes
// from the same tab, standing in for a second player.

type Vec3 = readonly [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segFlags: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string; payload: unknown }[]; roads: Net } | null };
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  elementFromPoint(x: number, y: number): { dispatchEvent(event: unknown): boolean } | null;
};
declare function requestAnimationFrame(callback: () => void): number;
declare const PointerEvent: new (type: string, init: Record<string, unknown>) => unknown;

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);
const STREET = { ax: 4220, bx: 4520, z: 4600 };

function city(withStreet: boolean): Buffer {
  const state = createState(SEED);
  if (withStreet) buildRoads(state, [[[STREET.ax, STREET.z], [STREET.bx, STREET.z], "street"]]);
  return Buffer.from(serialize(state));
}

async function openCity(page: Page, bytes: Buffer): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Dropped.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  const back = height * MENU_SHIFT;
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * 0.75 + back],
      [x, g, z + back],
    ] as const,
  );
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

/**
 * Clicks at (x, z) with `rival` sent just ahead of the click's own command,
 * in the same tick: the button goes down, then the rival is sent and the
 * button let up in one script, so nothing can step in between.
 */
async function clickBehind(page: Page, x: number, z: number, rival: { type: string; payload: unknown }): Promise<void> {
  await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.down();
  await page.evaluate(
    ([p, rival]) => {
      void window.cityCouncil.sendCommand(rival.type, rival.payload);
      const target = document.elementFromPoint(p.x, p.y);
      target?.dispatchEvent(new PointerEvent("pointerup", { clientX: p.x, clientY: p.y, button: 0, pointerId: 1, pointerType: "mouse", bubbles: true }));
    },
    [p, rival] as const,
  );
  // The real button comes up too; the click has already been taken.
  await page.mouse.up();
  await frames(page);
}

async function log(page: Page): Promise<{ type: string; payload: unknown }[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => ({ type: e.type, payload: e.payload })) ?? []);
}

/** Live segments the player built, not the outside connections' fixed stubs. */
async function playerSegments(page: Page): Promise<number> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    let n = 0;
    for (let s = 0; net && s < net.segFlags.length; s++) if (((net.segFlags[s] ?? 0) & 3) === 1) n++;
    return n;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("a continuous road stops at a segment the step drops, and says why", async ({ page }, testInfo) => {
  await openCity(page, city(false));
  await look(page, 4320, 4640, 260);
  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyU");
  await expect(page.locator("#draw-mode-continuous")).toHaveAttribute("aria-pressed", "true");
  await click(page, 4240, 4600);
  await hover(page, 4400, 4600);
  await attach(page, testInfo, "1 the first segment of a continuous road, before the click");
  const start = (await log(page)).length;
  // Another street lands on the same line first, in the same tick.
  await clickBehind(page, 4400, 4600, { type: "BuildRoad", payload: { from: { x: 4240, z: 4600 }, to: { x: 4400, z: 4600 }, type: "street" } });
  await expect(page.locator("#road-note")).toBeVisible();
  const note = (await page.locator("#road-note").textContent()) ?? "";
  expect(note.length).toBeGreaterThan(0);
  // Only the rival street was built. The road ended: nothing carries on from the dropped segment.
  await expect.poll(async () => (await log(page)).length).toBe(start + 1);
  expect(await playerSegments(page)).toBe(1);
  await expect(page.locator("#road-hint")).toContainText("Click on the map to start a road.");
  await hover(page, 4400, 4720);
  await attach(page, testInfo, "2 the segment was dropped at the step: its preview is gone, the road has ended and the note says why");
});

test("a bulldoze of a street another road split first is refused, and removes nothing", async ({ page }, testInfo) => {
  await openCity(page, city(true));
  await look(page, 4370, 4620, 260);
  await page.keyboard.press("KeyB");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  await hover(page, 4300, STREET.z);
  await expect(page.locator("#bulldoze-tag .price")).toHaveText(/^300 m/);
  await attach(page, testInfo, "3 the bulldoze preview marks the whole street");
  const start = (await log(page)).length;
  // A crossing road lands first, in the same tick, and splits the street the player picked.
  await clickBehind(page, 4300, STREET.z, { type: "BuildRoad", payload: { from: { x: 4370, z: 4500 }, to: { x: 4370, z: 4700 }, type: "street" } });
  await expect(page.locator("#road-note")).toHaveText("This road changed after you picked it, so nothing was done");
  await expect.poll(async () => (await log(page)).length).toBe(start + 1);
  expect((await log(page)).slice(start).map((e) => e.type)).toEqual(["BuildRoad"]);
  // Both halves of the street and both of the crossing stand.
  expect(await playerSegments(page)).toBe(4);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "4 the bulldoze was refused: the crossing is built, the street is whole, and the note says why");
});
