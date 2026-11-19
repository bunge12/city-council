// One way for a spec to wait until the view has built what the camera sees
// (issue #223). The page builds chunks of buildings, cells and decoration a
// few each frame, within a budget, and a frame in software WebGL on a CI
// runner takes most of a second, so waiting for the budget to get there
// took hundreds of frames on the scale town. A page opened with `?flush`
// has `view.flush()`, which builds every pending chunk at once, ends every
// building fade and draws once. The canvas says when every build queue is
// empty with `data-render-settled`.
//
// building-lod.spec.ts keeps one test that fills a scene through the
// per-frame budget, the path players get.

import type { Page } from "@playwright/test";

declare const window: { cityCouncil: { view: Promise<{ flush?: () => void }> } };
declare const document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };

/** `url` with the `flush` switch added to its query, so the page has `view.flush()`. */
export function withFlush(url: string): string {
  const [path, query = ""] = url.split("?", 2) as [string, string?];
  const rest = query.split("&").filter((p) => p !== "" && p !== "flush");
  return `${path}?${["flush", ...rest].join("&")}`;
}

/**
 * Builds everything pending now and waits until the canvas says every build
 * queue is empty. If a delta from the sim lands after a flush and marks
 * chunks again, it flushes again: it polls rather than counting frames.
 * Usually the first flush settles it, in one drawn frame.
 * The page must be opened with `withFlush`.
 */
export async function settleView(page: Page, timeout = 120_000): Promise<void> {
  // One round trip: in software WebGL the page answers between frames of a
  // second or more each, and a `waitForFunction` costs several.
  const settled = await page.evaluate(async (timeout) => {
    const view = await window.cityCouncil.view;
    if (!view.flush) throw new Error("the page has no view.flush(): open it with withFlush(url)");
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
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForFunction(() => document.querySelector("#view")?.getAttribute("data-render-settled") === "true", null, { timeout });
}

declare function requestAnimationFrame(callback: () => void): number;
declare function setTimeout(callback: () => void, ms: number): number;
declare const performance: { now(): number };
