import { expect, test } from "@playwright/test";
import { heightAt, generateTerrain } from "../packages/sim/src/index";
import { MEASURE_VIEWPORT, drawnNow, poseAndSettle, writeReport, type Vec3 } from "./building-lod-helpers";
import { openCity } from "./helpers";
import { frameTime, perfFigures } from "./measure";
import { SEED } from "./road-fixtures";
import { scaleCityFile } from "./scale-city-files";
import { withCityHall } from "./city-hall-fixtures";

// Issue M4-17: the frame on the scale city of 500,000 residents in each zoom
// band, without City Hall and with it, from the same poses over its lot, for
// the pull request. City Hall is one building more, so the frame should not
// change past the noise of software WebGL. No test holds the times, which
// are the runner's as much as the city's; the draw calls and triangles are
// the same on every machine, so the spec holds those: City Hall adds at most
// one model's mesh near the camera and nothing past it.

declare const document: { body: { dataset: Record<string, string | undefined> } };

test.use({ viewport: MEASURE_VIEWPORT });

/** How long the page may take to open the city before the test gives up: it stops a hang and holds no speed. */
const OPEN_TIMEOUT_MS = 900_000;
const RESIDENTS = 500_000;
const FRAMES = 30;
const terrain = generateTerrain(SEED);

interface Band {
  band: string;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

test("the frame in each band on the 500,000 city, without City Hall and with it", async ({ page }) => {
  const base = scaleCityFile(RESIDENTS);
  const hall = withCityHall(base.bytes);
  const { x, z } = hall.middle;
  const g = heightAt(terrain, x, z);
  const poses: { band: string; position: Vec3; target: Vec3 }[] = [
    { band: "street", position: [x, g + 120, z + 180], target: [x, g, z] },
    { band: "district", position: [x, g + 900, z + 900], target: [x, g, z] },
    { band: "city", position: [x, g + 4000, z + 3000], target: [x, g, z] },
  ];
  const report: Record<string, Band[]> = {};
  for (const [name, bytes] of [
    ["without", base.bytes],
    ["with", hall.bytes],
  ] as const) {
    await openCity(page, bytes, { query: "webgl&preset=low&heldclock", name: `Scale ${name}`, timeout: OPEN_TIMEOUT_MS });
    const bands: Band[] = [];
    for (const { band, position, target } of poses) {
      await poseAndSettle(page, position, target);
      expect(await page.evaluate(() => document.body.dataset["zoomBand"])).toBe(band);
      const frameMs = Math.round((await frameTime(page, FRAMES)) * 10) / 10;
      const drawn = await drawnNow(page);
      bands.push({ band, frameMs, drawCalls: drawn.drawCalls, triangles: drawn.triangles });
    }
    report[name] = bands;
  }
  await writeReport(test.info(), "M4-17 the 500,000 city without City Hall and with it", "city-hall-frame-report.json", { residents: base.totals, hall: hall.middle, ...report });
  const figures: Record<string, number> = {};
  for (const name of ["without", "with"]) for (const b of report[name] ?? []) figures[`${b.band} band ${name} City Hall (ms)`] = b.frameMs;
  perfFigures("city-hall-frame", "500,000 city, frame with and without City Hall, Low", figures);
  // City Hall adds one model near the camera, at most a mesh and its scaffolding's, and past the street band nothing a frame draws on its own.
  for (const [i, b] of (report["with"] ?? []).entries()) {
    const before = report["without"]?.[i];
    expect(b.drawCalls - (before?.drawCalls ?? 0), b.band).toBeLessThanOrEqual(b.band === "street" ? 2 : 0);
  }
});
