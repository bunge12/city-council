// Issue #133: the zoning overlay's city band, drawn as runs of cells joined
// into one mesh per group of chunks, beside the per-chunk meshes the street
// and district bands draw.
import { describe, expect, it } from "vitest";
import { Scene, type Object3D } from "three/webgpu";
import { CELL_OPEN, CHUNKS_PER_SIDE, type ChunkCellShapes } from "@city-council/sim";
import { cityGroupOf, createCellLayer, type CellSource } from "../src/render/cell-meshes";
import { CELLS } from "../src/render/config";

/** A straight row of `n` cells along +x from (x, z), at slots from `first`. */
function row(first: number, n: number, x: number, z: number): ChunkCellShapes {
  const corners = new Float64Array(n * 8);
  for (let k = 0; k < n; k++) corners.set([x + k * 8, z, x + k * 8 + 8, z, x + k * 8 + 8, z + 8, x + k * 8, z + 8], k * 8);
  return { slots: Int32Array.from({ length: n }, (_, k) => first + k), statuses: new Uint8Array(n).fill(CELL_OPEN), corners };
}

/** Two neighbouring chunks in one city band group, chunks 0 and 1, and one in another group, each with a row of ten cells. */
function fakeSource() {
  const far = (CELLS.cityGroup + 1) * CHUNKS_PER_SIDE + CELLS.cityGroup + 1;
  const shapes = new Map<number, ChunkCellShapes>([
    [0, row(0, 10, 100, 100)],
    [1, row(10, 10, 600, 100)],
    [far, row(20, 10, 2600, 2600)],
  ]);
  const zone = new Uint8Array(30).fill(1);
  const density = new Uint8Array(30).fill(1);
  const source: CellSource = {
    shapes: (c) => shapes.get(c) ?? { slots: new Int32Array(0), statuses: new Uint8Array(0), corners: new Float64Array(0) },
    cells: () => ({ zone, density }),
  };
  return { source, zone, far };
}

function shown(scene: Scene, prefix: string): string[] {
  const out: string[] = [];
  const walk = (o: Object3D, visible: boolean) => {
    const v = visible && o.visible;
    if (v && o.name.startsWith(prefix) && (o as { isMesh?: boolean }).isMesh) out.push(o.name);
    for (const child of o.children) walk(child, v);
  };
  walk(scene, true);
  return out.sort();
}

describe("the zoning overlay's city band (issue #133)", () => {
  const camera = { x: 0, z: 0 };

  it("draws a group of chunks as one mesh of runs in the city band, and each chunk's cells in the others", () => {
    const { source, far } = fakeSource();
    expect(cityGroupOf(0)).toBe(cityGroupOf(1));
    expect(cityGroupOf(far)).not.toBe(cityGroupOf(0));
    const scene = new Scene();
    const layer = createCellLayer(scene, source, () => 0);
    layer.setVisible(true);
    layer.setBand("district");
    layer.update(camera, Infinity);
    expect(shown(scene, "cells ")).toHaveLength(3);
    expect(shown(scene, "city cells ")).toEqual([]);
    layer.setBand("city");
    expect(shown(scene, "cells ")).toEqual([]);
    expect(shown(scene, "city cells ")).toHaveLength(2);
    // Thirty cells in three straight rows of ten: three quads.
    expect(layer.stats()).toMatchObject({ zoned: 30, cityRuns: 3, cityGroups: 2 });
    layer.dispose();
  });

  it("joins a group again when a chunk in it changes, and drops it once none of its cells is zoned", () => {
    const { source, zone } = fakeSource();
    const scene = new Scene();
    const layer = createCellLayer(scene, source, () => 0);
    layer.setVisible(true);
    layer.setBand("city");
    layer.update(camera, Infinity);
    // A cell in the middle of chunk 1's row rezoned: that row is three runs now.
    zone[15] = 2;
    layer.apply([1]);
    layer.update(camera, Infinity);
    expect(layer.stats()).toMatchObject({ cityRuns: 5, cityGroups: 2 });
    // Every cell of the first group unzoned: it has no mesh. The unzoned cells are still drawn as outlines in the other bands.
    zone.fill(0, 0, 20);
    layer.apply([0, 1]);
    layer.update(camera, Infinity);
    expect(layer.stats()).toMatchObject({ cityRuns: 1, cityGroups: 1, unzoned: 20 });
    expect(shown(scene, "city cells ")).toHaveLength(1);
    layer.dispose();
  });
});
