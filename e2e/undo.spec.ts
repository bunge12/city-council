import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M1-14: undo. A player draws a street across one that came with the
// city, zones one of its pieces (issue 111), upgrades the other and
// bulldozes the zoned one, then takes all four back one step at a time:
// Ctrl+Z, the undo button and Cmd+Z. The bulldozed piece comes back with its
// zoning, the zoning goes on its own undo, the network ends exactly as the
// city file had it, the button goes grey, and an undo with nothing left
// shows the sim's reason.
//
// The city is built in Node with the sim and imported as a city file. Its
// street was built by another player id, so this player cannot undo it.

type Vec3 = readonly [number, number, number];
interface Net {
  segFlags: ArrayLike<number>;
  segType: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  segCX: ArrayLike<number>;
  segCZ: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: {
      state: { log: { type: string; playerId: string }[]; roads: Net & Record<string, ArrayLike<number>>; cells: { zone: ArrayLike<number> };
        buildings: Record<"flags" | "firstSeg" | "firstSide" | "firstPlace" | "builtAt", ArrayLike<number>>;
      } | null;
    };
    sendCommand(type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);

/** A north-south street at x = 4350 from z = 4500 to 4700, built by another player. */
function startCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4350, 4500], [4350, 4700], "street"]]);
  return state;
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * 0.75],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const h = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function click(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  await page.mouse.click(p.x, p.y);
  await frames(page);
}

/** Moves the pointer off the map so no preview shows in a screenshot. */
async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page);
}

/** Every road array of the mirror's copy, as plain lists, to compare whole networks. */
async function roads(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return Object.fromEntries(Object.entries(net).map(([k, a]) => [k, Array.from(a)]));
  });
}

/** How many cells in the mirror are zoned. */
async function zonedCount(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(window.cityCouncil.mirror.state?.cells.zone ?? []).filter((z) => z !== 0).length);
}

/** How many buildings stand in the mirror. */
async function buildingCount(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(window.cityCouncil.mirror.state?.buildings.flags ?? []).filter((f) => f !== 0).length);
}

/** Opens the zone tool, and with it the zoning overlay, and waits for the cells to be drawn. */
async function zoneTool(page: Page): Promise<void> {
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
}

/** Attaches a screenshot with the zoning overlay on, then closes the zone tool. */
async function attachZoning(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await zoneTool(page);
  await away(page);
  await attach(page, testInfo, name);
  await page.keyboard.press("KeyK");
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "false");
}

async function logTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => e.type) ?? []);
}

