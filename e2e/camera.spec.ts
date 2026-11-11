import { expect, test, type Page } from "@playwright/test";

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
type Vec3 = [number, number, number];
interface Hit {
  x: number;
  y: number;
  z: number;
}
interface Hooks {
  rig: {
    pose: { target: Hit; distance: number; yaw: number; pitch: number };
    setPose(position: Vec3, target: Vec3): void;
    pickGround(sx: number, sy: number): Hit | null;
    heightAboveGround(): number;
  };
  terrain: { samples: number; spacing: number; heights: Float32Array };
  lastPick: Hit | null | undefined;
  project(x: number, y: number, z: number): { x: number; y: number };
}
declare const window: { cityCouncil: { camera: Promise<Hooks> } };
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

const VIEWPORT = { width: 1280, height: 800 };
const CENTRE = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
/** The readout panel sits over the top-left corner; clicks stay clear of it. */
const PANEL = { right: 400, bottom: 460 };

test.use({ viewport: VIEWPORT });

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 15_000 });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Points the camera at ground point (x, z) from `distance` metres, `pitch` above the horizon, on bearing `yaw`. */
async function aim(page: Page, x: number, z: number, distance: number, pitch: number, yaw: number): Promise<Hit> {
  return page.evaluate(
    async ([x, z, distance, pitch, yaw]) => {
      const cam = await window.cityCouncil.camera;
      // Place the target first so the rig snaps it to the ground, then aim from there.
      cam.rig.setPose([x, 1000, z + 1000], [x, 0, z]);
      const t = cam.rig.pose.target;
      const flat = distance * Math.cos(pitch);
      cam.rig.setPose([t.x + flat * Math.sin(yaw), t.y + distance * Math.sin(pitch), t.z + flat * Math.cos(yaw)], [t.x, t.y, t.z]);
      return { x: t.x, y: t.y, z: t.z };
    },
    [x, z, distance, pitch, yaw] as const,
  );
}

/** Clicks screen point (sx, sy) and returns what the page picked. */
async function clickAt(page: Page, sx: number, sy: number): Promise<Hit> {
  await page.evaluate(async () => {
    (await window.cityCouncil.camera).lastPick = undefined;
  });
  await page.mouse.click(sx, sy);
  const hit = await page.evaluate(async () => (await window.cityCouncil.camera).lastPick);
  if (!hit) throw new Error(`click at ${sx}, ${sy} picked nothing`);
  await expect(page.locator("#pick-world")).toHaveText(`${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}, ${hit.z.toFixed(1)} m`);
  return hit;
}

function within1m(hit: Hit, want: Hit): void {
  const d = Math.hypot(hit.x - want.x, hit.y - want.y, hit.z - want.z);
  expect(d, `picked ${JSON.stringify(hit)}, wanted ${JSON.stringify(want)}`).toBeLessThan(1);
}

async function mapSize(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const t = (await window.cityCouncil.camera).terrain;
    return t.samples * t.spacing;
  });
}

test("a click with a fixed camera picks the ground under it, within 1 m", async ({ page }, testInfo) => {
  await ready(page);
  // The screen centre: the camera looks at a known ground point.
  const target = await aim(page, 4200, 6800, 2400, 0.75, 0.4);
  await frames(page);
  within1m(await clickAt(page, CENTRE.x, CENTRE.y), target);

  // An off-centre point: project a known ground point with the camera's own
  // matrices and click where it lands.
  const other = await page.evaluate(async () => {
    const cam = await window.cityCouncil.camera;
    const t = cam.rig.pose.target;
    const x = t.x + 350;
    const z = t.z + 220;
    // The expected height, read from the heights directly: bilinear, as the sim's heightAt.
    const h = cam.terrain;
    const gx = x / h.spacing;
    const gz = z / h.spacing;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const at = (a: number, b: number) => h.heights[b * h.samples + a] ?? 0;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * (gx - i);
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * (gx - i);
    const y = top + (bottom - top) * (gz - j);
    return { world: { x, y, z }, screen: cam.project(x, y, z) };
  });
  expect(other.screen.x).toBeGreaterThan(PANEL.right);
  expect(other.screen.x).toBeLessThan(VIEWPORT.width);
  within1m(await clickAt(page, other.screen.x, other.screen.y), other.world);
  await page.mouse.move(other.screen.x, other.screen.y);
  await frames(page);
  await expect(page.locator("#cursor-world")).toHaveText(/^[\d.]+, [\d.]+, [\d.]+ m$/);
  await testInfo.attach("fixed camera, cursor marker on the picked point", { body: await page.screenshot(), contentType: "image/png" });
});

