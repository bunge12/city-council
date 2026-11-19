import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  BUILDING_TYPES,
  buildingCount,
  buildingInfo,
  cellAt,
  createState,
  findLot,
  serialize,
  step,
  submit,
  syncCells,
  type SimState,
} from "../packages/sim/src/index";
import { addBuilding } from "../packages/sim/src/buildings/buildings";
import { finishConstruction } from "./building-fixtures";
import { SEED, buildRoads, groundAt } from "./road-fixtures";
import { settleView, withFlush } from "./settle";

// Issue M2-14: through-lots. Two blocks between three parallel streets
// twelve cells apart, closed at both ends, on seed 2026's flat square. The
// north block is zoned C3 and the south one I3 on both strips, and each
// takes a big building across the whole block from one street to the next,
// with lots on one strip beside it. Built in Node with the sim and imported
// as a city file, like the buildings walkthrough.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: {
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
    view: Promise<{ buildingStats(): { buildings: number } | null; decorCounts(): { trees: number; grass: number } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
test.setTimeout(180_000);

const WEST = 4200;
const EAST = 4400;
/** The three streets' centre lines: road edges 96 m apart, two strips of six 8 m cells. */
const STREETS = [4600, 4706, 4812];
const HALF = 5;

interface Fixture {
  bytes: Buffer;
  state: SimState;
  buildings: number;
  through: number[];
}

/** Adds the lot the finder gives at the front cell under (x, z), if any. */
function buildAt(state: SimState, x: number, z: number, variant: number): boolean {
  const cell = cellAt(state, x, z);
  if (!cell || cell.depth !== 0) return false;
  const result = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
  if (!result.ok) return false;
  const type = BUILDING_TYPES[result.lot.type];
  if (!type) return false;
  addBuilding(state, { ...result.lot, residents: type.residents[0], variant });
  return true;
}

function throughLotCity(): Fixture {
  const state = createState(SEED);
  buildRoads(state, [
    ...STREETS.map((z) => [[WEST, z], [EAST, z], "street"] as [[number, number], [number, number], string]),
    [[WEST, STREETS[0] as number], [WEST, STREETS[2] as number], "street"],
    [[EAST, STREETS[0] as number], [EAST, STREETS[2] as number], "street"],
  ]);
  let seq = 0;
  for (const [zone, k] of [["commercial", 0], ["industrial", 1]] as const) {
    const mid = ((STREETS[k] as number) + (STREETS[k + 1] as number)) / 2;
    const payload = { zone, density: 3, rects: [{ from: { x: WEST + 2 * HALF + 2, z: mid }, to: { x: EAST - 2 * HALF - 2, z: mid }, width: 92 }] };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "ZoneCells", payload });
    if (!result.ok) throw new Error(`zoning refused: ${result.reason}`);
    step(state);
  }
  syncCells(state);
  let variant = 0;
  // Each block's north strip first, west to east, so the through-lots go in
  // before lots on one strip fill the rest; then every strip again.
  const strips = [STREETS[0] as number, STREETS[1] as number].map((z) => z + HALF + 4);
  const backs = [STREETS[1] as number, STREETS[2] as number].map((z) => z - HALF - 4);
  for (const z of strips) for (let x = WEST + 4; x < EAST; x += 8) if (buildAt(state, x, z, variant)) variant++;
  for (const z of [...strips, ...backs]) for (let x = WEST + 4; x < EAST; x += 8) if (buildAt(state, x, z, variant)) variant++;
  const through: number[] = [];
  state.buildings.flags.forEach((f, id) => f && (state.buildings.backDepth[id] ?? 0) > 0 && through.push(id));
  finishConstruction(state);
  // Saved paused, so nothing grows while the test looks.
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), state, buildings: buildingCount(state.buildings), through };
}

const fixture = throughLotCity();

async function openCity(page: Page, query: string): Promise<void> {
  await page.goto(withFlush(`/${query}`));
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "Through-lots.city", mimeType: "application/octet-stream", buffer: fixture.bytes });
  await loaded;
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.waitForFunction(
    (count) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(count),
    fixture.buildings,
    { timeout: 120_000 },
  );
}

async function look(page: Page, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
  // Decoration fills in near the camera over a few frames: wait for its counts to hold.
  await settleView(page);
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  // The canvas fills the page, so the page's screenshot is the view's. A
  // locator's waits for the canvas to hold still over animation frames,
  // which in software WebGL take most of a second each: 15 s a shot against 6.
  const shot = await page.screenshot();
  await page.addStyleTag({ content: "#ui { display: block !important; }" });
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("the fixture has a through-lot on each block, each fronting two streets", () => {
  const types = fixture.through.map((id) => BUILDING_TYPES[fixture.state.buildings.type[id] ?? 0]?.zone);
  expect(types).toContain("commercial");
  expect(types).toContain("industrial");
  for (const id of fixture.through) {
    const zs = (buildingInfo(fixture.state, id)?.corners ?? []).filter((_, i) => i % 2 === 1);
    // From one street's edge to the next one's, 96 m.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(96, 0);
  }
});

test("through-lot buildings draw across their blocks", async ({ page }, testInfo) => {
  // About 2 minutes on a fast CI runner, from three poses that each wait for
  // decoration to settle in software WebGL: 3 minutes left no room for a slow one.
  test.setTimeout(300_000);
  await openCity(page, "?webgl&preset=balanced");
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  expect(stats?.buildings).toBe(fixture.buildings);
  const cx = (WEST + EAST) / 2;
  const cz = STREETS[1] as number;
  const g = groundAt(cx, cz);
  await look(page, [cx + 120, g + 190, cz + 230], [cx, g, cz]);
  await shoot(page, testInfo, "both blocks from the south-east");
  await look(page, [cx - 10, g + 330, cz + 40], [cx, g, cz]);
  await shoot(page, testInfo, "both blocks from above");
  const north = ((STREETS[0] as number) + cz) / 2;
  await look(page, [cx + 60, g + 70, north + 110], [cx, g + 5, north]);
  await shoot(page, testInfo, "the C3 block, low");
});
