import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createState, generateTerrain, heightAt, serialize } from "../packages/sim/src/index";
import { SEED, buildRoads, groundAt } from "./road-fixtures";

// Issue M1-08: snapping. A player draws a block of four streets with every
// click up to 10 pixels off where they aim, and gets four nodes and right
// angles. Then a road 3 degrees off square snaps to 90 and shows the
// right-angle marker, the readout shows 96 m as 12 cells, a road ending on a
// street makes a T-junction on it, and each marker is captured.

type Vec3 = [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segFlags: ArrayLike<number>;
}
interface SnapInfo {
  kind: string;
  x: number;
  z: number;
  square: boolean;
  angle: number | null;
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
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const terrain = generateTerrain(SEED);

/** An empty city on the fixture seed, as a city file. */
function emptyCity(): Buffer {
  return Buffer.from(serialize(createState(SEED)));
}

/** A city with one street west to east, from (4220, 4600) to (4524, 4600), as a city file. */
function streetCity(): Buffer {
  const state = createState(SEED);
  buildRoads(state, [[[4220, 4600], [4524, 4600], "street"]]);
  return Buffer.from(serialize(state));
}

async function openCity(page: Page, bytes: Buffer = emptyCity()): Promise<void> {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({
    name: "Snapping.city",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
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

/** Moves the pointer to ground point (x, z), `off` CSS pixels away on screen, and returns where it snapped. */
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

/** Metres a CSS pixel covers at ground point (x, z), east and south. */
async function metresPerPixel(page: Page, x: number, z: number): Promise<number> {
  const o = await screenAt(page, x, z);
  const e = await screenAt(page, x + 10, z);
  const s = await screenAt(page, x, z + 10);
  return 10 / Math.min(Math.hypot(e.x - o.x, e.y - o.y), Math.hypot(s.x - o.x, s.y - o.y));
}

interface NodeInfo {
  x: number;
  z: number;
  /** Unit directions of the live segments leaving the node. */
  dirs: [number, number][];
}

async function nodes(page: Page): Promise<NodeInfo[]> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) return [];
    const out: NodeInfo[] = [];
    for (let n = 0; n < net.nodeFlags.length; n++) {
      if (((net.nodeFlags[n] ?? 0) & 1) === 0) continue;
      // Not a node on an outside connection's fixed stub (segment flag 2).
      let onStub = false;
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 3) === 3 && (net.segA[s] === n || net.segB[s] === n)) onStub = true;
      }
      if (onStub) continue;
      const x = net.nodeX[n] ?? 0;
      const z = net.nodeZ[n] ?? 0;
      const dirs: [number, number][] = [];
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
        const other = net.segA[s] === n ? net.segB[s] : net.segB[s] === n ? net.segA[s] : -1;
        if (other === undefined || other < 0) continue;
        const dx = (net.nodeX[other] ?? 0) - x;
        const dz = (net.nodeZ[other] ?? 0) - z;
        const len = Math.hypot(dx, dz);
        dirs.push([dx / len, dz / len]);
      }
      out.push({ x, z, dirs });
    }
    return out;
  });
}

function angleBetween(a: [number, number], b: [number, number]): number {
  return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
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
];

