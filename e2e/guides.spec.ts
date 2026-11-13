import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, deserialize, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt, scaleCity } from "./road-fixtures";

// Issue M1-19: guide lines and parallel offset. A player draws a street
// beside an existing one with every click up to 10 pixels off, and it lands
// with 96 m between the road edges. A third street ends in line with a node
// two blocks away. With both toggles off neither guide draws or snaps. In a
// network of 30,000 segments, drawing with the guides on keeps the frame
// time it has with them off.

type Vec3 = [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segFlags: ArrayLike<number>;
}
interface GuideInfo {
  kind: string;
  cells?: number;
}
interface SnapInfo {
  kind: string;
  x: number;
  z: number;
  guides?: GuideInfo[];
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: unknown[]; roads: Net } | null };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      snap(): SnapInfo | null;
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
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);
const STREET_WIDTH = 10;

/** A city with one street west to east, from (4220, 4600) to (4524, 4600), as a city file. */
function streetCity(): Buffer {
  const state = createState(SEED);
  buildRoads(state, [[[4220, 4600], [4524, 4600], "street"]]);
  return Buffer.from(serialize(state));
}

async function openCity(page: Page, bytes: Buffer, name = "Guides"): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number, off: [number, number] = [0, 0]): Promise<SnapInfo | null> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x + off[0], p.y + off[1], { steps: 4 });
  await frames(page);
  return page.evaluate(async () => (await window.cityCouncil.camera).snap());
}

async function click(page: Page, x: number, z: number, off: [number, number] = [0, 0]): Promise<SnapInfo | null> {
  const snap = await hover(page, x, z, off);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x + off[0], p.y + off[1]);
  await frames(page);
  return snap;
}

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

/** Live road nodes. */
async function nodes(page: Page): Promise<{ x: number; z: number }[]> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) return [];
    const out: { x: number; z: number }[] = [];
    for (let n = 0; n < net.nodeFlags.length; n++) {
      if (((net.nodeFlags[n] ?? 0) & 1) === 0) continue;
      // Not a node on an outside connection's fixed stub (segment flag 2).
      let onStub = false;
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 3) === 3 && (net.segA[s] === n || net.segB[s] === n)) onStub = true;
      }
      if (!onStub) out.push({ x: net.nodeX[n] ?? 0, z: net.nodeZ[n] ?? 0 });
    }
    return out;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Pixel offsets about 10 px long, in different directions, for clicks that miss. */
const MISS: [number, number][] = [
  [7, -7],
  [-6, 8],
  [9, 4],
  [-8, -6],
  [5, 8],
  [-9, 4],
];

/** Opens the one-street city from above, with the road tool on and a street picked. */
async function overStreet(page: Page): Promise<void> {
  await openCity(page, streetCity());
  const g = groundAt(4372, 4730);
  await setPose(page, [4372, g + 470, 4730 + 150], [4372, g, 4730]);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyZ");
  for (const id of ["lines", "offset"]) await expect(page.locator(`#guide-${id}`)).toHaveAttribute("aria-pressed", "true");
}

