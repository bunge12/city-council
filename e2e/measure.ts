// Measuring a page for the scale checks (scale.spec.ts, building-lod.spec.ts):
// the time between animation frames, and the tab's JS heap.

import type { Page } from "@playwright/test";

declare const performance: { now(): number };
declare function requestAnimationFrame(callback: () => void): number;

/** Mean time between `frames` animation frames, in ms. */
export async function frameTime(page: Page, frames: number): Promise<number> {
  return page.evaluate(async (frames) => {
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      let last = -1;
      const tick = (now: number) => {
        if (last >= 0) times.push(now - last);
        last = now;
        if (times.length < frames) requestAnimationFrame(() => tick(performance.now()));
        else resolve();
      };
      requestAnimationFrame(() => tick(performance.now()));
    });
    return times.reduce((a, b) => a + b, 0) / times.length;
  }, frames);
}

export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * The tab's JS heap after a full collection: the page's and the sim
 * worker's, each read through the DevTools protocol. The worker is reached
 * by auto-attaching to the page's child targets.
 */
export async function memory(page: Page): Promise<{ pageMb: number; workerMb: number | null }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;

  // Messages to the worker go through the page's session, by session id.
  const workers: string[] = [];
  cdp.on("Target.attachedToTarget", (e) => {
    if (e.targetInfo.type === "worker") workers.push(e.sessionId);
  });
  const replies = new Map<number, (result: Record<string, unknown>) => void>();
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    const message = JSON.parse(e.message) as { id?: number; result?: Record<string, unknown> };
    if (message.id !== undefined) replies.get(message.id)?.(message.result ?? {});
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  let id = 0;
  const ask = (sessionId: string, method: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const n = ++id;
      replies.set(n, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
      void cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method }) });
    });
  let worker: number | null = null;
  for (const sessionId of workers) {
    try {
      await ask(sessionId, "HeapProfiler.collectGarbage");
      const usage = await ask(sessionId, "Runtime.getHeapUsage");
      worker = (worker ?? 0) + Number(usage["usedSize"] ?? 0);
    } catch {
      // A worker that does not answer is left out; the report says null.
    }
  }
  await cdp.detach();
  return { pageMb: mb(used), workerMb: worker === null ? null : mb(worker) };
}
