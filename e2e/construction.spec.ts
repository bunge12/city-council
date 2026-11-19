import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { buildingCount, serialize } from "../packages/sim/src/index";
import { builtFixtureCity } from "./building-fixtures";
import { groundAt } from "./road-fixtures";
import { buildingsDrawn, canvasShot, openCity, ready, settle } from "./helpers";

// Issue 136: construction on screen. A new building draws in three stages
// over CONSTRUCTION.ticks of game time: scaffolding up, the building rising
// inside it, the scaffolding down. Client only: the sim builds the building
// whole on one tick. The animation lives in packages/client/src/render,
// which lint keeps from importing what writes state and from calling
// sendCommand (rule 8, issue #225), in place of a test of the state hash.
// The frame time at Balanced with a few hundred buildings under
// construction is construction-frame-time.spec.ts, in the perf project.
//
// The city is the building fixture (building-fixtures.ts) with every
// building's builtAt set to the tick it is saved at, so all of them are new
// when the city opens: a few hundred buildings under construction at once.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    saveNow(): Promise<unknown>;
    mirror: { state: { tick: number; speed: number } | null };
    advance(steps: number): Promise<number>;
    view: Promise<{ decorCounts(): unknown; onFrame(listener: () => void): void }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const T = CONSTRUCTION.ticks;

/** The building fixture paused, every building `age` ticks old at the tick it is saved at. */
function newCity(age = 0): { bytes: Buffer; tick: number; buildings: number } {
  const { state } = builtFixtureCity();
  state.tick = 1000;
  state.buildings.builtAt.fill(state.tick - age);
  // No zoning left, so the grower builds nothing new while the city runs and
  // every building under construction is one of the fixture's. Buildings
  // stay when their cells are unzoned.
  state.cells.zone.fill(0);
  state.cells.density.fill(0);
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), tick: state.tick, buildings: buildingCount(state.buildings) };
}
const city = newCity();

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
}

const dataset = (page: Page, key: string) => page.evaluate((key) => document.body.dataset[key], key);
const tick = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? -1);

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
// The two that run the city hold the worker's clock (`?heldclock`) and step
// it by hand, so each picture is taken at the age it is meant to show and a
// pause lands on the tick it was sent on, however slowly the runner draws
// (issue #224). Before that they ran at 4x and polled, and on a slow runner
// a pause meant for tick 128 landed at tick 4080.
//
// They draw at Low and at a quarter of the pixels: in software a frame of
// this street under construction takes seconds at Balanced, and these tests
// wait on several. Scaffolding draws the same at every preset, and the
// bands, counts and still-picture check do not depend on the size.
const RUN_TIMEOUT = 480_000;
const RUN_VIEWPORT = { width: 640, height: 400 };
/**
 * How long to wait for what changes on the next frame drawn: the scaffolding
 * coming down once the tick has passed the end of construction, or the zoom
 * band after a camera move. In software a frame of this street can take seconds.
 */
const FRAME_WAIT = 30_000;

/** Runs `steps` steps of the held clock and resolves with the tick once their delta is in the page's copy. */
const advance = (page: Page, steps: number) => page.evaluate((n) => window.cityCouncil.advance(n), steps);

/** Sends a command with the clock held, runs the one step that applies it, and returns its outcome. */
async function command(page: Page, type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
  return page.evaluate(async ([type, payload]) => {
    const settled = window.cityCouncil.sendCommand(type, payload);
    await window.cityCouncil.advance(1);
    return settled;
  }, [type, payload] as const);
}

/** Waits until the page has drawn `count` whole frames since now. */
async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (count) => {
    const view = await window.cityCouncil.view;
    await new Promise<void>((resolve) => {
      let seen = 0;
      view.onFrame(() => {
        if (++seen === count) resolve();
      });
    });
  }, count);
}

