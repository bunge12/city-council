import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  BUILDING_TYPES,
  CELL_OPEN,
  CELL_ROAD,
  CELL_STEEP,
  CELL_WATER,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  ROAD_TYPES,
  ZONING_BALANCE,
  cellAt,
  cellCorners,
  cellStatuses,
  createState,
  deserialize,
  generateTerrain,
  hashState,
  heightAt,
  replay,
  serialize,
  step,
  submit,
  syncCells,
  type SimState,
} from "../packages/sim/src/index";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { MENU_SHIFT } from "./dock";

// The M2 exit test from docs/milestones/M2.md (issue M2-17), as one
// walkthrough a player could do by hand, run once on WebGPU (when the
// browser has an adapter) and once on the `?webgl` fallback. It runs in the
// `walkthrough` project, against the production build or, with BASE_URL,
// the public address.
//
// The city starts as streets with nothing zoned, built in Node through
// BuildRoad commands by the player id "fixture" and imported as a city
// file, so every run zones the same ground and the log replays from the
// seed. On seed 2026's flat square: a grid of three streets west to east,
// at z = 4450, 4570 and 4690 from x = 4130 to 4670, crossed by five north
// to south every 135 m, which gives 24 strips of six cells, one each side
// of each of the twelve pieces between junctions. South of it, a street
// along z = 4800 between two that run on south to z = 4960, which the
// player closes into a block 12 cells deep in step 7, and a short street
// along z = 4800 further east for step 10. Off the square, a street along
// the inlet's north shore, whose south cells lie on water, and one up the
// slope to the west, whose west cells are too steep.
//
// Every step goes through the page's own controls: the zone tool, the road
// tool, the bulldozer, the speed buttons, the graphics setting and the city
// menu. The mirror's read-only copy is read to check what a step did, and
// the cells and the replay are checked in Node on a downloaded city file.
// Screenshots of each step land in walkthrough-screenshots/m2-<backend>/
// and are attached to the report.

type Vec3 = readonly [number, number, number];
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
}
interface CellInfo {
  segment: number;
  side: number;
  place: number;
  depth: number;
  index: number;
  status: number;
}
interface CellStats {
  visible: boolean;
  zoned: number;
  unzoned: number;
  marked: number;
  pending: number;
}
type Form = "full" | "simple" | "box" | "flat";
interface BuildingStats {
  buildings: number;
  forms: Record<Form, { chunks: number; buildings: number; meshes: number }>;
}
interface SaveStatus {
  city: { id: string };
  loadedFrom: string;
  loadedTick: number;
}
type Tint = { wall: number; roof: number; trim: number };
type Arrays = Record<string, ArrayLike<number>>;
declare const window: {
  cityCouncil: {
    saves: { status: SaveStatus | null };
    downloadCity(): Promise<{ hash: string; tick: number }>;
    mirror: {
      state: ({ tick: number; log: LogEntry[]; roads: Arrays; cells: Arrays; buildings: Arrays } & Record<string, unknown>) | null;
      cellAt(x: number, z: number): CellInfo | null;
      buildingAt(x: number, z: number): { id: number } | null;
    };
    renderStatus(): { backend: string } | null;
    view: Promise<{
      cellStats(): CellStats | null;
      buildingStats(): BuildingStats | null;
      buildingForm(chunk: number): Form | null;
      buildingTint(id: number): Tint | null;
      buildingTop(id: number): { x: number; y: number; z: number } | null;
      lighting(): { preset: string; shadows: boolean; focus: Vec3 | null };
      decorCounts(): unknown;
    }>;
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
// Several page loads, game months of growth at 4x and many redraws, on a
// machine that may have no GPU.
test.setTimeout(1_500_000);

const SCREENSHOTS = "walkthrough-screenshots";
const terrain = generateTerrain(SEED);
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const HALF = (ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0) / 2;
const zoneNumber = (id: string): number => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;
const letterOf = (zone: number): string => ZONING_BALANCE.zones[zone - 1]?.letter ?? "?";
const typeIndex = (id: string): number => BUILDING_TYPES.findIndex((t) => t.id === id);

/** The grid: three streets west to east and five north to south, 135 m apart. */
const ROWS = [4450, 4570, 4690] as const;
const COLS = [4130, 4265, 4400, 4535, 4670] as const;
/** The block the player closes in step 7: streets along z = 4800 and, drawn in the step, z = 4906, 12 cells apart between their edges. */
const BLOCK = { x0: 4130, x1: 4400, z0: 4800, z1: 4906 };
/** The short street for step 10, and the street along the inlet and the one up the slope for step 1. */
const SHORT = { x0: 4480, x1: 4660, z: 4800 };
const SHORE = { x0: 3420, x1: 3680, z: 6560 };
const SLOPE = { x: 3760, z0: 4600, z1: 4800 };

/** A strip: one side of the piece of grid street `row` between columns `col` and `col + 1`. */
interface Strip {
  row: (typeof ROWS)[number];
  col: number;
  north: boolean;
}
/** Where the zone tool's fill picks the strip: on the street, just on its side of the centre line, half way along. */
const fillPoint = (s: Strip): [number, number] => [(COLS[s.col] ?? 0) + 67.5, s.row + (s.north ? -HALF / 2 : HALF / 2)];
/** The centre of the strip's cell `depth` back from the road, half way along. */
const stripCell = (s: Strip, depth = 0): [number, number] => [(COLS[s.col] ?? 0) + 67.5 + CELL / 2, s.row + (s.north ? -1 : 1) * (HALF + CELL / 2 + depth * CELL)];

/** Step 4: every zone at every density, one strip each. R1 is the strip step 2 paints. */
const PAINT: { zone: string; density: number; strip: Strip }[] = [
  { zone: "residential", density: 1, strip: { row: 4570, col: 0, north: true } },
  { zone: "residential", density: 2, strip: { row: 4570, col: 2, north: false } },
  { zone: "residential", density: 3, strip: { row: 4570, col: 3, north: false } },
  { zone: "commercial", density: 1, strip: { row: 4450, col: 0, north: true } },
  { zone: "commercial", density: 2, strip: { row: 4450, col: 1, north: true } },
  { zone: "commercial", density: 3, strip: { row: 4450, col: 2, north: true } },
  { zone: "office", density: 1, strip: { row: 4450, col: 3, north: true } },
  { zone: "office", density: 2, strip: { row: 4450, col: 0, north: false } },
  { zone: "office", density: 3, strip: { row: 4450, col: 1, north: false } },
  { zone: "industrial", density: 1, strip: { row: 4450, col: 2, north: false } },
  { zone: "industrial", density: 2, strip: { row: 4450, col: 3, north: false } },
  { zone: "industrial", density: 3, strip: { row: 4570, col: 2, north: true } },
  { zone: "mixed", density: 1, strip: { row: 4570, col: 3, north: true } },
  { zone: "mixed", density: 2, strip: { row: 4570, col: 0, north: false } },
  { zone: "mixed", density: 3, strip: { row: 4570, col: 1, north: false } },
];
const R1_STRIP = PAINT[0]?.strip ?? { row: 4570, col: 0, north: true };
/** Step 8: a second R1 strip, for a road through its houses. */
const HOUSES_STRIP: Strip = { row: 4570, col: 1, north: true };
/** Step 5: a shallow R2 strip, three cells deep, and an R3 strip three deep, where no R3 lot fits. */
const SHALLOW_R2: Strip = { row: 4690, col: 0, north: true };
const SMALL_R3: Strip = { row: 4690, col: 1, north: true };
const DEEP_R2 = PAINT[1]?.strip ?? { row: 4570, col: 2, north: false };
/** Step 9: the piece of the middle street between its two eastern junctions, with M1 on its north side and R3 on its south. */
const BULLDOZED = { x: 4602.5, z: 4570 };

function walkthroughCity(): SimState {
  const state = createState(SEED);
  buildRoads(state, [
    ...ROWS.map((z) => [[COLS[0], z], [COLS[4], z], "street"] as [[number, number], [number, number], string]),
    ...COLS.map((x) => [[x, ROWS[0]], [x, ROWS[2]], "street"] as [[number, number], [number, number], string]),
    [[BLOCK.x0, ROWS[2]], [BLOCK.x0, 4960], "street"],
    [[BLOCK.x1, ROWS[2]], [BLOCK.x1, 4960], "street"],
    [[BLOCK.x0, BLOCK.z0], [BLOCK.x1, BLOCK.z0], "street"],
    [[SHORT.x0, SHORT.z], [SHORT.x1, SHORT.z], "street"],
    [[SHORE.x0, SHORE.z], [SHORE.x1, SHORE.z], "street"],
    [[SLOPE.x, SLOPE.z0], [SLOPE.x, SLOPE.z1], "street"],
  ]);
  // Saved paused: nothing grows until the walkthrough presses a speed. By
  // a command, as a player pauses, so a replay of the log pauses too: a
  // stroke applies at once while paused and waits for the cells while the
  // game runs (M2 review, #147).
  if (!submit(state, { seq: 1000, playerId: "fixture", type: "SetSpeed", payload: { speed: 0 } }).ok) throw new Error("pause refused");
  step(state);
  return state;
}

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

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        const next = (left: number) => (left <= 0 ? r() : requestAnimationFrame(() => next(left - 1)));
        next(n);
      }),
    n,
  );
}