/** The live segment whose middle is nearest (x, z) in the mirror, and its type. */
async function segmentNear(page: Page, x: number, z: number): Promise<{ id: number; type: number }> {
  return page.evaluate(
    ([x, z]) => {
      const net = window.cityCouncil.mirror.state?.roads;
      if (!net) throw new Error("no state");
      let best = { id: -1, type: -1 };
      let bestD = Infinity;
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
        const a = net.segA[s] ?? 0;
        const b = net.segB[s] ?? 0;
        const mx = ((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0) + 2 * (net.segCX[s] ?? 0)) / 4;
        const mz = ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0) + 2 * (net.segCZ[s] ?? 0)) / 4;
        const d = Math.hypot(mx - x, mz - z);
        if (d < bestD) {
          best = { id: s, type: net.segType[s] ?? -1 };
          bestD = d;
        }
      }
      return bestD < 5 ? best : { id: -1, type: -1 };
    },
    [x, z] as const,
  );
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("builds, zones, upgrades and bulldozes, then undoes all four one step at a time", async ({ page }, testInfo) => {
  await openCity(page, startCity(), { name: "Undo" });
  await look(page, 4350, 4600, 260);
  await page.keyboard.press("KeyL");
  await expect(page.locator("#activity-log")).toBeVisible();
  const note = page.locator("#undo-note");
  const start = await roads(page);
  const startLog = (await logTypes(page)).length;
  // Undo is Ctrl+Z or Cmd+Z only: the dock has no button for it (issue #332).
  await expect(page.locator("#undo")).toHaveCount(0);
  await attach(page, testInfo, "1 a street from the city file, nothing to undo");

  // Draw a street west to east across it. It splits the street it crosses.
  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyZ");
  await click(page, 4220, 4600);
  await click(page, 4480, 4600);
  await expect.poll(async () => (await logTypes(page)).length).toBe(startLog + 1);
  await page.keyboard.press("KeyR");
  const built = await roads(page);
  const west = await segmentNear(page, 4285, 4600);
  const east = await segmentNear(page, 4415, 4600);
  expect(west.id).toBeGreaterThanOrEqual(0);
  expect(east.id).toBeGreaterThanOrEqual(0);
  await away(page);
  await attach(page, testInfo, "2 built a street across it");

  // Zone R1 along the north side of the east piece with the zone tool's defaults.
  await zoneTool(page);
  await click(page, 4415, 4596);
  await expect.poll(async () => (await logTypes(page)).length).toBe(startLog + 2);
  await expect.poll(() => zonedCount(page)).toBeGreaterThan(0);
  const zoned = await zonedCount(page);
  await page.keyboard.press("KeyK");
  // A house grows on it.
  await expect.poll(() => buildingCount(page), { timeout: 60_000 }).toBeGreaterThan(0);
  await attachZoning(page, testInfo, "3 zoned the east piece R1, and a house grew");

  // Upgrade the west piece to an avenue.
  await page.keyboard.press("KeyV");
  await page.keyboard.press("KeyX");
  // Shift takes the whole piece (issue 86).
  await page.keyboard.down("Shift");
  await click(page, 4285, 4600);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await segmentNear(page, 4285, 4600)).type).toBe(1);
  const upgraded = await roads(page);
  await away(page);
  await attach(page, testInfo, "4 upgraded the west piece to an avenue");

  // Pause, so nothing grows while the undos are checked. Commands still apply.
  await page.getByRole("button", { name: "Pause" }).click();

  // Clear the house first. A bulldoze that took it could not be undone (M4-09),
  // and clearing a building has no undo record, so the steps below still undo one by one.
  const houses = await page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.buildings;
    const out: { id: number; segment: number; side: number; place: number; builtAt: number }[] = [];
    if (!b) return out;
    for (let id = 0; id < b.flags.length; id++) {
      if (b.flags[id]) out.push({ id, segment: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, builtAt: b.builtAt[id] ?? 0 });
    }
    return out;
  });
  expect(houses.length).toBeGreaterThan(0);
  expect(await page.evaluate((buildings) => window.cityCouncil.sendCommand("BulldozeBuilding", { buildings }), houses)).toEqual({ ok: true });
  await expect.poll(() => buildingCount(page)).toBe(0);

  // Bulldoze the east piece, with nothing on it now.
  await page.keyboard.press("KeyB");
  await page.keyboard.down("Shift");
  await click(page, 4415, 4600);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await segmentNear(page, 4415, 4600)).id).toBe(-1);
  await page.keyboard.press("KeyB");
  await expect.poll(() => zonedCount(page)).toBe(0);
  expect(await buildingCount(page)).toBe(0);
  await attachZoning(page, testInfo, "5 cleared the house, then bulldozed the east piece and its zoning");
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoad", "ZoneCells", "UpgradeRoad", "SetSpeed", "BulldozeBuilding", "BulldozeRoad"]);

  // Ctrl+Z brings the east piece back, under the same id, with its zoning.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(async () => (await segmentNear(page, 4415, 4600)).id).toBe(east.id);
  expect(await roads(page)).toEqual(upgraded);
  await expect.poll(() => zonedCount(page)).toBe(zoned);
  // The house does not come back: clearing it has no undo, and the grower builds again once the game runs.
  expect(await buildingCount(page)).toBe(0);
  await attachZoning(page, testInfo, "6 Ctrl+Z put the bulldozed piece back with its zoning, and no house");

  // Ctrl+Z again takes back the upgrade.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(async () => (await segmentNear(page, 4285, 4600)).type).toBe(0);
  expect(await roads(page)).toEqual(built);
  await away(page);
  await attach(page, testInfo, "7 Ctrl+Z turned the avenue back into a street");

  // Ctrl+Z takes back the zoning, and leaves the roads as they are.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(() => zonedCount(page)).toBe(0);
  expect(await roads(page)).toEqual(built);
  await attachZoning(page, testInfo, "8 Ctrl+Z took back the zoning");

  // Cmd+Z takes back the build and rejoins the street it split.
  await page.keyboard.press("Meta+KeyZ");
  await expect.poll(async () => roads(page)).toEqual(start);
  expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoad", "ZoneCells", "UpgradeRoad", "SetSpeed", "BulldozeBuilding", "BulldozeRoad", "Undo", "Undo", "Undo", "Undo"]);
  await expect(page.locator("#activity-log")).toContainText("Undo");
  await away(page);
  await attach(page, testInfo, "9 Cmd+Z took back the build, the network is as the file had it");

  // One more press, with nothing left: the sim refuses and says why.
  await page.keyboard.press("Control+KeyZ");
  await expect(note).toHaveText("Nothing to undo");
  expect((await logTypes(page)).slice(startLog)).toHaveLength(10);
  await attach(page, testInfo, "10 nothing left to undo, and the reason shown");
});
