import { expect, test, type Page } from "@playwright/test";

// The hooks packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
interface SaveStatus {
  city: { id: string; name: string; seed: number };
  loadedFrom: string;
  loadedTick: number;
  lastSave: { tick: number; savedAt: number; reason: string } | null;
  problem: string | null;
  cities: { id: string; tick: number }[];
}
interface LogEntry {
  tick: number;
  seq: number;
  playerId: string;
  type: string;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<unknown>;
    saveNow(): Promise<SaveStatus>;
    saves: { status: SaveStatus | null };
    mirror: { state: { tick: number; log: LogEntry[] } | null };
  };
};
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  dispatchEvent(event: unknown): boolean;
};
declare const Event: new (type: string) => unknown;
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

async function tick(page: Page): Promise<number> {
  return Number(await page.locator("#sim-tick").textContent());
}

async function status(page: Page): Promise<SaveStatus> {
  await page.waitForFunction(() => window.cityCouncil.saves.status !== null);
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/);
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true");
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  expect(await page.evaluate((s) => window.cityCouncil.sendCommand("SetSpeed", { speed: s }), speed)).toEqual({ ok: true });
  await expect(page.locator("#sim-speed")).toHaveText(speed === 0 ? "paused" : `${speed}x`);
}

/**
 * Changes the stored latest snapshot of city `id` in the page's IndexedDB,
 * as disk damage or a newer build would. `edit` is "flip" to damage a byte,
 * or "newer" to mark it as written by a newer version. Returns the bytes now
 * stored, as a plain array.
 */
async function tamper(page: Page, id: string, edit: "flip" | "newer"): Promise<number[]> {
  return page.evaluate(
    async ({ id, edit }) => {
      const db = await new Promise<IdbDb>((resolve, reject) => {
        const req = indexedDB.open("city-council");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error("open failed"));
      });
      const tx = db.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const get = store.get(id);
      const bytes = await new Promise<number[]>((resolve) => {
        get.onsuccess = () => {
          const record = get.result as { latest: ArrayBuffer };
          const latest = new Uint8Array(record.latest);
          if (edit === "flip") latest[latest.length - 5] = (latest[latest.length - 5] ?? 0) ^ 0xff;
          else new DataView(latest.buffer).setUint16(6, 999, true);
          store.put({ ...record, latest: latest.buffer });
          resolve(Array.from(latest));
        };
      });
      await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
      db.close();
      return bytes;
    },
    { id, edit },
  );
}

async function storedLatest(page: Page, id: string): Promise<number[]> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IdbDb>((resolve) => {
      const req = indexedDB.open("city-council");
      req.onsuccess = () => resolve(req.result);
    });
    const get = db.transaction("snapshots", "readonly").objectStore("snapshots").get(id);
    const bytes = await new Promise<number[]>((resolve) => {
      get.onsuccess = () => resolve(Array.from(new Uint8Array((get.result as { latest: ArrayBuffer }).latest)));
    });
    db.close();
    return bytes;
  }, id);
}

