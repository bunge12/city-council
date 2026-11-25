import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { cellAt, cellsSettled, createState, segmentEnds, segmentTypeId, step, submit, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

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
  await openCity(page, state, { name: "Undo" });
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

// #369: an undo that would remove a road buildings stand on is refused too.
// The player built the street at z = 4600 and another player zoned along it,
// and houses grew. Ctrl+Z would take the street and every house on it, so it
// is refused with the sim's reason, and goes through once the houses are
// cleared.
test("an undo that would remove a street houses stand on is refused, and goes through once they are cleared", async ({ page }, testInfo) => {
  const state = createState(SEED);
  if (!submit(state, { seq: 1, playerId: "local", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" } }).ok) throw new Error("street refused");
  step(state);
  const zone = { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4579 }, to: { x: 4390, z: 4579 }, width: 28 }] };
  if (!submit(state, { seq: 2, playerId: "fixture", type: "ZoneCells", payload: zone }).ok) throw new Error("zoning refused");
  step(state);
  for (let i = 0; i < 40 * 100; i++) step(state);
  await openCity(page, state, { name: "Undo" });
  // Paused, so nothing grows again on the zoning once the houses are cleared.
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
  const g = groundAt(4296, 4590);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [
    [4296, g + 170, 4590 + 130],
    [4296, g, 4590],
  ] as const);
  await frames(page);
  const standing = await houses(page);
  expect(standing.length).toBeGreaterThan(5);
  await attach(page, testInfo, "1 houses another player's zoning grew along the player's street");

  const logBefore = await page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
  await page.keyboard.press("Control+KeyZ");
  await expect(page.locator("#undo-note")).toHaveText("Cannot undo: buildings stand on that road");
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0)).toBe(logBefore);
  expect((await houses(page)).length).toBe(standing.length);
  await attach(page, testInfo, "2 Ctrl+Z refused: houses stand on the street");

  expect(await page.evaluate((buildings) => window.cityCouncil.sendCommand("BulldozeBuilding", { buildings }), standing)).toEqual({ ok: true });
  await expect.poll(async () => (await houses(page)).length).toBe(0);
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.log.at(-1)?.type)).toBe("Undo");
  await attach(page, testInfo, "3 cleared the houses, and Ctrl+Z took the street back");
});
