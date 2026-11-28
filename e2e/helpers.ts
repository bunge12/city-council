// What most spec files need to open a city and wait for the page, in one
// place, so a fix to one of them reaches every spec (issue #227).

import { expect, type Locator, type Page } from "@playwright/test";
import { serialize, type SimState } from "../packages/sim/src/index";

/** What the page reports about its renderer, as `window.cityCouncil.renderStatus()` returns it. */
export interface RenderStatus {
  backend: string;
  seed: number;
  terrainMs: number;
  buildMs: number;
  readyMs: number;
}

declare const window: {
  cityCouncil: {
    renderStatus(): RenderStatus | null;
    saves: { status: { city: { name: string }; problem: string | null } | null };
    view: Promise<{ flush?: () => void }>;
    mirror?: { state: { tick: number; seed: number } | null };
    loading?: () => unknown;
    readSteps?: () => unknown;
  };
};
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
};
declare function requestAnimationFrame(callback: () => void): number;
declare function setTimeout(callback: () => void, ms: number): number;
declare const performance: { now(): number };

/**
 * `url` with the `flush` switch in its query, so the page has
 * `view.flush()` (issue #223). `openPage` and `openCity` add it.
 */
export function withFlush(url: string): string {
  const [path, query = ""] = url.split("?", 2) as [string, string?];
  const rest = query.split("&").filter((p) => p !== "" && p !== "flush");
  return `${path}?${["flush", ...rest].join("&")}`;
}

/** What became of the city file `openCity` last served each page: when Playwright was asked for it and answered (#450). */
const fixtureNotes = new WeakMap<Page, string[]>();

/** Errors and console errors each page has had since `watchErrors` was first called on it, the last few. */
const pageErrors = new WeakMap<Page, string[]>();

/** Starts keeping `page`'s uncaught errors and console errors, for `loadReport`. Calling it again does nothing. */
function watchErrors(page: Page): void {
  if (pageErrors.has(page)) return;
  const kept: string[] = [];
  pageErrors.set(page, kept);
  const keep = (line: string) => {
    kept.push(line.slice(0, 500));
    if (kept.length > 10) kept.shift();
  };
  page.on("pageerror", (error) => keep(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") keep(`console: ${message.text()}`);
  });
  page.on("crash", () => keep("the page crashed"));
}

/**
 * What the page says about its load: the body's data flags (the loading
 * stages it passed, whether the worker reported on saves, whether the city
 * is open in another tab, buildings pending), the save status, the mirror's
 * tick, the steps of reading the save, whether the fixture was served,
 * and the errors it had. For a `ready` that timed out, so the CI log
 * shows where the load stopped without the trace, which the artifact store
 * may not let a session download (issues #432 and #447). A page whose main
 * thread is stuck cannot answer, and says so after a few seconds.
 */
export async function loadReport(page: Page): Promise<string> {
  const errors = pageErrors.get(page) ?? [];
  const asked = page
    .evaluate(() => {
      const council = window.cityCouncil as typeof window.cityCouncil | undefined;
      const status = council?.saves.status ?? null;
      return {
        flags: { ...document.body.dataset },
        saves: status,
        mirror: council?.mirror?.state ? { tick: council.mirror.state.tick, seed: council.mirror.state.seed } : null,
        loading: council?.loading?.() ?? null,
        readSteps: council?.readSteps?.() ?? null,
      };
    })
    .then((found) => JSON.stringify({ ...found, fixture: fixtureNotes.get(page) ?? null }))
    .catch((error: unknown) => `the page could not be asked (${error instanceof Error ? error.message : String(error)})`);
  const stuck = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("the page did not answer within 10 s, so its main thread is stuck"), 10_000);
    void asked.finally(() => clearTimeout(timer));
  });
  const found = await Promise.race([asked, stuck]);
  return `${found}; errors: ${errors.length > 0 ? errors.join(" | ") : "none"}`;
}