test("a city resumes from the saved tick after a reload, with its activity log", async ({ page }) => {
  await open(page);
  const first = await status(page);
  expect(first.loadedFrom).toBe("new city");
  // A new city is saved straight away so it is in the list.
  expect(first.lastSave?.reason).toBe("new city");

  expect(await page.evaluate(() => window.cityCouncil.sendCommand("NoOp", { note: "before reload" }))).toEqual({ ok: true });
  await expect.poll(() => tick(page), { timeout: 10_000 }).toBeGreaterThan(30);
  // Pause so the tick cannot move between the save and the reload, even if
  // the reload's own hidden-tab save lands.
  await setSpeed(page, 0);
  const savedTick = await tick(page);
  await page.getByRole("button", { name: "City" }).click();
  await page.getByRole("region", { name: "City menu" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#save-status")).toContainText(`tick ${savedTick} at`);
  await expect(page.locator("#save-status")).toContainText("(manual)");
  const logBefore = await page.evaluate(() => window.cityCouncil.mirror.state?.log);
  expect(logBefore?.map((e) => e.type)).toEqual(["NoOp", "SetSpeed"]);
  await page.screenshot({ path: "test-results/save-before-reload.png" });

  await page.reload();
  await open(page);
  const after = await status(page);
  expect(after.loadedFrom).toBe("latest save");
  expect(after.city.id).toBe(first.city.id);
  expect(after.loadedTick).toBe(savedTick);
  expect(await tick(page)).toBe(savedTick);
  await expect(page.locator("#sim-speed")).toHaveText("paused");
  await expect(page.locator("#sim-log-length")).toHaveText("2");
  expect(await page.evaluate(() => window.cityCouncil.mirror.state?.log)).toEqual(logBefore);
  await expect(page.locator("#save-problem")).toBeHidden();
  await page.screenshot({ path: "test-results/save-after-reload.png" });

  // And it carries on from there.
  await setSpeed(page, 1);
  await expect.poll(() => tick(page)).toBeGreaterThan(savedTick + 3);
});

test("hiding the tab saves the city", async ({ page }) => {
  await open(page);
  await expect.poll(() => tick(page)).toBeGreaterThan(10);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#save-status")).toContainText("(hidden)");
});

test("the page asks to keep storage and says so when the browser declines", async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => document.body.dataset["persistence"] !== undefined);
  const persistence = await page.evaluate(() => document.body.dataset["persistence"]);
  if (persistence === "persisted") {
    await expect(page.locator("#storage-note")).toBeHidden();
  } else {
    await expect(page.locator("#storage-note")).toBeVisible();
    await expect(page.locator("#storage-note")).toContainText("may clear them");
  }
});

// The tamper tests close the tab that ran the city before changing its save,
// then open it again in a new tab. A tab left running would autosave the
// city every 30 seconds, and a reload saves it as the tab hides; either
// could replace the snapshot the test just changed.

/**
 * Closes `page`, so its worker stops saving, and tampers with city `id`
 * from a blank page on the same origin that does not run the game.
 */
async function closeAndTamper(page: Page, id: string, edit: "flip" | "newer"): Promise<number[]> {
  const context = page.context();
  await page.close();
  const blank = await context.newPage();
  await blank.route("**/blank", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  await blank.goto("/blank");
  const bytes = await tamper(blank, id, edit);
  await blank.close();
  return bytes;
}

test("a damaged save is reported and the previous good save is loaded", async ({ page: first }) => {
  const page = first;
  await open(page);
  await setSpeed(page, 0);
  const goodTick = await tick(page);
  await page.evaluate(() => window.cityCouncil.saveNow());
  await setSpeed(page, 4);
  await expect.poll(() => tick(page)).toBeGreaterThan(goodTick + 10);
  await setSpeed(page, 0);
  await page.evaluate(() => window.cityCouncil.saveNow());
  const { city } = await status(page);
  const context = page.context();
  await closeAndTamper(page, city.id, "flip");

  const second = await context.newPage();
  await open(second);
  const after = await status(second);
  expect(after.city.id).toBe(city.id);
  expect(after.loadedFrom).toBe("previous save");
  expect(after.loadedTick).toBe(goodTick);
  expect(await tick(second)).toBe(goodTick);
  await expect(second.locator("#save-problem")).toBeVisible();
  await expect(second.locator("#save-problem")).toContainText("could not be used");
  await expect(second.locator("#save-problem")).toContainText(`from tick ${goodTick}`);
  await second.screenshot({ path: "test-results/save-damaged.png" });
});

test("a save from a newer version is refused and left untouched", async ({ page: first }) => {
  const page = first;
  await open(page);
  const { city } = await status(page);
  await page.evaluate(() => window.cityCouncil.saveNow());
  const context = page.context();
  const stored = await closeAndTamper(page, city.id, "newer");

  const second = await context.newPage();
  await open(second);
  const after = await status(second);
  expect(after.loadedFrom).toBe("new city");
  expect(after.city.id).not.toBe(city.id);
  await expect(second.locator("#save-problem")).toBeVisible();
  await expect(second.locator("#save-problem")).toContainText("newer version of the game");
  await expect(second.locator("#save-problem")).toContainText("left as it is");
  await second.screenshot({ path: "test-results/save-newer.png" });
  // The new city saves under its own id; the newer save is still as it was.
  await second.evaluate(() => window.cityCouncil.saveNow());
  expect(await storedLatest(second, city.id)).toEqual(stored);
});