test("draws a square block with clicks up to 10 pixels off target", async ({ page }, testInfo) => {
  await openCity(page);
  const g = groundAt(4350, 4610);
  await setPose(page, [4350, g + 170, 4740], [4350, g, 4610]);
  // Close enough that 10 px is well under half a cell, as a player zooms in to place a block.
  expect(await metresPerPixel(page, 4350, 4610)).toBeLessThan(0.45);
  await page.keyboard.press("KeyB");
  await page.keyboard.press("KeyZ");
  for (const id of ["angle", "length"]) await expect(page.locator(`#guide-${id}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#guide-grid")).toHaveAttribute("aria-pressed", "false");

  const SIDE = 96;
  // The first corner is open ground; wherever the click lands is the corner.
  const first = await click(page, 4302, 4562, MISS[0]);
  if (!first) throw new Error("no snap at the first click");
  // The tool rounds the start to the sim's build grid, an eighth of a metre.
  const a = { x: Math.round(first.x * 8) / 8, z: Math.round(first.z * 8) / 8 };
  // The second, 96 m east as the player aims it. Length snap makes it exactly 96.
  const b = await click(page, a.x + SIDE, a.z, MISS[1]);
  expect(b?.kind).toBe("none");
  await expect.poll(() => logLength(page)).toBe(1);
  if (!b) throw new Error("no snap at the second click");
  expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(SIDE, 6);
  // The sim rounds the corners to its build grid too; work from where they are.
  // The third, aimed square off the first street.
  const ux = (b.x - a.x) / SIDE;
  const uz = (b.z - a.z) / SIDE;
  await click(page, b.x, b.z, MISS[2]);
  const c = await click(page, b.x - uz * SIDE, b.z + ux * SIDE, MISS[3]);
  expect(c?.kind).toBe("angle");
  expect(c?.square).toBe(true);
  await expect.poll(() => logLength(page)).toBe(2);
  if (!c) throw new Error("no snap at the third click");
  // The fourth, square off the second street, back toward the first corner's side.
  await click(page, c.x, c.z, MISS[4]);
  const d = await click(page, c.x - ux * SIDE, c.z - uz * SIDE, MISS[0]);
  expect(d?.kind).toBe("angle");
  await expect.poll(() => logLength(page)).toBe(3);
  if (!d) throw new Error("no snap at the fourth click");
  // Close the block on the first corner's node.
  await click(page, d.x, d.z, MISS[1]);
  const close = await click(page, a.x, a.z, MISS[2]);
  expect(close?.kind).toBe("node");
  await expect.poll(() => logLength(page)).toBe(4);

  // Four nodes, each with two streets at a right angle.
  await expect.poll(async () => (await nodes(page)).length).toBe(4);
  const found = await nodes(page);
  for (const n of found) {
    expect(n.dirs).toHaveLength(2);
    const [p, q] = n.dirs;
    if (!p || !q) throw new Error("a corner without two streets");
    expect(Math.abs(angleBetween(p, q) - 90)).toBeLessThan(0.2);
  }
  await page.mouse.move(40, 120);
  await frames(page);
  await attach(page, testInfo, "a block of four streets with right angles");
});

/** Opens the one-street city over its east end, with the road tool on. Returns the east end. */
async function overStreet(page: Page): Promise<NodeInfo> {
  await openCity(page, streetCity());
  const g = groundAt(4400, 4640);
  await setPose(page, [4400, g + 380, 4920], [4400, g, 4640]);
  // At this zoom 3 degrees off at 99 m, about 5 m, is inside the 14 px reach of a 90 degree snap.
  expect(14 * (await metresPerPixel(page, 4524, 4650))).toBeGreaterThan(5.5);
  await page.locator("#road-tool").click();
  const end = (await nodes(page)).find((n) => n.x > 4500);
  if (!end) throw new Error("no east end");
  return end;
}

test("a road 3 degrees off square snaps to 90 with its markers and readout, and the guides switch off", async ({ page }, testInfo) => {
  const end = await overStreet(page);

  // From the east end, a road 3 degrees off square: it snaps to 90 and shows the right-angle marker.
  await click(page, end.x, end.z, [4, 3]);
  const off3 = { x: end.x + Math.sin((3 * Math.PI) / 180) * 99, z: end.z + Math.cos((3 * Math.PI) / 180) * 99 };
  const square = await hover(page, off3.x, off3.z);
  expect(square?.kind).toBe("angle");
  const readout = page.locator("#road-readout");
  await expect(readout).toHaveAttribute("data-square", "true");
  await expect(readout).toHaveAttribute("data-snap", "angle");
  expect(Number(await readout.getAttribute("data-angle"))).toBeCloseTo(90, 6);
  await expect(page.locator("#road-angle")).toContainText("90° to the road, square");
  // The readout shows 96 m as 12 cells.
  await expect(readout).toHaveAttribute("data-length", "96");
  await expect(readout).toContainText("96 m");
  await expect(page.locator("#road-cells")).toHaveText("12 cells");
  await attach(page, testInfo, "angle guide line and right-angle marker, 96 m as 12 cells");

  // The same road with the angle toggle off keeps its 3 degrees.
  await page.locator("#guide-angle").click();
  await expect(page.locator("#guide-angle")).toHaveAttribute("aria-pressed", "false");
  const free = await hover(page, off3.x, off3.z);
  expect(free?.kind).toBe("none");
  await expect(readout).toHaveAttribute("data-square", "false");
  expect(Math.abs(Number(await readout.getAttribute("data-angle")) - 90)).toBeCloseTo(3, 0);
  await page.locator("#guide-angle").click();

  // Holding Alt suspends the guides for a free-hand segment.
  await page.keyboard.down("Alt");
  const alt = await hover(page, off3.x, off3.z, [1, 0]);
  expect(alt?.kind).toBe("none");
  await expect(readout).toHaveAttribute("data-square", "false");
  await page.keyboard.up("Alt");
  expect((await hover(page, off3.x, off3.z))?.kind).toBe("angle");
  await page.keyboard.press("Escape");
});

test("node, segment and grid snaps show their markers, and a segment snap makes a T-junction", async ({ page }, testInfo) => {
  const end = await overStreet(page);

  // Node marker: the cursor near the east end, before a road starts.
  expect((await hover(page, end.x, end.z, [9, -5]))?.kind).toBe("node");
  await expect(page.locator("body")).toHaveAttribute("data-snap", "node");
  await attach(page, testInfo, "node marker");

  // A road from open ground north of the street, ending on it near square: a T-junction on the street.
  const tx = 4372.6;
  await click(page, tx, 4480);
  const seg = await hover(page, tx + 3, 4600, [6, 4]);
  expect(seg?.kind).toBe("segment");
  await attach(page, testInfo, "segment marker meeting the street square");
  await click(page, tx + 3, 4600, [6, 4]);
  await expect.poll(() => logLength(page)).toBe(2);
  const t = (await nodes(page)).find((n) => n.dirs.length === 3);
  expect(t).toBeDefined();
  expect(t?.z).toBe(4600);
  // No node a few centimetres off the street.
  for (const n of await nodes(page)) {
    const dz = Math.abs(n.z - 4600);
    expect(dz === 0 || dz > 1).toBe(true);
  }

  // A point on a segment, before a road starts.
  const onSeg = await hover(page, 4290, 4600, [3, 7]);
  expect(onSeg?.kind).toBe("segment");
  await expect(page.locator("body")).toHaveAttribute("data-snap", "segment");
  await attach(page, testInfo, "point on a segment marker");

  // The terrain grid, off by default, snaps to 16 m when on.
  expect((await hover(page, 4421, 4705))?.kind).toBe("none");
  await page.locator("#guide-grid").click();
  const grid = await hover(page, 4421, 4705);
  expect(grid?.kind).toBe("grid");
  expect([(grid?.x ?? 0) % 16, (grid?.z ?? 0) % 16]).toEqual([0, 0]);
  await attach(page, testInfo, "terrain grid marker");
});
