import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { LEVEL_BRIDGE, ROAD_TYPES, SEG_FIXED, bridgeDeckLevel, createState, generateTerrain, heightAt, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { frames, openCity } from "./helpers";

// Issue M1-13: the upgrade and bulldoze tools. A player upgrades a street to
// an avenue and sees it widen, bulldozes it and sees it gone, with a log
// entry for each; drags across four segments for one entry; picks a curve,
// a bridge and one of two close roads; sees a fixed road refused; reverses a
// one-way with a right-click; and finds both keys in the shortcut list.
//
// Each city is built in Node with the sim and imported as a city file, so
// every run edits the same roads.

type Vec3 = readonly [number, number, number];
interface Net {
  segFlags: ArrayLike<number>;
  segType: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string; payload: unknown }[]; roads: Net } | null };
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

/** A street along z = 4600 from x = 4150 to 4550, crossed by three streets: four segments along it. */
const MAIN_Z = 4600;
const CROSS_XS = [4250, 4350, 4450];

function crossedCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4150, MAIN_Z], [4550, MAIN_Z], "street"], ...CROSS_XS.map((x) => [[x, 4500], [x, 4700], "street"] as [[number, number], [number, number], string])]);
  return state;
}

/** Seed 2026's inlet: water from x = 3488 to 3600 along z = 6600. */
const RIVER = { x0: 3400, x1: 3700, z: 6600, mid: 3545 };

/** A curved avenue, two streets 16 m apart, and a bridge, for picking. */
function pickingCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [
    [[4150, 4900], [4350, 4900], "avenue", [4250, 4800]],
    [[4150, 4600], [4450, 4600], "street"],
    [[4150, 4616], [4450, 4616], "street"],
    [[RIVER.x0, RIVER.z], [RIVER.x1, RIVER.z], "street"],
    [[4500, 4700], [4650, 4700], "oneWay"],
  ]);
  return state;
}

/** The live segment whose middle is nearest (x, z). */
function segmentNear(state: SimState, x: number, z: number): number {
  const net = state.roads;
  let best = -1;
  let bestD = Infinity;
  for (let s = 0; s < net.segFlags.length; s++) {
    if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    const mx = ((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0) + 2 * (net.segCX[s] ?? 0)) / 4;
    const mz = ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0) + 2 * (net.segCZ[s] ?? 0)) / 4;
    const d = Math.hypot(mx - x, mz - z);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Looks at (x, z) from `height` metres up and to the south, `back` times as far south as up. */
async function look(page: Page, x: number, z: number, height: number, back = 0.75): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * back],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

/** Where (x, z) is drawn on screen: on the ground, or at height `y` when given. */
async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

async function hover(page: Page, x: number, z: number, y?: number): Promise<void> {
  const p = await screenAt(page, x, z, y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
}

async function click(page: Page, x: number, z: number, button: "left" | "right" = "left"): Promise<void> {
  await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x, p.y, { button });
  await frames(page);
}

async function picked(page: Page): Promise<number> {
  return Number(await page.evaluate(() => document.body.dataset["pickedSegment"]));
}

async function logEntries(page: Page): Promise<{ type: string; payload: unknown }[]> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => ({ type: e.type, payload: e.payload })) ?? []);
}

async function segment(page: Page, seg: number): Promise<{ alive: boolean; type: number; a: number; b: number }> {
  return page.evaluate((seg) => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return { alive: ((net.segFlags[seg] ?? 0) & 1) !== 0, type: net.segType[seg] ?? -1, a: net.segA[seg] ?? -1, b: net.segB[seg] ?? -1 };
  }, seg);
}

