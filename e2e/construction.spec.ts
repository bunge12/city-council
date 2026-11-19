import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { buildingCount, serialize } from "../packages/sim/src/index";
import { builtFixtureCity } from "./building-fixtures";
import { MEASURE_STATE } from "./browser-state";
import { frameTime } from "./measure";
import { groundAt } from "./road-fixtures";

// Issue 136: construction on screen. A new building draws in three stages
// over CONSTRUCTION.ticks of game time: scaffolding up, the building rising
// inside it, the scaffolding down. Client only: the sim builds the building
// whole on one tick, so the state hash is the same with the animation off.
//
// The city is the building fixture (building-fixtures.ts) with every
// building's builtAt set to the tick it is saved at, so all of them are new
// when the city opens: a few hundred buildings under construction at once.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    saveNow(): Promise<unknown>;
    downloadCity(): Promise<{ hash: string; tick: number }>;
    mirror: { state: { tick: number; speed: number } | null };
    view: Promise<{ decorCounts(): unknown; onFrame(listener: (stats: { drawn: boolean }) => void): void; renderer: { domElement: { toDataURL(type: string): string } } }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
  constructionFrames?: { tick: number; scaffolds: number }[];
  constructionShots?: { tick: number; shot: string }[];
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const T = CONSTRUCTION.ticks;

/** The building fixture paused, every building `age` ticks old at the tick it is saved at. */
function newCity(age = 0): { bytes: Buffer; tick: number; buildings: number } {
  const { state } = builtFixtureCity();
  state.tick = 1000;
  state.buildings.builtAt.fill(state.tick - age);
  // No zoning left, so the grower builds nothing new while the city runs. A
  // slow runner can take many game days to land a pause, and a building grown
  // just before it would still be under construction when the test looks.
  // Buildings stay when their cells are unzoned.
  state.cells.zone.fill(0);
  state.cells.density.fill(0);
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), tick: state.tick, buildings: buildingCount(state.buildings) };
}
const city = newCity();

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

