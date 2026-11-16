import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_TYPES, buildingInfo } from "../packages/sim/src/index";
import { builtFixtureCity } from "./building-fixtures";
import { zonedFixtureCity } from "./cell-fixtures";
import { groundAt } from "./road-fixtures";

// Issue M2-12: building rendering. It runs in the `roads` project, headed
// with WebGPU on where the browser has an adapter (see playwright.config.ts),
// so the WebGPU path and `?webgl` are drawn and compared with the same
// screenshots, at Balanced and at Low.
//
// The city is the road fixture with every zone painted along its streets
// and buildings of every type standing on them (building-fixtures.ts),
// imported as a city file.

type Vec3 = [number, number, number];
interface BuildingStats {
  buildings: number;
  models: number;
  pending: number;
  lastWrites: number;
  totalWrites: number;
  totalWritesByForm: { full: number; simple: number };
  lastRebuilt: number;
  totalRebuilt: number;
}
type Tint = { wall: number; roof: number; trim: number };
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    renderStatus(): { backend: string } | null;
    mirror: { state: { buildings: { flags: Uint8Array } } | null };
    view: Promise<{ buildingStats(): BuildingStats | null; buildingTint(id: number): Tint | null; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const fixture = builtFixtureCity();

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

/** Waits until every building in the city is drawn: they fill in a few chunks a frame. */
async function buildingsDrawn(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(count),
    count,
    { timeout: 120_000 },
  );
}

/** Opens the page, then imports `bytes` as a city and waits for it to be drawn. */
async function openCity(page: Page, query: string, name: string, bytes: Buffer): Promise<string> {
  await page.goto(`/${query}`);
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  const status = await page.evaluate(() => window.cityCouncil.renderStatus());
  return status?.backend ?? "none";
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/** Waits until decoration has finished building near the camera: its counts hold for ten frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let last = "";
    let steady = 0;
    for (let f = 0; f < 600 && steady < 10; f++) {
      await frame();
      const now = JSON.stringify(view.decorCounts());
      steady = now === last ? steady + 1 : 0;
      last = now;
    }
  });
}

async function stats(page: Page): Promise<BuildingStats> {
  const s = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  if (!s) throw new Error("no building layer");
  return s;
}

async function tints(page: Page, ids: number[]): Promise<(Tint | null)[]> {
  return page.evaluate(async (ids) => {
    const view = await window.cityCouncil.view;
    return ids.map((id) => view.buildingTint(id));
  }, ids);
}

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The canvas alone, without the page's panels over it. */
async function canvasShot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  const shot = await page.locator("#view").screenshot();
  await page.addStyleTag({ content: "#ui { display: block !important; }" });
  return shot;
}

const GRID = { x: 4250, z: 4600 };
const ground = groundAt(GRID.x, GRID.z);
/** The street band over the middle of the fixture's street grid. */
const STREET: { position: Vec3; target: Vec3 } = { position: [GRID.x - 60, ground + 210, GRID.z + 230], target: [GRID.x + 20, ground, GRID.z + 10] };
/** More views for the pull request: low over the grid, and the avenue's towers. */
const VIEWS: { name: string; position: Vec3; target: Vec3 }[] = [
  { name: "over the grid", position: [GRID.x + 40, ground + 70, GRID.z + 130], target: [GRID.x + 10, ground + 5, GRID.z + 40] },
  { name: "along the avenue", position: [4520, ground + 90, 4980], target: [4430, ground + 20, 4800] },
  { name: "the five-way junction", position: [4720, ground + 230, 4760], target: [4600, ground, 4630] },
];

const BACKENDS = [
  { name: "default backend", query: "" },
  { name: "?webgl", query: "webgl&" },
] as const;

test("the fixture has buildings of every type", () => {
  // Through-lot types (M2-14) stand across a block, and through-lots.spec.ts draws them.
  expect(BUILDING_TYPES.filter((t) => !t.throughLot && !fixture.counts[t.index]).map((t) => t.id)).toEqual([]);
});

