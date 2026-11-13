import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-22: roads on different levels cross without a junction. No player
// tool sets a level in M1, so the debug panel's road level picker builds an
// elevated road over a ground street. The preview shows no junction, the
// built road stands on piers over the street with no node between them, and
// a second elevated road crossing the first joins it at its own level.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: {
      state: {
        log: { type: string }[];
        roads: { segLevelA: ArrayLike<number>; segLevelB: ArrayLike<number>; segFlags: ArrayLike<number>; nodeFlags: ArrayLike<number> };
      } | null;
    };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);

/** A ground street west to east across seed 2026's flat square, and the line the elevated road takes over it. */
const STREET = { x0: 4200, x1: 4600, z: 4600 };
const OVER = { x: 4400, z0: 4480, z1: 4720 };
/** The second elevated road, west to east, crossing the first at (4400, 4680). */
const SECOND = { x0: 4300, x1: 4520, z: 4680 };

async function openCity(page: Page, bytes: Buffer): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Levels.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Looks at (x, z) from `height` metres up, `back` times as far to the south as up and `side` times as far to the east. */
async function look(page: Page, x: number, z: number, height: number, back = 0.75, side = 0): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x + height * side, g + height, z + height * back],
      [x, g, z],
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

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

/** Each player-built live segment's levels at A and B, in id order, and the live node count. */
async function graph(page: Page): Promise<{ levels: [number, number][]; nodes: number }> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    const levels: [number, number][] = [];
    let nodes = 0;
    if (!net) return { levels, nodes };
    for (let s = 0; s < net.segFlags.length; s++) {
      if (((net.segFlags[s] ?? 0) & 3) === 1) levels.push([net.segLevelA[s] ?? 0, net.segLevelB[s] ?? 0]);
    }
    for (let n = 0; n < net.nodeFlags.length; n++) if (((net.nodeFlags[n] ?? 0) & 3) === 1) nodes++;
    return { levels, nodes };
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("an elevated road built from the debug panel passes over a ground street with no junction, and joins another at its own level", async ({ page }, testInfo) => {
  const state = createState(SEED);
  buildRoads(state, [[[STREET.x0, STREET.z], [STREET.x1, STREET.z], "street"]]);
  await openCity(page, Buffer.from(serialize(state)));
  const before = await graph(page);
  expect(before.levels).toEqual([[0, 0]]);
  const logged = await logLength(page);

  // The debug panel's road level picker: the only way to build off the ground in M1.
  await page.keyboard.press("Backquote");
  const picker = page.locator("#road-level");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue("ground");
  await expect(picker.locator("option")).toHaveText(["Ground", "Tunnel", "Elevated 1", "Elevated 2"]);
  await picker.selectOption("elevated1");
  await page.keyboard.press("Backquote");

  await look(page, OVER.x, STREET.z, 320);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyX");
  await click(page, OVER.x, OVER.z0);
  await hover(page, OVER.x, OVER.z1);
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await attach(page, testInfo, "1 preview of an elevated avenue across the street");
  await click(page, OVER.x, OVER.z1);
  await expect.poll(() => logLength(page)).toBe(logged + 1);

  // Two segments, the avenue on the first elevated level, and no node where they cross.
  const after = await graph(page);
  expect(after.levels).toEqual([
    [0, 0],
    [3, 3],
  ]);
  expect(after.nodes).toBe(before.nodes + 2);
  await page.keyboard.press("Escape");
  await page.mouse.move(20, 400);

  // Low and from the south-east, to see the deck on its piers over the street.
  await look(page, OVER.x, STREET.z, 30, 1.6, 1.2);
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe("street");
  await attach(page, testInfo, "2 elevated avenue over the street, from the side");
  await look(page, OVER.x, STREET.z, 140, 0.9, 0.4);
  await attach(page, testInfo, "3 elevated avenue over the street, from higher");

  // A second elevated road across the first splits it and joins it, up on its level.
  await look(page, OVER.x, SECOND.z, 320);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyZ");
  await click(page, SECOND.x0, SECOND.z);
  await hover(page, SECOND.x1, SECOND.z);
  await expect(readout).toHaveAttribute("data-ok", "true");
  await click(page, SECOND.x1, SECOND.z);
  await expect.poll(() => logLength(page)).toBe(logged + 2);
  const joined = await graph(page);
  expect(joined.levels.filter(([a]) => a === 3)).toHaveLength(4);
  expect(joined.nodes).toBe(after.nodes + 3);
  await page.keyboard.press("Escape");
  await page.mouse.move(20, 400);
  await look(page, OVER.x, 4640, 70, 1.4, 0.9);
  await attach(page, testInfo, "4 two elevated roads joined at their own level, over the street");
});