test("a street beside another lands 96 m edge to edge, and a third lines up with a node two blocks away", async ({ page }, testInfo) => {
  await overStreet(page);
  const log0 = await logLength(page);

  // The second street: both clicks about 10 px off the line twelve cells south of the first.
  const OFFSET_Z = 4600 + 96 + STREET_WIDTH;
  const startSnap = await hover(page, 4250, OFFSET_Z, MISS[0]);
  expect(startSnap?.kind).toBe("offset");
  expect(startSnap?.guides?.[0]?.cells).toBe(12);
  // Before the first click the readout gives the gap.
  await expect(page.locator("#road-offset")).toHaveText("12 cells beside the road, edge to edge");
  await attach(page, testInfo, "parallel offset at 12 cells, before the first click");
  await click(page, 4250, OFFSET_Z, MISS[0]);
  // The end, aimed at the line square to the first street's east end: the offset and that line cross there.
  const end = await hover(page, 4524, OFFSET_Z, MISS[1]);
  expect(end?.kind).toBe("crossing");
  expect(end?.guides?.map((g) => g.kind).sort()).toEqual(["line", "offset"]);
  await expect(page.locator("#road-offset")).toContainText("12 cells");
  await attach(page, testInfo, "parallel offset crossing a guide line");
  await click(page, 4524, OFFSET_Z, MISS[1]);
  await expect.poll(() => logLength(page)).toBe(log0 + 1);

  const second = (await nodes(page)).filter((n) => n.z > 4650);
  expect(second).toHaveLength(2);
  for (const n of second) {
    expect(n.z).toBe(OFFSET_Z);
    // Between the road edges: the centre distance less half of each street.
    expect(n.z - 4600 - STREET_WIDTH).toBe(96);
  }
  expect(second.map((n) => n.x).sort()).toContain(4524);

  // The third street, twelve cells beyond the second, west to the line square to the first street's west end.
  const THIRD_Z = OFFSET_Z + 96 + STREET_WIDTH;
  await click(page, 4480, THIRD_Z, MISS[2]);
  const lined = await hover(page, 4220, THIRD_Z, MISS[3]);
  expect(lined?.kind).toBe("crossing");
  await attach(page, testInfo, "guide line from a node two blocks away");
  await click(page, 4220, THIRD_Z, MISS[3]);
  await expect.poll(() => logLength(page)).toBe(log0 + 2);
  const third = (await nodes(page)).filter((n) => n.z > OFFSET_Z + 50);
  expect(third).toHaveLength(2);
  for (const n of third) expect(n.z).toBe(THIRD_Z);
  // Its end in line with the first street's west end, two blocks north.
  expect(third.map((n) => n.x)).toContain(4220);
  expect(await nodes(page)).toContainEqual({ x: 4220, z: 4600 });

  // A guide line on its own: from open ground, the cursor 4 px off the line square to the second street's west end.
  await click(page, 4400, 4745);
  // At z = 4740 the cursor is clear of every offset from the three streets.
  // The second street's west end is wherever its first click landed along the offset.
  const west = Math.min(...second.map((n) => n.x));
  const line = await hover(page, west, 4740, [4, 0]);
  expect(line?.kind).toBe("line");
  expect(line?.x).toBeCloseTo(west, 6);
  await attach(page, testInfo, "guide line square to a road end");
  await page.keyboard.press("Escape");
});

test("with both toggles off, neither guide draws or snaps", async ({ page }, testInfo) => {
  await overStreet(page);
  const OFFSET_Z = 4600 + 96 + STREET_WIDTH;
  await page.locator("#guide-lines").click();
  await page.locator("#guide-offset").click();
  for (const id of ["lines", "offset"]) await expect(page.locator(`#guide-${id}`)).toHaveAttribute("aria-pressed", "false");

  const start = await hover(page, 4300, OFFSET_Z, MISS[0]);
  expect(start?.kind).toBe("none");
  expect(start?.guides).toBeUndefined();
  await expect(page.locator("#road-offset")).toHaveCount(0);
  await click(page, 4300, OFFSET_Z, MISS[0]);
  // Square off nothing, at the crossing that caught before: nothing catches, and no guide is drawn.
  const end = await hover(page, 4524, OFFSET_Z, MISS[1]);
  expect(["none"]).toContain(end?.kind);
  expect(end?.guides).toBeUndefined();
  await expect(page.locator("#road-offset")).toHaveCount(0);
  await attach(page, testInfo, "guides off: no line, no offset");

  // On again, the same pointer catches.
  await page.locator("#guide-lines").click();
  await page.locator("#guide-offset").click();
  expect((await hover(page, 4524, OFFSET_Z, MISS[1]))?.kind).toBe("crossing");
  // And the free-hand key suspends them.
  await page.keyboard.down("Alt");
  expect((await hover(page, 4524, OFFSET_Z, [-5, 9]))?.kind).toBe("none");
  await page.keyboard.up("Alt");
  await page.keyboard.press("Escape");
});

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
  test.setTimeout(300_000);
  const bytes = scaleCity(30_000);
  const at = busySpot(bytes, 150);
  await openCity(page, bytes, "Thirty thousand");
  const g = groundAt(at.x, at.z);
  await setPose(page, [at.x, g + 380, at.z + 170], [at.x, g, at.z]);
  await page.keyboard.press("KeyB");
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
  // A machine with a GPU draws both at the display's rate; a CI runner draws
  // in software, and there the guides may add a little to the frame, not more.
  expect(mean(on)).toBeLessThan(Math.max(1000 / 55, mean(off) * 1.15 + 2));
  await page.keyboard.press("Escape");
});
