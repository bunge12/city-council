import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// The hooks packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
interface CityMeta {
  id: string;
  name: string;
  tick: number;
}
interface SaveStatus {
  city: { id: string; name: string; seed: number };
  loadedFrom: string;
  loadedTick: number;
  cities: CityMeta[];
}
interface DownloadedCity {
  fileName: string;
  tick: number;
  hash: string;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    downloadCity(): Promise<DownloadedCity>;
    saves: { status: SaveStatus | null };
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const indexedDB: {
  open(name: string): { result: IdbDb; onsuccess: (() => void) | null; onerror: (() => void) | null };
};
interface IdbDb {
  transaction(store: string, mode: string): {
    objectStore(name: string): {
      get(key: string): { result: unknown; onsuccess: (() => void) | null };
      put(value: unknown): void;
    };
    oncomplete: (() => void) | null;
  };
  close(): void;
}

const ORIGIN = "http://localhost:5173";

// Each test loads the page three or four times, and the map takes a few
// seconds per load on a software WebGL fallback.
test.setTimeout(90_000);

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true");
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await ready(page);
}

async function status(page: Page): Promise<SaveStatus> {
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  expect(await page.evaluate((s) => window.cityCouncil.sendCommand("SetSpeed", { speed: s }), speed)).toEqual({ ok: true });
  await expect(page.locator("#sim-speed")).toHaveText(speed === 0 ? "paused" : `${speed}x`);
}

let downloads = 0;

/** Downloads the city through the page and returns what the file holds and where it went. */
async function download(page: Page): Promise<DownloadedCity & { path: string }> {
  const [file, info] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => window.cityCouncil.downloadCity()),
  ]);
  expect(file.suggestedFilename()).toBe(info.fileName);
  // Keep the file's own name, since an import names the city after it.
  const path = test.info().outputPath(`download-${++downloads}`, info.fileName);
  await file.saveAs(path);
  return { ...info, path };
}

/** Picks a file in the Import control and waits for the page to open the imported city. */
async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles(file);
  await loaded;
  await ready(page);
}

/** Clears everything the site has stored, as the browser's "clear site data" does. */
async function clearSiteData(page: Page): Promise<Page> {
  const context = page.context();
  // Close the tab first so its worker cannot write to storage after the clear.
  await page.close();
  const fresh = await context.newPage();
  const cdp = await context.newCDPSession(fresh);
  await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
  await cdp.detach();
  return fresh;
}

test("a downloaded city comes back with the same hash after site data is cleared", async ({ page: first }) => {
  let page = first;
  await open(page);
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("NoOp", { note: "take me with you" }))).toEqual({ ok: true });
  await expect.poll(() => tick(page), { timeout: 10_000 }).toBeGreaterThan(30);
  await setSpeed(page, 0);
  const original = await status(page);
  const file = await download(page);
  expect(file.fileName).toBe(`${original.city.name}.city`);
  expect(file.tick).toBe(await tick(page));
  await expect(page.locator("#file-note")).toContainText(`Downloaded ${file.fileName} at tick ${file.tick}`);
  await page.screenshot({ path: "test-results/city-file-downloaded.png" });

  page = await clearSiteData(page);
  await open(page);
  const cleared = await status(page);
  expect(cleared.loadedFrom).toBe("new city");
  expect(cleared.city.id).not.toBe(original.city.id);
  expect(cleared.cities).toHaveLength(1);

  await importFile(page, file.path);
  const after = await status(page);
  expect(after.loadedFrom).toBe("latest save");
  expect(after.city.id).not.toBe(cleared.city.id);
  expect(after.city.name).toBe(original.city.name === cleared.city.name ? `${original.city.name} 2` : original.city.name);
  expect(after.loadedTick).toBe(file.tick);
  expect(await tick(page)).toBe(file.tick);
  await expect(page.locator("#sim-speed")).toHaveText("paused");
  await expect(page.locator("#file-note")).toContainText(`from ${file.fileName}`);
  // The city that was there before the import is still in the list.
  expect(after.cities.map((c) => c.id).sort()).toEqual([after.city.id, cleared.city.id].sort());
  await page.screenshot({ path: "test-results/city-file-imported.png" });
  // Downloading the imported city gives the same state as the original file.
  const again = await download(page);
  expect(again.tick).toBe(file.tick);
  expect(again.hash).toBe(file.hash);
});

