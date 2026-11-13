import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  ROAD_TYPES,
  createState,
  deserialize,
  generateTerrain,
  hashState,
  heightAt,
  reachesOutside,
  replay,
  serialize,
} from "../packages/sim/src/index";
import { formatMoneyShort } from "../packages/client/src/ui/format";
import { SEED, groundAt } from "./road-fixtures";

// The M1 exit test from docs/milestones/M1.md (issue M1-17), as one
// walkthrough a player could do by hand, run once on WebGPU (when the
// browser has an adapter) and once on the `?webgl` fallback. It runs in the
// `walkthrough` project, against the production build or, with BASE_URL,
// the public address.
//
// It starts from an empty city on the fixture seed, imported as a city
// file, so every run draws on the same ground: the flat dry square from
// (4100, 4400) to (4700, 5000), the inlet at (3488 to 3600, 6600) and the
// slope west of the square. Every step goes through the page's own
// controls. The mirror's read-only copy is read to check what a step did,
// and the replay and the connections are checked in Node on a downloaded
// city file. Screenshots of each step land in
// walkthrough-screenshots/m1-<backend>/ and are attached to the report.

type Vec3 = readonly [number, number, number];
interface Net {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  segA: ArrayLike<number>;
  segB: ArrayLike<number>;
  segCX: ArrayLike<number>;
  segCZ: ArrayLike<number>;
  segFlags: ArrayLike<number>;
  segType: ArrayLike<number>;
  segLevelA: ArrayLike<number>;
}
interface LogEntry {
  tick: number;
  seq: number;
  playerId: string;
  type: string;
  payload: unknown;
}
interface SnapInfo {
  kind: string;
  x: number;
  z: number;
  square?: boolean;
  guides?: { kind: string; cells?: number }[];
}
interface SaveStatus {
  city: { id: string };
  loadedFrom: string;
  loadedTick: number;
}
declare const window: {
  cityCouncil: {
    saves: { status: SaveStatus | null };
    mirror: { state: ({ tick: number; log: LogEntry[]; roads: Net; connections: ArrayLike<number> } & Record<string, unknown>) | null };
    renderStatus(): { backend: string } | null;
    camera: Promise<{
      rig: { setPose(position: Vec3, target: Vec3): void };
      project(x: number, y: number, z: number): { x: number; y: number };
      snap(): SnapInfo | null;
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare const navigator: { gpu?: { requestAdapter(): Promise<unknown> } };
declare function requestAnimationFrame(callback: () => void): number;

const VIEWPORT = { width: 1280, height: 800 };
test.use({ viewport: VIEWPORT });
// Several page loads with the whole map and many redraws, on a machine
// that may have no GPU.
test.setTimeout(600_000);

const SCREENSHOTS = "walkthrough-screenshots";
const terrain = generateTerrain(SEED);
const street = ROAD_TYPES.find((t) => t.id === "street");
const STREET_WIDTH = 10;

/** The first street, west to east across the flat square. */
const A = { x0: 4220, x1: 4524, z: 4600 };
/** The second street, north to south across the first. */
const B = { x: 4350, z0: 4470, z1: 4730 };
/** Seed 2026's inlet: water from x = 3488 to 3600 along z = 6600. */
const RIVER = { x0: 3400, x1: 3700, z: 6600, mid: 3545 };
/** A street up the slope west of the flat square: an 18% grade, over the street's 16% (found with planRoad). */
const STEEP = { x0: 3850, x1: 3930, z: 4700 };
/** The street's slope limit as the refusal reads it, a whole percentage. */
const STREET_SLOPE = `${Math.round((street?.maxSlope ?? 0) * 100)}%`;
/** The street the grid is dragged from, on the inlet's east bank, and the grid's far corner across the water. */
const GRID_STREET = { x: 3840, z0: 6640, z1: 6900 };
const GRID_CORNER = { x: 3440, z: 6890 };
/** Pixel offsets about 10 px long, for clicks that miss, as in the snapping and guides specs. */
const MISS: [number, number][] = [
  [7, -7],
  [-6, 8],
  [9, 4],
  [-8, -6],
];

async function shot(page: Page, info: TestInfo, dir: string, name: string): Promise<void> {
  mkdirSync(join(SCREENSHOTS, dir), { recursive: true });
  const body = await page.screenshot({ path: join(SCREENSHOTS, dir, `${name}.png`) });
  await info.attach(name, { body, contentType: "image/png" });
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator("#sim-tick")).toHaveText(/^\d+$/, { timeout: 60_000 });
  await page.waitForFunction(() => document.body.dataset["saveLoaded"] === "true", null, { timeout: 60_000 });
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  // The import and storage notes would cover the map in the screenshots.
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Looks at (x, z) from `height` metres up and to the south, `back` times as far south as up. */
async function look(page: Page, x: number, z: number, height: number, back = 0.75): Promise<void> {
  const g = groundAt(x, z);
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * back],
      [x, g, z],
    ] as const,
  );
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  const y = Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, y, z] as const);
}

