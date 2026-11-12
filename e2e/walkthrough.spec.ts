import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import { deserialize, hashState, replay } from "../packages/sim/src/index";
import { decodePng, shareUnlike } from "./png";

// The M0 exit test from docs/milestones/M0.md, as one walkthrough a player
// could do by hand, run once on WebGPU (when the browser has an adapter)
// and once on the `?webgl` fallback. It runs in the `walkthrough` project,
// against the production build or, with BASE_URL, the public address.
//
// Every step goes through the page's own controls, except where a step
// needs a reading the page does not show, such as the camera's pose.
// Screenshots of each step land in walkthrough-screenshots/<backend>/ and
// are attached to the report.

interface Hit {
  x: number;
  y: number;
  z: number;
}
interface SaveStatus {
  city: { id: string; name: string; seed: number };
  loadedFrom: string;
  loadedTick: number;
  cities: { id: string }[];
}
interface LogEntry {
  tick: number;
  seq: number;
  playerId: string;
  type: string;
  payload: unknown;
}
declare const window: {
  cityCouncil: {
    saves: { status: SaveStatus | null };
    mirror: { state: { tick: number; seed: number; log: LogEntry[] } | null };
    renderStatus(): { backend: string; seed: number; readyMs: number } | null;
    view: Promise<{ lodCounts(): number[] }>;
    camera: Promise<{
      rig: { pose: { target: Hit; distance: number; yaw: number; pitch: number } };
      terrain: { samples: number; spacing: number };
      lastPick: Hit | null | undefined;
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const navigator: { gpu?: { requestAdapter(): Promise<unknown> } };

const VIEWPORT = { width: 1280, height: 800 };
const CENTRE = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
const MAP_METRES = 12_000;
const CHUNKS = 24 * 24;
/** M0 exit test step 1: the map is on screen within this long of opening the page. */
const LOAD_BUDGET_MS = 5000;
/** The page's sky colour, 0xb7cfe0. */
const SKY = [0xb7, 0xcf, 0xe0] as const;
/**
 * A modest home broadband line, for the cold load. The FCC's current
 * benchmark is 100 Mbit/s down; this is a quarter of that.
 */
const BROADBAND = { latency: 20, downloadThroughput: (25e6 / 8) | 0, uploadThroughput: (5e6 / 8) | 0 };

test.use({ viewport: VIEWPORT });
// Four page loads with the whole map, two of them throttled, on a machine
// that may have no GPU.
test.setTimeout(300_000);

const SCREENSHOTS = "walkthrough-screenshots";

async function shot(page: Page, info: TestInfo, dir: string, name: string): Promise<void> {
  mkdirSync(join(SCREENSHOTS, dir), { recursive: true });
  const body = await page.screenshot({ path: join(SCREENSHOTS, dir, `${name}.png`) });
  await info.attach(name, { body, contentType: "image/png" });
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/, { timeout: 15_000 });
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true", null, { timeout: 15_000 });
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
}

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

async function status(page: Page): Promise<SaveStatus> {
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

async function log(page: Page): Promise<LogEntry[]> {
  return (await page.evaluate(() => window.cityCouncil.mirror.state?.log)) ?? [];
}

async function pose(page: Page) {
  return page.evaluate(async () => (await window.cityCouncil.camera).rig.pose);
}

const speedButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

async function setSpeed(page: Page, name: "Pause" | "1x" | "2x" | "4x"): Promise<void> {
  await speedButton(page, name).click();
  await expect(speedButton(page, name)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sim-speed")).toHaveText(name === "Pause" ? "paused" : name);
}

/** Ticks per real second over `ms`, from the tick the page shows. */
async function measureRate(page: Page, ms: number): Promise<number> {
  const t0 = await tick(page);
  const start = Date.now();
  await page.waitForTimeout(ms);
  const t1 = await tick(page);
  return ((t1 - t0) * 1000) / (Date.now() - start);
}

/** The city menu, opened if it is closed. */
async function cityMenu(page: Page) {
  const menu = page.getByRole("region", { name: "City menu" });
  if (!(await menu.isVisible())) await page.getByRole("button", { name: "City" }).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Downloads the city with the menu's button and returns the file's bytes. */
async function download(page: Page, info: TestInfo, name: string): Promise<{ path: string; bytes: Uint8Array }> {
  const menu = await cityMenu(page);
  const [file] = await Promise.all([page.waitForEvent("download"), menu.locator("#download-city").click()]);
  expect(file.suggestedFilename()).toMatch(/\.city$/);
  const path = info.outputPath(name, file.suggestedFilename());
  await file.saveAs(path);
  return { path, bytes: new Uint8Array(readFileSync(path)) };
}

/** Opens the page cold, on a throttled line, and returns how long the map took. */
async function coldOpen(page: Page, cdp: CDPSession, url: string): Promise<{ wallMs: number; readyMs: number }> {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...BROADBAND });
  const start = Date.now();
  await page.goto(url);
  await ready(page);
  const wallMs = Date.now() - start;
  const render = await page.evaluate(() => window.cityCouncil.renderStatus());
  if (!render) throw new Error("render status missing after ready");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  return { wallMs, readyMs: render.readyMs };
}

for (const variant of [
  { name: "webgpu", query: "" },
  { name: "webgl", query: "?webgl" },
] as const) {
  test(`M0 walkthrough (${variant.name})`, async ({ page: firstPage, context }, info) => {
    let page = firstPage;
    const url = `./${variant.query}`;
    const dir = variant.name;
    const origin = new URL(info.project.use.baseURL ?? "http://localhost:4173/").origin;

    // The WebGPU run expects WebGPU only where this browser offers an adapter.
    await page.goto(url);
    const hasWebGpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    const wantBackend = variant.name === "webgpu" && hasWebGpu ? "webgpu" : "webgl2";
    if (variant.name === "webgpu" && !hasWebGpu) {
      info.annotations.push({ type: "backend", description: "no WebGPU adapter in this browser; ran on the WebGL 2 fallback" });
    }
    // That load stored a new city. Start the walkthrough from empty storage.
    page = await clearSiteData(page, origin);

    await test.step("1. open the page: a 12 km map from a seed renders within 5 seconds", async () => {
      const cdp = await context.newCDPSession(page);
      const load = await coldOpen(page, cdp, url);
      await cdp.detach();
      const render = await page.evaluate(() => window.cityCouncil.renderStatus());
      expect(render?.backend).toBe(wantBackend);
      const opened = await status(page);
      expect(opened.loadedFrom).toBe("new city");
      expect(render?.seed).toBe(opened.city.seed);
      const size = await page.evaluate(async () => {
        const t = (await window.cityCouncil.camera).terrain;
        return t.samples * t.spacing;
      });
      expect(size).toBe(MAP_METRES);
      const lods = await page.evaluate(async () => (await window.cityCouncil.view).lodCounts());
      expect(lods.reduce((a, b) => a + b, 0)).toBe(CHUNKS);
      // Measured from navigation start in the page, and from the test's own
      // clock around the navigation. Both must be inside the budget.
      expect(load.readyMs).toBeLessThan(LOAD_BUDGET_MS);
      expect(load.wallMs).toBeLessThan(LOAD_BUDGET_MS);
      const note = `cold load on 25 Mbit/s, 20 ms: map ready at ${load.readyMs.toFixed(0)} ms in the page, ${load.wallMs} ms around the navigation (${render?.backend}, seed ${opened.city.seed})`;
      info.annotations.push({ type: "cold load", description: note });
      console.log(`${variant.name}: ${note}`);

      // The map is drawn, not just loaded: the renderer reports the chunks
      // and the water as draw calls, and most of the screen is not sky.
      // A lost WebGPU device leaves the counters at zero and the canvas
      // empty while everything else on the page carries on.
      await page.keyboard.press("Backquote");
      await expect(page.locator("#render-draws")).toHaveText(/^5\d\d, [1-9]\d*k triangles$/);
      await page.keyboard.press("Backquote");
      await expect(page.getByRole("region", { name: "Debug panel" })).toBeHidden();
      // Below the top bar and right of the storage note.
      const view = decodePng(await page.screenshot({ clip: { x: 400, y: 120, width: 880, height: 680 } }));
      const drawn = shareUnlike(view, SKY);
      expect(drawn, "share of the view that is terrain or water, not sky").toBeGreaterThan(0.4);
      await shot(page, info, dir, "1-map");
    });

    await test.step("2. orbit, pan and zoom; a click on the ground reports world coordinates", async () => {
      await page.keyboard.press("Backquote");
      await expect(page.getByRole("region", { name: "Debug panel" })).toBeVisible();

      const before = await pose(page);
      // Right drag orbits.
      await page.mouse.move(CENTRE.x + 150, CENTRE.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(CENTRE.x + 350, CENTRE.y - 40, { steps: 8 });
      await page.mouse.up({ button: "right" });
      const orbited = await pose(page);
      expect(Math.abs(orbited.yaw - before.yaw) + Math.abs(orbited.pitch - before.pitch)).toBeGreaterThan(0.05);
      expect(orbited.distance).toBeCloseTo(before.distance, 0);

      // Left drag pans.
      await page.mouse.move(CENTRE.x + 150, CENTRE.y);
      await page.mouse.down();
      await page.mouse.move(CENTRE.x - 50, CENTRE.y + 100, { steps: 8 });
      await page.mouse.up();
      const panned = await pose(page);
      expect(Math.hypot(panned.target.x - orbited.target.x, panned.target.z - orbited.target.z)).toBeGreaterThan(10);

      // The wheel zooms.
      await page.mouse.move(CENTRE.x, CENTRE.y);
      for (let k = 0; k < 3; k++) await page.mouse.wheel(0, -400);
      await expect.poll(async () => (await pose(page)).distance).toBeLessThan(panned.distance * 0.9);
      await shot(page, info, dir, "2-camera-moved");

      // A click on the ground in the middle of the screen.
      await page.evaluate(async () => {
        (await window.cityCouncil.camera).lastPick = undefined;
      });
      await page.mouse.click(CENTRE.x, CENTRE.y);
      const hit = await page.evaluate(async () => (await window.cityCouncil.camera).lastPick);
      if (!hit) throw new Error("the click picked nothing");
      for (const v of [hit.x, hit.z]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(MAP_METRES);
      }
      await expect(page.locator("#pick-world")).toHaveText(`${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}, ${hit.z.toFixed(1)} m`);
      await shot(page, info, dir, "2-ground-picked");
    });

    await test.step("3. the sim ticks at 10 per second; pause, 1x, 2x and 4x change the rate", async () => {
      await expect(page.locator("#sim-speed")).toHaveText("1x");
      await expect.poll(async () => Number(await page.locator("#sim-tps").textContent()), { timeout: 10_000 }).toBeGreaterThan(8);
      expect(Number(await page.locator("#sim-tps").textContent())).toBeLessThan(12);
      // Rates measured over 2 s of real time, within a generous margin for a
      // shared CI machine. The host catches up on late steps, so the average
      // holds even when a frame is slow.
      for (const [name, speed] of [["1x", 1], ["2x", 2], ["4x", 4]] as const) {
        await setSpeed(page, name);
        const rate = await measureRate(page, 2000);
        expect(rate, `ticks per second at ${name}`).toBeGreaterThan(10 * speed * 0.7);
        expect(rate, `ticks per second at ${name}`).toBeLessThan(10 * speed * 1.3);
        if (speed === 4) {
          await expect.poll(async () => Number(await page.locator("#sim-tps").textContent())).toBeGreaterThan(28);
          await shot(page, info, dir, "3-speed-4x");
        }
      }
      await setSpeed(page, "Pause");
      expect(await measureRate(page, 1000)).toBe(0);
      await setSpeed(page, "1x");
    });

    await test.step("4. a no-op command appears in the activity log with a player id and a tick", async () => {
      await page.getByRole("button", { name: "Log" }).click();
      const panel = page.getByRole("region", { name: "Activity log" });
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Send NoOp" }).click();
      await expect(page.locator("#sim-last-result")).toHaveText("NoOp: ok");
      const row = panel.getByRole("row").nth(1);
      await expect(row).toContainText("NoOp");
      await expect(row.getByRole("cell").nth(1)).toHaveText("local");
      const loggedTick = Number(await row.getByRole("cell").first().textContent());
      expect(loggedTick).toBeGreaterThan(0);
      expect(loggedTick).toBeLessThanOrEqual(await tick(page));
      const entry = (await log(page)).find((e) => e.type === "NoOp");
      expect(entry).toMatchObject({ playerId: "local", tick: loggedTick });
      await shot(page, info, dir, "4-activity-log");
    });

    let saved: { id: string; tick: number; log: LogEntry[] } = { id: "", tick: 0, log: [] };
    await test.step("5. reload: the same city comes back at the same tick, from IndexedDB", async () => {
      // Pause so the tick cannot move between the save and the reload.
      await setSpeed(page, "Pause");
      const savedTick = await tick(page);
      const menu = await cityMenu(page);
      await menu.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("#save-status")).toContainText(`tick ${savedTick} at`);
      saved = { id: (await status(page)).city.id, tick: savedTick, log: await log(page) };
      expect(saved.log.map((e) => e.type)).toContain("NoOp");

      await page.reload();
      await ready(page);
      const after = await status(page);
      expect(after.loadedFrom).toBe("latest save");
      expect(after.city.id).toBe(saved.id);
      expect(after.loadedTick).toBe(saved.tick);
      expect(await tick(page)).toBe(saved.tick);
      expect(await log(page)).toEqual(saved.log);
      await expect(page.locator("#sim-speed")).toHaveText("paused");
      await shot(page, info, dir, "5-after-reload");
    });

    let file: { path: string; bytes: Uint8Array } = { path: "", bytes: new Uint8Array() };
    await test.step("6. download the city, clear site data, import the file: the same city comes back", async () => {
      file = await download(page, info, "download-1");
      const original = deserialize(file.bytes);
      expect(original.state.tick).toBe(saved.tick);
      await expect(page.locator("#file-note")).toContainText(`at tick ${saved.tick}`);
      await shot(page, info, dir, "6-downloaded");

      page = await clearSiteData(page, origin);
      await page.goto(url);
      await ready(page);
      const cleared = await status(page);
      expect(cleared.loadedFrom).toBe("new city");
      expect(cleared.cities).toHaveLength(1);

      const menu = await cityMenu(page);
      const loaded = page.waitForEvent("load");
      await menu.locator("#import-file").setInputFiles(file.path);
      await loaded;
      await ready(page);
      const imported = await status(page);
      expect(imported.loadedFrom).toBe("latest save");
      expect(imported.loadedTick).toBe(saved.tick);
      expect(await tick(page)).toBe(saved.tick);
      expect(await log(page)).toEqual(saved.log);
      await expect(page.locator("#file-note")).toContainText("from ");
      await shot(page, info, dir, "6-imported");

      // The imported city downloads to the same state as the original file.
      const again = deserialize((await download(page, info, "download-2")).bytes);
      expect(hashState(again.state)).toBe(hashState(original.state));
    });

    await test.step("7. a replay of the recorded command log from the seed gives the same state hash", async () => {
      // Here in Node, not in the browser: a second engine rebuilds the city.
      const { header, state, pagedLog } = deserialize(file.bytes);
      const fullLog = [...pagedLog, ...state.log];
      expect(fullLog.map((e) => e.type)).toContain("NoOp");
      for (const e of fullLog) expect(e.playerId).toBe("local");
      const rebuilt = replay(header.seed, fullLog, header.tick);
      expect(rebuilt.tick).toBe(header.tick);
      const hash = hashState(rebuilt);
      expect(hash).toBe(hashState(state));
      info.annotations.push({ type: "replay", description: `seed ${header.seed}, ${fullLog.length} commands, tick ${header.tick}, hash ${hash}` });
    });
  });
}

/** Closes the tab, clears everything the origin stored, and opens a fresh tab. */
async function clearSiteData(page: Page, origin: string): Promise<Page> {
  const context = page.context();
  // Close the tab first so its worker cannot write to storage after the clear.
  await page.close();
  const fresh = await context.newPage();
  const cdp = await context.newCDPSession(fresh);
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await cdp.detach();
  return fresh;
}
