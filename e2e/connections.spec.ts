import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import fixture from "../packages/sim/test/fixtures/connections.json" with { type: "json" };
import { decodePng, type Image } from "./png";

// Issue M1-16: outside connections. A new city starts with two or three
// highway stubs at the map edge, the camera looks at one, each is marked
// so the player can find it from the city band, and the player builds out
// from a stub's end. The places match the ones Node computes.

type Vec3 = readonly [number, number, number];
interface Place {
  x: number;
  z: number;
  innerX: number;
  innerZ: number;
}
declare const window: {
  cityCouncil: {
    connectionsCheck(seed: number): Place[];
    mirror: {
      state: {
        seed: number;
        connections: ArrayLike<number>;
        roads: { nodeX: ArrayLike<number>; nodeZ: ArrayLike<number>; nodeHeight: ArrayLike<number>; segFlags: ArrayLike<number> };
      } | null;
    };
    sendCommand(type: string, payload: unknown): Promise<{ ok: boolean; reason?: string }>;
    camera: Promise<{
      rig: {
        setPose(position: Vec3, target: Vec3): void;
        pose: { target: { x: number; y: number; z: number }; distance: number };
        zoomBand(): string;
      };
      project(x: number, y: number, z: number): { x: number; y: number };
    }>;
  };
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

for (const { seed, connections } of fixture.seeds) {
  test(`connections for seed ${seed} match the Node places`, async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => "cityCouncil" in globalThis);
    expect(await page.evaluate((s) => window.cityCouncil.connectionsCheck(s), seed)).toEqual(connections);
  });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<Image> {
  const path = testInfo.outputPath(`${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
  const png = await page.screenshot();
  writeFileSync(path, png);
  await testInfo.attach(name, { path, contentType: "image/png" });
  return decodePng(png);
}

/** The new city's connections as the mirror holds them: edge node and stub end, with heights. */
async function placed(page: Page): Promise<{ x: number; y: number; z: number; ix: number; iy: number; iz: number }[]> {
  return page.evaluate(() => {
    const s = window.cityCouncil.mirror.state;
    if (!s) return [];
    const r = s.roads;
    // Each stub's inner end is the node its edge node's segment leads to; a
    // new city has nothing else, so it is the next node id.
    return Array.from(s.connections, (edge) => ({
      x: r.nodeX[edge] ?? 0,
      y: r.nodeHeight[edge] ?? 0,
      z: r.nodeZ[edge] ?? 0,
      ix: r.nodeX[edge + 1] ?? 0,
      iy: r.nodeHeight[edge + 1] ?? 0,
      iz: r.nodeZ[edge + 1] ?? 0,
    }));
  });
}

/** Pixels of the marks' road-sign blue in the square of `half` pixels around (cx, cy). */
function bluePixels(image: Image, cx: number, cy: number, half: number): number {
  let n = 0;
  for (let y = Math.round(cy - half); y <= cy + half; y++) {
    for (let x = Math.round(cx - half); x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      const r = image.rgba[i] ?? 0;
      const g = image.rgba[i + 1] ?? 0;
      const b = image.rgba[i + 2] ?? 0;
      if (b - r > 120 && b - g > 60) n++;
    }
  }
  return n;
}

test("a new city starts looking at a connection, and every connection is marked from the city band", async ({ page }, testInfo) => {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
  const list = await placed(page);
  expect(list.length).toBeGreaterThanOrEqual(2);
  expect(list.length).toBeLessThanOrEqual(3);
  await expect.poll(() => page.evaluate(() => document.body.dataset["connectionMarks"])).toBe(String(list.length));

  // The camera starts on the first connection, looking in along its stub.
  const first = list[0];
  if (!first) throw new Error("no connection");
  const start = await page.evaluate(async () => {
    const cam = await window.cityCouncil.camera;
    return { target: cam.rig.pose.target, band: cam.rig.zoomBand() };
  });
  expect(start.band).toBe("district");
  const ux = (first.ix - first.x) / 200;
  const uz = (first.iz - first.z) / 200;
  const ahead = (start.target.x - first.ix) * ux + (start.target.z - first.iz) * uz;
  expect(ahead).toBeGreaterThan(0);
  expect(ahead).toBeLessThan(1000);
  await frames(page);
  const opening = await attach(page, testInfo, "1 a new city opens on an outside connection");
  const atEdge = await page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [first.x, first.y, first.z] as const);
  expect(bluePixels(opening, atEdge.x, atEdge.y, 40)).toBeGreaterThan(100);

  // The whole map from straight above and high up: each connection has its mark.
  await page.evaluate(async () => (await window.cityCouncil.camera).rig.setPose([6000, 18_000, 6400], [6000, 0, 6000]));
  await frames(page);
  expect(await page.evaluate(async () => (await window.cityCouncil.camera).rig.zoomBand())).toBe("city");
  const whole = await attach(page, testInfo, "2 every connection is marked from the city band");
  for (const c of list) {
    const p = await page.evaluate(async ([x, y, z]) => (await window.cityCouncil.camera).project(x, y, z), [c.x, c.y, c.z] as const);
    expect(bluePixels(whole, p.x, p.y, 30), `mark at ${c.x}, ${c.z}`).toBeGreaterThan(100);
  }
});

test("the player builds a street from a stub's end, and cannot bulldoze the stub", async ({ page }, testInfo) => {
  await page.goto("/?webgl");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
  await page.addStyleTag({ content: ".notes { display: none !important; }" });
  const [first] = await placed(page);
  if (!first) throw new Error("no connection");
  const ux = (first.ix - first.x) / 200;
  const uz = (first.iz - first.z) / 200;
  const built = await page.evaluate(
    (p) => window.cityCouncil.sendCommand("BuildRoad", p),
    { from: { x: first.ix, z: first.iz }, to: { x: first.ix + ux * 400, z: first.iz + uz * 400 }, type: "street" },
  );
  expect(built).toEqual({ ok: true });
  const bulldoze = await page.evaluate(() => window.cityCouncil.sendCommand("BulldozeRoad", { segments: [0] }));
  expect(bulldoze.ok).toBe(false);
  expect(bulldoze.reason).toMatch(/fixed and cannot be bulldozed/);
  // Closer in, from the side, so the stub, its mark and the street off its end all show.
  const tx = first.ix + ux * 100;
  const tz = first.iz + uz * 100;
  await page.evaluate(
    async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t),
    [
      [tx - ux * 200 - uz * 600, first.iy + 700, tz - uz * 200 + ux * 600],
      [tx, first.iy, tz],
    ] as const,
  );
  await frames(page);
  await frames(page);
  await attach(page, testInfo, "3 a street built from the end of a stub");
});
