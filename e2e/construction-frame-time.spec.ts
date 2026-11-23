import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CONSTRUCTION } from "../packages/client/src/render/config";
import { buildingCount, serialize } from "../packages/sim/src/index";
import { builtFixtureCity } from "./building-fixtures";
import { buildingsDrawn, canvasShot, openCity, settle } from "./helpers";
import { frameTime, perfFigures } from "./measure";
import { groundAt } from "./road-fixtures";

// Issue 136: the frame time with a few hundred buildings under construction
// at Balanced, beside the same city with the animation off. In the perf
// project (issue #225): it measures and holds nothing. The animation itself
// is construction.spec.ts.

type Vec3 = [number, number, number];
declare const window: {
  cityCouncil: { camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }> };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: { width: 1280, height: 800 } });
// Two page loads of a street under scaffolding at Balanced, drawn in software.
test.setTimeout(480_000);

const T = CONSTRUCTION.ticks;

/** The building fixture paused, every building `age` ticks old, with no zoning left so nothing new grows. */
function newCity(age: number): { bytes: Buffer; buildings: number } {
  const { state } = builtFixtureCity();
  state.tick = 1000;
  state.buildings.builtAt.fill(state.tick - age);
  // In use since it was built (M3-24): a save checks it is no earlier.
  state.buildings.statusSince.fill(state.tick - age);
  state.cells.zone.fill(0);
  state.cells.density.fill(0);
  state.speed = 0;
  return { bytes: Buffer.from(serialize(state)), buildings: buildingCount(state.buildings) };
}

const dataset = (page: Page, key: string) => page.evaluate((key) => document.body.dataset[key], key);

async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const GRID = { x: 4250, z: 4600 };
const ground = groundAt(GRID.x, GRID.z);

test("frame time with a few hundred buildings under construction, at Balanced", async ({ page }, testInfo) => {
  const results: Record<string, number> = {};
  const far: { position: Vec3; target: Vec3 } = { position: [GRID.x - 60, ground + 210, GRID.z + 230], target: [GRID.x + 20, ground, GRID.z + 10] };
  // Every building mid-rise, under scaffolding. Paused, so a slow runner measures the same stage throughout: the stages are worked out per vertex every frame, running or not.
  const mid = newCity(Math.round(T * 0.4));
  for (const query of ["?webgl&preset=balanced", "?webgl&preset=balanced&noconstruction"]) {
    await openCity(page, mid.bytes, { query, name: "new" });
    await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [far.position, far.target] as const);
    await buildingsDrawn(page, mid.buildings);
    await settle(page);
    const off = query.includes("noconstruction");
    expect(Number(await dataset(page, "buildingsUnderConstruction"))).toBe(off ? 0 : mid.buildings);
    results[off ? "off" : "on"] = await frameTime(page, 30);
    await attach(testInfo, off ? "animation off" : "under construction", await canvasShot(page));
  }
  const report = { buildings: mid.buildings, frameMs: results, ticks: T };
  await testInfo.attach("frame time", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  perfFigures("construction", `${mid.buildings} buildings under construction, Balanced, WebGL 2`, {
    "under construction (ms)": results["on"],
    "animation off (ms)": results["off"],
  });
  console.log(`frame time with ${mid.buildings} buildings under construction at Balanced: ${results["on"]?.toFixed(1)} ms; animation off: ${results["off"]?.toFixed(1)} ms`);
});