test("picking works at the map edge and on the steepest slope", async ({ page }, testInfo) => {
  await ready(page);
  const size = await mapSize(page);

  // Map edges: look at a point half a metre inside each edge from the map side.
  for (const [x, z, yaw] of [
    [size - 0.5, 6000, -Math.PI / 2],
    [0.5, 6000, Math.PI / 2],
    [6000, size - 0.5, Math.PI],
    [6000, 0.5, 0],
  ] as const) {
    // Bearing points from the target to the camera, so the camera stands inside the map.
    const target = await aim(page, x, z, 1500, 0.8, yaw + Math.PI);
    await frames(page);
    within1m(await clickAt(page, CENTRE.x, CENTRE.y), target);
  }
  await testInfo.attach("map edge", { body: await page.screenshot(), contentType: "image/png" });

  // The steepest sample on the map, found from the heights the page holds.
  const steep = await page.evaluate(async () => {
    const t = (await window.cityCouncil.camera).terrain;
    const n = t.samples;
    let best = { i: 1, j: 1, s: -1 };
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const dx = (t.heights[j * n + i + 1] ?? 0) - (t.heights[j * n + i - 1] ?? 0);
        const dz = (t.heights[(j + 1) * n + i] ?? 0) - (t.heights[(j - 1) * n + i] ?? 0);
        const s = Math.hypot(dx, dz) / (2 * t.spacing);
        if (s > best.s) best = { i, j, s };
      }
    }
    return { x: best.i * t.spacing, z: best.j * t.spacing, slope: best.s };
  });
  expect(steep.slope).toBeGreaterThan(0.5);
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const target = await aim(page, steep.x, steep.z, 700, 1.1, yaw);
    await frames(page);
    within1m(await clickAt(page, CENTRE.x, CENTRE.y), target);
  }
  await testInfo.attach("steepest slope", { body: await page.screenshot(), contentType: "image/png" });
});