/** Waits until the buildings near the camera are drawn in the form they want, and decoration has stopped filling in. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsSettled"] === "true", null, { timeout: 180_000 });
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let last = "";
    let steady = 0;
    for (let f = 0; f < 600 && steady < 10; f++) {
      await frame();
      const now = JSON.stringify(view.decorCounts());
      steady = now === last ? steady + 1 : 0;
      last = now;
    }
  });
}

/** Looks at (x, z) from `height` metres up and to the south, set back so the work area sits above the tool menus. */
async function look(page: Page, x: number, z: number, height: number, back = 0.75): Promise<void> {
  const g = groundAt(x, z);
  const shift = height * MENU_SHIFT;
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [x, g + height, z + height * back + shift],
      [x, g, z + shift],
    ] as const,
  );
  await frames(page);
}

async function setPose(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
  await frames(page);
}

async function screenAt(page: Page, x: number, z: number, y?: number): Promise<{ x: number; y: number }> {
  const h = y ?? Math.max(heightAt(terrain, x, z), terrain.waterLevel);
  return page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [x, h, z] as const);
}

/** Fails naming the panel over screen point `p`, if one would take the pointer off the map. */
async function clearOfPanels(page: Page, p: { x: number; y: number }, what: string): Promise<void> {
  const over = await page.evaluate(([px, py]) => {
    const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { id: string; tagName: string; closest(s: string): { id: string } | null } | null } }).document.elementFromPoint(px, py);
    if (!el || el.id === "view") return null;
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} in ${el.closest("[id]")?.id ?? "the page"}`;
  }, [p.x, p.y] as const);
  expect(over, `${what} is under a panel at (${Math.round(p.x)}, ${Math.round(p.y)})`).toBeNull();
}

/** Moves the pointer to ground point (x, z), `off` CSS pixels away on screen, and returns where it snapped. */
async function hover(page: Page, x: number, z: number, off: [number, number] = [0, 0]): Promise<SnapInfo | null> {
  const p = await screenAt(page, x, z);
  const at = { x: p.x + off[0], y: p.y + off[1] };
  await clearOfPanels(page, at, `ground point (${x}, ${z})`);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await frames(page, 3);
  return page.evaluate(async () => (await window.cityCouncil.camera).snap());
}

async function click(page: Page, x: number, z: number, off: [number, number] = [0, 0]): Promise<SnapInfo | null> {
  const snap = await hover(page, x, z, off);
  await page.mouse.down();
  await page.mouse.up();
  await frames(page);
  return snap;
}

/** Moves the pointer onto building `id` as drawn, a little under its roof. */
async function hoverBuilding(page: Page, id: number): Promise<void> {
  const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), id);
  if (!top) throw new Error(`building ${id} is not drawn`);
  const p = await screenAt(page, top.x, top.z, top.y - 1);
  await clearOfPanels(page, p, `building ${id}`);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await frames(page, 3);
}

/** Moves the pointer off the map so no preview shows in a screenshot. */
async function away(page: Page): Promise<void> {
  await page.mouse.move(640, 20);
  await frames(page, 3);
}

async function log(page: Page): Promise<LogEntry[]> {
  return (await page.evaluate(() => window.cityCouncil.mirror.state?.log)) ?? [];
}

async function logTypes(page: Page): Promise<string[]> {
  return (await log(page)).map((e) => e.type);
}

async function status(page: Page): Promise<SaveStatus> {
  const value = await page.evaluate(() => window.cityCouncil.saves.status);
  if (!value) throw new Error("no save status");
  return value;
}

const speedButton = (page: Page, name: string) => page.getByRole("group", { name: "Game speed" }).getByRole("button", { name, exact: true });

async function setSpeed(page: Page, name: "Pause" | "4x"): Promise<void> {
  await speedButton(page, name).click();
  await expect(speedButton(page, name)).toHaveAttribute("aria-pressed", "true");
  // The speed is state: wait for the copy to have it, so the tick stops before anything is read.
  await expect.poll(() => page.evaluate(() => window.cityCouncil.mirror.state?.["speed"])).toBe(name === "Pause" ? 0 : 4);
}

/** The city menu, opened if it is closed. */
async function cityMenu(page: Page) {
  const menu = page.getByRole("region", { name: "City menu" });
  if (!(await menu.isVisible())) await page.getByRole("button", { name: "City", exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}

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

/** Turns every tool off: Escape drops what a tool holds, a second leaves it. */
async function noTool(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const on = await page
      .locator("#road-tool, #upgrade-tool, #bulldoze-tool, #grid-tool, #zone-tool")
      .evaluateAll((els) => els.some((e) => e.getAttribute("aria-pressed") === "true"));
    if (!on) return;
    await page.keyboard.press("Escape");
    await frames(page);
  }
  throw new Error("a tool stayed on");
}

/** Turns the zone tool on, if it is off, and waits for the overlay's cells. */
async function zoneTool(page: Page): Promise<void> {
  if ((await page.locator("#zone-tool").getAttribute("aria-pressed")) !== "true") {
    await noTool(page);
    await page.keyboard.press("KeyK");
  }
  await expect(page.locator("#zone-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zone-menu")).toBeVisible();
  await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
}

/** Picks the zone, the density and the fill depth in the zone tool's menu. */
async function pick(page: Page, zone: string, density: number, depth = DEPTH): Promise<void> {
  await page.locator(`#zone-${zone}`).click();
  await expect(page.locator(`#zone-${zone}`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`#zone-density-${density}`).click();
  await expect(page.locator(`#zone-density-${density}`)).toHaveAttribute("aria-pressed", "true");
  await page.locator("#zone-mode-fill").click();
  await page.locator(`#zone-depth-${depth}`).click();
  await expect(page.locator(`#zone-depth-${depth}`)).toHaveAttribute("aria-pressed", "true");
}

/** Fills `strip` with the zone tool's current pick: one ZoneCells, checked in the log. */
async function fill(page: Page, strip: Strip): Promise<void> {
  const before = (await log(page)).filter((e) => e.type === "ZoneCells").length;
  const [x, z] = fillPoint(strip);
  await hover(page, x, z);
  await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
  await click(page, x, z);
  await expect.poll(async () => (await log(page)).filter((e) => e.type === "ZoneCells").length).toBe(before + 1);
}

