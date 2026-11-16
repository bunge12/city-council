import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ROAD_TYPES, ZONING_BALANCE, createState, generateTerrain, heightAt, serialize, type SimState } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M2-18: the homes figure in the top bar. A player paints R1 along a
// street with the zone tool, lets the grower build, and watches the figure
// go up; bulldozes a house and watches it go down; reloads and finds the
// same figure. The tooltip gives the room those homes hold, as capacity.
//
// The city is one street built in Node with the sim and imported as a city
// file, with nothing zoned.

type Vec3 = readonly [number, number, number];
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: { state: { log: { type: string }[]; buildings: { flags: Uint8Array; zone: Uint8Array; residents: Int32Array } } | null };
    view: Promise<{ buildingTop(id: number): { x: number; y: number; z: number } | null }>;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const terrain = generateTerrain(SEED);
const HALF = (ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0) / 2;
const RESIDENTIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;
/** Screenshots also land here, for the pull request's evidence page. */
const EVIDENCE = process.env["HOMES_EVIDENCE_DIR"];
const STREET_Z = 4600;
const MID_X = 4300;

function oneStreet(): SimState {
  const state = createState(SEED);
  buildRoads(state, [[[4200, STREET_Z], [4392, STREET_Z], "street"]]);
  return state;
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((n) => new Promise<void>((r) => {
    const step = (left: number) => (left <= 0 ? r() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  }), n);
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [[x, g + height, z + height * 0.75], [x, g, z]] as const);
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 60_000 });
  await frames(page, 4);
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

/** The figure the top bar shows, as a number, or the text when it is not one. */
async function shown(page: Page): Promise<number | string> {
  const text = (await page.locator("#homes-count").textContent()) ?? "";
  const n = Number(text.replace(/,/g, ""));
  return text !== "" && Number.isFinite(n) ? n : text;
}

/** Residential buildings standing in the page's copy, counted in full, and their room. */
async function counted(page: Page): Promise<{ count: number; capacity: number; ids: number[] }> {
  return page.evaluate((residential) => {
    const b = window.cityCouncil.mirror.state?.buildings;
    const ids: number[] = [];
    let capacity = 0;
    b?.flags.forEach((f, id) => {
      if ((f & 1) === 0 || b.zone[id] !== residential) return;
      ids.push(id);
      capacity += b.residents[id] ?? 0;
    });
    return { count: ids.length, capacity, ids };
  }, RESIDENTIAL);
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  expect(await page.evaluate((speed) => window.cityCouncil.sendCommand("SetSpeed", { speed }), speed)).toEqual({ ok: true });
}

let shotNo = 0;
async function attach(page: Page, testInfo: TestInfo, name: string, whole = false): Promise<void> {
  const file = `${String(++shotNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = testInfo.outputPath(file);
  const png = whole ? await page.screenshot() : await page.locator(".top-bar").screenshot();
  writeFileSync(path, png);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/${file}`, png);
  }
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the top bar counts the homes built: up as houses grow, down when one is bulldozed, the same after a reload", async ({ page }, testInfo) => {
  await page.goto("/?webgl");
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Elm Street.city", mimeType: "application/octet-stream", buffer: Buffer.from(serialize(oneStreet())) });
  await loaded;
  await ready(page);
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
  const figure = page.locator("#homes");

  await test.step("a city with no homes shows 0, beside the date", async () => {
    await setSpeed(page, 0);
    await expect(page.locator("#homes-count")).toHaveText("0");
    await expect(figure).toHaveText("Homes 0");
    // Right after the date in the bar.
    expect(await page.locator("#game-date + #homes").count()).toBe(1);
    await expect(figure).toHaveAttribute("title", /Capacity: room for 0 residents/);
    await attach(page, testInfo, "no homes yet");
  });

  await test.step("paint R1 along the street with the zone tool", async () => {
    await look(page, MID_X, STREET_Z - 30, 260);
    await page.locator("#view").focus();
    await page.keyboard.press("KeyK");
    await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
    await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
    await expect(page.locator("#zone-residential")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#zone-density-1")).toHaveAttribute("aria-pressed", "true");
    const p = await screenAt(page, MID_X, STREET_Z - HALF / 2);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await frames(page);
    await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.log.filter((e) => e.type === "ZoneCells").length ?? 0)).toBe(1);
    await page.keyboard.press("KeyK");
    await page.mouse.move(640, 20);
  });

  let grown = 0;
  await test.step("houses grow and the figure goes up with them", async () => {
    await setSpeed(page, 4);
    // One building a game day: a day is 100 ticks, 2.5 s at 4x.
    await expect.poll(() => shown(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
    await setSpeed(page, 0);
    // A paused city: the figure and a full count of the copy agree.
    const full = await counted(page);
    await expect.poll(() => shown(page)).toBe(full.count);
    grown = full.count;
    await expect(page.locator("#homes-count")).toHaveAttribute("data-capacity", String(full.capacity));
    await expect(figure).toHaveAttribute("title", `Residential buildings standing. Capacity: room for ${full.capacity.toLocaleString("en-US")} ${full.capacity === 1 ? "resident" : "residents"} in these homes. Not a count of people.`);
    await attach(page, testInfo, `${grown} homes built`);
    await look(page, MID_X, STREET_Z - 30, 220);
    await attach(page, testInfo, "the houses and the top bar", true);
  });

  await test.step("bulldozing a house takes one off", async () => {
    const { ids } = await counted(page);
    const house = ids[0];
    if (house === undefined) throw new Error("no house");
    await page.keyboard.press("KeyB");
    await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
    const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), house);
    if (!top) throw new Error(`house ${house} is not drawn`);
    const p = await screenAt(page, top.x, top.z, top.y - 1);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await frames(page, 3);
    await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-kind", "building");
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => shown(page), { timeout: 30_000 }).toBe(grown - 1);
    expect((await counted(page)).count).toBe(grown - 1);
    await page.keyboard.press("KeyB");
    await page.mouse.move(640, 20);
    await attach(page, testInfo, `${grown - 1} homes after the bulldozer`);
  });

  await test.step("a reload shows the same figure", async () => {
    const before = await counted(page);
    await page.getByRole("button", { name: "City" }).click();
    await page.getByRole("region", { name: "City menu" }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#save-status")).toContainText("(manual)");
    await page.reload();
    await ready(page);
    await expect.poll(() => shown(page), { timeout: 30_000 }).toBe(before.count);
    await expect(page.locator("#homes-count")).toHaveAttribute("data-capacity", String(before.capacity));
    expect(await counted(page)).toEqual(before);
    await attach(page, testInfo, "the same figure after a reload");
  });

  await test.step("importing another city counts that city's homes", async () => {
    expect(await shown(page)).toBeGreaterThan(0);
    const loaded = page.waitForEvent("load");
    await page.locator("#import-file").setInputFiles({ name: "Bare Street.city", mimeType: "application/octet-stream", buffer: Buffer.from(serialize(oneStreet())) });
    await loaded;
    await ready(page);
    await expect.poll(() => shown(page), { timeout: 30_000 }).toBe(0);
    expect((await counted(page)).count).toBe(0);
  });
});