/** Waits until the page has drawn its first frame with terrain. A timeout says where the load stopped (`loadReport`). */
export async function ready(page: Page, timeout = 60_000): Promise<void> {
  watchErrors(page);
  try {
    await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    error.message = `${error.message}\nThe page when the wait gave up: ${await loadReport(page)}`;
    throw error;
  }
}

/** Waits until the city has loaded: the sim's tick is on screen and the worker has reported on saves. */
export async function cityLoaded(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/, { timeout });
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true", null, { timeout });
}

/** Waits until the city has loaded and the page has drawn it: `cityLoaded`, then `ready`. */
export async function cityReady(page: Page, timeout = 60_000): Promise<void> {
  await cityLoaded(page, timeout);
  await ready(page, timeout);
}

/** Hides the import and storage notes, which would cover the map in screenshots. A reload brings them back. */
export async function hideNotes(page: Page): Promise<void> {
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

/** The page's render status, which it has once `ready`. */
export async function renderStatus(page: Page): Promise<RenderStatus> {
  const status = await page.evaluate(() => window.cityCouncil.renderStatus());
  if (!status) throw new Error("render status missing after ready");
  return status;
}

/** Goes to `url` and waits until the page is `ready`, then returns its render status. */
export async function openPage(page: Page, url = "./", timeout = 60_000): Promise<RenderStatus> {
  watchErrors(page);
  await page.goto(withFlush(url));
  await ready(page, timeout);
  return renderStatus(page);
}

export interface OpenCityOptions {
  /** Flags for the page's address, such as `webgl&debug`. A leading `/` or `?` is dropped. */
  query?: string;
  /** The city's name. The file is `<name>.city`, which the city is named after, as on import. */
  name?: string;
  /** Also waits until the graphics preset has settled. */
  presetSettled?: boolean;
  /** Leaves the notes over the map. They are hidden by default, so screenshots show the map. */
  notes?: boolean;
  timeout?: number;
}

/** Numbers the addresses fixtures are served at, so each is answered once and two never mix. */
let served = 0;

/**
 * Opens `city` in one page load and waits until it is drawn. The page's
 * `?load=` address names a city file that `page.route` answers with the
 * fixture's bytes, and the worker stores and opens it in place of any other,
 * as an import does but without the import's reload. Only city-file.spec.ts
 * and the M0 walkthrough still import through `#import-file`, since there
 * the import is what is tested. Returns the
 * render backend.
 */
export async function openCity(page: Page, city: SimState | Uint8Array, options: OpenCityOptions = {}): Promise<string> {
  const { query = "webgl", name = "Fixture", presetSettled = false, notes = false, timeout = 60_000 } = options;
  const bytes = city instanceof Uint8Array ? city : serialize(city);
  // Relative to the page, so it works under a base path such as GitHub Pages'.
  const address = `e2e-fixture/${++served}/${encodeURIComponent(name)}.city`;
  const answers: string[] = [];
  fixtureNotes.set(page, answers);
  const started = Date.now();
  const note = (what: string) => answers.push(`${what} at ${Date.now() - started} ms`);
  await page.route(
    `**/${address}`,
    async (route) => {
      note(`${bytes.byteLength} bytes asked for`);
      try {
        await route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" });
        note("answered");
      } catch (error) {
        note(`not answered (${error instanceof Error ? error.message : String(error)})`);
        throw error;
      }
    },
    { times: 1 },
  );
  const flags = query.replace(/^\/?\??/, "");
  watchErrors(page);
  await page.goto(withFlush(`./?${flags ? `${flags}&` : ""}load=${encodeURIComponent(address)}`));
  await ready(page, timeout);
  // A file that could not be had opens the tab's usual city with a note, so check it was this one.
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true", null, { timeout });
  const opened = await page.evaluate(() => window.cityCouncil.saves.status);
  if (opened?.problem) throw new Error(`the fixture did not open: ${opened.problem}`);
  const named = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+)?$`);
  if (!named.test(opened?.city.name ?? "")) throw new Error(`opened "${opened?.city.name}", not the fixture "${name}"`);
  if (presetSettled) await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout });
  if (!notes) await hideNotes(page);
  return (await renderStatus(page)).backend;
}

/** Waits until the building layer has read every chunk from the mirror and draws `count` buildings. */
export async function buildingsDrawn(page: Page, count: number, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    (count) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(count),
    count,
    { timeout },
  );
}

/** Resolves after `n` animation frames. */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        const step = (left: number) => (left <= 0 ? r() : requestAnimationFrame(() => step(left - 1)));
        step(n);
      }),
    n,
  );
}

export interface SettleOptions {
  timeout?: number;
}

/**
 * Builds everything the camera needs now and waits until the canvas says
 * every build queue is empty (issue #223): buildings read and in the form
 * they want with no fade under way, the forms kept for a zoom built, the
 * decoration in range and the overlay's cells while it is shown. The page
 * builds chunks a few a frame within a budget, and in software WebGL a frame
 * takes a second or more, so `view.flush()`, which `openPage` and `openCity`
 * switch on, builds them all at once instead. If a delta from the sim marks
 * chunks again, it flushes again. Usually the first flush settles it.
 * building-lod.spec.ts keeps one test that fills a scene through the budget.
 */
export async function settle(page: Page, options: SettleOptions = {}): Promise<void> {
  const { timeout = 120_000 } = options;
  // One round trip: the page answers between frames of a second or more, and a `waitForFunction` costs several.
  const settled = await page.evaluate(async (timeout) => {
    const view = await window.cityCouncil.view;
    if (!view.flush) throw new Error("the page has no view.flush(): open it with openPage, openCity or withFlush(url)");
    const canvas = document.querySelector("#view");
    const end = performance.now() + timeout;
    for (;;) {
      // Always, even when the queues look empty: right after a camera move they still describe the last frame's view.
      view.flush();
      if (canvas?.getAttribute("data-render-settled") === "true") return true;
      if (performance.now() > end) return false;
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  }, timeout);
  if (!settled) throw new Error(`the view did not settle in ${timeout} ms`);
}

/** Waits, without flushing, until the per-frame budget has built every pending chunk: the path players get. */
export async function settleThroughFrames(page: Page, timeout = 120_000): Promise<void> {
  // The signal is set after each frame, so one drawn after the camera moved.
  await frames(page, 2);
  await page.waitForFunction(() => document.querySelector("#view")?.getAttribute("data-render-settled") === "true", null, { timeout });
}

/**
 * The canvas without the UI over it. A screenshot of the page clipped to the
 * canvas, not of the canvas element: an element screenshot first waits for
 * the element to hold still over animation frames, which in software
 * rendering took 13 to 18 s against about 7 s for the page (#145, #217).
 */
export async function canvasShot(page: Page): Promise<Buffer> {
  const hide = await page.addStyleTag({ content: "#ui { display: none !important; }" });
  try {
    const box = await page.locator("#view").boundingBox();
    if (!box) throw new Error("the canvas is not on the page");
    return await page.screenshot({ clip: box });
  } finally {
    await hide.evaluate((tag) => tag.remove());
  }
}

/** The settings menu under the top bar's Settings button (issue #332), opened if it is closed. */
export async function openSettings(page: Page): Promise<Locator> {
  const menu = page.getByRole("region", { name: "Settings", exact: true });
  if (!(await menu.isVisible())) await page.locator("#settings-toggle").click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Presses one of the settings menu's panel buttons, opening the menu first if it is closed. */
export async function settingsButton(page: Page, name: "City" | "Log" | "Debug"): Promise<void> {
  const menu = await openSettings(page);
  await menu.getByRole("button", { name, exact: true }).click();
}
