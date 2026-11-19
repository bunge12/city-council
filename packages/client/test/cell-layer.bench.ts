// The zoning overlay's lot-mark timings (issue #164), moved out of
// cell-layer.test.ts so `pnpm test` holds no wall-clock time (issue #231).
// Run with `pnpm bench`. cell-layer.test.ts keeps the exact checks.
//
// The first chunk after a load pays for the sim's indexes, so the layer
// times it apart from the rest: its marks and its frame go to `firstMarksMs`
// and `firstFrameMs`, and every later chunk to the slowest figures.
import { expect, test } from "vitest";
import { Scene } from "three/webgpu";
import { CELL_OPEN, budgetFigure, type ChunkCellShapes } from "@city-council/sim";
import { createCellLayer, type CellSource } from "../src/render/cell-meshes";
import { hold } from "./budget";

/**
 * What the fixture's first chunk's marks cost, in milliseconds, as building
 * the sim's indexes would: the budget the later chunks are held under
 * (`client.cell-layer.later-chunk` in the sim's balance/budgets.json).
 */
const FIRST_MS = budgetFigure("client.cell-layer.later-chunk").budget;

/** Spends at least `ms` milliseconds, as a first call that builds an index would. */
function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

/** A straight row of ten cells along +x from (x, z), at slots from `first`. */
function row(first: number, x: number, z: number): ChunkCellShapes {
  const n = 10;
  const corners = new Float64Array(n * 8);
  for (let k = 0; k < n; k++) corners.set([x + k * 8, z, x + k * 8 + 8, z, x + k * 8 + 8, z + 8, x + k * 8, z + 8], k * 8);
  return { slots: Int32Array.from({ length: n }, (_, k) => first + k), statuses: new Uint8Array(n).fill(CELL_OPEN), corners };
}

test("the zoning overlay times the first chunk's lot marks apart from the rest", () => {
  const shapes = new Map<number, ChunkCellShapes>([
    [0, row(0, 100, 100)],
    [1, row(10, 600, 100)],
    [2, row(20, 1100, 100)],
  ]);
  const zone = new Uint8Array(30).fill(1);
  const density = new Uint8Array(30).fill(1);
  let calls = 0;
  const source: CellSource = {
    shapes: (c) => shapes.get(c) ?? { slots: new Int32Array(0), statuses: new Uint8Array(0), corners: new Float64Array(0) },
    cells: () => ({ zone, density }),
    marks: (_chunk, s) => {
      if (calls++ === 0) busy(FIRST_MS);
      return new Uint8Array(s.slots.length).fill(1);
    },
  };
  const layer = createCellLayer(new Scene(), source, () => 0);
  layer.setVisible(true);
  // The frame that turns the overlay on builds no chunk (issue #163); the next builds them all.
  layer.update({ x: 0, z: 0 }, 0);
  layer.update({ x: 0, z: 0 }, Infinity);
  let stats = layer.stats();
  expect(stats.marked).toBe(30);
  expect(stats.firstMarksMs, "the first chunk's marks").toBeGreaterThanOrEqual(FIRST_MS);
  expect(stats.firstFrameMs, "the first frame").toBeGreaterThanOrEqual(FIRST_MS);
  // The rest take microseconds: a pause of the runner is the only way past this.
  hold("client.cell-layer.later-chunk", "the slowest later chunk's marks", { max: stats.slowestMarksMs });
  hold("client.cell-layer.later-chunk", "the slowest later frame", { max: stats.slowestFrameMs });
  // A snapshot starts the timings again: its first chunk is the slow one this time.
  calls = 0;
  layer.reset();
  layer.update({ x: 0, z: 0 }, Infinity);
  stats = layer.stats();
  expect(stats.firstMarksMs, "the first chunk's marks after a reset").toBeGreaterThanOrEqual(FIRST_MS);
  hold("client.cell-layer.later-chunk", "the slowest later chunk's marks after a reset", { max: stats.slowestMarksMs });
  layer.dispose();
});