/** Moves the pointer to ground point (x, z), `off` CSS pixels away on screen, and returns where it snapped. */
async function hover(page: Page, x: number, z: number, off: [number, number] = [0, 0]): Promise<SnapInfo | null> {
  const p = await screenAt(page, x, z);
  // A panel over the point would take the pointer off the map, and the tool
  // would see nothing. Say which one rather than fail later on the readout.
  const over = await page.evaluate(([px, py]) => {
    const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { id: string; tagName: string; closest(s: string): { id: string } | null } | null } }).document.elementFromPoint(px, py);
    if (!el || el.id === "view") return null;
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} in ${el.closest("[id]")?.id ?? "the page"}`;
  }, [p.x + off[0], p.y + off[1]] as const);
  expect(over, `ground point (${x}, ${z}) is under a panel at (${Math.round(p.x)}, ${Math.round(p.y)})`).toBeNull();
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

/** Drags from one ground point to another with the left button. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await screenAt(page, from[0], from[1]);
  const b = await screenAt(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await frames(page);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 30 });
  await frames(page);
  await page.mouse.up();
  await frames(page);
}

/** Moves the pointer off the map so no preview shows in a screenshot. */
async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page);
}

async function log(page: Page): Promise<LogEntry[]> {
  return (await page.evaluate(() => window.cityCouncil.mirror.state?.log)) ?? [];
}

async function logTypes(page: Page): Promise<string[]> {
  return (await log(page)).map((e) => e.type);
}

/** Every road array of the mirror's copy, as plain lists, to compare whole networks. */
async function roads(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return Object.fromEntries(Object.entries(net).map(([k, a]) => [k, Array.from(a as ArrayLike<number>)]));
  });
}

interface Seg {
  id: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cx: number;
  cz: number;
  type: number;
  level: number;
  fixed: boolean;
}

/** The live segments of a network read with `roads`. */
function segments(net: Record<string, number[]>): Seg[] {
  const out: Seg[] = [];
  const flags = net["segFlags"] ?? [];
  for (let s = 0; s < flags.length; s++) {
    const f = flags[s] ?? 0;
    if ((f & 1) === 0) continue;
    const a = net["segA"]?.[s] ?? 0;
    const b = net["segB"]?.[s] ?? 0;
    out.push({
      id: s,
      ax: net["nodeX"]?.[a] ?? 0,
      az: net["nodeZ"]?.[a] ?? 0,
      bx: net["nodeX"]?.[b] ?? 0,
      bz: net["nodeZ"]?.[b] ?? 0,
      cx: net["segCX"]?.[s] ?? 0,
      cz: net["segCZ"]?.[s] ?? 0,
      type: net["segType"]?.[s] ?? 0,
      level: net["segLevelA"]?.[s] ?? 0,
      fixed: (f & 2) !== 0,
    });
  }
  return out;
}

/** The live segment whose middle is nearest (x, z), within 5 m, or null. */
function segmentNear(net: Record<string, number[]>, x: number, z: number): Seg | null {
  let best: Seg | null = null;
  let bestD = 5;
  for (const s of segments(net)) {
    const d = Math.hypot((s.ax + s.bx + 2 * s.cx) / 4 - x, (s.az + s.bz + 2 * s.cz) / 4 - z);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Live nodes the player built (not on an outside connection's fixed stub), with how many segments meet there. */
function nodes(net: Record<string, number[]>): { x: number; z: number; degree: number }[] {
  const segs = segments(net);
  const stub = new Set<string>();
  for (const s of segs) if (s.fixed) stub.add(`${s.ax},${s.az}`).add(`${s.bx},${s.bz}`);
  const out: { x: number; z: number; degree: number }[] = [];
  const flags = net["nodeFlags"] ?? [];
  for (let n = 0; n < flags.length; n++) {
    if (((flags[n] ?? 0) & 1) === 0) continue;
    const x = net["nodeX"]?.[n] ?? 0;
    const z = net["nodeZ"]?.[n] ?? 0;
    if (stub.has(`${x},${z}`)) continue;
    const degree = segs.filter((s) => (s.ax === x && s.az === z) || (s.bx === x && s.bz === z)).length;
    out.push({ x, z, degree });
  }
  return out;
}

const isCurved = (s: Seg): boolean => s.cx !== (s.ax + s.bx) / 2 || s.cz !== (s.az + s.bz) / 2;

async function status(page: Page): Promise<SaveStatus> {
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

const speedButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

async function setSpeed(page: Page, name: "Pause" | "1x"): Promise<void> {
  await speedButton(page, name).click();
  await expect(speedButton(page, name)).toHaveAttribute("aria-pressed", "true");
}

/** The city menu, opened if it is closed. */
async function cityMenu(page: Page) {
  const menu = page.getByRole("region", { name: "City menu" });
  if (!(await menu.isVisible())) await page.getByRole("button", { name: "City", exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Closes the city menu if it is open, so it does not cover the map. */
async function closeCityMenu(page: Page): Promise<void> {
  const menu = page.getByRole("region", { name: "City menu" });
  if (await menu.isVisible()) await page.getByRole("button", { name: "City", exact: true }).click();
  await expect(menu).toBeHidden();
}

/** Downloads the city with the menu's button and returns the file's bytes. */
async function download(page: Page, info: TestInfo, name: string): Promise<Uint8Array> {
  const menu = await cityMenu(page);
  const [file] = await Promise.all([page.waitForEvent("download"), menu.locator("#download-city").click()]);
  const path = info.outputPath(name, file.suggestedFilename());
  await file.saveAs(path);
  await closeCityMenu(page);
  return new Uint8Array(readFileSync(path));
}

/** Turns the road tool on if it is off, in straight mode, drawing `type`. */
async function roadTool(page: Page, type: "KeyZ" | "KeyX" = "KeyZ"): Promise<void> {
  if ((await page.locator("#road-tool").getAttribute("aria-pressed")) !== "true") await page.keyboard.press("KeyB");
  await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(type);
  await page.keyboard.press("KeyT");
  await expect(page.locator("#draw-mode-straight")).toHaveAttribute("aria-pressed", "true");
}

/** Turns the road tool off: Escape drops a road being drawn, a second leaves the tool. */
async function noTool(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const on = await page.locator("#road-tool, #upgrade-tool, #bulldoze-tool, #grid-tool").evaluateAll((els) =>
      els.some((e) => e.getAttribute("aria-pressed") === "true"),
    );
    if (!on) return;
    await page.keyboard.press("Escape");
    await frames(page);
  }
}

async function debugPanel(page: Page, open: boolean): Promise<void> {
  const panel = page.getByRole("region", { name: "Debug panel" });
  if ((await panel.isVisible()) !== open) await page.keyboard.press("Backquote");
  if (open) await expect(panel).toBeVisible();
  else await expect(panel).toBeHidden();
}

for (const variant of [
  { name: "webgpu", query: "" },
  { name: "webgl", query: "?webgl" },
] as const) {
  test(`M1 walkthrough (${variant.name})`, async ({ page }, info) => {
    if (!street) throw new Error("street is in the balance file");
    const url = `./${variant.query}`;
    const dir = `m1-${variant.name}`;
    const readout = page.locator("#road-readout");
    const rows = page.locator("#activity-log tbody tr");

    // The WebGPU run expects WebGPU only where this browser offers an adapter.
    await page.goto(url);
    const hasWebGpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    const wantBackend = variant.name === "webgpu" && hasWebGpu ? "webgpu" : "webgl2";
    if (variant.name === "webgpu" && !hasWebGpu) {
      info.annotations.push({ type: "backend", description: "no WebGPU adapter in this browser; ran on the WebGL 2 fallback" });
    }
    await ready(page);
    // An empty city on the fixture seed, imported as a city file. The page
    // reloads into it.
    const loaded = page.waitForEvent("load");
    await page.locator("#import-file").setInputFiles({
      name: "M1 walkthrough.city",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(serialize(createState(SEED))),
    });
    await loaded;
    await ready(page);
    expect((await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend).toBe(wantBackend);
    expect(await logTypes(page)).toEqual([]);
    await page.keyboard.press("KeyL");
    await expect(page.locator("#activity-log")).toBeVisible();

    await test.step("1. draw a straight street: it appears on the map and in the log with a player id and a tick", async () => {
      await look(page, 4372, 4600, 330);
      await roadTool(page);
      await click(page, A.x0, A.z);
      await hover(page, A.x1, A.z);
      await expect(readout).toHaveAttribute("data-ok", "true");
      await shot(page, info, dir, "1-street-preview");
      await click(page, A.x1, A.z);
      await expect.poll(async () => (await log(page)).length).toBe(1);
      const entry = (await log(page))[0];
      expect(entry).toMatchObject({ type: "BuildRoad", playerId: "local" });
      expect(entry?.tick).toBeGreaterThan(0);
      await expect(rows.nth(0)).toContainText("BuildRoad");
      await expect(rows.nth(0).locator("td").nth(0)).toHaveText(String(entry?.tick));
      await expect(rows.nth(0).locator("td").nth(1)).toHaveText("local");
      const net = await roads(page);
      const built = segments(net).filter((s) => !s.fixed);
      expect(built).toHaveLength(1);
      expect([built[0]?.ax, built[0]?.az, built[0]?.bx, built[0]?.bz]).toEqual([A.x0, A.z, A.x1, A.z]);
      await away(page);
      await shot(page, info, dir, "1-street-built");
      // The log stays closed from here, so it does not cover the map. Its
      // panel is only hidden, and its rows are still read below.
      await page.keyboard.press("KeyL");
      await expect(page.locator("#activity-log")).toBeHidden();
    });

    await test.step("2. draw a second street across the first: the first splits and a four-way intersection forms", async () => {
      await click(page, B.x, B.z0);
      await hover(page, B.x, B.z1);
      await expect(readout).toContainText("1 junction");
      await click(page, B.x, B.z1);
      await expect.poll(async () => (await log(page)).length).toBe(2);
      const net = await roads(page);
      const four = nodes(net).filter((n) => n.degree === 4);
      expect(four).toEqual([{ x: B.x, z: A.z, degree: 4 }]);
      // The first street is now two segments, meeting at the junction.
      expect(segments(net).filter((s) => !s.fixed && s.az === A.z && s.bz === A.z)).toHaveLength(2);
      await away(page);
      await shot(page, info, dir, "2-four-way");
    });

    await test.step("3. a curved avenue whose end snaps to a node, and a road that snaps to 90 degrees off a segment", async () => {
      // Curved mode: start, direction, end. The end is clicked 3 m off the
      // first street's east end and lands on it.
      await look(page, 4590, 4560, 300);
      await roadTool(page, "KeyX");
      await page.keyboard.press("KeyY");
      await expect(page.locator("#draw-mode-curved")).toHaveAttribute("aria-pressed", "true");
      await click(page, 4660, 4500);
      await click(page, 4660, 4600);
      const end = await hover(page, A.x1 - 2, A.z + 3);
      expect(end).toMatchObject({ kind: "node", x: A.x1, z: A.z });
      await expect(readout).toHaveAttribute("data-ok", "true");
      await expect(readout).toHaveAttribute("data-type", "avenue");
      await shot(page, info, dir, "3-curve-snaps-to-node");
      await click(page, A.x1 - 2, A.z + 3);
      await expect.poll(async () => (await log(page)).length).toBe(3);
      let net = await roads(page);
      const curve = segments(net).find(isCurved);
      if (!curve) throw new Error("no curved segment");
      expect(curve.type).toBe(1);
      expect([
        [curve.ax, curve.az],
        [curve.bx, curve.bz],
      ]).toContainEqual([A.x1, A.z]);

      // Straight again: from the first street's west end, 3 degrees off
      // square, which the angle guide holds at 90. From high enough that
      // the 5 m the pointer is off is inside the guide's 14 pixels.
      await look(page, A.x0, 4550, 330);
      await roadTool(page);
      const s0 = await click(page, A.x0, A.z, [4, 3]);
      expect(s0).toMatchObject({ kind: "node", x: A.x0, z: A.z });
      const off3 = { x: A.x0 + Math.sin((3 * Math.PI) / 180) * 99, z: A.z - Math.cos((3 * Math.PI) / 180) * 99 };
      const square = await hover(page, off3.x, off3.z);
      expect(square?.kind).toBe("angle");
      expect(square?.square).toBe(true);
      await expect(readout).toHaveAttribute("data-square", "true");
      await expect(page.locator("#road-angle")).toContainText("90° to the road, square");
      await shot(page, info, dir, "3-square-off-the-street");
      await click(page, off3.x, off3.z);
      await expect.poll(async () => (await log(page)).length).toBe(4);
      net = await roads(page);
      const spur = segments(net).find((s) => s.ax === A.x0 && s.bx === A.x0 && s.az !== s.bz);
      if (!spur) throw new Error("no square spur");
      expect(Math.min(spur.az, spur.bz)).toBeLessThan(A.z);
      await away(page);
      await shot(page, info, dir, "3-curve-and-square-built");
    });

    await test.step("4. a road across water becomes a bridge; a road up a slope too steep is refused with the reason", async () => {
      await look(page, RIVER.mid, RIVER.z, 260);
      await click(page, RIVER.x0, RIVER.z);
      await hover(page, RIVER.x1, RIVER.z);
      await expect(readout).toHaveAttribute("data-ok", "true");
      await expect(page.locator("#road-bridge")).toContainText(/^Bridge, \d+ m$/);
      await shot(page, info, dir, "4-bridge-preview");
      await click(page, RIVER.x1, RIVER.z);
      await expect.poll(async () => (await log(page)).length).toBe(5);
      const levels = segments(await roads(page))
        .filter((s) => s.az === RIVER.z && s.bz === RIVER.z)
        .sort((p, q) => Math.min(p.ax, p.bx) - Math.min(q.ax, q.bx))
        .map((s) => s.level);
      expect(levels).toEqual([0, 1, 0]);
      await away(page);
      await shot(page, info, dir, "4-bridge-built");

      await look(page, (STEEP.x0 + STEEP.x1) / 2, STEEP.z, 260);
      await click(page, STEEP.x0, STEEP.z);
      await hover(page, STEEP.x1, STEEP.z);
      await expect(readout).toHaveAttribute("data-ok", "false");
      await expect(page.locator("#road-reason")).toHaveText(new RegExp(`^Too steep: a \\d+% grade, and the street limit is ${STREET_SLOPE}$`));
      await shot(page, info, dir, "4-steep-refused");
      await click(page, STEEP.x1, STEEP.z);
      await expect(page.locator("#road-note")).toContainText("Too steep");
      await page.waitForTimeout(500);
      expect((await log(page)).length).toBe(5);
      await page.keyboard.press("Escape");
    });

    await test.step("5. the preview shows the length and the cost before the click; nothing is charged", async () => {
      await look(page, 4372, 4800, 330);
      await click(page, 4200, 4900);
      await hover(page, 4440, 4900);
      await expect(readout).toHaveAttribute("data-ok", "true");
      const length = Number(await readout.getAttribute("data-length"));
      const cost = Number(await readout.getAttribute("data-cost"));
      expect(length).toBeGreaterThan(230);
      expect(cost).toBe(Math.round(length * street.buildCostPerMetre));
      await expect(page.locator("#road-cost")).toHaveText(formatMoneyShort(cost));
      await expect(readout).toContainText(`${length.toFixed(0)} m`);
      await shot(page, info, dir, "5-length-and-cost");
      // There is no treasury in the state to charge, until M4.
      const keys = await page.evaluate(() => Object.keys(window.cityCouncil.mirror.state ?? {}));
      for (const key of keys) expect(key).not.toMatch(/money|treasury|cash|funds|budget/i);
      await page.keyboard.press("Escape");
      await expect(readout).toHaveCount(0);
      expect((await log(page)).length).toBe(5);
      await noTool(page);
    });

    await test.step("6. upgrade a street to an avenue in place, bulldoze a segment, and undo both one step at a time", async () => {
      await look(page, B.x, A.z, 260);
      const before = await roads(page);
      const west = segmentNear(before, (A.x0 + B.x) / 2, A.z);
      const south = segmentNear(before, B.x, (A.z + B.z1) / 2);
      if (!west || !south) throw new Error("segments to edit missing");
      expect(west.type).toBe(0);

      await page.keyboard.press("KeyV");
      await page.keyboard.press("KeyX");
      await expect(page.locator("#upgrade-tool")).toHaveAttribute("aria-pressed", "true");
      await hover(page, (A.x0 + B.x) / 2, A.z);
      await expect(page.locator("#edit-readout")).toHaveAttribute("data-kind", "upgrade");
      await click(page, (A.x0 + B.x) / 2, A.z);
      await expect.poll(async () => segmentNear(await roads(page), (A.x0 + B.x) / 2, A.z)?.type).toBe(1);
      const upgraded = await roads(page);
      // In place: the same id and the same ends.
      expect(segmentNear(upgraded, (A.x0 + B.x) / 2, A.z)?.id).toBe(west.id);
      await away(page);
      await shot(page, info, dir, "6-upgraded");

      await page.keyboard.press("KeyN");
      await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
      await click(page, B.x, (A.z + B.z1) / 2);
      await expect.poll(async () => segmentNear(await roads(page), B.x, (A.z + B.z1) / 2)).toBeNull();
      await away(page);
      await shot(page, info, dir, "6-bulldozed");
      expect((await logTypes(page)).slice(-2)).toEqual(["UpgradeRoad", "BulldozeRoad"]);

      await page.keyboard.press("Control+KeyZ");
      await expect.poll(async () => roads(page)).toEqual(upgraded);
      await shot(page, info, dir, "6-undo-1-bulldoze-back");
      await page.keyboard.press("Control+KeyZ");
      await expect.poll(async () => roads(page)).toEqual(before);
      expect((await logTypes(page)).slice(-4)).toEqual(["UpgradeRoad", "BulldozeRoad", "Undo", "Undo"]);
      await expect(rows.nth(0)).toContainText("Undo");
      await shot(page, info, dir, "6-undo-2-street-again");
      await noTool(page);
    });

    await test.step("7. the route between two points is highlighted; bulldoze the only link and there is no route", async () => {
      await look(page, 4300, 4560, 330);
      await debugPanel(page, true);
      const route = page.locator("#route-readout");
      await page.locator("#route-tool").click();
      await expect(page.locator("#route-tool")).toHaveAttribute("aria-pressed", "true");
      await expect(route).toHaveText("click the start");
      // From the square spur to the second street's north arm: the only way
      // is along the first street's west piece.
      await click(page, A.x0, 4540);
      await expect(route).toHaveText("click the end");
      await click(page, B.x, 4510);
      await expect(route).toHaveAttribute("data-found", "true");
      await expect(route).toHaveText(/^\d+ m, \d+ s, 3 segments$/);
      await away(page);
      await shot(page, info, dir, "7-route");

      const before = await roads(page);
      await page.keyboard.press("KeyN");
      await click(page, (A.x0 + B.x) / 2, A.z);
      await expect.poll(async () => segmentNear(await roads(page), (A.x0 + B.x) / 2, A.z)).toBeNull();
      await expect(route).toHaveText("no route");
      await expect(route).toHaveAttribute("data-found", "false");
      await away(page);
      await shot(page, info, dir, "7-no-route");
      // Put the link back for the steps after.
      await page.keyboard.press("Control+KeyZ");
      await expect.poll(async () => roads(page)).toEqual(before);
      await expect(route).toHaveAttribute("data-found", "true");
      // The bulldozer took the tool's place. Turning the route tool on
      // again clears the points, and Escape with none leaves it.
      await noTool(page);
      await page.locator("#route-tool").click();
      await expect(route).toHaveText("click the start");
      await page.keyboard.press("Escape");
      await expect(page.locator("#route-tool")).toHaveAttribute("aria-pressed", "false");
      await debugPanel(page, false);
    });

    await test.step("8. every outside connection is reachable from a road joined to it", async () => {
      const stubs = await page.evaluate(() => {
        const s = window.cityCouncil.mirror.state;
        if (!s) return [];
        const r = s.roads;
        return Array.from(s.connections, (edge) => ({ ix: r.nodeX[edge + 1] ?? 0, iz: r.nodeZ[edge + 1] ?? 0, x: r.nodeX[edge] ?? 0, z: r.nodeZ[edge] ?? 0 }));
      });
      expect(stubs.length).toBeGreaterThanOrEqual(2);
      const ends: { x: number; z: number }[] = [];
      for (const [i, c] of stubs.entries()) {
        const len = Math.hypot(c.ix - c.x, c.iz - c.z);
        const ux = (c.ix - c.x) / len;
        const uz = (c.iz - c.z) / len;
        const end = { x: Math.round((c.ix + ux * 200) * 8) / 8, z: Math.round((c.iz + uz * 200) * 8) / 8 };
        await look(page, c.ix + ux * 100, c.iz + uz * 100, 330);
        await roadTool(page);
        const start = await click(page, c.ix, c.iz);
        expect(start).toMatchObject({ kind: "node", x: c.ix, z: c.iz });
        const before = (await log(page)).length;
        await click(page, end.x, end.z);
        await expect.poll(async () => (await log(page)).length).toBe(before + 1);
        await away(page);
        await shot(page, info, dir, `8-street-from-connection-${i + 1}`);
        ends.push(end);
      }
      await noTool(page);
      // From each new street's far end, the sim's own search finds a way
      // out of the map, on the city as a downloaded file has it.
      const { state } = deserialize(await download(page, info, "connections"));
      const net = state.roads;
      for (const end of ends) {
        let node = -1;
        for (let n = 0; n < net.nodeFlags.length; n++) {
          if (((net.nodeFlags[n] ?? 0) & 1) !== 0 && Math.hypot((net.nodeX[n] ?? 0) - end.x, (net.nodeZ[n] ?? 0) - end.z) < 0.5) node = n;
        }
        expect(node, `node at ${end.x}, ${end.z}`).toBeGreaterThanOrEqual(0);
        expect(reachesOutside(net, state.connections, node)).toBe(true);
      }
    });

    let saved: { roads: Record<string, number[]>; log: LogEntry[]; tick: number } = { roads: {}, log: [], tick: 0 };
    await test.step("9. reload the page: the same network comes back", async () => {
      await setSpeed(page, "Pause");
      const tick = Number(await page.locator("#sim-tick").textContent());
      const menu = await cityMenu(page);
      await menu.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("#save-status")).toContainText(`tick ${tick} at`);
      await closeCityMenu(page);
      saved = { roads: await roads(page), log: await log(page), tick };
      const id = (await status(page)).city.id;

      await page.reload();
      await ready(page);
      const after = await status(page);
      expect(after.loadedFrom).toBe("latest save");
      expect(after.city.id).toBe(id);
      expect(after.loadedTick).toBe(tick);
      expect(await roads(page)).toEqual(saved.roads);
      expect(await log(page)).toEqual(saved.log);
      // The panels are page state and start closed again.
      await look(page, 4372, 4600, 420);
      await shot(page, info, dir, "9-after-reload");
    });

    await test.step("10. a replay of the recorded command log from the same seed gives the same state hash", async () => {
      const { header, state, pagedLog } = deserialize(await download(page, info, "replay"));
      expect(header.tick).toBe(saved.tick);
      const fullLog = [...pagedLog, ...state.log];
      expect(fullLog.map((e) => e.type)).toEqual(saved.log.map((e) => e.type));
      for (const e of fullLog) expect(e.playerId).toBe("local");
      const rebuilt = replay(header.seed, fullLog, header.tick);
      const hash = hashState(rebuilt);
      expect(hash).toBe(hashState(state));
      info.annotations.push({ type: "replay", description: `seed ${header.seed}, ${fullLog.length} commands, tick ${header.tick}, hash ${hash}` });
      await setSpeed(page, "1x");
    });

    await test.step("11. close a loop of streets: the debug panel outlines the block with its area; bulldoze a side and it goes", async () => {
      await debugPanel(page, true);
      await page.locator("#blocks-toggle").click();
      await expect(page.locator("#blocks-toggle")).toHaveAttribute("aria-pressed", "true");
      const blocks = page.locator("#blocks-readout");
      await expect(blocks).not.toHaveText("off");
      const startCount = Number((await blocks.getAttribute("data-count")) ?? 0);
      const startLabels = await page.locator(".block-label").count();

      // Four streets round a 120 m square on the flat ground, drawn in
      // continuous mode and closed with a double click on the first corner.
      await look(page, 4620, 4920, 330);
      await roadTool(page);
      await page.keyboard.press("KeyU");
      await expect(page.locator("#draw-mode-continuous")).toHaveAttribute("aria-pressed", "true");
      const corners: [number, number][] = [
        [4560, 4860],
        [4680, 4860],
        [4680, 4980],
        [4560, 4980],
      ];
      const before = (await log(page)).length;
      for (const [x, z] of corners) await click(page, x, z);
      const first = await screenAt(page, 4560, 4860);
      await page.mouse.dblclick(first.x, first.y);
      await frames(page);
      await expect.poll(async () => (await log(page)).length).toBe(before + 4);
      await noTool(page);
      await expect(blocks).toHaveAttribute("data-count", String(startCount + 1));
      await expect(page.locator(".block-label")).toHaveCount(startLabels + 1);
      await expect(page.locator(".block-label[data-area='14400']")).toHaveCount(1);
      await expect(page.locator(".block-label[data-area='14400']")).toHaveText("14,400 m²");
      await away(page);
      await shot(page, info, dir, "11-block-outlined");

      await page.keyboard.press("KeyN");
      await click(page, 4620, 4860);
      await expect(blocks).toHaveAttribute("data-count", String(startCount));
      await expect(page.locator(".block-label[data-area='14400']")).toHaveCount(0);
      await noTool(page);
      await away(page);
      await shot(page, info, dir, "11-side-bulldozed-block-gone");
      await page.locator("#blocks-toggle").click();
      await debugPanel(page, false);
    });

    await test.step("12. a street beside another snaps parallel at twelve cells; its end lines up with a node two blocks away", async () => {
      const g = groundAt(4372, 4730);
      await page.evaluate(
        async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
        [
          [4372, g + 470, 4880],
          [4372, g, 4730],
        ] as const,
      );
      await frames(page);
      await roadTool(page);
      for (const id of ["lines", "offset"]) await expect(page.locator(`#guide-${id}`)).toHaveAttribute("aria-pressed", "true");
      const log0 = (await log(page)).length;

      const OFFSET_Z = A.z + 96 + STREET_WIDTH;
      const start = await hover(page, 4250, OFFSET_Z, MISS[0]);
      expect(start?.kind).toBe("offset");
      expect(start?.guides?.[0]?.cells).toBe(12);
      await expect(page.locator("#road-offset")).toHaveText("12 cells beside the road, edge to edge");
      await shot(page, info, dir, "12-parallel-offset");
      await click(page, 4250, OFFSET_Z, MISS[0]);
      const end = await hover(page, A.x1, OFFSET_Z, MISS[1]);
      expect(end?.kind).toBe("crossing");
      await click(page, A.x1, OFFSET_Z, MISS[1]);
      await expect.poll(async () => (await log(page)).length).toBe(log0 + 1);
      const second = nodes(await roads(page)).filter((n) => n.z === OFFSET_Z);
      // Its two ends, on the offset line, and where it crosses the second
      // street. The start keeps the x the click had; the end is in line
      // with the first street's east end.
      expect(second).toHaveLength(3);
      expect(second.map((n) => n.x)).toEqual(expect.arrayContaining([B.x, A.x1]));
      expect(OFFSET_Z - A.z - STREET_WIDTH).toBe(96);

      // A third street two blocks from the first, drawn east to west: its
      // end lines up with the first street's west end.
      const THIRD_Z = OFFSET_Z + 96 + STREET_WIDTH;
      await click(page, 4480, THIRD_Z, MISS[2]);
      const lined = await hover(page, A.x0, THIRD_Z, MISS[3]);
      expect(lined?.kind).toBe("crossing");
      await shot(page, info, dir, "12-lined-up-with-a-node-two-blocks-away");
      await click(page, A.x0, THIRD_Z, MISS[3]);
      await expect.poll(async () => (await log(page)).length).toBe(log0 + 2);
      const third = nodes(await roads(page)).filter((n) => n.z === THIRD_Z);
      expect(third.map((n) => n.x)).toContain(A.x0);
      expect(nodes(await roads(page))).toContainEqual(expect.objectContaining({ x: A.x0, z: A.z }));
      await noTool(page);
      await away(page);
      await shot(page, info, dir, "12-three-parallel-streets");
    });

    await test.step("13. drag a grid from a street and confirm: one log entry, joined, stopped at water, one undo removes it", async () => {
      await look(page, 3640, 6770, 560);
      await roadTool(page);
      await click(page, GRID_STREET.x, GRID_STREET.z0);
      await click(page, GRID_STREET.x, GRID_STREET.z1);
      await expect.poll(async () => (await logTypes(page)).at(-1)).toBe("BuildRoad");
      await noTool(page);
      const start = await roads(page);
      const startLog = (await log(page)).length;

      await page.keyboard.press("KeyG");
      await expect(page.locator("#grid-tool")).toHaveAttribute("aria-pressed", "true");
      await page.locator("#grid-depth").fill("12");
      await page.locator("#grid-width").fill("12");
      await drag(page, [GRID_STREET.x, GRID_STREET.z0 + 10], [GRID_CORNER.x, GRID_CORNER.z]);
      const summary = page.locator("#grid-summary");
      await expect(summary).toHaveAttribute("data-ok", "true");
      const junctions = Number(await summary.getAttribute("data-junctions"));
      expect(junctions).toBeGreaterThanOrEqual(2);
      expect(Number(await summary.getAttribute("data-cuts"))).toBeGreaterThan(0);
      await expect(summary).toContainText(/street ends? cut by water or slope/);
      await away(page);
      await shot(page, info, dir, "13-grid-preview");

      await page.locator("#grid-confirm").click();
      await expect.poll(async () => (await log(page)).length).toBe(startLog + 1);
      expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoadGrid"]);
      await expect(rows.nth(0)).toContainText("BuildRoadGrid");
      const built = await roads(page);
      // Joined: the street it was dragged from is split, and the grid's
      // streets meet it at as many junctions as the preview showed.
      const old = new Set(segments(start).map((s) => `${s.ax},${s.az},${s.bx},${s.bz}`));
      const added = segments(built).filter((s) => !old.has(`${s.ax},${s.az},${s.bx},${s.bz}`));
      const onStreet = added.filter((s) => s.ax === GRID_STREET.x && s.bx === GRID_STREET.x);
      expect(onStreet.length).toBeGreaterThanOrEqual(2);
      const meeting = added.filter((s) => (s.ax === GRID_STREET.x) !== (s.bx === GRID_STREET.x));
      expect(meeting.length).toBe(junctions);
      // Stopped at water: every new street ends on dry ground.
      for (const s of added) {
        expect(heightAt(terrain, s.ax, s.az)).toBeGreaterThan(terrain.waterLevel);
        expect(heightAt(terrain, s.bx, s.bz)).toBeGreaterThan(terrain.waterLevel);
        expect(s.level).toBe(0);
      }
      await away(page);
      await shot(page, info, dir, "13-grid-built");

      await page.keyboard.press("Control+KeyZ");
      await expect.poll(async () => roads(page)).toEqual(start);
      expect((await logTypes(page)).slice(startLog)).toEqual(["BuildRoadGrid", "Undo"]);
      await noTool(page);
      await away(page);
      await shot(page, info, dir, "13-one-undo-removed-the-grid");
    });
  });
}
