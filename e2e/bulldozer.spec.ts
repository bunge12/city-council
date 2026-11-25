import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_TYPES, POPS_BALANCE, SEG_FIXED, cellAt, createState, generateTerrain, heightAt, syncCells, type SimState } from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { addPop } from "../packages/sim/src/pops/pops";
import { lotProblem } from "../packages/sim/src/buildings/where";
import { finishConstruction } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue 116: the bulldozer, a tool of its own. B turns it on, R the road
// tool, Page Up and Page Down tilt. Whatever is under the pointer lights up
// with a price tag above it, and a click removes it: a road with the houses
// on its cells, or a house alone, at once and with no undo. A drag takes
// every thing of the kind it starts on. Where a building and a road are
// both under the pointer the building wins, and a filter lets a drag along
// a road pass over the houses. An outside connection cannot be removed.
//
// The city is built in Node with the sim and imported as a city file: a
// street running east from (4200, 4600) with a house on every two cells of
// its north side, two people living in each of its room for three, and a
// second street north of the houses, along z = 4480, with nothing on it.
// The tags count the people living there, whom a click displaces (M3-12),
// not the room.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    mirror: { state: { buildings: { flags: Uint8Array; firstPlace: Int32Array }; log: { type: string; payload: unknown }[]; roads: { segFlags: Uint8Array; segA: Int32Array; segB: Int32Array; nodeX: Float64Array; nodeZ: Float64Array } } | null };
    view: Promise<{ buildingTop(id: number): { x: number; y: number; z: number } | null }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      pickSegmentAt(sx: number, sy: number): number;
      pickBuildingAt(sx: number, sy: number): number;
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const terrain = generateTerrain(SEED);
const CELL = 8;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["BULLDOZER_EVIDENCE_DIR"];

const cellCentre = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

/** The street with houses two cells wide and four deep along its north side, and an empty street behind them. */
function houseCity(): { state: SimState; houses: number } {
  const state = createState(SEED);
  buildRoads(state, [
    [[4200, 4600], [4392, 4600], "street"],
    [[4200, 4480], [4392, 4480], "street"],
  ]);
  syncCells(state);
  for (let p = 0; p < 24; p++) {
    for (let k = 0; k < 6; k++) {
      const [x, z] = cellCentre(p, k);
      const cell = cellAt(state, x, z);
      if (!cell) continue;
      state.cells.zone[cell.index] = 1;
      state.cells.density[cell.index] = 1;
    }
  }
  const type = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  let houses = 0;
  for (let p = 0; p + 1 < 24; p += 2) {
    const [x, z] = cellCentre(p, 0);
    const cell = cellAt(state, x, z);
    if (!cell) continue;
    const shape = { first: { seg: cell.segment, side: cell.side, place: cell.place, dir: 0 }, width: 2, depth: 4, back: null };
    if (lotProblem(state, shape, 1, 1) !== null) continue;
    const lot = { firstSeg: cell.segment, firstSide: cell.side, firstPlace: cell.place, dir: 0, width: 2, depth: 4, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 };
    const home = addBuilding(state, { ...lot, type, residents: 3, variant: p * 7 });
    // Two people in a house with room for three, so a count of the people living there differs from the room (M3-12).
    // Newcomers in their grace, so the residential bar does not send them away while the test runs (#361).
    addPop(state, { home, size: 2, education: 1, wealth: 1, children: 0, satisfaction: 100, graceDays: POPS_BALANCE.newcomer.graceDays });
    houses++;
  }
  finishConstruction(state);
  return { state, houses };
}

/** Looks at (x, z) from `height` up, from the south, or from the north with `fromNorth`. */
async function look(page: Page, x: number, z: number, height: number, fromNorth = false): Promise<void> {
  const g = groundAt(x, z);
  const back = fromNorth ? -height * 0.9 : height * 0.75;
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + back], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function moveTo(page: Page, x: number, z: number): Promise<void> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

/** Moves the pointer to the top of building `id` as drawn. */
async function moveToTop(page: Page, id: number): Promise<{ x: number; y: number }> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  // A little under the roof's top, onto the building.
  const p = await screenAt(page, top.x, top.z, top.y - 1);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
  return p;
}

async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page, 4);
}

/** Live buildings, west to east. */
async function live(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.buildings;
    if (!b) return [];
    return Array.from(b.flags.keys())
      .filter((id) => ((b.flags[id] ?? 0) & 1) !== 0)
      .sort((p, q) => (b.firstPlace[p] ?? 0) - (b.firstPlace[q] ?? 0));
  });
}

/** The building ids each `BulldozeBuilding` in the log from entry `from` on named. */
async function bulldozedFrom(page: Page, from: number): Promise<number[][]> {
  return page.evaluate(
    (from) =>
      (window.cityCouncil.mirror.state?.log ?? [])
        .slice(from)
        .filter((e) => e.type === "BulldozeBuilding")
        .map((e) => (e.payload as { buildings: { id: number }[] }).buildings.map((b) => b.id)),
    from,
  );
}

