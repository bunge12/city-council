import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { deserialize, generateTerrain, heightAt } from "../packages/sim/src/index";
import { frames, openCity } from "./helpers";
import { perfFigures } from "./measure";
import { SEED, groundAt, scaleCity } from "./road-fixtures";

// Issue M1-19 at scale: drawing in a network of 30,000 segments with the
// guides on, against the same with them off. In the perf project (issue
// #225), which reports and does not gate a merge: on CI runners, which draw
// in software, the bound below failed a merge four times in three days on
// slow machines. The guides themselves are guides.spec.ts.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  getElementById(id: string): { dispatchEvent(e: unknown): boolean } | null;
};
declare function requestAnimationFrame(callback: (now: number) => void): number;
declare const PointerEvent: new (type: string, init: Record<string, unknown>) => unknown;

test.use({ viewport: { width: 1280, height: 800 } });

const terrain = generateTerrain(SEED);

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/**
 * A busy spot in a city: the centre of the 260 m square whose node count is
 * nearest `target`. The fixture's very densest square piles thousands of
 * nodes into one blob no player would build, and drawing it at street zoom
 * is the renderer's problem, not the guides'.
 */
function busySpot(bytes: Buffer, target: number): { x: number; z: number; nodes: number } {
  const net = deserialize(new Uint8Array(bytes)).state.roads;
  const size = 260;
  const counts = new Map<string, number>();
  for (let n = 0; n < net.nodeFlags.length; n++) {
    if (((net.nodeFlags[n] ?? 0) & 1) === 0) continue;
    const key = `${Math.floor((net.nodeX[n] ?? 0) / size)},${Math.floor((net.nodeZ[n] ?? 0) / size)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = { key: "", n: 0 };
  for (const [key, n] of [...counts].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
    if (Math.abs(n - target) < Math.abs(best.n - target)) best = { key, n };
  }
  const [i, j] = best.key.split(",").map(Number);
  return { x: ((i ?? 0) + 0.5) * size, z: ((j ?? 0) + 0.5) * size, nodes: best.n };
}

/** Mean frame time in ms over `count` frames while the pointer circles `centre` on screen, one move a frame. */
async function drawingFrameTime(page: Page, centre: { x: number; y: number }, count: number): Promise<number> {
  return page.evaluate(
    async ([cx, cy, count]) => {
      const canvas = document.getElementById("view");
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let last = -1;
        let k = 0;
        const tick = (now: number) => {
          if (last >= 0) times.push(now - last);
          last = now;
          const a = (k++ / 30) * Math.PI * 2;
          canvas?.dispatchEvent(
            new PointerEvent("pointermove", { clientX: cx + Math.cos(a) * 120, clientY: cy + Math.sin(a) * 80, pointerId: 1, pointerType: "mouse", bubbles: true }),
          );
          if (times.length < count) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return times.reduce((a, b) => a + b, 0) / times.length;
    },
    [centre.x, centre.y, count] as const,
  );
}

test("drawing in a network of 30,000 segments keeps its frame time with the guides on", async ({ page }, testInfo) => {
  // 3.1 minutes on a CI runner that draws a frame here in 0.7 s; one that
  // takes 1.2 s ran past five minutes (issue #152).
  test.setTimeout(480_000);
  const bytes = scaleCity(30_000);
  const at = busySpot(bytes, 150);
  await openCity(page, bytes, { name: "Thirty thousand" });
  const g = groundAt(at.x, at.z);
  await setPose(page, [at.x, g + 380, at.z + 170], [at.x, g, at.z]);
  await page.keyboard.press("KeyR");
  // Free-hand, so the start lands where clicked, on open ground or a road.
  await page.keyboard.down("Alt");
  const centre = await screenAt(page, at.x, at.z);
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.up("Alt");
  await frames(page);

  const toggle = async () => {
    await page.locator("#guide-lines").click();
    await page.locator("#guide-offset").click();
  };
  const FRAMES = 30;
  // Alternate, guides on then off, to spread the machine's noise over both.
  const on: number[] = [];
  const off: number[] = [];
  for (let round = 0; round < 2; round++) {
    on.push(await drawingFrameTime(page, centre, FRAMES));
    await toggle();
    off.push(await drawingFrameTime(page, centre, FRAMES));
    await toggle();
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const report = { at, onFrameMs: mean(on), offFrameMs: mean(off), on, off };
  console.log(`30,000 segments, drawing: ${JSON.stringify(report)}`);
  await testInfo.attach("frame times", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  await attach(page, testInfo, "drawing in 30,000 segments");
  perfFigures("guides-scale", "drawing in 30,000 segments, street band, WebGL 2", { "guides on (ms)": report.onFrameMs, "guides off (ms)": report.offFrameMs });
  // A machine with a GPU draws both at the display's rate; a CI runner draws
  // in software, and there the guides may add a little to the frame, not more.
  expect(mean(on)).toBeLessThan(Math.max(1000 / 55, mean(off) * 1.15 + 2));
  await page.keyboard.press("Escape");
});