/** Where segments' ends are and their types in the page's copy now, as a bulldoze or upgrade carries them. */
async function endsOf(page: Page, segs: readonly number[]): Promise<{ ends: number[][]; types: string[] }> {
  const rows = await page.evaluate((segs) => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return segs.map((seg) => {
      const a = net.segA[seg] ?? 0;
      const b = net.segB[seg] ?? 0;
      return { ends: [net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0, net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0], type: net.segType[seg] ?? 0 };
    });
  }, segs);
  return { ends: rows.map((r) => r.ends), types: rows.map((r) => ROAD_TYPES[r.type]?.id ?? "") };
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("upgrades a street to an avenue and sees it widen, then bulldozes it, with a log entry each", async ({ page }, testInfo) => {
  const state = crossedCity();
  const seg = segmentNear(state, 4300, MAIN_Z);
  await openCity(page, state, { name: "Edit" });
  await look(page, 4300, MAIN_Z, 160);
  const readout = page.locator("#edit-readout");
  const start = (await logEntries(page)).length;
  const ends = await endsOf(page, [seg]);
  await attach(page, testInfo, "1 a street before");

  // V turns on the upgrade tool, X picks avenue in the road type picker.
  await page.keyboard.press("KeyV");
  await page.keyboard.press("KeyX");
  await expect(page.locator("#upgrade-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#road-type-avenue")).toHaveAttribute("aria-pressed", "true");
  // Shift takes the whole segment (issue 86); without it the tools take a stretch.
  await page.keyboard.down("Shift");
  await hover(page, 4300, MAIN_Z);
  expect(await picked(page)).toBe(seg);
  await expect(readout).toHaveAttribute("data-kind", "upgrade");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toContainText(/^Upgrade to avenue, 100 m · \$[\d.]+K$/);
  expect(Number(await readout.getAttribute("data-cost"))).toBeGreaterThan(0);
  await attach(page, testInfo, "2 upgrade preview shows the avenue's width and price");

  await click(page, 4300, MAIN_Z);
  await expect.poll(async () => (await segment(page, seg)).type).toBe(1);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "3 upgraded to an avenue");
  let log = await logEntries(page);
  expect(log.slice(start)).toEqual([{ type: "UpgradeRoad", payload: { segments: [seg], ...ends, type: "avenue" } }]);

  const upgraded = await endsOf(page, [seg]);
  expect(upgraded.types).toEqual(["avenue"]);
  // B turns on the bulldozer (issue 116), whose price tag stands over the road.
  await page.keyboard.press("KeyB");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  await hover(page, 4300, MAIN_Z);
  const tag = page.locator("#bulldoze-tag");
  await expect(tag).toHaveAttribute("data-kind", "road");
  await expect(tag.locator(".what")).toHaveText("Bulldoze this road");
  await expect(tag.locator(".price")).toHaveText(/^100 m · \$[\d.]+K$/);
  await attach(page, testInfo, "4 bulldoze preview marks the avenue");
  await click(page, 4300, MAIN_Z);
  await expect.poll(async () => (await segment(page, seg)).alive).toBe(false);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "5 bulldozed");
  log = await logEntries(page);
  expect(log.slice(start)).toEqual([
    { type: "UpgradeRoad", payload: { segments: [seg], ...ends, type: "avenue" } },
    { type: "BulldozeRoad", payload: { segments: [seg], ...upgraded } },
  ]);
});

test("a drag across four segments bulldozes them in one log entry", async ({ page }, testInfo) => {
  const state = crossedCity();
  const segs = [4200, 4300, 4400, 4500].map((x) => segmentNear(state, x, MAIN_Z));
  await openCity(page, state, { name: "Edit" });
  await look(page, 4350, MAIN_Z, 320);
  const start = (await logEntries(page)).length;
  const ends = await endsOf(page, segs);
  await page.keyboard.press("KeyB");
  // With Shift held a drag takes each segment it passes over whole (issue 86).
  await page.keyboard.down("Shift");
  const a = await screenAt(page, 4165, MAIN_Z);
  const b = await screenAt(page, 4535, MAIN_Z);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 30 });
  await frames(page);
  const tag = page.locator("#bulldoze-tag");
  await expect(tag).toHaveAttribute("data-ids", segs.join(","));
  await expect(tag.locator(".what")).toHaveText("Bulldoze 4 road segments");
  await expect(tag.locator(".price")).toHaveText(/^400 m/);
  await attach(page, testInfo, "6 a drag marks four segments");
  await page.mouse.up();
  await expect.poll(async () => (await logEntries(page)).length).toBe(start + 1);
  const log = await logEntries(page);
  expect(log.slice(start)).toEqual([{ type: "BulldozeRoad", payload: { segments: segs, ...ends } }]);
  for (const seg of segs) expect((await segment(page, seg)).alive).toBe(false);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "7 four segments gone, one log entry");
});

