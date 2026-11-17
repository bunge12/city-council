import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { cellAt, cellsSettled, createState, segmentEnds, segmentTypeId, serialize, step, submit, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// M2 review (#147): an undo that would take ground a building stands on is
// refused. The city file has a street at z = 4600 zoned R1 along its north
// side, and a street from the north that meets it at x = 4296, laid after
// the zoning, so the zoned cells under it are blocked; houses stand on the
// rest. The player bulldozes the street from the north, its ground opens and
// a house grows there. Ctrl+Z would put the street back over that house, so
// it is refused with the sim's reason. Once the player clears the house with
// a BulldozeBuilding, which names it with the tick it was built (the M2
// review's other fix), Ctrl+Z puts the street back.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: {
      state: {
        log: { type: string }[];
        buildings: { flags: ArrayLike<number>; firstSeg: ArrayLike<number>; firstSide: ArrayLike<number>; firstPlace: ArrayLike<number>; builtAt: ArrayLike<number> };
      } | null;
    };
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

const CROSS_X = 4296;

/** The city file, grown in Node until no free zoned cell is left, and the street from the north with its ends and type. */
function startCity(): { state: SimState; cross: { segments: number[]; ends: number[][]; types: string[] } } {
  const state = createState(SEED);
  buildRoads(state, [[[4200, 4600], [4392, 4600], "street"]]);
  const zone = { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4579 }, to: { x: 4390, z: 4579 }, width: 28 }] };
  if (!submit(state, { seq: 100, playerId: "fixture", type: "ZoneCells", payload: zone }).ok) throw new Error("zoning refused");
  step(state);
  buildRoads(state, [[[CROSS_X, 4450], [CROSS_X, 4600], "street"]]);
  while (!cellsSettled(state)) step(state);
  // A month of growth fills the strip but for the cells under the street from the north.
  for (let i = 0; i < 40 * 100; i++) step(state);
  const seg = cellAt(state, CROSS_X + 9, 4520)?.segment;
  if (seg === undefined) throw new Error("no street from the north");
  return { state, cross: { segments: [seg], ends: [segmentEnds(state.roads, seg)], types: [segmentTypeId(state.roads, seg)] } };
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page);
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Every building standing, as a BulldozeBuilding names it. */
async function houses(page: Page): Promise<{ id: number; segment: number; side: number; place: number; builtAt: number }[]> {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.buildings;
    const out: { id: number; segment: number; side: number; place: number; builtAt: number }[] = [];
    if (!b) return out;
    for (let id = 0; id < b.flags.length; id++) {
      if (b.flags[id]) out.push({ id, segment: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, builtAt: b.builtAt[id] ?? 0 });
    }
    return out;
  });
}

test("an undo that would put a street back over a house is refused, and goes through once the house is cleared", async ({ page }, testInfo) => {
  const { state, cross } = startCity();
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Undo.city", mimeType: "application/octet-stream", buffer: Buffer.from(serialize(state)) });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
  const g = groundAt(CROSS_X, 4560);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [
    [CROSS_X, g + 170, 4560 + 130],
    [CROSS_X, g, 4560],
  ] as const);
  await frames(page);
  const before = (await houses(page)).map((h) => h.id);
  expect(before.length).toBeGreaterThan(5);
  await attach(page, testInfo, "1 houses along the street, none under the street from the north");

  // The player bulldozes the street from the north. The ground under it opens, and a house grows there.
  expect(await page.evaluate((p) => window.cityCouncil.sendCommand("BulldozeRoad", p), cross)).toEqual({ ok: true });
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  await expect.poll(async () => (await houses(page)).length, { timeout: 120_000 }).toBeGreaterThan(before.length);
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
  const grown = (await houses(page)).filter((h) => !before.includes(h.id));
  await attach(page, testInfo, "2 bulldozed the street from the north, and a house grew where it was");

  // Ctrl+Z would put the street back over that house: refused, with the reason.
  const logBefore = await page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
  await page.keyboard.press("Control+KeyZ");
  await expect(page.locator("#undo-note")).toHaveText("Cannot undo: buildings now stand on ground that road would take back");
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0)).toBe(logBefore);
  await attach(page, testInfo, "3 Ctrl+Z refused: a house stands where the street would come back");

  // Clear what grew there, named with the tick each was built, and Ctrl+Z goes through.
  expect(await page.evaluate((buildings) => window.cityCouncil.sendCommand("BulldozeBuilding", { buildings }), grown)).toEqual({ ok: true });
  await expect.poll(async () => (await houses(page)).length).toBe(before.length);
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.log.at(-1)?.type)).toBe("Undo");
  await attach(page, testInfo, "4 cleared the house, and Ctrl+Z put the street back");
});
