import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-10: curved and continuous drawing modes. A curved avenue drawn
// from open ground ends on an existing node, a curved street leaves the end
// of a road in line with it, a three-segment road is drawn in continuous
// mode and ended with a double click, a continuous road stops at a segment
// the sim refuses, and switching mode or tool part way through a road leaves
// nothing behind.

type Vec3 = [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segCX: ArrayLike<number>;
  segCZ: ArrayLike<number>;
  segFlags: ArrayLike<number>;
}
interface SnapInfo {
  kind: string;
  x: number;
  z: number;
}
declare const window: {
  cityCouncil: {
    mirror: { state: { log: { type: string; playerId: string }[]; roads: Net } | null };
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      snap(): SnapInfo | null;
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);

/** The street every test but the continuous one starts from: west to east, (4220, 4600) to (4524, 4600). */
const STREET = { ax: 4220, bx: 4524, z: 4600 };

function city(withStreet: boolean): Buffer {
  const state = createState(SEED);
  if (withStreet) buildRoads(state, [[[STREET.ax, STREET.z], [STREET.bx, STREET.z], "street"]]);
  return Buffer.from(serialize(state));
}

async function openCity(page: Page, bytes: Buffer): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Modes.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function look(page: Page, x: number, z: number, height: number): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * 0.75],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = heightAt(terrain, x, z);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

async function hover(page: Page, x: number, z: number): Promise<SnapInfo | null> {
  const p = await screenAt(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page);
  return page.evaluate(async () => (await window.cityCouncil.camera).snap());
}

async function click(page: Page, x: number, z: number): Promise<SnapInfo | null> {
  const snap = await hover(page, x, z);
  const p = await screenAt(page, x, z);
  await page.mouse.click(p.x, p.y);
  await frames(page);
  return snap;
}

async function logLength(page: Page): Promise<number> {
  return page.evaluate(() => window.cityCouncil.mirror.state?.log.length ?? 0);
}

interface SegInfo {
  a: [number, number];
  b: [number, number];
  c: [number, number];
}

async function segments(page: Page): Promise<SegInfo[]> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) return [];
    const out: SegInfo[] = [];
    for (let s = 0; s < net.segFlags.length; s++) {
      if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      out.push({
        a: [net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0],
        b: [net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0],
        c: [net.segCX[s] ?? 0, net.segCZ[s] ?? 0],
      });
    }
    return out;
  });
}

async function liveNodes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const flags = window.cityCouncil.mirror.state?.roads.nodeFlags;
    let n = 0;
    for (let i = 0; i < (flags?.length ?? 0); i++) if (((flags?.[i] ?? 0) & 1) !== 0) n++;
    return n;
  });
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, await page.screenshot());
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Unit tangent of a segment leaving the point `at`, one of its ends. */
function tangentFrom(seg: SegInfo, at: [number, number]): [number, number] {
  const fromA = Math.hypot(seg.a[0] - at[0], seg.a[1] - at[1]) < 1e-6;
  const end = fromA ? seg.a : seg.b;
  const dx = seg.c[0] - end[0];
  const dz = seg.c[1] - end[1];
  const len = Math.hypot(dx, dz);
  return [dx / len, dz / len];
}

const hint = (page: Page) => page.locator("#road-hint");