test("picks a curve along the curve, a bridge at its deck, and the nearer of two close roads", async ({ page }, testInfo) => {
  const state = pickingCity();
  const curve = segmentNear(state, 4250, 4850);
  const south = segmentNear(state, 4300, 4600);
  const north = segmentNear(state, 4300, 4616);
  const bridge = Array.from(state.roads.segLevelA).indexOf(LEVEL_BRIDGE);
  expect(bridge).toBeGreaterThanOrEqual(0);
  await openCity(page, state, { name: "Edit" });
  await page.keyboard.press("KeyB");

  // The arch's apex is 50 m off its chord.
  await look(page, 4250, 4860, 200);
  await hover(page, 4250, 4850);
  expect(await picked(page)).toBe(curve);
  await attach(page, testInfo, "8 picking a curve at its apex");
  await hover(page, 4250, 4900);
  expect(await picked(page)).toBe(-1);

  // Two streets 16 m apart: each side picks its own.
  await look(page, 4300, 4608, 120);
  await hover(page, 4300, 4603);
  expect(await picked(page)).toBe(south);
  await hover(page, 4300, 4613);
  expect(await picked(page)).toBe(north);
  await attach(page, testInfo, "9 picking the north of two close streets");

  // The bridge's deck, drawn above the water.
  await look(page, RIVER.mid, RIVER.z, 60, 2);
  await hover(page, RIVER.mid, RIVER.z, bridgeDeckLevel(terrain.waterLevel));
  expect(await picked(page)).toBe(bridge);
  await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-ids", String(bridge));
  await attach(page, testInfo, "10 picking a bridge at its deck");
});

test("a fixed road shows as not removable, and a right-click reverses a one-way", async ({ page }, testInfo) => {
  const state = pickingCity();
  const fixed = segmentNear(state, 4300, 4600);
  state.roads.segFlags[fixed] = (state.roads.segFlags[fixed] ?? 0) | SEG_FIXED;
  const oneWay = segmentNear(state, 4575, 4700);
  await openCity(page, state, { name: "Edit" });
  const start = (await logEntries(page)).length;
  await page.keyboard.press("KeyB");
  await look(page, 4300, 4608, 120);
  await hover(page, 4300, 4600);
  const readout = page.locator("#bulldoze-tag");
  await expect(readout).toHaveAttribute("data-ok", "false");
  await expect(readout).toHaveAttribute("data-fixed", "true");
  await expect(page.locator("#bulldoze-reason")).toHaveText("This road is fixed and cannot be removed");
  await attach(page, testInfo, "11 a fixed road cannot be removed");
  await click(page, 4300, 4600);
  await expect(page.locator("#road-note")).toHaveText("This road is fixed and cannot be removed");
  expect((await logEntries(page)).length).toBe(start);

  const before = await segment(page, oneWay);
  const ends = await endsOf(page, [oneWay]);
  await page.keyboard.press("KeyV");
  await look(page, 4575, 4700, 120);
  await click(page, 4575, 4700, "right");
  await expect.poll(async () => (await segment(page, oneWay)).a).toBe(before.b);
  expect((await segment(page, oneWay)).b).toBe(before.a);
  expect((await logEntries(page)).slice(start)).toEqual([{ type: "UpgradeRoad", payload: { segments: [oneWay], ...ends, type: "oneWay" } }]);
  await attach(page, testInfo, "12 a one-way reversed by a right-click");
});

test("both tools' keys are listed with the other shortcuts", async ({ page }, testInfo) => {
  await openCity(page, crossedCity(), { name: "Edit" });
  await page.keyboard.press("Backquote");
  const panel = page.locator("#debug-panel");
  await expect(panel).toContainText("upgrade tool on or off");
  await expect(panel).toContainText("bulldozer on or off");
  await page.keyboard.press("KeyV");
  await expect(page.locator("#upgrade-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyB");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
  // The bulldozer has its own menu, so the road menu closes and takes the upgrade button with it (issue 116).
  await expect(page.locator("#road-menu")).toHaveCount(0);
  await expect(page.locator("#upgrade-tool")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "false");
  await attach(page, testInfo, "13 the shortcut list");
});

/** Each live, unfixed segment along z = 4600 as [west x, east x, type], west to east. */
async function alongMain(page: Page): Promise<[number, number, number][]> {
  return page.evaluate((z) => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    const out: [number, number, number][] = [];
    for (let s = 0; s < net.segFlags.length; s++) {
      if (((net.segFlags[s] ?? 0) & 1) === 0 || ((net.segFlags[s] ?? 0) & 2) !== 0) continue;
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      if (net.nodeZ[a] !== z || net.nodeZ[b] !== z) continue;
      const xa = net.nodeX[a] ?? 0;
      const xb = net.nodeX[b] ?? 0;
      out.push([Math.min(xa, xb), Math.max(xa, xb), net.segType[s] ?? -1]);
    }
    return out.sort((p, q) => p[0] - q[0]);
  }, MAIN_Z);
}