async function openCity(page: Page, query: string, bytes: Buffer): Promise<void> {
  await page.goto(`/${query}`);
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "new.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function drawn(page: Page, count: number): Promise<void> {
  await page.waitForFunction((count) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(count), count, { timeout: 120_000 });
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

/** Waits until decoration near the camera has finished building and the buildings show the form they want. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["buildingsSettled"] === "true", null, { timeout: 120_000 });
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

const dataset = (page: Page, key: string) => page.evaluate((key) => document.body.dataset[key], key);
const tick = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? -1);

async function canvasShot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  const shot = await page.locator("#view").screenshot();
  await page.addStyleTag({ content: "#ui { display: block !important; }" });
  return shot;
}

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const GRID = { x: 4250, z: 4600 };
const ground = groundAt(GRID.x, GRID.z);
/** Low over a street of the fixture's grid, in the street band, where buildings draw in full with scaffolding. */
/** Over the same streets in the district band, where buildings draw simplified. */
const DISTRICT: Vec3 = [GRID.x - 200, ground + 600, GRID.z + 650];
const CLOSE: { position: Vec3; target: Vec3 } = { position: [GRID.x + 10, ground + 95, GRID.z + 150], target: [GRID.x + 10, ground + 4, GRID.z + 30] };

// The tests that draw a few hundred buildings under construction in the
// street band took two to four minutes on a CI runner when they landed, and
// ran past six on slower ones (issue #152). They get eight.
//
// The two that run the city at 4x draw at Low. In software, at Balanced, a
// frame of this street under construction takes seconds and the page falls
// so far behind the worker that a pause sent at tick 128 landed at tick 4080.
// Scaffolding draws the same at every preset; only the frame-time test is
// about Balanced.
//
// They also draw at a quarter of the pixels. #202's glass made a frame of
// this street dearer in software, and on the slowest runners (EPYC 7763) the
// pause test ran past eight minutes on both attempts. At 640 x 400 it takes
// half as long. The bands, counts and still-picture check do not depend on
// the size; the frame-time test keeps 1280 x 800 so its figure stays
// comparable.
const RUN_TIMEOUT = 480_000;
const RUN_VIEWPORT = { width: 640, height: 400 };
/**
 * How long to wait for what changes on the next frame drawn: the scaffolding
 * coming down once the tick has passed the end of construction, or the zoom
 * band after a camera move. In software a frame of this street can take
 * seconds, longer while the page catches up on a burst of deltas at 4x.
 */
const FRAME_WAIT = 30_000;

test("at 4x a new building's scaffolding goes up, the building rises inside it, and the scaffolding comes down", async ({ page }, testInfo) => {
  test.setTimeout(RUN_TIMEOUT);
  await page.setViewportSize(RUN_VIEWPORT);
  await openCity(page, "?webgl&preset=low&debug", city.bytes);
  await setPose(page, CLOSE.position, CLOSE.target);
  await drawn(page, city.buildings);
  await settle(page);
  expect(await dataset(page, "zoomBand")).toBe("street");
  // Paused on the tick every building was built on: all of them under construction, nothing standing yet.
  expect(await tick(page)).toBe(city.tick);
  expect(Number(await dataset(page, "buildingsUnderConstruction"))).toBe(city.buildings);
  expect(Number(await dataset(page, "scaffolds"))).toBeGreaterThan(0);
  await attach(testInfo, "0 just built, nothing standing", await canvasShot(page));

  // The stages to picture: the middle of each, by age in ticks.
  const up = CONSTRUCTION.scaffoldUp;
  const down = CONSTRUCTION.scaffoldDown;
  const stages = [
    { age: (T * up) / 2, name: "1 scaffolding going up" },
    { age: T * (up + (1 - up - down) / 2), name: "2 building rising" },
    { age: T * (1 - down / 2), name: "3 scaffolding coming down" },
  ];
  // Every frame drawn at 4x, with the tick it was drawn at, and a picture of
  // the first frame drawn at or past each stage's age. Frames are slow on a
  // runner without a GPU, so the run is not stopped at chosen ticks, and
  // encoding a picture of every frame made them slower still (issue #226).
  await page.evaluate(
    async ({ start, ages }) => {
      const view = await window.cityCouncil.view;
      window.constructionFrames = [];
      window.constructionShots = [];
      let next = 0;
      view.onFrame((stats) => {
        const frames = window.constructionFrames;
        const shots = window.constructionShots;
        const t = window.cityCouncil.mirror.state?.tick;
        if (!frames || !shots || t === undefined || !stats.drawn) return;
        frames.push({ tick: t, scaffolds: Number(document.body.dataset["scaffolds"] ?? 0) });
        const age = ages[next];
        if (age !== undefined && t - start >= age) {
          shots.push({ tick: t, shot: view.renderer.domElement.toDataURL("image/png") });
          while ((ages[next] ?? Infinity) <= t - start) next++;
        }
      });
    },
    { start: city.tick, ages: stages.map((s) => s.age) },
  );
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  await page.waitForFunction((end) => (window.cityCouncil.mirror.state?.tick ?? 0) >= end, city.tick + T + 8, { timeout: 120_000 });
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
  await expect.poll(() => dataset(page, "scaffolds"), { timeout: FRAME_WAIT }).toBe("0");
  const { frames, shots } = await page.evaluate(() => {
    const f = { frames: window.constructionFrames ?? [], shots: window.constructionShots ?? [] };
    delete window.constructionFrames;
    delete window.constructionShots;
    return f;
  });
  // Nothing grew while it ran: every scaffold was one of the fixture's buildings.
  expect(await dataset(page, "buildingsDrawn")).toBe(String(city.buildings));
  const ages = frames.map((f) => f.tick - city.tick);
  console.log(`frames drawn at ages ${ages.join(", ")}`);
  await testInfo.attach("frame ages", { body: JSON.stringify(ages), contentType: "application/json" });
  // The run went through construction a frame at a time, and every building's scaffolding came away at the end.
  expect(frames.filter((f) => f.tick - city.tick > 0 && f.tick - city.tick < T).length).toBeGreaterThanOrEqual(3);
  expect(frames.at(-1)?.scaffolds).toBe(0);
  // A frame was drawn inside each stage, so each has its picture. A frame
  // that skipped a stage's middle pictures the stages it skipped, late.
  for (const stage of stages) {
    const shot = shots.find((s) => s.tick - city.tick >= stage.age);
    if (!shot) throw new Error(`no frame drawn past age ${stage.age}`);
    await attach(testInfo, `${stage.name}, age ${shot.tick - city.tick} of ${T} ticks at 4x`, Buffer.from(shot.shot.split(",")[1] ?? "", "base64"));
  }
  await attach(testInfo, `4 finished, age ${(await tick(page)) - city.tick} of ${T} ticks at 4x`, await canvasShot(page));
  await page.getByRole("region", { name: "Debug panel" }).screenshot({ path: testInfo.outputPath("debug-panel.png") });
  await testInfo.attach("debug panel", { path: testInfo.outputPath("debug-panel.png"), contentType: "image/png" });

  // Saved and reloaded: the buildings are older than the animation, so they draw finished and nothing replays.
  await page.evaluate(() => window.cityCouncil.saveNow());
  await page.reload();
  await ready(page);
  await setPose(page, CLOSE.position, CLOSE.target);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && Number(document.body.dataset["buildingsDrawn"]) > 0, null, { timeout: 120_000 });
  await settle(page);
  expect(await tick(page)).toBeGreaterThanOrEqual(city.tick + T);
  expect(await dataset(page, "buildingsUnderConstruction")).toBe("0");
  expect(await dataset(page, "scaffolds")).toBe("0");
  await attach(testInfo, "5 after a reload, finished", await canvasShot(page));
});