test("a curved avenue ends on an existing node, with the preview following the curve", async ({ page }, testInfo) => {
  await openCity(page, city(true));
  await look(page, 4420, 4700, 330);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyX");
  await page.keyboard.press("KeyY");
  await expect(page.locator("#draw-mode-curved")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toContainText("Click on the map to start a road.");

  await click(page, 4300, 4800);
  await expect(hint(page)).toContainText("set the direction");
  // No road yet: only a line shows the direction.
  await hover(page, 4524, 4800);
  await expect(page.locator("#road-readout")).toBeHidden();
  await attach(page, testInfo, "curved 1 direction line");
  await click(page, 4524, 4800);
  await expect(hint(page)).toContainText("Click to end the curve");

  // The end catches the street's east end.
  const end = await hover(page, 4522, 4603);
  expect(end).toMatchObject({ kind: "node", x: STREET.bx, z: STREET.z });
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-ok", "true");
  await expect(readout).toHaveAttribute("data-type", "avenue");
  // Length and cost follow the curve: longer than the chord, priced on it.
  const length = Number(await readout.getAttribute("data-length"));
  const chord = Math.hypot(STREET.bx - 4300, STREET.z - 4800);
  expect(length).toBeGreaterThan(chord + 20);
  expect(Number(await readout.getAttribute("data-cost"))).toBeGreaterThan(0);
  await attach(page, testInfo, "curved 2 preview ending on a node");

  await click(page, 4522, 4603);
  await expect.poll(() => logLength(page)).toBe(2);
  const avenue = (await segments(page)).find((s) => s.c[0] !== (s.a[0] + s.b[0]) / 2 || s.c[1] !== (s.a[1] + s.b[1]) / 2);
  if (!avenue) throw new Error("no curved segment");
  expect([avenue.a, avenue.b]).toContainEqual([STREET.bx, STREET.z]);
  // Still two nodes for the street and one more for the avenue's start.
  expect(await liveNodes(page)).toBe(3);
  await page.mouse.move(20, 400);
  await frames(page);
  await attach(page, testInfo, "curved 3 avenue built");
});

test("a curve from the end of a road leaves in line with it, with no kink at the join", async ({ page }, testInfo) => {
  await openCity(page, city(true));
  await look(page, 4180, 4560, 160);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyY");
  // From the street's west end, the direction is held in line with the street.
  await click(page, STREET.ax, STREET.z);
  const held = await hover(page, 4150, 4570);
  expect(held?.kind).toBe("tangent");
  expect(held?.z).toBeCloseTo(STREET.z, 6);
  expect(held?.x ?? 0).toBeLessThan(STREET.ax);
  await attach(page, testInfo, "tangent 1 direction held in line");
  await click(page, 4150, 4570);
  await click(page, 4110, 4500);
  await expect.poll(() => logLength(page)).toBe(2);
  const segs = await segments(page);
  expect(segs).toHaveLength(2);
  const join: [number, number] = [STREET.ax, STREET.z];
  const [s0, s1] = segs as [SegInfo, SegInfo];
  const a = tangentFrom(s0, join);
  const b = tangentFrom(s1, join);
  // Opposite directions out of the node: a straight run through it.
  const kink = 180 - (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
  expect(kink).toBeLessThan(0.2);
  await page.mouse.move(20, 400);
  await look(page, STREET.ax, STREET.z, 60);
  await attach(page, testInfo, "tangent 2 join with no kink");
});

test("continuous mode draws a three-segment road, one log entry per segment, ended by a double click", async ({ page }, testInfo) => {
  await openCity(page, city(false));
  await look(page, 4400, 4640, 300);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyU");
  await expect(page.locator("#draw-mode-continuous")).toHaveAttribute("aria-pressed", "true");
  const corners: [number, number][] = [
    [4240, 4560],
    [4400, 4560],
    [4400, 4720],
    [4520, 4720],
  ];
  const [first, ...rest] = corners as [[number, number], ...[number, number][]];
  await click(page, first[0], first[1]);
  for (const [i, [x, z]] of rest.entries()) {
    if (i === rest.length - 1) {
      await hover(page, x, z);
      await attach(page, testInfo, "continuous 1 third segment preview");
      const p = await screenAt(page, x, z);
      await page.mouse.dblclick(p.x, p.y);
      await frames(page);
    } else {
      await click(page, x, z);
      await expect(hint(page)).toContainText("start the next");
    }
    await expect.poll(() => logLength(page)).toBe(i + 1);
  }
  // The double click ended the road.
  await expect(hint(page)).toContainText("Click on the map to start a road.");
  await expect(page.locator("#road-note")).toBeHidden();
  const log = await page.evaluate(() => window.cityCouncil.mirror.state?.log.map((e) => [e.type, e.playerId]) ?? []);
  expect(log).toHaveLength(3);
  for (const [type, player] of log) {
    expect(type).toBe("BuildRoad");
    expect(player).toBeTruthy();
  }
  expect(await segments(page)).toHaveLength(3);
  expect(await liveNodes(page)).toBe(4);
  await page.mouse.move(20, 400);
  await frames(page);
  await attach(page, testInfo, "continuous 2 three segments built");
});

test("a continuous road stops at a refused segment and keeps the ones built", async ({ page }, testInfo) => {
  await openCity(page, city(false));
  await look(page, 4320, 4600, 220);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyU");
  await click(page, 4240, 4600);
  await click(page, 4400, 4600);
  await expect.poll(() => logLength(page)).toBe(1);
  // Doubling back at a sharp angle.
  await hover(page, 4240, 4630);
  await expect(page.locator("#road-readout")).toHaveAttribute("data-ok", "false");
  await expect(page.locator("#road-reason")).toContainText("too sharp");
  await attach(page, testInfo, "refused 1 sharp segment in red");
  await click(page, 4240, 4630);
  await expect(page.locator("#road-note")).toContainText("too sharp");
  await expect(hint(page)).toContainText("Click on the map to start a road.");
  expect(await logLength(page)).toBe(1);
  expect(await segments(page)).toHaveLength(1);
});

test("switching mode or tool part way through a road cancels it and leaves nothing behind", async ({ page }) => {
  await openCity(page, city(true));
  await look(page, 4380, 4680, 260);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyY");
  await click(page, 4300, 4760);
  await click(page, 4400, 4700);
  await expect(hint(page)).toContainText("Click to end the curve");
  // Mode switch: the curve goes.
  await page.keyboard.press("KeyT");
  await expect(page.locator("#draw-mode-straight")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toContainText("Click on the map to start a road.");
  await hover(page, 4480, 4760);
  await expect(page.locator("#road-readout")).toBeHidden();
  // Tool switch, part way through a continuous road.
  await page.keyboard.press("KeyU");
  await click(page, 4300, 4760);
  await click(page, 4400, 4760);
  await expect.poll(() => logLength(page)).toBe(2);
  await hover(page, 4400, 4660);
  await expect(page.locator("#road-readout")).toBeVisible();
  await page.locator("#road-tool").click();
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#road-tool").click();
  await hover(page, 4400, 4660);
  await expect(page.locator("#road-readout")).toBeHidden();
  await expect(hint(page)).toContainText("Click on the map to start a road.");
  // Only the street and the one segment clicked before the switch.
  expect(await logLength(page)).toBe(2);
  expect(await segments(page)).toHaveLength(2);
});