test("a file that is not a city, or is cut short, is refused and nothing changes", async ({ page }) => {
  await open(page);
  await setSpeed(page, 0);
  const file = await download(page);
  const before = await status(page);
  const bytes = await readFile(file.path);

  const cases = [
    { name: "notes.city", buffer: Buffer.from("these are not the cities you are looking for"), error: "This is not a City Council save" },
    { name: "Half a town.city", buffer: bytes.subarray(0, Math.floor(bytes.length / 2)), error: "cut short" },
  ];
  let navigated = false;
  page.on("framenavigated", () => (navigated = true));
  for (const { name, buffer, error } of cases) {
    await page.locator("#import-file").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await expect(page.locator("#file-problem")).toBeVisible();
    await expect(page.locator("#file-problem")).toContainText(`Could not import "${name}".`);
    await expect(page.locator("#file-problem")).toContainText(error);
    await page.screenshot({ path: `test-results/city-file-refused-${name.split(".")[0]?.replace(/ /g, "-")}.png` });
  }
  expect(navigated).toBe(false);
  const after = await status(page);
  expect(after.city).toEqual(before.city);
  expect(after.cities.map((c) => c.id)).toEqual(before.cities.map((c) => c.id));

  // The page still opens the same city next time.
  await page.reload();
  await ready(page);
  expect((await status(page)).city.id).toBe(before.city.id);
});

test("importing the same file twice gives two separate cities", async ({ page }) => {
  await open(page);
  await setSpeed(page, 0);
  const file = await download(page);
  const before = await status(page);

  await importFile(page, file.path);
  const first = await status(page);
  await importFile(page, file.path);
  const second = await status(page);

  expect(first.city.id).not.toBe(second.city.id);
  expect(new Set([before.city.id, first.city.id, second.city.id]).size).toBe(3);
  expect(second.cities).toHaveLength(before.cities.length + 2);
  const name = before.city.name;
  expect([first.city.name, second.city.name]).toEqual([`${name} 2`, `${name} 3`]);
  for (const city of [first, second]) expect(city.loadedTick).toBe(file.tick);
  expect((await download(page)).hash).toBe(file.hash);
  await page.screenshot({ path: "test-results/city-file-imported-twice.png" });
});

test("the page reminds the player to download a copy now and then", async ({ page }) => {
  await open(page);
  await expect(page.locator("#export-reminder")).toBeHidden();

  // Pretend the city was made four days ago and never downloaded. The page
  // and the worker read the same wall clock, so this moves the stored time
  // rather than the clock.
  const { city } = await status(page);
  await page.evaluate(async (id) => {
    const db = await new Promise<IdbDb>((resolve, reject) => {
      const req = indexedDB.open("city-council");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("open failed"));
    });
    const tx = db.transaction("cities", "readwrite");
    const store = tx.objectStore("cities");
    const get = store.get(id);
    get.onsuccess = () => store.put({ ...(get.result as object), createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000 });
    await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
    db.close();
  }, city.id);
  await page.reload();
  await ready(page);
  await expect(page.locator("#export-reminder")).toBeVisible();
  await expect(page.locator("#export-reminder")).toContainText("have not downloaded a copy");
  await page.screenshot({ path: "test-results/city-file-reminder.png" });
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#export-reminder")).toBeHidden();

  // It comes back next time, until a copy is downloaded.
  await page.reload();
  await ready(page);
  await expect(page.locator("#export-reminder")).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download a copy" }).click()]);
  expect(file.suggestedFilename()).toMatch(/\.city$/);
  await expect(page.locator("#export-reminder")).toBeHidden();
});
