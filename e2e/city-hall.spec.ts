import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { CREDITED, ECONOMY, MILESTONES, TIME_BALANCE, buildingInfo, formatMoneyShort, generateTerrain, heightAt } from "../packages/sim/src/index";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { frames, openCity, settleThroughFrames } from "./helpers";
import { CITY_HALL, HALL_POINT, townEveCity, villageEveCity } from "./city-hall-fixtures";
import { SEED } from "./road-fixtures";

// Issue M4-17: City Hall in the client. The town is a day short of its first
// milestone, which opens City Hall (city-hall-fixtures.ts). The spec passes
// it, places City Hall with the tool, finds the treasury charged by the
// price the tool showed and the lot's cells unzonable, and clicks City Hall
// to open the budget. Then the town with City Hall standing, a day short of
// Town, grows it a stage, on WebGPU and on WebGL. The page holds the
// worker's clock (`?heldclock`), so the sim steps only when the spec says
// and no figure moves while one is read: the outcome is the same on a slow
// runner and a fast one.

type Vec3 = readonly [number, number, number];
interface Corners {
  corners: number[] | null;
}
declare const window: {
  cityCouncil: {
    mirror: {
      state: { tick: number; speed: number; budget: { treasury: number }; milestones: ArrayLike<number>; cells: { zone: ArrayLike<number> }; logSpent: number[] } | null;
      building(id: number): Corners | null;
      cellAt(x: number, z: number): { index: number } | null;
    };
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    advance(steps: number): Promise<number>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
    view: Promise<{ buildingTop(id: number): { y: number } | null; forEachRising(fn: (x: number, y: number, z: number) => void): void; buildingStats(): { models: number } | null }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

/**
 * WebGPU as the walkthrough gets it (playwright.config.ts): headed, and on
 * Linux through SwiftShader's Vulkan, where the headless shell has none,
 * so the default backend is WebGPU where the machine has an adapter. The
 * `?webgl` runs ask for WebGL 2.
 */
const WEBGPU_ARGS =
  process.platform === "linux"
    ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"]
    : ["--enable-unsafe-webgpu"];

test.use({ viewport: { width: 1280, height: 800 }, headless: false, channel: "chromium", launchOptions: { args: WEBGPU_ARGS } });
test.setTimeout(180_000);

const DAY = TIME_BALANCE.ticksPerDay;
const terrain = generateTerrain(SEED);
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["CITY_HALL_EVIDENCE_DIR"];

async function attach(page: Page, testInfo: TestInfo, name: string, what?: Locator): Promise<void> {
  const file = `${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const shot = what ? await what.screenshot() : await page.screenshot();
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, shot);
  }
}

const ground = (x: number, z: number) => Math.max(heightAt(terrain, x, z), terrain.waterLevel);

/** Puts the camera `back` metres south of (x, z) and `up` metres over it, looking at it. */
async function look(page: Page, x: number, z: number, up: number, back: number): Promise<void> {
  const g = ground(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + up, z + back], [x, g, z]] as const);
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number, y = ground(x, z)): Promise<{ x: number; y: number }> {
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const p = await screenAt(page, x, z, y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  return p;
}

const treasury = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.budget.treasury ?? null);
const reached = (page: Page) => page.evaluate(() => window.cityCouncil.mirror.state?.milestones.length ?? 0);

/** Runs the town at 1x in steps of `steps` ticks, at most `days` game days, until it has reached `count` milestones, then pauses it. */
async function runUntilMilestones(page: Page, count: number, days: number, steps = DAY): Promise<void> {
  expect(await page.evaluate(async () => {
    const settled = window.cityCouncil.sendCommand("SetSpeed", { speed: 1 });
    await window.cityCouncil.advance(1);
    return settled;
  })).toMatchObject({ ok: true });
  for (let n = 0; n < (days * DAY) / steps && (await reached(page)) < count; n++) await page.evaluate((s) => window.cityCouncil.advance(s), steps);
  expect(await reached(page)).toBe(count);
  expect(await page.evaluate(async () => {
    const settled = window.cityCouncil.sendCommand("SetSpeed", { speed: 0 });
    await window.cityCouncil.advance(1);
    return settled;
  })).toMatchObject({ ok: true });
}

/** The middle of a lot's corners. */
function middle(c: ArrayLike<number>): { x: number; z: number } {
  return { x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4, z: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4 };
}

test("City Hall unlocks at the first milestone, the tool places it for the price it shows, its cells cannot be zoned, and a click on it opens the budget", async ({ page }, testInfo) => {
  const city = villageEveCity();
  await openCity(page, city.bytes, { query: "webgl&heldclock", name: "City Hall" });
  const button = page.locator("#landmark-tool");

  // Locked until Village, with the population that opens it.
  await expect(button).toHaveAttribute("data-locked", "true");
  await expect(button).toContainText(`Unlocks at ${MILESTONES[0]?.population.toLocaleString("en-US")} residents`);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyH");
  await expect(button).toHaveAttribute("aria-pressed", "false");

  // The town passes the first milestone: a day, by the fixture, and a few at most.
  await runUntilMilestones(page, 1, 3);
  await expect(button).not.toHaveAttribute("data-locked", "true");

  // The tool shows the lot on the road side under the pointer, green, with the price and the upkeep.
  await look(page, HALL_POINT.x, HALL_POINT.z, 160, 200);
  await page.locator("#view").focus();
  await page.keyboard.press("KeyH");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await hover(page, HALL_POINT.x, HALL_POINT.z);
  const readout = page.locator("#landmark-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toHaveAttribute("data-price", String(CITY_HALL.price));
  await expect(readout).toHaveAttribute("data-refusal", "");
  await expect(readout).toHaveAttribute("data-cells", String(CITY_HALL.width * CITY_HALL.depth));
  await expect(readout).toContainText(`Place City Hall · ${formatMoneyShort(CITY_HALL.price)}`);
  await expect(readout).toContainText(`Upkeep ${formatMoneyShort(CITY_HALL.upkeepPerYear)} a year`);
  await expect.poll(() => page.evaluate(() => document.body.dataset["landmarkPreview"])).toBe("ok");
  await attach(page, testInfo, "placement preview");

  // Over the houses, red, with the sim's reason.
  await hover(page, 600, 4030);
  await expect(readout).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#landmark-reason")).toContainText("needs a free lot");
  await expect.poll(() => page.evaluate(() => document.body.dataset["landmarkPreview"])).toBe("refused");
  await attach(page, testInfo, "placement refused");

  // A click places it. Paused, so the treasury moves by the price alone.
  await hover(page, HALL_POINT.x, HALL_POINT.z);
  const before = (await treasury(page)) ?? 0;
  const at = await screenAt(page, HALL_POINT.x, HALL_POINT.z);
  await page.mouse.click(at.x, at.y);
  await page.evaluate(() => window.cityCouncil.advance(1));
  await expect.poll(() => treasury(page)).toBe(before - CITY_HALL.price);
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.logSpent.at(-1))).toBe(CITY_HALL.price);
  // One of a kind: the tool leaves once it stands.
  await expect(button).toHaveAttribute("aria-pressed", "false");
  const hall = await page.evaluate(() => {
    const state = window.cityCouncil.mirror.state as unknown as { buildings: { flags: ArrayLike<number> } };
    return Array.from(state.buildings.flags).findIndex((f) => (f & 16) !== 0);
  });
  expect(hall).toBeGreaterThanOrEqual(0);
  const corners = (await page.evaluate((id) => window.cityCouncil.mirror.building(id)?.corners ?? null, hall)) ?? [];
  const mid = middle(corners);

  // Its cells cannot be zoned: a stroke across the lot paints none of them.
  const zoned = () => page.evaluate(([x, z]) => {
    const m = window.cityCouncil.mirror;
    const cell = m.cellAt(x, z);
    return cell ? (m.state?.cells.zone[cell.index] ?? -1) : -1;
  }, [mid.x, mid.z] as const);
  expect(await zoned()).toBe(0);
  const stroke = await page.evaluate(async ([a, b]) => {
    const settled = window.cityCouncil.sendCommand("ZoneCells", { zone: "residential", density: 1, rects: [{ from: a, to: b, width: 30 }] });
    await window.cityCouncil.advance(1);
    return settled;
  }, [{ x: mid.x - 20, z: mid.z }, { x: mid.x + 20, z: mid.z }] as const);
  // Refused as a stroke that changes nothing, or applied around the lot: either way no cell of it is zoned.
  expect(stroke.ok || /nothing|no cell/i.test(stroke.reason ?? "")).toBe(true);
  expect(await zoned()).toBe(0);

  // Let the construction finish, so the model is drawn whole.
  await page.evaluate((s) => window.cityCouncil.advance(s), CONSTRUCTION.ticks + 1);
  await settleThroughFrames(page);
  const roof = (await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id)?.y ?? null, hall)) ?? 0;

  // With no tool on, the readout gives its name, its stage and its upkeep.
  await look(page, mid.x, mid.z, 120, 160);
  // The readout names the building on the ground under the pointer.
  await hover(page, mid.x, mid.z);
  const info = page.locator("#building-readout");
  await expect(info).toHaveAttribute("data-landmark", "true");
  await expect(info).toHaveAttribute("data-stage", "1");
  await expect(info).toHaveAttribute("data-upkeep", String(CITY_HALL.upkeepPerYear));
  await expect(info).toContainText("City Hall");
  await expect(info).toContainText("City-owned · stage 1 of 4");
  await expect(info).toContainText(`Upkeep ${formatMoneyShort(CITY_HALL.upkeepPerYear)} a year`);
  await attach(page, testInfo, "hover readout");

  // A click on it opens the budget.
  const panel = page.locator("#budget-panel");
  await expect(panel).toBeHidden();
  const top = await screenAt(page, mid.x, mid.z, roof - 1);
  await page.mouse.click(top.x, top.y);
  await expect(panel).toBeVisible();
  await attach(page, testInfo, "click opens the budget");
  await page.keyboard.press("KeyM");
  await expect(panel).toBeHidden();

  // The bulldozer prices it as the city's own: demolition only, less the refund.
  await page.locator("#view").focus();
  await page.keyboard.press("KeyB");
  await hover(page, mid.x, mid.z, roof - 1);
  const tag = page.locator("#bulldoze-tag");
  await expect(tag).toHaveAttribute("data-ids", String(hall));
  await expect(tag).toContainText("City Hall");
  await expect(tag.locator('tr[data-line="cityDemolition"]')).toContainText("City-owned: demolition only");
  const refund = Math.floor(CITY_HALL.price * ECONOMY.eminentDomain.refundShare);
  expect(refund).toBeGreaterThan(0);
  await expect(tag.locator('tr[data-line="cityRefund"]')).toHaveAttribute("data-amount", String(refund));
  await expect(tag.locator('tr[data-line="total"]')).toHaveAttribute("data-amount", String(Number(await tag.getAttribute("data-cost"))));
  await attach(page, testInfo, "bulldoze tag");
});

for (const backend of ["webgl", "default"] as const) {
  test(`City Hall grows a stage at Town and is drawn going up again (${backend === "webgl" ? "?webgl" : "default backend"})`, async ({ page }, testInfo) => {
    const city = townEveCity();
    const info = buildingInfo(city.state, city.hall);
    const mid = middle(info?.corners ?? []);
    const used = await openCity(page, city.bytes, { query: backend === "webgl" ? "webgl&heldclock" : "heldclock", name: "Town eve" });
    testInfo.annotations.push({ type: "backend", description: used });
    // CI's runners have SwiftShader's WebGPU adapter, so the default backend is WebGPU there.
    if (backend === "default" && process.env["CI"]) expect(used).toBe("webgpu");
    await look(page, mid.x, mid.z, 60, -110);
    await settleThroughFrames(page);
    const height = () => page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id)?.y ?? null, city.hall);
    const first = (await height()) ?? 0;
    expect(first).toBeGreaterThan(0);
    await attach(page, testInfo, `stage 1 ${backend}`);

    // Town, the first milestone that grows it, in steps short of the construction's length so it is caught going up.
    await runUntilMilestones(page, 2, 3, Math.floor(CONSTRUCTION.ticks / 4));
    expect(MILESTONES[1]?.grows).toContain(CITY_HALL.id);
    await frames(page, 4);
    const rising = await page.evaluate(async ([x, z]) => {
      let near = 0;
      (await window.cityCouncil.view).forEachRising((rx, _y, rz) => {
        if (Math.abs(rx - x) < 30 && Math.abs(rz - z) < 30) near++;
      });
      return near;
    }, [mid.x, mid.z] as const);
    expect(rising).toBe(1);
    await attach(page, testInfo, `stage 2 going up ${backend}`);

    // Once it is up, the model is the next stage's: taller, and the readout says so.
    await page.evaluate((s) => window.cityCouncil.advance(s), CONSTRUCTION.ticks + 1);
    await settleThroughFrames(page);
    await expect.poll(height).toBeGreaterThan(first + 5);
    // The readout names the building on the ground under the pointer.
    await hover(page, mid.x, mid.z);
    await expect(page.locator("#building-readout")).toHaveAttribute("data-stage", "2");
    await page.mouse.move(5, 400);
    await frames(page);
    await attach(page, testInfo, `stage 2 ${backend}`);
  });
}

test("City Hall reads as civic at each stage in every zoom band", async ({ page }, testInfo) => {
  const city = townEveCity();
  const info = buildingInfo(city.state, city.hall);
  const mid = middle(info?.corners ?? []);
  // Stages 3 and 4 by milestones credited rather than reached, which grow it the same and play nothing.
  const growing = MILESTONES.flatMap((m, i) => (m.grows.includes(CITY_HALL.id) ? [i] : []));
  for (const stage of [1, 2, 3, 4]) {
    const state = city.state;
    const upTo = stage === 1 ? 1 : (growing[stage - 2] ?? 0) + 1;
    state.milestones = new Int32Array(upTo).fill(CREDITED);
    await openCity(page, state, { query: "webgl&heldclock", name: `Stage ${stage}` });
    for (const [band, up, back] of [
      ["street", 60, -110],
      ["district", 700, -600],
      ["city", 3500, -2200],
    ] as const) {
      await look(page, mid.x, mid.z, up, back);
      await settleThroughFrames(page);
      await expect.poll(() => page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      await attach(page, testInfo, `stage ${stage} ${band} band`);
    }
  }
});