/** The zone and density of the cell under (x, z) in the copy, or null where there is no cell. */
async function cellZone(page: Page, x: number, z: number): Promise<{ zone: number; density: number; segment: number; side: number; status: number } | null> {
  return page.evaluate(
    ([x, z]) => {
      const { mirror } = window.cityCouncil;
      const cell = mirror.cellAt(x, z);
      const cells = mirror.state?.cells;
      if (!cell || !cells) return null;
      return { zone: cells["zone"]?.[cell.index] ?? 0, density: cells["density"]?.[cell.index] ?? 0, segment: cell.segment, side: cell.side, status: cell.status };
    },
    [x, z] as const,
  );
}

/** The segment and side the strip's cells belong to, as `seg/side`. */
async function stripKey(page: Page, strip: Strip): Promise<string> {
  const [x, z] = stripCell(strip);
  const cell = await cellZone(page, x, z);
  if (!cell) throw new Error(`no cell at ${x}, ${z}`);
  return `${cell.segment}/${cell.side}`;
}

interface Building {
  id: number;
  type: number;
  zone: number;
  density: number;
  /** The zone and density of the cell the lot starts from. */
  cellZone: number;
  cellDensity: number;
  strip: string;
  width: number;
  depth: number;
  backDepth: number;
  variant: number;
  builtAt: number;
}

/** Every building standing in the copy. */
async function buildings(page: Page): Promise<Building[]> {
  return page.evaluate((depth) => {
    const s = window.cityCouncil.mirror.state;
    if (!s) return [];
    const b = s.buildings;
    const offset = s.cells["offset"] ?? [];
    const out: Building[] = [];
    const flags = b["flags"] ?? [];
    for (let id = 0; id < flags.length; id++) {
      if (((flags[id] ?? 0) & 1) === 0) continue;
      const seg = b["firstSeg"]?.[id] ?? 0;
      const side = b["firstSide"]?.[id] ?? 0;
      const slot = (offset[seg] ?? 0) + ((b["firstPlace"]?.[id] ?? 0) * 2 + side) * depth;
      out.push({
        id,
        type: b["type"]?.[id] ?? 0,
        zone: b["zone"]?.[id] ?? 0,
        density: b["density"]?.[id] ?? 0,
        cellZone: s.cells["zone"]?.[slot] ?? 0,
        cellDensity: s.cells["density"]?.[slot] ?? 0,
        strip: `${seg}/${side}`,
        width: b["width"]?.[id] ?? 0,
        depth: b["depth"]?.[id] ?? 0,
        backDepth: b["backDepth"]?.[id] ?? 0,
        variant: b["variant"]?.[id] ?? 0,
        builtAt: b["builtAt"]?.[id] ?? 0,
      });
    }
    return out;
  }, DEPTH);
}

/** Every road array of the copy, as plain lists, to compare whole networks. */
async function roads(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const net = window.cityCouncil.mirror.state?.roads;
    if (!net) throw new Error("no state");
    return Object.fromEntries(Object.entries(net).map(([k, a]) => [k, Array.from(a)]));
  });
}

/** The zone and density arrays of the copy's cells. */
async function zoning(page: Page): Promise<{ zone: number[]; density: number[] }> {
  return page.evaluate(() => {
    const c = window.cityCouncil.mirror.state?.cells;
    return { zone: Array.from(c?.["zone"] ?? []), density: Array.from(c?.["density"] ?? []) };
  });
}

/** The live segment whose middle is within 5 m of (x, z), or -1. */
async function segmentNear(page: Page, x: number, z: number): Promise<number> {
  return page.evaluate(
    ([x, z]) => {
      const r = window.cityCouncil.mirror.state?.roads;
      if (!r) return -1;
      const flags = r["segFlags"] ?? [];
      for (let s = 0; s < flags.length; s++) {
        if (((flags[s] ?? 0) & 1) === 0) continue;
        const a = r["segA"]?.[s] ?? 0;
        const b = r["segB"]?.[s] ?? 0;
        const mx = ((r["nodeX"]?.[a] ?? 0) + (r["nodeX"]?.[b] ?? 0)) / 2;
        const mz = ((r["nodeZ"]?.[a] ?? 0) + (r["nodeZ"]?.[b] ?? 0)) / 2;
        if (Math.hypot(mx - x, mz - z) < 5) return s;
      }
      return -1;
    },
    [x, z] as const,
  );
}

/** The figure the top bar shows for homes. */
async function homesShown(page: Page): Promise<number> {
  const text = (await page.locator("#homes-count").textContent()) ?? "";
  return Number(text.replace(/,/g, ""));
}

/** Residential buildings standing in the copy: the homes the top bar counts. */
async function homesCounted(page: Page): Promise<number> {
  const r = zoneNumber("residential");
  return (await buildings(page)).filter((b) => b.zone === r).length;
}

async function tints(page: Page, ids: number[]): Promise<(Tint | null)[]> {
  return page.evaluate(async (ids) => {
    const view = await window.cityCouncil.view;
    return ids.map((id) => view.buildingTint(id));
  }, ids);
}

/** Runs the game at 4x until `done` holds, then pauses. */
async function growUntil<T>(page: Page, what: string, read: () => Promise<T>, done: (value: T) => boolean, timeout = 240_000): Promise<T> {
  await setSpeed(page, "4x");
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        last = await read();
        return done(last);
      },
      { message: what, timeout, intervals: [1000] },
    )
    .toBe(true);
  await setSpeed(page, "Pause");
  // What stands once paused, which may be a little more than what passed.
  return read();
}

/** Runs the game until building `id` has finished its construction animation, for a screenshot of it standing. */
async function untilBuilt(page: Page, id: number): Promise<void> {
  const built = (await buildings(page)).find((b) => b.id === id);
  if (!built) throw new Error(`building ${id} is not standing`);
  const done = built.builtAt + CONSTRUCTION.ticks;
  await growUntil(page, `building ${id} finished`, () => page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? 0), (tick) => tick >= done);
}

const centre = (strip: Strip): [number, number] => [(COLS[strip.col] ?? 0) + 67.5, strip.row];

