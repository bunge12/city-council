// What most spec files need to open a city and wait for the page, in one
// place, so a fix to one of them reaches every spec (issue #227).

import { expect, type Page } from "@playwright/test";
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

/** Waits until the page has drawn its first frame with terrain. */
export async function ready(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout });
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
 * as an import does but without the import's reload. Only city-file.spec.ts,
 * the M0 walkthrough and one step of homes.spec.ts still import through
 * `#import-file`, since there the import is what is tested. Returns the
 * render backend.
 */
export async function openCity(page: Page, city: SimState | Uint8Array, options: OpenCityOptions = {}): Promise<string> {
  const { query = "webgl", name = "Fixture", presetSettled = false, notes = false, timeout = 60_000 } = options;
  const bytes = city instanceof Uint8Array ? city : serialize(city);
  // Relative to the page, so it works under a base path such as GitHub Pages'.
  const address = `e2e-fixture/${++served}/${encodeURIComponent(name)}.city`;
  await page.route(`**/${address}`, (route) => route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" }), { times: 1 });
  const flags = query.replace(/^\/?\??/, "");
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