test("a new building's scaffolding goes up, the building rises inside it, and the scaffolding comes down", async ({ page }, testInfo) => {
  test.setTimeout(RUN_TIMEOUT);
  await page.setViewportSize(RUN_VIEWPORT);
  await openCity(page, city.bytes, { query: "?webgl&preset=low&debug&heldclock", name: "new" });
  await setPose(page, CLOSE.position, CLOSE.target);
  await buildingsDrawn(page, city.buildings);
  await settle(page);
  expect(await dataset(page, "zoomBand")).toBe("street");
  // Paused on the tick every building was built on: all of them under construction, nothing standing yet.
  expect(await tick(page)).toBe(city.tick);
  expect(Number(await dataset(page, "buildingsUnderConstruction"))).toBe(city.buildings);
  expect(Number(await dataset(page, "scaffolds"))).toBeGreaterThan(0);
  await attach(testInfo, "0 just built, nothing standing", await canvasShot(page));

  // Running at 4x. The step that applies the speed is the first tick.
  expect(await command(page, "SetSpeed", { speed: 4 })).toEqual({ ok: true });
  expect(await tick(page)).toBe(city.tick + 1);
  // Stopped in the middle of each stage, and at the end.
  const up = CONSTRUCTION.scaffoldUp;
  const down = CONSTRUCTION.scaffoldDown;
  const stages = [
    { age: Math.round((T * up) / 2), name: "1 scaffolding going up" },
    { age: Math.round(T * (up + (1 - up - down) / 2)), name: "2 building rising" },
    { age: Math.round(T * (1 - down / 2)), name: "3 scaffolding coming down" },
    { age: T + 8, name: "4 finished" },
  ];
  for (const stage of stages) {
    expect(await advance(page, city.tick + stage.age - (await tick(page)))).toBe(city.tick + stage.age);
    const finished = stage.age >= T;
    await expect.poll(() => dataset(page, "buildingsUnderConstruction"), { timeout: FRAME_WAIT }).toBe(finished ? "0" : String(city.buildings));
    if (finished) await expect.poll(() => dataset(page, "scaffolds"), { timeout: FRAME_WAIT }).toBe("0");
    else expect(Number(await dataset(page, "scaffolds"))).toBeGreaterThan(0);
    await frames(page);
    await attach(testInfo, `${stage.name}, age ${stage.age} of ${T} ticks`, await canvasShot(page));
  }
  expect(await command(page, "SetSpeed", { speed: 0 })).toEqual({ ok: true });
  // Nothing grew while it ran: every scaffold was one of the fixture's buildings.
  expect(await dataset(page, "buildingsDrawn")).toBe(String(city.buildings));
  await page.getByRole("region", { name: "Debug panel" }).screenshot({ path: testInfo.outputPath("debug-panel.png") });
  await testInfo.attach("debug panel", { path: testInfo.outputPath("debug-panel.png"), contentType: "image/png" });

  // Saved and reloaded: the buildings are older than the animation, so they draw finished and nothing replays.
  await page.evaluate(() => window.cityCouncil.saveNow());
  await page.reload();
  await ready(page);
  await setPose(page, CLOSE.position, CLOSE.target);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && Number(document.body.dataset["buildingsDrawn"]) > 0, null, { timeout: 120_000 });
  await settle(page);
  expect(await tick(page)).toBe(city.tick + T + 8);
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
  await openCity(page, mid.bytes, { query: "?webgl&preset=low&heldclock", name: "new" });
  await setPose(page, CLOSE.position, CLOSE.target);
  await buildingsDrawn(page, mid.buildings);
  await settle(page);
  expect(Number(await dataset(page, "scaffolds"))).toBeGreaterThan(0);
  const first = await canvasShot(page);
  await attach(testInfo, `paused at age ${age} of ${T} ticks`, first);
  // Thirty paused steps, three seconds at 1x: the tick and the picture stay where they were.
  expect(await advance(page, 30)).toBe(mid.tick);
  await frames(page, 5);
  const second = await canvasShot(page);
  await attach(testInfo, "30 paused steps later, still paused", second);
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
  expect(await command(page, "SetSpeed", { speed: 4 })).toEqual({ ok: true });
  expect(await advance(page, T - age - 1)).toBe(mid.tick + T - age);
  await expect.poll(() => dataset(page, "scaffolds"), { timeout: FRAME_WAIT }).toBe("0");
  expect(await dataset(page, "buildingsUnderConstruction")).toBe("0");
  expect(await command(page, "SetSpeed", { speed: 0 })).toEqual({ ok: true });
  await attach(testInfo, "run on at 4x, finished", await canvasShot(page));
  await setPose(page, DISTRICT, [GRID.x, ground, GRID.z]);
  await expect.poll(() => dataset(page, "zoomBand"), { timeout: FRAME_WAIT }).toBe("district");
  await settle(page);
  await attach(testInfo, "run on at 4x, finished, district band", await canvasShot(page));
});