for (const variant of [
  { name: "webgpu", query: "" },
  { name: "webgl", query: "?webgl" },
] as const) {
  test(`M2 walkthrough (${variant.name})`, async ({ page }, info) => {
    const url = `./${variant.query}`;
    const dir = `m2-${variant.name}`;
    const rows = page.locator("#activity-log tbody tr");

    // The WebGPU run expects WebGPU only where this browser offers an adapter.
    await page.goto(url);
    const hasWebGpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    // CI starts Chromium with a software WebGPU adapter (playwright.config.ts).
    if (variant.name === "webgpu" && process.env["CI"]) expect(hasWebGpu, "CI must have a WebGPU adapter").toBe(true);
    const wantBackend = variant.name === "webgpu" && hasWebGpu ? "webgpu" : "webgl2";
    if (variant.name === "webgpu" && !hasWebGpu) {
      info.annotations.push({ type: "backend", description: "no WebGPU adapter in this browser; ran on the WebGL 2 fallback" });
    }
    await ready(page);
    const loaded = page.waitForEvent("load");
    await page.locator("#import-file").setInputFiles({
      name: "M2 walkthrough.city",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(serialize(walkthroughCity())),
    });
    await loaded;
    await ready(page);
    expect((await page.evaluate(() => window.cityCouncil.renderStatus()))?.backend).toBe(wantBackend);
    await expect(speedButton(page, "Pause")).toHaveAttribute("aria-pressed", "true");
    expect(await buildings(page)).toEqual([]);
    await page.locator("#view").focus();
    /** The homes figure at each point the walkthrough checks it, for step 14. */
    const homes: { when: string; shown: number; counted: number }[] = [];
    const noteHomes = async (when: string) => {
      const counted = await homesCounted(page);
      await expect.poll(() => homesShown(page)).toBe(counted);
      homes.push({ when, shown: await homesShown(page), counted });
    };
    await noteHomes("before any zoning");
    expect(homes[0]?.shown).toBe(0);

    await test.step("1. open the zone tool: cells along both sides of every street, six deep, none on water, steep ground or another road", async () => {
      await look(page, 4400, 4570, 420);
      await zoneTool(page);
      await expect.poll(() => page.evaluate(() => document.body.dataset["zoningOverlay"])).toBe("true");
      const stats = await page.evaluate(async () => (await window.cityCouncil.view).cellStats());
      expect(stats?.visible).toBe(true);
      expect(stats?.zoned).toBe(0);
      expect(stats?.unzoned ?? 0).toBeGreaterThan(1000);
      await away(page);
      await shot(page, info, dir, "1-cells-along-the-grid");

      // The cells as the sim lays them out, on a downloaded copy of the city.
      const { state } = deserialize(await download(page, info, "cells"));
      syncCells(state);
      const statuses = cellStatuses(state);
      const { offset } = state.cells;
      const net = state.roads;
      const counts = new Map<number, number>();
      for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
      for (let seg = 0; seg + 1 < offset.length; seg++) {
        if (((net.segFlags[seg] ?? 0) & 1) === 0 || ((net.segFlags[seg] ?? 0) & 2) !== 0) continue;
        const cells = (offset[seg + 1] ?? 0) - (offset[seg] ?? 0);
        // Both sides of every street the player can zone, six deep: whole columns of 2 x 6.
        expect(cells, `segment ${seg}`).toBeGreaterThan(0);
        expect(cells % (2 * DEPTH), `segment ${seg}`).toBe(0);
      }
      // And the cells really reach six deep: on each side of a grid street, the cell six back from the edge is open and is the sixth.
      for (const north of [true, false]) {
        const [x, z] = stripCell({ ...R1_STRIP, north }, DEPTH - 1);
        const deepest = cellAt(state, x, z);
        expect(deepest?.depth, `${north ? "north" : "south"} side, six back`).toBe(DEPTH - 1);
        expect(deepest?.status, `${north ? "north" : "south"} side, six back`).toBe(CELL_OPEN);
      }
      // The shore street's south cells reach the water, the slope street's west cells are too steep, and every junction blocks some.
      expect(counts.get(CELL_WATER) ?? 0).toBeGreaterThan(20);
      expect(counts.get(CELL_STEEP) ?? 0).toBeGreaterThan(20);
      expect(counts.get(CELL_ROAD) ?? 0).toBeGreaterThan(20);
      // No open cell has water under it, ground steeper than the limit, or a road over it.
      const segs: { ax: number; az: number; bx: number; bz: number }[] = [];
      for (let s = 0; s < net.segFlags.length; s++) {
        if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
        const a = net.segA[s] ?? 0;
        const b = net.segB[s] ?? 0;
        segs.push({ ax: net.nodeX[a] ?? 0, az: net.nodeZ[a] ?? 0, bx: net.nodeX[b] ?? 0, bz: net.nodeZ[b] ?? 0 });
      }
      const onRoad = (x: number, z: number): boolean =>
        segs.some((s) => {
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const len = Math.hypot(dx, dz);
          const t = ((x - s.ax) * dx + (z - s.az) * dz) / (len * len);
          if (t < 0 || t > 1) return false;
          return Math.abs(((x - s.ax) * dz - (z - s.az) * dx) / len) < HALF - 0.5;
        });
      let open = 0;
      for (let seg = 0; seg + 1 < offset.length; seg++) {
        for (let slot = offset[seg] ?? 0; slot < (offset[seg + 1] ?? 0); slot++) {
          if (statuses[slot] !== CELL_OPEN) continue;
          open++;
          const local = slot - (offset[seg] ?? 0);
          const depth = local % DEPTH;
          const rest = (local - depth) / DEPTH;
          const side = rest % 2;
          const place = (rest - side) / 2;
          const corners = cellCorners(state, { segment: seg, side, place, depth });
          if (!corners) throw new Error(`open cell ${slot} has no corners`);
          const cx = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
          const cz = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
          expect(heightAt(terrain, cx, cz), `cell ${slot} at ${cx}, ${cz} is on water`).toBeGreaterThan(terrain.waterLevel);
          const e = 1;
          const slope = Math.hypot(heightAt(terrain, cx + e, cz) - heightAt(terrain, cx - e, cz), heightAt(terrain, cx, cz + e) - heightAt(terrain, cx, cz - e)) / (2 * e);
          expect(slope, `cell ${slot} at ${cx}, ${cz} is steep`).toBeLessThan(ZONING_BALANCE.maxSlope + 0.03);
          expect(onRoad(cx, cz), `cell ${slot} at ${cx}, ${cz} is under a road`).toBe(false);
        }
      }
      expect(open).toBeGreaterThan(2000);
      info.annotations.push({ type: "cells", description: `${statuses.length} cells, ${open} open, ${JSON.stringify(Object.fromEntries(counts))} by status` });

      await look(page, (SHORE.x0 + SHORE.x1) / 2, SHORE.z, 260);
      await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
      await away(page);
      await shot(page, info, dir, "1-no-cells-on-the-water");
      await look(page, SLOPE.x, (SLOPE.z0 + SLOPE.z1) / 2, 260);
      await page.waitForFunction(() => document.body.dataset["cellsPending"] === "0", null, { timeout: 60_000 });
      await away(page);
      await shot(page, info, dir, "1-no-cells-on-the-steep-side");
    });

    await test.step("2. paint R1 along one side of a street: the cells change colour, and the command is in the log with a player id and a tick", async () => {
      await look(page, 4270, 4570, 300);
      await page.keyboard.press("KeyL");
      await expect(page.locator("#activity-log")).toBeVisible();
      await pick(page, "residential", 1);
      const [x, z] = fillPoint(R1_STRIP);
      await hover(page, x, z);
      const readout = page.locator("#zone-readout");
      await expect(readout).toHaveAttribute("data-ok", "true");
      const count = Number(await readout.getAttribute("data-cells"));
      expect(count).toBeGreaterThan(10 * DEPTH);
      await expect(readout).toContainText(`Zone ${count} cells R1`);
      await shot(page, info, dir, "2-r1-preview");
      await fill(page, R1_STRIP);
      const entry = (await log(page)).at(-1);
      expect(entry).toMatchObject({ type: "ZoneCells", playerId: "local" });
      expect(entry?.tick).toBeGreaterThan(0);
      await expect(rows.nth(0)).toContainText("ZoneCells");
      await expect(rows.nth(0).locator("td").nth(0)).toHaveText(String(entry?.tick));
      await expect(rows.nth(0).locator("td").nth(1)).toHaveText("local");
      // Its cells are R1 in the copy, every row of them, and only on its side.
      for (let depth = 0; depth < DEPTH; depth++) {
        expect(await cellZone(page, ...stripCell(R1_STRIP, depth))).toMatchObject({ zone: zoneNumber("residential"), density: 1 });
      }
      expect((await cellZone(page, ...stripCell({ ...R1_STRIP, north: false })))?.zone).toBe(0);
      // The overlay draws them filled now.
      await expect.poll(async () => (await page.evaluate(async () => (await window.cityCouncil.view).cellStats()))?.zoned).toBe(count);
      await away(page);
      await shot(page, info, dir, "2-r1-painted-and-logged");
      // The log stays closed from here, so it does not cover the map. Its rows are still read.
      await page.keyboard.press("KeyL");
      await expect(page.locator("#activity-log")).toBeHidden();
    });

    await test.step("3. wait: houses appear along the street over time, and two houses of one type have different colours", async () => {
      await noTool(page);
      const strip = await stripKey(page, R1_STRIP);
      const home = typeIndex("single-family-home");
      const onStrip = async () => (await buildings(page)).filter((b) => b.strip === strip);
      const first = await growUntil(page, "a house on the R1 strip", onStrip, (b) => b.length >= 1);
      const firstTick = await page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? 0);
      const grown = await growUntil(page, "two single family homes on the R1 strip", onStrip, (b) => b.filter((h) => h.type === home).length >= 2);
      // Over time: more stood later than at first, on a later tick.
      expect(grown.length).toBeGreaterThan(first.length);
      expect(await page.evaluate(() => window.cityCouncil.mirror.state?.tick ?? 0)).toBeGreaterThan(firstTick);
      for (const b of grown) expect(BUILDING_TYPES[b.type]?.zone).toBe("residential");
      const houses = grown.filter((h) => h.type === home);
      const [hx, hz] = centre(R1_STRIP);
      await look(page, hx, hz - 30, 140);
      await settle(page);
      const colours = (await tints(page, houses.map((h) => h.id))).map((t) => JSON.stringify(t));
      expect(colours.every((c) => c !== "null"), colours.join("\n")).toBe(true);
      expect(new Set(colours).size, colours.join("\n")).toBeGreaterThan(1);
      await shot(page, info, dir, "3-houses-in-two-colours");
      await noteHomes("houses grew on the R1 strip");
      expect(homes.at(-1)?.shown ?? 0).toBeGreaterThan(0);
    });

    await test.step("4. paint each of the five zones at each of the three densities: each grows buildings of its own kind", async () => {
      await zoneTool(page);
      for (const [k, { zone, density, strip }] of PAINT.entries()) {
        if (k === 0) continue;
        await look(page, centre(strip)[0], centre(strip)[1], 300);
        await pick(page, zone, density);
        await fill(page, strip);
      }
      // The second R1 strip, for the road through its houses in step 8.
      await look(page, centre(HOUSES_STRIP)[0], centre(HOUSES_STRIP)[1], 300);
      await pick(page, "residential", 1);
      await fill(page, HOUSES_STRIP);
      await look(page, 4400, 4520, 420);
      await away(page);
      await shot(page, info, dir, "4-fifteen-zones-painted");
      await noTool(page);

      const keys = await Promise.all(PAINT.map(({ strip }) => stripKey(page, strip)));
      const housesKey = await stripKey(page, HOUSES_STRIP);
      const everyStrip = await growUntil(
        page,
        "a building on every zone and density",
        () => buildings(page),
        (bs) => [...keys, housesKey].every((key) => bs.some((b) => b.strip === key)),
        600_000,
      );
      for (const [k, { zone, density }] of PAINT.entries()) {
        const on = everyStrip.filter((b) => b.strip === keys[k]);
        expect(on.length, `${zone} ${density}`).toBeGreaterThan(0);
        for (const b of on) {
          const type = BUILDING_TYPES[b.type];
          // Its own kind: a type of that zone and density, on cells of that zone and density.
          expect(`${type?.zone} ${type?.density}`, `building ${b.id}, ${type?.id}`).toBe(`${zone} ${density}`);
          expect([b.zone, b.density, b.cellZone, b.cellDensity]).toEqual([zoneNumber(zone), density, zoneNumber(zone), density]);
        }
      }
      info.annotations.push({
        type: "step 4",
        description: PAINT.map(({ zone, density }, k) => `${letterOf(zoneNumber(zone))}${density}: ${[...new Set(everyStrip.filter((b) => b.strip === keys[k]).map((b) => BUILDING_TYPES[b.type]?.id))].join(", ")}`).join("; "),
      });
      await look(page, 4400, 4540, 380);
      await settle(page);
      await shot(page, info, dir, "4-every-zone-grew-its-own-kind");
      await setPose(page, [4300, groundAt(4300, 4500) + 120, 4640], [4330, groundAt(4330, 4500), 4500]);
      await settle(page);
      await shot(page, info, dir, "4-every-zone-grew-its-own-kind-closer");
      await noteHomes("every zone grew");
      expect(homes.at(-1)?.shown ?? 0).toBeGreaterThan(homes.at(-2)?.shown ?? 0);
    });

    await test.step("5. a shallow R2 strip gets townhomes and a deep one apartments; an R3 lot smaller than 4 x 4 stays empty, and the overlay says why", async () => {
      await zoneTool(page);
      await look(page, centre(SHALLOW_R2)[0] + 67, centre(SHALLOW_R2)[1], 300);
      await pick(page, "residential", 2, 3);
      await fill(page, SHALLOW_R2);
      await pick(page, "residential", 3, 3);
      await fill(page, SMALL_R3);
      // The R3 strip is hatched, and hovering it says why nothing grows there.
      await expect.poll(async () => (await page.evaluate(async () => (await window.cityCouncil.view).cellStats()))?.marked ?? 0).toBeGreaterThan(0);
      const [rx, rz] = stripCell(SMALL_R3, 1);
      await hover(page, rx, rz);
      await expect(page.locator("#zone-lot-note")).toHaveText(/^Nothing can grow here: R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 deep$/);
      await shot(page, info, dir, "5-r3-too-shallow-and-why");
      await noTool(page);

      const shallow = await stripKey(page, SHALLOW_R2);
      const deep = await stripKey(page, DEEP_R2);
      const small = await stripKey(page, SMALL_R3);
      const townhomes = typeIndex("townhomes");
      const apartments = typeIndex("apartments");
      const grown = await growUntil(
        page,
        "townhomes on the shallow R2 strip and apartments on the deep one",
        () => buildings(page),
        (bs) => bs.some((b) => b.strip === shallow) && bs.some((b) => b.strip === deep && b.type === apartments),
        600_000,
      );
      const onShallow = grown.filter((b) => b.strip === shallow);
      expect(onShallow.length).toBeGreaterThan(0);
      for (const b of onShallow) expect(b.type, `building ${b.id} on the shallow strip`).toBe(townhomes);
      expect(grown.filter((b) => b.strip === deep && b.type === apartments).length).toBeGreaterThan(0);
      expect(grown.filter((b) => b.strip === small)).toEqual([]);
      // Still marked, and still empty.
      await zoneTool(page);
      await hover(page, rx, rz);
      await expect(page.locator("#zone-lot-note")).toContainText("R3 needs a lot at least 4 wide and 4 deep");
      await noTool(page);
      await setPose(page, [4290, groundAt(4290, 4650) + 150, 4800], [4265, groundAt(4265, 4650), 4650]);
      await settle(page);
      await shot(page, info, dir, "5-townhomes-apartments-and-an-empty-r3-strip");
    });

    await test.step("6. rezone a built R1 lot to C2: the house stays; clear it, and a C2 building grows there", async () => {
      const strip = await stripKey(page, R1_STRIP);
      const before = (await buildings(page)).filter((b) => b.strip === strip);
      // A house two cells wide, so a C2 type fits on its lot once it is cleared.
      const house = before.find((b) => b.width >= 2 && b.depth >= 2);
      if (!house) throw new Error(`no house two cells wide on the R1 strip: ${JSON.stringify(before)}`);
      await look(page, centre(R1_STRIP)[0], centre(R1_STRIP)[1] - 20, 220);
      await zoneTool(page);
      await pick(page, "commercial", 2);
      await fill(page, R1_STRIP);
      for (let depth = 0; depth < DEPTH; depth++) expect(await cellZone(page, ...stripCell(R1_STRIP, depth))).toMatchObject({ zone: zoneNumber("commercial"), density: 2 });
      // Every house on it still stands, as it was.
      const after = (await buildings(page)).filter((b) => b.strip === strip);
      expect(after).toEqual(before.map((b) => ({ ...b, cellZone: zoneNumber("commercial"), cellDensity: 2 })));
      await noTool(page);
      await settle(page);
      await shot(page, info, dir, "6-rezoned-c2-houses-stay");

      const top = await page.evaluate(async (id) => (await window.cityCouncil.view).buildingTop(id), house.id);
      if (!top) throw new Error(`house ${house.id} is not drawn`);
      await noteHomes("before the house is cleared");
      const homesBefore = homes.at(-1)?.shown ?? NaN;
      await page.keyboard.press("KeyB");
      await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
      await hoverBuilding(page, house.id);
      await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-kind", "building");
      await expect(page.locator("#bulldoze-tag")).toHaveAttribute("data-ids", String(house.id));
      await shot(page, info, dir, "6-clear-the-house");
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(async () => (await buildings(page)).some((b) => b.id === house.id && b.type === house.type)).toBe(false);
      expect((await logTypes(page)).at(-1)).toBe("BulldozeBuilding");
      await noTool(page);
      // The homes figure falls by the house.
      await noteHomes("the house cleared");
      expect(homes.at(-1)?.shown).toBe(homesBefore - 1);

      const c2 = await growUntil(
        page,
        "a C2 building where the house stood",
        () => page.evaluate(([x, z]) => window.cityCouncil.mirror.buildingAt(x, z)?.id ?? -1, [top.x, top.z] as const),
        (id) => id >= 0,
        600_000,
      );
      const built = (await buildings(page)).find((b) => b.id === c2);
      expect(BUILDING_TYPES[built?.type ?? -1]?.zone).toBe("commercial");
      expect(BUILDING_TYPES[built?.type ?? -1]?.density).toBe(2);
      info.annotations.push({ type: "step 6", description: `house ${house.id} cleared, ${BUILDING_TYPES[built?.type ?? -1]?.id} ${c2} grew on its lot` });
      await untilBuilt(page, c2);
      const g = groundAt(top.x, top.z);
      await setPose(page, [top.x + 20, g + 150, top.z + 60], [top.x, g, top.z]);
      await settle(page);
      await shot(page, info, dir, "6-a-c2-building-where-the-house-was");
    });

    await test.step("7. a street 12 cells from a parallel one, both strips zoned C3: one large building stands across both strips", async () => {
      await look(page, (BLOCK.x0 + BLOCK.x1) / 2, (BLOCK.z0 + BLOCK.z1) / 2, 320);
      await noTool(page);
      await page.keyboard.press("KeyR");
      await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("KeyZ");
      await page.keyboard.press("KeyT");
      await expect(page.locator("#draw-mode-straight")).toHaveAttribute("aria-pressed", "true");
      const logBefore = (await log(page)).length;
      await click(page, BLOCK.x0, BLOCK.z1);
      await hover(page, BLOCK.x1, BLOCK.z1);
      await expect(page.locator("#road-readout")).toHaveAttribute("data-ok", "true");
      await click(page, BLOCK.x1, BLOCK.z1);
      await expect.poll(async () => (await log(page)).length).toBe(logBefore + 1);
      expect((await log(page)).at(-1)).toMatchObject({ type: "BuildRoad", playerId: "local" });
      expect(await segmentNear(page, (BLOCK.x0 + BLOCK.x1) / 2, BLOCK.z1)).toBeGreaterThanOrEqual(0);
      await noTool(page);

      await zoneTool(page);
      await pick(page, "commercial", 3);
      const mid = (BLOCK.x0 + BLOCK.x1) / 2;
      for (const [x, z] of [
        [mid, BLOCK.z0 + HALF / 2],
        [mid, BLOCK.z1 - HALF / 2],
      ] as const) {
        const before = (await log(page)).filter((e) => e.type === "ZoneCells").length;
        await hover(page, x, z);
        await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
        await click(page, x, z);
        await expect.poll(async () => (await log(page)).filter((e) => e.type === "ZoneCells").length).toBe(before + 1);
      }
      const south = await cellZone(page, mid + CELL / 2, BLOCK.z0 + HALF + CELL / 2);
      const north = await cellZone(page, mid + CELL / 2, BLOCK.z1 - HALF - CELL / 2);
      expect(south).toMatchObject({ zone: zoneNumber("commercial"), density: 3 });
      expect(north).toMatchObject({ zone: zoneNumber("commercial"), density: 3 });
      await away(page);
      await shot(page, info, dir, "7-block-zoned-c3-both-strips");
      await noTool(page);

      const strips = [`${south?.segment}/${south?.side}`, `${north?.segment}/${north?.side}`];
      const grown = await growUntil(
        page,
        "a building across the block",
        () => buildings(page),
        (bs) => bs.some((b) => strips.includes(b.strip) && b.backDepth > 0),
        600_000,
      );
      const across = grown.filter((b) => strips.includes(b.strip) && b.backDepth > 0);
      for (const b of across) {
        const type = BUILDING_TYPES[b.type];
        expect(type?.throughLot, type?.id).toBe(true);
        expect(type?.zone).toBe("commercial");
        // Across both strips: deeper than one strip, down to the back of the other.
        expect(b.depth).toBeGreaterThan(DEPTH);
        expect(b.backDepth).toBeGreaterThan(0);
        expect(b.depth - b.backDepth).toBe(DEPTH);
      }
      info.annotations.push({ type: "step 7", description: across.map((b) => `${BUILDING_TYPES[b.type]?.id} ${b.width} x ${b.depth}`).join(", ") });
      for (const b of across) await untilBuilt(page, b.id);
      await setPose(page, [mid + 140, groundAt(mid, 4853) + 170, 4853 + 220], [mid, groundAt(mid, 4853), 4853]);
      await settle(page);
      await shot(page, info, dir, "7-one-building-across-both-strips");
    });

    await test.step("8. a road through a row of houses: the preview marks and counts them, and after the click they are gone", async () => {
      const strip = await stripKey(page, HOUSES_STRIP);
      const r1 = zoneNumber("residential");
      const houses = (await buildings(page)).filter((b) => b.strip === strip && b.zone === r1);
      expect(houses.length).toBeGreaterThan(0);
      const [cx] = centre(HOUSES_STRIP);
      await look(page, cx, 4510, 260);
      await settle(page);
      // Through the house nearest the middle of the strip, from the street to the one north of it.
      const tops = await page.evaluate(async (ids) => {
        const view = await window.cityCouncil.view;
        return ids.map((id) => ({ id, top: view.buildingTop(id) }));
      }, houses.map((h) => h.id));
      const target = tops.filter((t) => t.top).sort((a, b) => Math.abs((a.top?.x ?? 0) - cx) - Math.abs((b.top?.x ?? 0) - cx))[0];
      if (!target?.top) throw new Error("no house drawn");
      const x = Math.round(target.top.x * 8) / 8;
      const standing = await buildings(page);
      await page.keyboard.press("KeyR");
      await expect(page.locator("#road-tool")).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("KeyZ");
      await click(page, x, HOUSES_STRIP.row);
      await hover(page, x, ROWS[0]);
      const readout = page.locator("#road-readout");
      await expect(readout).toHaveAttribute("data-ok", "true");
      const count = Number(await readout.getAttribute("data-clears"));
      expect(count).toBeGreaterThan(0);
      await expect(page.locator("#road-clears")).toHaveText(new RegExp(`^Clears ${count} building${count === 1 ? "" : "s"}`));
      // Marked: the layer has them as the ones to clear.
      expect(await page.evaluate(() => document.body.dataset["buildingsToClear"])).toBe(String(count));
      await shot(page, info, dir, "8-the-road-marks-and-counts-the-houses");
      const logBefore = (await log(page)).length;
      await click(page, x, ROWS[0]);
      await expect.poll(async () => (await log(page)).length).toBeGreaterThan(logBefore);
      expect((await log(page)).slice(logBefore).map((e) => e.type)).toContain("BuildRoad");
      await expect.poll(async () => (await buildings(page)).length).toBe(standing.length - count);
      const left = new Set((await buildings(page)).map((b) => b.id));
      expect(left.has(target.id)).toBe(false);
      await noTool(page);
      await settle(page);
      await shot(page, info, dir, "8-after-the-click-they-are-gone");
      await noteHomes("a road through the houses");
    });

    await test.step("9. bulldoze a built street: its cells and buildings go; undo brings back the street and its zoning, and buildings grow again", async () => {
      await look(page, BULLDOZED.x, BULLDOZED.z, 260);
      const seg = await segmentNear(page, BULLDOZED.x, BULLDOZED.z);
      expect(seg).toBeGreaterThanOrEqual(0);
      const sides = [`${seg}/0`, `${seg}/1`];
      const on = (await buildings(page)).filter((b) => sides.includes(b.strip));
      expect(on.length).toBeGreaterThan(0);
      const northCell = stripCell({ row: 4570, col: 3, north: true }, 2);
      const southCell = stripCell({ row: 4570, col: 3, north: false }, 2);
      const zonedBefore = [await cellZone(page, ...northCell), await cellZone(page, ...southCell)];
      expect(zonedBefore.map((c) => c?.zone)).toEqual([zoneNumber("mixed"), zoneNumber("residential")]);
      const zonesBefore = await zoning(page);
      await settle(page);
      await shot(page, info, dir, "9-the-built-street");

      await page.keyboard.press("KeyB");
      await expect(page.locator("#bulldoze-tool")).toHaveAttribute("aria-pressed", "true");
      // From straight above, so no tower beside the street stands in front of it on screen.
      const g = groundAt(BULLDOZED.x, BULLDOZED.z);
      await setPose(page, [BULLDOZED.x, g + 300, BULLDOZED.z + 1], [BULLDOZED.x, g, BULLDOZED.z]);
      await hover(page, BULLDOZED.x, BULLDOZED.z);
      const tag = page.locator("#bulldoze-tag");
      await expect(tag).toHaveAttribute("data-kind", "road");
      await expect(tag).toHaveAttribute("data-buildings", String(on.length));
      await shot(page, info, dir, "9-bulldoze-preview");
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => segmentNear(page, BULLDOZED.x, BULLDOZED.z)).toBe(-1);
      expect((await logTypes(page)).at(-1)).toBe("BulldozeRoad");
      // Its cells go with it, and the buildings on them.
      expect(await cellZone(page, ...northCell)).toBeNull();
      expect(await cellZone(page, ...southCell)).toBeNull();
      const ids = new Set(on.map((b) => b.id));
      expect((await buildings(page)).filter((b) => ids.has(b.id) && sides.includes(b.strip))).toEqual([]);
      await page.keyboard.press("KeyB");
      await away(page);
      await settle(page);
      await shot(page, info, dir, "9-bulldozed-cells-and-buildings-gone");

      await page.keyboard.press("Control+KeyZ");
      await expect.poll(() => segmentNear(page, BULLDOZED.x, BULLDOZED.z)).toBe(seg);
      expect((await logTypes(page)).at(-1)).toBe("Undo");
      await expect.poll(async () => [await cellZone(page, ...northCell), await cellZone(page, ...southCell)]).toEqual(zonedBefore);
      expect(await zoning(page)).toEqual(zonesBefore);
      // The buildings do not come back with it: the grower builds again.
      expect((await buildings(page)).filter((b) => sides.includes(b.strip))).toEqual([]);
      await settle(page);
      await shot(page, info, dir, "9-undo-street-and-zoning-back");
      await growUntil(page, "buildings on the street again", () => buildings(page), (bs) => sides.every((s) => bs.some((b) => b.strip === s)), 600_000);
      await settle(page);
      await shot(page, info, dir, "9-buildings-grow-again");
      await noteHomes("the street bulldozed and undone, and grown again");
    });

    await test.step("10. a street drawn beside a zoned strip: its end snaps to a cell corner", async () => {
      await look(page, (SHORT.x0 + SHORT.x1) / 2, SHORT.z + 40, 200);
      await zoneTool(page);
      await pick(page, "residential", 1);
      const before = (await log(page)).filter((e) => e.type === "ZoneCells").length;
      const mid = (SHORT.x0 + SHORT.x1) / 2;
      await hover(page, mid, SHORT.z + HALF / 2);
      await expect(page.locator("#zone-readout")).toHaveAttribute("data-ok", "true");
      await click(page, mid, SHORT.z + HALF / 2);
      await expect.poll(async () => (await log(page)).filter((e) => e.type === "ZoneCells").length).toBe(before + 1);
      // The strip's back row and its west end, from the copy.
      const backZ = SHORT.z + HALF + (DEPTH - 0.5) * CELL;
      let west = SHORT.x0;
      while (west < mid && ((await cellZone(page, west, backZ))?.zone ?? 0) === 0) west += 0.5;
      const strip = async () => {
        const out: boolean[] = [];
        for (let x = west + CELL / 2; x < SHORT.x1 - CELL; x += CELL) {
          for (let d = 0; d < DEPTH; d++) {
            const c = await cellZone(page, x, SHORT.z + HALF + (d + 0.5) * CELL);
            if (c) out.push(c.status === CELL_OPEN && c.zone !== 0);
          }
        }
        return out;
      };
      const whole = await strip();
      expect(whole.length).toBeGreaterThan(10 * DEPTH);
      expect(whole.every(Boolean)).toBe(true);
      await away(page);
      await shot(page, info, dir, "10-zoned-strip");

      await noTool(page);
      await page.keyboard.press("KeyR");
      await page.keyboard.press("KeyZ");
      await page.keyboard.press("KeyT");
      await expect(page.locator("#guide-cells")).toHaveAttribute("aria-pressed", "true");
      // Behind the strip, clear of its back, starting a few pixels off its west corner.
      const behind = SHORT.z + HALF + DEPTH * CELL + HALF + 0.25;
      const start = await hover(page, west - HALF - 0.25, behind, [5, -4]);
      expect(start?.kind).toBe("corner");
      await shot(page, info, dir, "10-the-start-snaps-to-the-corner");
      await click(page, west - HALF - 0.25, behind, [5, -4]);
      const logBefore = (await log(page)).length;
      const endX = west + 12 * CELL;
      const end = await hover(page, endX, behind, [-4, 5]);
      expect(["corner", "edge"]).toContain(end?.kind);
      await click(page, endX, behind, [-4, 5]);
      await expect.poll(async () => (await log(page)).length).toBe(logBefore + 1);
      const built = (await log(page)).at(-1)?.payload as { from: { x: number; z: number }; to: { x: number; z: number } };
      expect(built.from.x).toBeCloseTo(start?.x ?? NaN, 3);
      expect(built.from.z).toBeCloseTo(start?.z ?? NaN, 3);
      expect(built.from.z).toBeCloseTo(behind, 3);
      // Every cell of the strip is still open and zoned.
      await expect.poll(async () => (await strip()).every(Boolean)).toBe(true);
      await noTool(page);
      await zoneTool(page);
      await away(page);
      await shot(page, info, dir, "10-street-beside-the-strip-every-cell-whole");
      await noTool(page);
    });

    await test.step("11. zoom out: full meshes in the street band, simplified models in the district band, flat blocks by zone in the city band", async () => {
      const [gx, gz] = [4400, 4570];
      const g = groundAt(gx, gz);
      const target: Vec3 = [gx, g, gz];
      const chunk = Math.floor(gz / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(gx / CHUNK_SIZE);
      const bands: { band: string; position: Vec3; form: Form }[] = [
        { band: "street", position: [gx - 60, g + 210, gz + 230], form: "full" },
        { band: "district", position: [gx - 300, g + 900, gz + 1100], form: "simple" },
        { band: "city", position: [gx - 800, g + 3600, gz + 3000], form: "flat" },
      ];
      for (const { band, position, form } of bands) {
        await setPose(page, position, target);
        await settle(page);
        expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
        expect(await page.evaluate(async (c) => (await window.cityCouncil.view).buildingForm(c), chunk)).toBe(form);
        const s = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
        expect(s?.forms[form].buildings ?? 0).toBeGreaterThan(0);
        if (band !== "street") expect(s?.forms.full.buildings).toBe(0);
        if (band === "city") {
          expect(s?.forms.simple.meshes).toBe(0);
          expect(s?.forms.box.meshes).toBe(0);
        }
        await shot(page, info, dir, `11-${band}-band-${form}`);
      }
    });

    await test.step("12. switch between Low, Balanced and High: Balanced has shadows near the camera and Low none; the state hash does not change", async () => {
      const [gx, gz] = centre(R1_STRIP);
      const g = groundAt(gx, gz);
      const target: Vec3 = [gx, g, gz];
      await setPose(page, [gx + 60, g + 120, gz + 160], target);
      const select = page.locator("#graphics-preset");
      const hashes: Record<string, string> = {};
      for (const preset of ["low", "balanced", "high"] as const) {
        await select.selectOption(preset);
        await page.waitForFunction(() => document.body.dataset["presetSettled"] === "true", null, { timeout: 180_000 });
        await expect.poll(async () => (await page.evaluate(async () => (await window.cityCouncil.view).lighting())).preset, { timeout: 180_000 }).toBe(preset);
        const light = await page.evaluate(async () => (await window.cityCouncil.view).lighting());
        expect(light.shadows, preset).toBe(preset !== "low");
        if (preset !== "low") {
          const f = light.focus ?? [Infinity, Infinity, Infinity];
          expect(Math.hypot(f[0] - target[0], f[2] - target[2]), `${preset} shadow focus`).toBeLessThan(30);
        }
        await settle(page);
        await shot(page, info, dir, `12-${preset}`);
        hashes[preset] = (await page.evaluate(() => window.cityCouncil.downloadCity())).hash;
      }
      expect(hashes["balanced"]).toBe(hashes["low"]);
      expect(hashes["high"]).toBe(hashes["low"]);
      info.annotations.push({ type: "step 12", description: `state hash ${hashes["low"]} at every preset` });
      await select.selectOption("low");
      await expect.poll(async () => (await page.evaluate(async () => (await window.cityCouncil.view).lighting())).preset, { timeout: 180_000 }).toBe("low");
    });

    let saved = { roads: {} as Record<string, number[]>, zoning: { zone: [] as number[], density: [] as number[] }, buildings: [] as Building[], tints: [] as (Tint | null)[], log: [] as LogEntry[], tick: 0 };
    await test.step("13. reload the page: the same roads, zoning and buildings come back, in the same colours", async () => {
      const tick = Number(await page.locator("#sim-tick").textContent());
      const menu = await cityMenu(page);
      await menu.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("#save-status")).toContainText(`tick ${tick} at`);
      await closeCityMenu(page);
      const [gx, gz] = [4400, 4570];
      const g = groundAt(gx, gz);
      const pose: [Vec3, Vec3] = [[gx - 60, g + 210, gz + 230], [gx, g, gz]];
      await setPose(page, ...pose);
      await settle(page);
      const bs = await buildings(page);
      saved = { roads: await roads(page), zoning: await zoning(page), buildings: bs, tints: await tints(page, bs.map((b) => b.id)), log: await log(page), tick };
      // Through all the growth since step 5, nothing grew on the R3 strip that is too shallow for a tower.
      // Its key is read again: the streets drawn and bulldozed since may have renumbered its segment.
      const smallStrip = await stripKey(page, SMALL_R3);
      expect(bs.filter((b) => b.strip === smallStrip)).toEqual([]);
      expect(saved.tints.filter((t) => t !== null).length).toBeGreaterThan(20);
      await shot(page, info, dir, "13-before-reload");
      const id = (await status(page)).city.id;

      await page.reload();
      await ready(page);
      const after = await status(page);
      expect(after.loadedFrom).toBe("latest save");
      expect(after.city.id).toBe(id);
      expect(after.loadedTick).toBe(tick);
      expect(await roads(page)).toEqual(saved.roads);
      expect(await zoning(page)).toEqual(saved.zoning);
      expect(await buildings(page)).toEqual(saved.buildings);
      expect(await log(page)).toEqual(saved.log);
      await setPose(page, ...pose);
      await settle(page);
      // The same colours, building by building, for every one drawn before.
      const again = await tints(page, saved.buildings.map((b) => b.id));
      for (const [k, t] of saved.tints.entries()) if (t !== null) expect(again[k], `building ${saved.buildings[k]?.id}`).toEqual(t);
      await shot(page, info, dir, "13-after-reload");
    });

    await test.step("14. the top bar counts the homes built: up as houses grow, down when one is bulldozed, the same after the reload", async () => {
      await noteHomes("after the reload");
      const at = (when: string) => homes.find((h) => h.when === when)?.shown ?? NaN;
      expect(at("before any zoning")).toBe(0);
      expect(at("houses grew on the R1 strip")).toBeGreaterThan(0);
      expect(at("every zone grew")).toBeGreaterThan(at("houses grew on the R1 strip"));
      expect(at("the house cleared")).toBe(at("before the house is cleared") - 1);
      // Every figure the bar showed was the count of residential buildings in the copy.
      for (const h of homes) expect(h.shown, h.when).toBe(h.counted);
      expect(homes.at(-1)?.shown).toBe(homes.at(-2)?.shown);
      expect(homes.at(-1)?.shown).toBe(saved.buildings.filter((b) => b.zone === zoneNumber("residential")).length);
      info.annotations.push({ type: "homes", description: homes.map((h) => `${h.when}: ${h.shown}`).join("; ") });
      const topBar = join(SCREENSHOTS, dir, "14-homes-in-the-top-bar.png");
      await page.locator(".top-bar").screenshot({ path: topBar });
      await info.attach("14-homes-in-the-top-bar", { path: topBar, contentType: "image/png" });
    });

    await test.step("15. a replay of the recorded command log from the same seed gives the same state hash", async () => {
      const { header, state, pagedLog } = deserialize(await download(page, info, "replay"));
      expect(header.tick).toBe(saved.tick);
      const fullLog = [...pagedLog, ...state.log];
      expect(fullLog.map((e) => e.type)).toEqual(saved.log.map((e) => e.type));
      for (const e of fullLog) expect(["fixture", "local"]).toContain(e.playerId);
      for (const type of ["ZoneCells", "BuildRoad", "BulldozeBuilding", "BulldozeRoad", "Undo", "SetSpeed"]) expect(fullLog.map((e) => e.type)).toContain(type);
      const rebuilt = replay(header.seed, fullLog, header.tick);
      const hash = hashState(rebuilt);
      expect(hash).toBe(hashState(state));
      info.annotations.push({ type: "replay", description: `seed ${header.seed}, ${fullLog.length} commands, tick ${header.tick}, ${state.buildings.flags.filter((f) => f !== 0).length} buildings, hash ${hash}` });
    });
  });
}