async function logTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => e.type) ?? []);
}

/** Live road segments with an end on z = `z`. */
async function roadsOn(page: Page, z: number): Promise<number[]> {
  return page.evaluate((z) => {
    const r = window.cityCouncil.mirror.state?.roads;
    if (!r) return [];
    return Array.from(r.segFlags.keys()).filter((s) => ((r.segFlags[s] ?? 0) & 1) !== 0 && r.nodeZ[r.segA[s] ?? 0] === z && r.nodeZ[r.segB[s] ?? 0] === z);
  }, z);
}

const target = (page: Page) => page.evaluate(() => document.body.dataset["bulldozeTarget"] ?? "");

let shotNo = 0;
async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const png = await page.screenshot();
  writeFileSync(path, png);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, png);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the bulldozer: its own tool, a price tag on what it picks, clicks and drags of roads and houses", async ({ page }, testInfo) => {
  const { state, houses } = houseCity();
  expect(houses).toBeGreaterThan(8);
  await openCity(page, state, { name: "Houses" });
  await look(page, 4296, 4570, 220);
  const tag = page.locator("#bulldoze-tag");

  await test.step("B turns the bulldozer on: its own dock button and filters, and the road menu is gone", async () => {
    await expect(page.locator("#bulldoze-tool")).toBeVisible();
    await page.keyboard.press("KeyB");
    await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#road-menu")).toHaveCount(0);
    await expect(page.locator("#bulldoze-filter-building")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#bulldoze-filter-road")).toHaveAttribute("aria-pressed", "true");
    await away(page);
    await attach(page, testInfo, "the bulldozer on, with its filters");
  });

  await test.step("hovering the street shows its price and the houses it takes, and marks them", async () => {
    // Shift takes the whole road (issue 86); without it the bulldozer takes a stretch.
    await page.keyboard.down("Shift");
    await moveTo(page, 4380, 4600);
    await expect(tag).toHaveAttribute("data-kind", "road");
    await expect(tag).toHaveAttribute("data-ok", "true");
    await expect(tag.locator(".what")).toHaveText("Bulldoze this road");
    await expect(tag.locator(".price")).toHaveText(/^192 m · \$[\d.]+K$/);
    await expect(page.locator("#bulldoze-clears")).toHaveText(`Takes ${houses} buildings, ${houses * 2} residents`);
    await expect(tag).toHaveAttribute("data-buildings", String(houses));
    await attach(page, testInfo, "a road's price tag, and the houses it takes marked");
  });

  const all = await live(page);
  const [first, second, third, fourth] = all;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) throw new Error("too few houses");

  await test.step("hovering a house shows its readout, a price line and that it cannot be undone", async () => {
    await moveToTop(page, fourth);
    expect(await target(page)).toBe(`building:${fourth}`);
    await expect(tag).toHaveAttribute("data-kind", "building");
    await expect(tag).toHaveAttribute("data-undoable", "false");
    await expect(tag.locator(".what")).toHaveText("Single family home");
    await expect(tag.locator(".detail")).toHaveText(/^Residential R1 \(2 × 4 lot\) · 2\/3 residents$/);
    await expect(tag).toHaveAttribute("data-residents", "2");
    await expect(page.locator("#bulldoze-cost")).toHaveText("$0");
    await expect(page.locator("#bulldoze-no-undo")).toHaveText("Can't be undone");
    await attach(page, testInfo, "a house's price tag");
  });

  await test.step("a click on a house removes it at once, with no dialog, in one log entry", async () => {
    const log = (await logTypes(page)).length;
    await page.mouse.down();
    await page.mouse.up();
    // The grower may build on the free lot at once, so the log says what went.
    await expect.poll(async () => bulldozedFrom(page, log), { timeout: 30_000 }).toEqual([[fourth]]);
    expect((await logTypes(page)).slice(log)).toEqual(["BulldozeBuilding"]);
    await away(page);
    await attach(page, testInfo, "the house is gone, one log entry");
  });

  await test.step("a drag over three houses removes them and leaves the street, in one log entry", async () => {
    const log = (await logTypes(page)).length;
    const roads = await roadsOn(page, 4600);
    const a = await moveToTop(page, first);
    const topC = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), third);
    if (!topC) throw new Error("third house not drawn");
    const c = await screenAt(page, topC.x, topC.z, topC.y - 1);
    await page.mouse.down();
    await page.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2, { steps: 15 });
    await page.mouse.move(c.x, c.y, { steps: 15 });
    await frames(page, 3);
    await expect(tag).toHaveAttribute("data-ids", [first, second, third].join(","));
    await expect(tag.locator(".what")).toHaveText("Bulldoze 3 buildings, 6 residents");
    await attach(page, testInfo, "a drag over three houses, one tag with the total");
    await page.mouse.up();
    await expect.poll(async () => bulldozedFrom(page, log), { timeout: 30_000 }).toEqual([[first, second, third]]);
    expect((await logTypes(page)).slice(log)).toEqual(["BulldozeBuilding"]);
    expect(await roadsOn(page, 4600)).toEqual(roads);
    await away(page);
    await attach(page, testInfo, "three houses gone, the street stays");
  });

  await test.step("from behind the houses, where a house covers the street on screen, the house is picked", async () => {
    await look(page, 4340, 4600, 60, true);
    // Look for a screen point that is over a house and inside the street's pick radius at once.
    const found = await page.evaluate(async () => {
      const cam = await window.cityCouncil.camera;
      let buildings = 0;
      let roads = 0;
      for (let y = 60; y < 780; y += 3) {
        for (let x = 60; x < 1220; x += 4) {
          const b = cam.pickBuildingAt(x, y);
          const r = cam.pickSegmentAt(x, y);
          if (b !== -1) buildings++;
          if (r !== -1) roads++;
          if (b !== -1 && r !== -1) return { at: { x, y }, house: b, buildings, roads };
        }
      }
      return { at: null, house: -1, buildings, roads };
    });
    expect(found.at, `points over a building: ${found.buildings}, over a road: ${found.roads}`).not.toBeNull();
    if (!found.at) return;
    await page.mouse.move(found.at.x, found.at.y, { steps: 4 });
    await frames(page, 3);
    expect(await target(page)).toBe(`building:${found.house}`);
    await attach(page, testInfo, "a house in front of the street on screen is picked over it");
  });

  await test.step("with Buildings off, a drag along the street passes over the houses, and removes them with the street", async () => {
    await look(page, 4296, 4570, 220);
    await page.locator("#bulldoze-filter-building").click();
    await expect(page.locator("#bulldoze-filter-building")).toHaveAttribute("aria-pressed", "false");
    const left = (await live(page)).length;
    expect(left).toBeGreaterThan(0);
    const log = (await logTypes(page)).length;
    const a = await screenAt(page, 4210, 4600);
    const b = await screenAt(page, 4385, 4600);
    await page.mouse.move(a.x, a.y, { steps: 4 });
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 30 });
    await frames(page, 3);
    await expect(tag).toHaveAttribute("data-kind", "road");
    // The grower keeps filling the lots cleared above, so the count is checked against none left after.
    expect(Number(await tag.getAttribute("data-buildings"))).toBeGreaterThanOrEqual(left);
    await attach(page, testInfo, "Buildings off: a drag along the street takes the street and the houses on it");
    await page.mouse.up();
    await expect.poll(async () => (await live(page)).length, { timeout: 30_000 }).toBe(0);
    expect((await logTypes(page)).slice(log)).toEqual(["BulldozeRoad"]);
    expect(await roadsOn(page, 4600)).toEqual([]);
    expect(await roadsOn(page, 4480)).toHaveLength(1);
    await away(page);
    await attach(page, testInfo, "the street and its houses gone, one log entry");
    await page.locator("#bulldoze-filter-building").click();
  });

  await test.step("an outside connection reads as one that cannot be removed, and a click sends nothing", async () => {
    const stub = await page.evaluate((fixed) => {
      const r = window.cityCouncil.mirror.state?.roads;
      if (!r) return null;
      for (let s = 0; s < r.segFlags.length; s++) {
        if (((r.segFlags[s] ?? 0) & 1) === 0 || ((r.segFlags[s] ?? 0) & fixed) === 0) continue;
        const a = r.segA[s] ?? 0;
        const b = r.segB[s] ?? 0;
        return { seg: s, x: ((r.nodeX[a] ?? 0) + (r.nodeX[b] ?? 0)) / 2, z: ((r.nodeZ[a] ?? 0) + (r.nodeZ[b] ?? 0)) / 2 };
      }
      return null;
    }, SEG_FIXED);
    if (!stub) throw new Error("no outside connection");
    await look(page, stub.x, stub.z, 150);
    await moveTo(page, stub.x, stub.z);
    expect(await target(page)).toBe(`road:${stub.seg}`);
    await expect(tag).toHaveAttribute("data-ok", "false");
    await expect(tag).toHaveAttribute("data-fixed", "true");
    await expect(page.locator("#bulldoze-reason")).toHaveText("This road is fixed and cannot be removed");
    await attach(page, testInfo, "an outside connection cannot be removed");
    const log = (await logTypes(page)).length;
    await page.mouse.down();
    await page.mouse.up();
    await frames(page, 6);
    expect((await logTypes(page)).length).toBe(log);
  });

  await test.step("R is the road tool, and the shortcuts panel lists R, B and Page Up and Page Down", async () => {
    await page.keyboard.press("KeyR");
    await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backquote");
    const panel = page.locator("#debug-panel");
    await expect(panel).toContainText("road tool on or off");
    await expect(panel).toContainText("bulldozer on or off");
    await expect(panel).toContainText("Page Up, Page Down");
    await panel.getByText("Page Up, Page Down").scrollIntoViewIfNeeded();
    await attach(page, testInfo, "the shortcuts panel with the new keys");
  });
});
