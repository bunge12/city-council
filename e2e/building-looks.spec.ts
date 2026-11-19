import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { BUILDING_TYPES, buildingInfo } from "../packages/sim/src/index";
import { builtFixtureCity, downtownFixtureCity } from "./building-fixtures";
import { groundAt } from "./road-fixtures";

// Issue #137: the look and detail of the buildings. A downtown of towers,
// slabs and podiums, and the street of every type, drawn close up and from
// further out, for the pull request: glass that does not read as asphalt,
// no roof to see into, no tree through a wall, and towers that differ.
// On WebGL 2, Balanced, in the evidence project (issue #225), which takes
// pictures and does not gate a merge. That every building is drawn, in many
// models, is held in the required check by downtown.spec.ts.

type Vec3 = [number, number, number];
interface BuildingStats {
  buildings: number;
  models: number;
  pending: number;
}
declare const window: {
  cityCouncil: {
    view: Promise<{ buildingStats(): BuildingStats | null; decorCounts(): { trees: number; grass: number } }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
// Each test opens a city of towers and takes several screenshots in software
// WebGL. The downtown test took 2.3 minutes on an EPYC 9V45 runner and ran out
// of five minutes on an EPYC 9V74, in its last close-ups both times. Slow
// runners take about twice as long (issue #152), so eight minutes.
test.setTimeout(480_000);

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

async function openCity(page: Page, name: string, city: { bytes: Buffer; buildings: number }): Promise<void> {
  await page.goto("/?webgl&preset=balanced");
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: `${name}.city`, mimeType: "application/octet-stream", buffer: city.bytes });
  await loaded;
  await ready(page);
  await page.waitForFunction(
    (count) => document.body.dataset["buildingsPending"] === "0" && document.body.dataset["buildingsDrawn"] === String(count),
    city.buildings,
    { timeout: 120_000 },
  );
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
}

/** Waits until decoration near the camera has finished building: its counts hold for ten frames. */
async function settle(page: Page): Promise<void> {
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

async function shoot(page: Page, testInfo: TestInfo, name: string, position: Vec3, target: Vec3): Promise<void> {
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [position, target] as const);
  await settle(page);
  const shot = await page.locator("#view").screenshot();
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, shot);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** A view of building `id` from in front of it and to one side, `back` lot sizes away. */
function frame(state: Parameters<typeof buildingInfo>[0], id: number, back = 1.6): { position: Vec3; target: Vec3 } {
  const c = buildingInfo(state, id)?.corners;
  if (!c) throw new Error(`no lot for building ${id}`);
  const at = (k: number) => c[k] ?? 0;
  const x = (at(0) + at(2) + at(4) + at(6)) / 4;
  const z = (at(1) + at(3) + at(5) + at(7)) / 4;
  // From the back of the lot to the road, and along the road.
  const fx = (at(0) + at(6) - at(2) - at(4)) / 2;
  const fz = (at(1) + at(7) - at(3) - at(5)) / 2;
  const sx = at(6) - at(0);
  const sz = at(7) - at(1);
  const f = Math.hypot(fx, fz);
  const s = Math.hypot(sx, sz);
  const size = Math.max(f, s, 30);
  const g = groundAt(x, z);
  return {
    position: [x + (fx / f) * size * back + (sx / s) * size * 0.7, g + size * 1.3, z + (fz / f) * size * back + (sz / s) * size * 0.7],
    target: [x, g + size * 0.35, z],
  };
}

/** The first building of each of these types in `state`. */
function firstOf(state: Parameters<typeof buildingInfo>[0], ids: readonly string[]): { type: string; id: number }[] {
  const b = state.buildings;
  return ids.flatMap((type) => {
    const index = BUILDING_TYPES.findIndex((t) => t.id === type);
    const id = b.flags.findIndex((f, k) => f !== 0 && b.type[k] === index);
    return id >= 0 ? [{ type, id }] : [];
  });
}

test("a downtown's towers come in many shapes, with glass that is not asphalt", async ({ page }, testInfo) => {
  const city = downtownFixtureCity();
  await openCity(page, "Downtown", city);
  const stats = await page.evaluate(async () => (await window.cityCouncil.view).buildingStats());
  expect(stats?.buildings).toBe(city.buildings);
  // Many models in use: each type's buildings draw several of its shapes.
  const towers = BUILDING_TYPES.filter((t) => t.density === 3 && t.zone !== "industrial" && !t.throughLot && (city.counts[t.index] ?? 0) > 0);
  expect(towers.length).toBeGreaterThan(8);
  expect(stats?.models ?? 0).toBeGreaterThan(towers.length * 2);
  testInfo.annotations.push({ type: "downtown", description: `${city.buildings} buildings of ${towers.length} types in ${stats?.models} models` });

  const ground = groundAt(4250, 4600);
  await shoot(page, testInfo, "downtown, over the grid", [4250 - 60, ground + 260, 4600 + 280], [4250 + 20, ground + 30, 4600 + 10]);
  await shoot(page, testInfo, "downtown, along the avenue", [4520, ground + 120, 4980], [4430, ground + 40, 4800]);
  for (const { type, id } of firstOf(city.state, ["office-tower", "tall-office-tower", "podium-tower", "office-slab"])) {
    const v = frame(city.state, id);
    await shoot(page, testInfo, `close up, ${type}`, v.position, v.target);
  }
});

test("every type up close: closed roofs, no trees through walls, light glass", async ({ page }, testInfo) => {
  const city = builtFixtureCity();
  await openCity(page, "Built", city);
  for (const { type, id } of firstOf(city.state, ["single-family-home", "townhomes", "apartments", "shop-row", "small-factory"])) {
    const v = frame(city.state, id);
    await shoot(page, testInfo, `close up, ${type}`, v.position, v.target);
  }
});