// Issue 86: both tools take a short stretch around the pointer, Shift the
// whole segment, and a drag along a road grows its stretch.
test("bulldozes and upgrades a stretch of a road, the whole road with Shift, and a drag's length", async ({ page }, testInfo) => {
  const state = crossedCity();
  await openCity(page, state, { name: "Edit" });
  await look(page, 4300, MAIN_Z, 160);
  const start = (await logEntries(page)).length;

  // The bulldozer marks 20 m around the pointer, not the 100 m segment.
  await page.keyboard.press("KeyB");
  await hover(page, 4300, MAIN_Z);
  const tag = page.locator("#bulldoze-tag");
  await expect(tag.locator(".what")).toHaveText("Bulldoze this stretch of road");
  await expect(tag.locator(".price")).toHaveText(/^20 m · \$[\d.]+K?$/);
  await attach(page, testInfo, "14 the bulldozer marks a stretch around the pointer");
  // Shift marks the whole segment, as before.
  await page.keyboard.down("Shift");
  await frames(page);
  await expect(tag.locator(".what")).toHaveText("Bulldoze this road");
  await expect(tag.locator(".price")).toHaveText(/^100 m · /);
  await attach(page, testInfo, "15 Shift marks the whole segment");
  await page.keyboard.up("Shift");
  await frames(page);
  await expect(tag.locator(".price")).toHaveText(/^20 m · /);

  await click(page, 4300, MAIN_Z);
  await expect.poll(async () => (await alongMain(page)).length).toBe(5);
  const cut = await alongMain(page);
  // The segment from 4250 to 4350 now ends at the gap on each side.
  const west = cut.find((s) => s[0] === 4250);
  const east = cut.find((s) => s[1] === 4350);
  expect(west && east && east[0] - west[1]).toBeCloseTo(20, 0);
  const log = (await logEntries(page)).slice(start);
  expect(log).toHaveLength(1);
  expect(log[0]?.type).toBe("BulldozeRoad");
  expect((log[0]?.payload as { sections?: number[][] }).sections).toHaveLength(1);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "16 a 20 m gap, the rest of the road standing");

  // The upgrade tool: a drag along the next segment grows its stretch, and one command upgrades it.
  await page.keyboard.press("KeyV");
  await page.keyboard.press("KeyX");
  const a = await screenAt(page, 4370, MAIN_Z);
  const b = await screenAt(page, 4430, MAIN_Z);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await frames(page);
  const readout = page.locator("#edit-readout");
  const metres = Number(await readout.getAttribute("data-length"));
  expect(metres).toBeGreaterThan(70);
  expect(metres).toBeLessThan(90);
  await attach(page, testInfo, "17 a drag along a road marks the stretch it covered");
  await page.mouse.up();
  await expect.poll(async () => (await alongMain(page)).filter((s) => s[2] === 1).length).toBe(1);
  const avenue = (await alongMain(page)).find((s) => s[2] === 1);
  expect(avenue && avenue[1] - avenue[0]).toBeCloseTo(metres, 0);
  expect((await logEntries(page)).slice(start).map((e) => e.type)).toEqual(["BulldozeRoad", "UpgradeRoad"]);
  await page.mouse.move(640, 20);
  await frames(page);
  await attach(page, testInfo, "18 the stretch upgraded to an avenue, the street either side");

  // One undo takes back the upgrade and its cuts together.
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(async () => (await alongMain(page)).filter((s) => s[2] === 1).length).toBe(0);
  expect((await alongMain(page)).find((s) => s[0] === 4350)).toEqual([4350, 4450, 0]);
});