for (const preset of ["balanced", "low"] as const) {
  for (const { name, query } of BACKENDS) {
    test(`every building type draws the same at ${preset} (${name})`, async ({ page }, testInfo) => {
      const backend = await openCity(page, `?${query}preset=${preset}`, "Built", fixture.bytes);
      if (query.startsWith("webgl")) expect(backend).toBe("webgl2");
      else if (process.env["CI"]) expect(backend).toBe("webgpu");
      testInfo.annotations.push({ type: "backend", description: backend });
      await expect.poll(() => page.evaluate(() => document.body.dataset["presetSettled"])).toBe("true");
      await buildingsDrawn(page, fixture.buildings);
      expect((await stats(page)).buildings).toBe(fixture.buildings);
      await setPose(page, STREET.position, STREET.target);
      await settle(page);
      await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe("street");
      // Every chunk of the fixture is near the camera, so drawn in full (issue
      // M2-13): every building written once in full, when its chunk was first
      // drawn so. The city opens in the district band, so each was written in
      // the simple form before that, which this does not count.
      await page.waitForFunction(() => document.body.dataset["buildingsSettled"] === "true");
      expect((await stats(page)).totalWritesByForm.full).toBe(fixture.buildings);
      const shot = await canvasShot(page);
      await attach(testInfo, `street band, ${preset}, ${backend}`, shot);
      // One baseline per preset, shared by both backends: they must draw the same picture.
      expect(shot).toMatchSnapshot(`buildings-${preset}.png`, { maxDiffPixelRatio: 0.01, threshold: 0.1 });
      // More views for the pull request, on one backend: software WebGPU is slow to screenshot.
      if (query.startsWith("webgl")) for (const view of VIEWS) {
        await setPose(page, view.position, view.target);
        await settle(page);
        await attach(testInfo, `${view.name}, ${preset}, ${backend}`, await canvasShot(page));
      }
    });
  }
}

/** Ids of the fixture's single family homes on one street, one segment and side. */
function housesOnOneStreet(): number[] {
  const b = fixture.state.buildings;
  const home = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");
  const bySide = new Map<string, number[]>();
  b.flags.forEach((f, id) => {
    if (f === 0 || b.type[id] !== home) return;
    const key = `${b.firstSeg[id]}/${b.firstSide[id]}`;
    bySide.set(key, [...(bySide.get(key) ?? []), id]);
  });
  return [...bySide.values()].find((ids) => ids.length >= 2) ?? [];
}

test("a building keeps its colours after a reload, and two houses on one street differ", async ({ page }, testInfo) => {
  await openCity(page, "?webgl&preset=low", "Built", fixture.bytes);
  await buildingsDrawn(page, fixture.buildings);
  const ids = Array.from({ length: fixture.buildings }, (_, id) => id);
  const before = await tints(page, ids);
  expect(before.every((t) => t !== null)).toBe(true);
  await page.reload();
  await ready(page);
  await buildingsDrawn(page, fixture.buildings);
  expect(await tints(page, ids)).toEqual(before);

  const houses = housesOnOneStreet();
  expect(houses.length).toBeGreaterThanOrEqual(2);
  const colours = (await tints(page, houses)).map((t) => JSON.stringify(t));
  expect(new Set(colours).size, colours.join("\n")).toBeGreaterThan(1);
  // Looking at the houses' lots, from the road side.
  const lots = houses.flatMap((id) => buildingInfo(fixture.state, id)?.corners ?? []);
  const mean = (k: number) => lots.filter((_, i) => i % 2 === k).reduce((a, v) => a + v, 0) / (lots.length / 2);
  const [hx, hz] = [mean(0), mean(1)];
  const h = groundAt(hx, hz);
  await setPose(page, [hx + 45, h + 55, hz + 45], [hx, h, hz]);
  await settle(page);
  await attach(testInfo, "houses on one street", await canvasShot(page));
});

test("a building the grower adds writes one instance and rebuilds no chunk", async ({ page }, testInfo) => {
  const { bytes } = zonedFixtureCity();
  await openCity(page, "?webgl&preset=low&debug", "Zoned", bytes);
  await expect.poll(async () => (await stats(page)).pending).toBe(0);
  expect((await stats(page)).buildings).toBe(0);
  // In the street band over the fixture, where buildings are drawn in full (issue M2-13).
  await setPose(page, STREET.position, STREET.target);
  await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe("street");
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  // One building a game day: a day is 100 ticks, 2.5 s at 4x.
  await expect.poll(async () => (await stats(page)).buildings, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
  await expect.poll(async () => (await stats(page)).pending).toBe(0);
  const s = await stats(page);
  // Each grown building landed in a delta of its own: one instance, no chunk.
  expect(s.lastWrites).toBe(1);
  expect(s.lastRebuilt).toBe(0);
  await expect(page.locator("#building-updates")).toHaveText(/^1 instance and 0 chunks rebuilt last,/);
  const drawn = await page.evaluate(() => {
    let n = 0;
    window.cityCouncil.mirror.state?.buildings.flags.forEach((f) => (n += f === 0 ? 0 : 1));
    return n;
  });
  expect(s.buildings).toBe(drawn);
  await page.getByRole("region", { name: "Debug panel" }).screenshot({ path: testInfo.outputPath("debug-panel.png") });
  await testInfo.attach("debug panel", { path: testInfo.outputPath("debug-panel.png"), contentType: "image/png" });
});