test("the camera stays above the terrain and keeps the map in view", async ({ page }, testInfo) => {
  // Software WebGL on CI takes up to a second a frame for low views, and
  // each mouse event waits for one.
  test.slow();
  await ready(page);
  const size = await mapSize(page);
  const clearance = () => page.evaluate(async () => (await window.cityCouncil.camera).rig.heightAboveGround());

  // Asked to go under the ground, it stays above it.
  await page.evaluate(async () => {
    const cam = await window.cityCouncil.camera;
    cam.rig.setPose([6000, -300, 6100], [6000, 0, 6000]);
  });
  expect(await clearance()).toBeGreaterThanOrEqual(19.99);

  // Wheel in on the steepest slope and hold the tilt-down key. Each input
  // waits for a frame, so start close and use few of them.
  await page.evaluate(async () => {
    const cam = await window.cityCouncil.camera;
    const t = cam.terrain;
    const n = t.samples;
    let best = { i: 1, j: 1, s: -1 };
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const dx = (t.heights[j * n + i + 1] ?? 0) - (t.heights[j * n + i - 1] ?? 0);
        const dz = (t.heights[(j + 1) * n + i] ?? 0) - (t.heights[(j - 1) * n + i] ?? 0);
        const s = Math.hypot(dx, dz);
        if (s > best.s) best = { i, j, s };
      }
    }
    const x = best.i * t.spacing;
    const z = best.j * t.spacing;
    cam.rig.setPose([x, 2000, z + 300], [x, 0, z]);
  });
  await page.mouse.move(CENTRE.x, CENTRE.y);
  for (let k = 0; k < 6; k++) {
    await page.mouse.wheel(0, -800);
    expect(await clearance()).toBeGreaterThanOrEqual(19.99);
  }
  // The tilt stops where the ground would come too close, so hold the key
  // for a number of frames, not until the pitch reaches some value.
  const pitch0 = await page.evaluate(async () => (await window.cityCouncil.camera).rig.pose.pitch);
  await page.keyboard.down("KeyF");
  for (let k = 0; k < 4; k++) {
    await frames(page);
    expect(await clearance()).toBeGreaterThanOrEqual(19.99);
  }
  await page.keyboard.up("KeyF");
  expect(await page.evaluate(async () => (await window.cityCouncil.camera).rig.pose.pitch)).toBeLessThan(pitch0);
  expect(await clearance()).toBeGreaterThanOrEqual(19.99);
  await testInfo.attach("zoomed in on the steepest slope and tilted down", { body: await page.screenshot(), contentType: "image/png" });

  // From high up, drag the map away again and again, then wheel all the way out.
  await page.evaluate(async () => (await window.cityCouncil.camera).rig.setPose([6000, 6000, 12000], [6000, 0, 6000]));
  for (let k = 0; k < 6; k++) {
    await page.mouse.move(CENTRE.x + 100, CENTRE.y);
    await page.mouse.down();
    await page.mouse.move(VIEWPORT.width - 20, VIEWPORT.height - 20, { steps: 2 });
    await page.mouse.up();
  }
  for (let k = 0; k < 8; k++) await page.mouse.wheel(0, 800);
  const pose = await page.evaluate(async () => (await window.cityCouncil.camera).rig.pose);
  expect(pose.target.x).toBeGreaterThanOrEqual(0);
  expect(pose.target.x).toBeLessThanOrEqual(size);
  expect(pose.target.z).toBeGreaterThanOrEqual(0);
  expect(pose.target.z).toBeLessThanOrEqual(size);
  expect(pose.distance).toBeLessThanOrEqual(20_000);
  // The ground is still under the middle of the screen.
  const centre = await page.evaluate(
    async ([x, y]) => (await window.cityCouncil.camera).rig.pickGround(x, y),
    [CENTRE.x, CENTRE.y] as const,
  );
  expect(centre).not.toBeNull();
  await frames(page);
  await expect(page.locator("#cam-band")).toHaveText("city");
  await testInfo.attach("dragged off and zoomed out", { body: await page.screenshot(), contentType: "image/png" });
});

test("the readout shows the zoom band and it changes at the configured heights", async ({ page }, testInfo) => {
  await ready(page);
  for (const [height, band] of [
    [450, "street"],
    [550, "district"],
    [2900, "district"],
    [3100, "city"],
  ] as const) {
    await page.evaluate(async (h) => {
      const cam = await window.cityCouncil.camera;
      cam.rig.setPose([6000, 1000, 7000], [6000, 0, 6000]);
      const t = cam.rig.pose.target;
      // Nearly straight down, so the ground below the camera is the target's.
      cam.rig.setPose([t.x, t.y + h, t.z + 1], [t.x, t.y, t.z]);
    }, height);
    await frames(page);
    await expect(page.locator("#cam-band")).toHaveText(band);
    const shown = Number((await page.locator("#cam-height").textContent())?.replace(" m", ""));
    expect(Math.abs(shown - height)).toBeLessThan(30);
    if (band !== "district" || height === 550) {
      await testInfo.attach(`${band} band at ${height} m`, { body: await page.screenshot(), contentType: "image/png" });
    }
  }
});