test("pausing freezes a building half way up, and running again finishes it", async ({ page }, testInfo) => {
  test.setTimeout(RUN_TIMEOUT);
  await page.setViewportSize(RUN_VIEWPORT);
  // Opened paused with every building half way through its rise.
  const age = Math.round(T * (CONSTRUCTION.scaffoldUp + (1 - CONSTRUCTION.scaffoldUp - CONSTRUCTION.scaffoldDown) / 2));
  const mid = newCity(age);
  await openCity(page, "?webgl&preset=low", mid.bytes);
  await setPose(page, CLOSE.position, CLOSE.target);
  await drawn(page, mid.buildings);
  await settle(page);
  expect(Number(await dataset(page, "scaffolds"))).toBeGreaterThan(0);
  const first = await canvasShot(page);
  await attach(testInfo, `paused at age ${age} of ${T} ticks`, first);
  await page.waitForTimeout(3000);
  expect(await tick(page)).toBe(mid.tick);
  const second = await canvasShot(page);
  await attach(testInfo, "3 s later, still paused", second);
  expect(second.equals(first), "the picture changed while paused").toBe(true);
  expect(await dataset(page, "buildingsUnderConstruction")).toBe(String(mid.buildings));
  // Further out the simplified buildings and boxes rise with no scaffolding, and the city band's blocks dither in.
  for (const [band, position] of [
    ["district", DISTRICT],
    ["city", [GRID.x - 600, ground + 3200, GRID.z + 3600]],
  ] as const) {
    await setPose(page, [...position], [GRID.x, ground, GRID.z]);
    await expect.poll(() => dataset(page, "zoomBand"), { timeout: FRAME_WAIT }).toBe(band);
    await settle(page);
    expect(await dataset(page, "scaffolds")).toBe("0");
    await attach(testInfo, `paused at age ${age}, ${band} band`, await canvasShot(page));
  }
  await setPose(page, CLOSE.position, CLOSE.target);
  await settle(page);
  // Running again, construction carries on from where it stopped and finishes.
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  await page.waitForFunction((end) => (window.cityCouncil.mirror.state?.tick ?? 0) >= end, mid.tick + T, { timeout: 120_000 });
  await expect.poll(() => dataset(page, "scaffolds"), { timeout: FRAME_WAIT }).toBe("0");
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
  await attach(testInfo, "run on at 4x, finished", await canvasShot(page));
  await setPose(page, DISTRICT, [GRID.x, ground, GRID.z]);
  await expect.poll(() => dataset(page, "zoomBand"), { timeout: FRAME_WAIT }).toBe("district");
  await settle(page);
  await attach(testInfo, "run on at 4x, finished, district band", await canvasShot(page));
});

test("the state hash is the same with the animation and without it", async ({ page }, testInfo) => {
  const hashes: Record<string, string> = {};
  for (const query of ["?webgl&preset=low", "?webgl&preset=low&noconstruction"]) {
    await openCity(page, query, city.bytes);
    await setPose(page, CLOSE.position, CLOSE.target);
    await drawn(page, city.buildings);
    await settle(page);
    const off = query.includes("noconstruction");
    expect(Number(await dataset(page, "scaffolds")) > 0, query).toBe(!off);
    // The same commands on the same paused tick.
    expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 0 }))).toEqual({ ok: true });
    const downloaded = await page.evaluate(() => window.cityCouncil.downloadCity());
    expect(downloaded.tick).toBe(city.tick);
    hashes[query] = downloaded.hash;
    await attach(testInfo, off ? "animation off" : "animation on", await canvasShot(page));
  }
  const [on, off] = Object.values(hashes);
  expect(on).toBe(off);
  await testInfo.attach("hashes", { body: JSON.stringify(hashes, null, 2), contentType: "application/json" });
});

test.describe("at the real settings", () => {
  // Times frames: every frame drawn, antialiased, at the real pixel ratio (issue #226).
  test.use({ storageState: MEASURE_STATE });

  test("frame time with a few hundred buildings under construction, at Balanced", async ({ page }, testInfo) => {
    test.setTimeout(RUN_TIMEOUT);
    const results: Record<string, number> = {};
    const far: { position: Vec3; target: Vec3 } = { position: [GRID.x - 60, ground + 210, GRID.z + 230], target: [GRID.x + 20, ground, GRID.z + 10] };
    // Every building mid-rise, under scaffolding. Paused, so a slow runner measures the same stage throughout: the stages are worked out per vertex every frame, running or not.
    const mid = newCity(Math.round(T * 0.4));
    for (const query of ["?webgl&preset=balanced", "?webgl&preset=balanced&noconstruction"]) {
      await openCity(page, query, mid.bytes);
      await setPose(page, far.position, far.target);
      await drawn(page, mid.buildings);
      await settle(page);
      const off = query.includes("noconstruction");
      expect(Number(await dataset(page, "buildingsUnderConstruction"))).toBe(off ? 0 : mid.buildings);
      results[off ? "off" : "on"] = await frameTime(page, 30);
      await attach(testInfo, off ? "animation off" : "under construction", await canvasShot(page));
    }
    const report = { buildings: mid.buildings, frameMs: results, ticks: T };
    await testInfo.attach("frame time", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(`frame time with ${mid.buildings} buildings under construction at Balanced: ${results["on"]?.toFixed(1)} ms; animation off: ${results["off"]?.toFixed(1)} ms`);
  });
});
