import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { zonedFixtureCity } from "./cell-fixtures";
import { groundAt } from "./road-fixtures";

// Issue M2-10: the grower. Buildings are not drawn until issue 12, so this
// checks what the page can show now: buildings arrive in the page's copy of
// the city over game time, and the debug panel times the grower as its own
// system.
//
// The city is the road fixture with every zone at every density painted
// along its streets (cell-fixtures.ts), imported as a city file.

type Vec3 = [number, number, number];
interface SceneObject {
  name: string;
  count?: number;
  traverseVisible(callback: (o: SceneObject) => void): void;
}
declare const window: {
  cityCouncil: {
    sendCommand(type: string, payload?: unknown): Promise<{ ok: boolean; reason?: string }>;
    mirror: { state: { tick: number; buildings: { flags: Uint8Array; residents: Int32Array } } | null };
    view: Promise<{
      scene: SceneObject;
      renderer: { domElement: { toDataURL(type: string): string } };
      onFrame(listener: (stats: { drawn: boolean }) => void): void;
      buildingStats(): { buildings: number } | null;
      decorCounts(): { trees: number; grass: number };
    }>;
    camera: Promise<{ rig: { setPose(position: Vec3, target: Vec3): void } }>;
  };
  growthFrames?: { trees: number; buildings: number; shot: string | null }[];
};
declare const document: { body: { dataset: Record<string, string | undefined> } };
declare function requestAnimationFrame(callback: () => void): number;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset["renderReady"] === "true", null, { timeout: 60_000 });
}

/** Live buildings in the page's copy of the city, and the residents they hold room for. */
async function grown(page: Page): Promise<{ buildings: number; residents: number }> {
  return page.evaluate(() => {
    const b = window.cityCouncil.mirror.state?.buildings;
    let buildings = 0;
    let residents = 0;
    b?.flags.forEach((f, id) => {
      if (f === 0) return;
      buildings++;
      residents += b.residents[id] ?? 0;
    });
    return { buildings, residents };
  });
}

test("buildings grow on zoned cells over game time, and the debug panel times the grower", async ({ page }, info) => {
  const { bytes } = zonedFixtureCity();
  await page.goto("/?debug&webgl&preset=low");
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "zoned.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  expect(await grown(page)).toEqual({ buildings: 0, residents: 0 });

  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  // One building a game day: a day is 100 ticks, 2.5 s at 4x.
  await expect.poll(async () => (await grown(page)).buildings, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const { buildings, residents } = await grown(page);
  expect(residents).toBeGreaterThan(0);

  const timings = page.locator("#sim-timings");
  await expect(timings).toContainText("grower");
  const debug = page.getByRole("region", { name: "Debug panel" });
  await debug.screenshot({ path: info.outputPath("debug-panel.png") });
  await page.screenshot({ path: info.outputPath("page.png") });
  await info.attach("grown", { body: JSON.stringify({ buildings, residents, tick: await page.locator("#sim-tick").textContent() }), contentType: "application/json" });
});

// Issue 141: a building coming onto a lot changes the decoration mask of the
// chunks its lot touches. That chunk's trees used to be dropped and built
// again on the next frame, so every tree in it blinked out for a frame or
// more each time a building grew. Here every frame of a few game days of
// growth counts the trees drawn: none may dip for a frame and come back.
test("trees near new buildings stay drawn while the city grows", async ({ page }, info) => {
  const { bytes } = zonedFixtureCity();
  await page.goto("/?webgl&preset=low");
  await ready(page);
  const loaded = page.waitForEvent("load");
  await page.locator("#import-file").setInputFiles({ name: "zoned.city", mimeType: "application/octet-stream", buffer: bytes });
  await loaded;
  await ready(page);
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  // Low over the fixture's street grid, where the zoned blocks have trees on them.
  const grid = { x: 4250, z: 4600 };
  const ground = groundAt(grid.x, grid.z);
  await page.evaluate(async ([p, t]) => (await window.cityCouncil.camera).rig.setPose(p, t), [
    [grid.x + 40, ground + 90, grid.z + 150],
    [grid.x + 10, ground + 5, grid.z + 40],
  ] as [Vec3, Vec3]);
  // Decoration in range finished building: its counts hold for ten frames.
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
  // After each frame is drawn: the tree instances in the scene, and every tenth frame's picture for the pull request.
  await page.evaluate(async () => {
    const view = await window.cityCouncil.view;
    window.growthFrames = [];
    view.onFrame((stats) => {
      const frames = window.growthFrames;
      // Under cheap frames (issue #226) a frame where nothing changed is not drawn, and the canvas has nothing to read.
      if (!frames || !stats.drawn) return;
      let trees = 0;
      view.scene.traverseVisible((o) => {
        if (o.name === "broadleaf" || o.name === "conifer") trees += o.count ?? 0;
      });
      const shot = frames.length % 10 === 0 ? view.renderer.domElement.toDataURL("image/png") : null;
      frames.push({ trees, buildings: view.buildingStats()?.buildings ?? 0, shot });
    });
  });
  expect(await page.evaluate(() => window.cityCouncil.sendCommand("SetSpeed", { speed: 4 }))).toEqual({ ok: true });
  await expect.poll(async () => (await grown(page)).buildings, { timeout: 60_000 }).toBeGreaterThanOrEqual(12);
  const frames = await page.evaluate(() => {
    const f = window.growthFrames ?? [];
    delete window.growthFrames;
    return f;
  });
  expect(frames.length).toBeGreaterThan(5);
  expect(frames.at(-1)?.buildings ?? 0).toBeGreaterThan(frames[0]?.buildings ?? 0);
  // A lot takes the few trees standing on it; a blink takes a whole chunk's and gives them back a frame later.
  const blinks: string[] = [];
  for (let i = 1; i + 1 < frames.length; i++) {
    const [a, b, c] = [frames[i - 1]?.trees ?? 0, frames[i]?.trees ?? 0, frames[i + 1]?.trees ?? 0];
    if (b < a - 50 && c > b + 50) blinks.push(`frame ${i}: ${a} -> ${b} -> ${c} trees`);
  }
  for (const [k, f] of frames.entries()) {
    if (!f.shot) continue;
    const path = info.outputPath(`growth-frame-${String(k).padStart(3, "0")}-${f.buildings}-buildings.png`);
    writeFileSync(path, Buffer.from(f.shot.split(",")[1] ?? "", "base64"));
    await info.attach(`frame ${k}, ${f.buildings} buildings`, { path, contentType: "image/png" });
  }
  await info.attach("trees per frame", { body: JSON.stringify(frames.map((f) => [f.buildings, f.trees])), contentType: "application/json" });
  expect(blinks).toEqual([]);
});
