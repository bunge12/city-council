// How long the grid tool's preview of a grid at the cap takes, moved out of
// grid-tool.test.ts so `pnpm test` holds no wall-clock time (issue #231).
// Run with `pnpm bench`. grid-tool.test.ts keeps the exact checks on the
// same preview.
import { expect, test } from "vitest";
import { createBareState, generateTerrain } from "@city-council/sim";
import { previewGrid } from "../src/tools/grid-tool";

/** A frame at 60 fps. Generous for a slow CI runner; on the development container it is a few milliseconds. */
const FRAME_MS = 16;
const SEED = 2026;

test("the grid tool previews a grid at the cap well inside a frame", async ({ bench }) => {
  const terrain = generateTerrain(SEED);
  const net = createBareState(SEED).roads;
  // 13 by 14 lines 40 m apart over the flat square: 337 sections on open
  // ground, near the most one grid can lay (issue 88).
  const payload = { origin: { x: 4110, z: 4410 }, along: { x: 4110 + 12 * 40, z: 4410 }, across: { x: 4110, z: 4410 + 13 * 40 }, depth: 30, width: 30, type: "street" };
  const first = previewGrid(net, terrain, payload);
  expect(first.ok, first.reason ?? "").toBe(true);
  expect(first.streets.reduce((n, s) => n + s.points.length - 1, 0)).toBe(337);
  const name = "preview a grid at the cap";
  const r = await bench(name, { async: false }, () => void previewGrid(net, terrain, payload)).run();
  expect(r.latency.mean, `[budget] ${name}`).toBeLessThan(FRAME_MS);
});
