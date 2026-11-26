// Issue M4-18: the budget overlay. Its diverging scale, its place in the
// overlay list, and how it colours the zoning overlay's cell meshes,
// ground under buildings included.
import { describe, expect, it } from "vitest";
import { BufferAttribute, Mesh, Scene, type Object3D } from "three/webgpu";
import { CELL_OPEN, CHUNKS_PER_SIDE, type ChunkCellShapes } from "@city-council/sim";
import { BUDGET_STEPS, budgetByte, budgetColour, budgetPlace, cellColour, landValueColour } from "../src/render/cell-geometry";
import { createCellLayer, type CellSource } from "../src/render/cell-meshes";
import { BUDGET_SCALE } from "../src/render/config";
import { OVERLAYS, colouringOf, toggledOverlay } from "../src/ui/overlays";
import { SHORTCUTS } from "../src/ui/shortcuts";

const rgb = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const light = (hex: number) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
const grey = (hex: number) => {
  const [r, g, b] = rgb(hex);
  return r === g && g === b;
};

describe("the budget colour scale", () => {
  it("puts break-even and anything within the neutral band at the grey middle", () => {
    expect(budgetPlace(0)).toBe(0);
    expect(budgetPlace(BUDGET_SCALE.neutral)).toBe(0);
    expect(budgetPlace(-BUDGET_SCALE.neutral)).toBe(0);
    expect(budgetByte(0)).toBe(BUDGET_STEPS);
    expect(grey(budgetColour(0))).toBe(true);
  });

  it("runs a loss to the red end and a gain to the blue end, by size on a log scale", () => {
    expect(budgetPlace(BUDGET_SCALE.full)).toBe(1);
    expect(budgetPlace(-BUDGET_SCALE.full)).toBe(-1);
    expect(budgetPlace(10 * BUDGET_SCALE.full)).toBe(1);
    // Halfway in log terms between the neutral band and the end of the arm.
    const mid = Math.sqrt(BUDGET_SCALE.neutral * BUDGET_SCALE.full);
    expect(budgetPlace(mid)).toBeCloseTo(0.5, 12);
    expect(budgetPlace(-mid)).toBeCloseTo(-0.5, 12);
    expect(budgetByte(-BUDGET_SCALE.full)).toBe(0);
    expect(budgetByte(BUDGET_SCALE.full)).toBe(2 * BUDGET_STEPS);
    const [r0, , b0] = rgb(budgetColour(-1));
    const [r1, , b1] = rgb(budgetColour(1));
    expect(r0).toBeGreaterThan(b0 ?? 0);
    expect(b1).toBeGreaterThan(r1 ?? 0);
  });

  it("gets darker at every step away from the middle on both arms, and takes no zone's or land value's colour", () => {
    let before = light(budgetColour(0));
    for (let v = 1; v <= BUDGET_STEPS; v++) {
      const l = light(budgetColour(v / BUDGET_STEPS));
      expect(l, `gain step ${v}`).toBeLessThanOrEqual(before);
      before = l;
    }
    before = light(budgetColour(0));
    for (let v = 1; v <= BUDGET_STEPS; v++) {
      const l = light(budgetColour(-v / BUDGET_STEPS));
      expect(l, `loss step ${v}`).toBeLessThanOrEqual(before);
      before = l;
    }
    const taken = new Set<number>([landValueColour(0), landValueColour(100)]);
    for (let z = 1; z <= 5; z++) for (let d = 1; d <= 3; d++) taken.add(cellColour(z, d));
    for (const s of BUDGET_SCALE.stops) expect(taken.has(s.colour)).toBe(false);
  });
});

describe("choosing the budget overlay", () => {
  it("is in the overlay list with the N key, and shows one at a time", () => {
    const entry = OVERLAYS.find((o) => o.id === "budget");
    expect(entry?.key).toBe("N");
    expect(SHORTCUTS.find((k) => k.codes.includes("KeyN"))?.action).toEqual({ kind: "overlay", id: "budget" });
    expect(colouringOf("budget")).toBe("budget");
    expect(toggledOverlay("landValue", "budget", null)).toBe("budget");
    expect(toggledOverlay("budget", "budget", null)).toBeNull();
    expect(toggledOverlay("budget", "budget", "zone")).toBe("zoning");
  });
});

/** A straight row of `n` cells along +x from (x, z), at slots from `first`. */
function row(first: number, n: number, x: number, z: number): ChunkCellShapes {
  const corners = new Float64Array(n * 8);
  for (let k = 0; k < n; k++) corners.set([x + k * 8, z, x + k * 8 + 8, z, x + k * 8 + 8, z + 8, x + k * 8, z + 8], k * 8);
  return { slots: Int32Array.from({ length: n }, (_, k) => first + k), statuses: new Uint8Array(n).fill(CELL_OPEN), corners };
}

function meshes(scene: Scene, prefix: string): Mesh[] {
  const out: Mesh[] = [];
  scene.traverse((o: Object3D) => {
    if (o.name.startsWith(prefix) && (o as { isMesh?: boolean }).isMesh) out.push(o as Mesh);
  });
  return out;
}

const ALL = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
const fillOf = (m: Mesh) => (m.geometry.getAttribute("cellFill") as BufferAttribute).array as Uint8Array;

describe("the budget overlay on the zoning overlay's meshes", () => {
  const camera = { x: 0, z: 0 };

  function setup() {
    // Chunk 0: ten cells zoned R1; buildings stand on the first four.
    const shapes = row(0, 10, 100, 100);
    const zone = new Uint8Array(10).fill(1);
    const density = new Uint8Array(10).fill(1);
    const built = Int32Array.from({ length: 10 }, (_, k) => (k < 4 ? 7 : -1));
    // The first half of the row loses money, the second half makes it.
    const bytes = Uint8Array.from({ length: 10 }, (_, k) => (k < 5 ? budgetByte(-BUDGET_SCALE.full) : budgetByte(BUDGET_SCALE.full)));
    let budgetCalls = 0;
    const source: CellSource = {
      shapes: (c) => (c === 0 ? shapes : { slots: new Int32Array(0), statuses: new Uint8Array(0), corners: new Float64Array(0) }),
      cells: () => ({ zone, density }),
      built: () => built,
      marks: (_c, s) => new Uint8Array(s.slots.length),
      budget: (c) => {
        budgetCalls++;
        return c === 0 ? bytes : null;
      },
    };
    const scene = new Scene();
    const layer = createCellLayer(scene, source, () => 0);
    return { scene, layer, calls: () => budgetCalls };
  }

  it("draws the ground under buildings too, coloured by its area's net, and leaves it out again for zoning", () => {
    const { scene, layer } = setup();
    layer.setVisible(true);
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    expect(layer.stats()).toMatchObject({ zoned: 6, totalRebuilt: ALL });

    // The budget colouring builds the chunk again, with the four cells under buildings.
    layer.setColouring("budget");
    layer.update(camera, Infinity);
    expect(layer.stats()).toMatchObject({ colouring: "budget", zoned: 10, pending: 0, totalRebuilt: ALL + 1 });
    const [mesh] = meshes(scene, "cells ");
    if (!mesh) throw new Error("no chunk mesh");
    const fill = fillOf(mesh);
    for (let k = 0; k < 10; k++) {
      const want = k < 5 ? budgetColour(-1) : budgetColour(1);
      expect([...fill.subarray(k * 16, k * 16 + 4)], `cell ${k}`).toEqual([...rgb(want), 255]);
    }

    layer.setColouring("zoning");
    layer.update(camera, Infinity);
    expect(layer.stats()).toMatchObject({ colouring: "zoning", zoned: 6, totalRebuilt: ALL + 2 });
    layer.dispose();
  });

  it("colours again in place when the figures change and the cells do not", () => {
    const { layer, calls } = setup();
    layer.setVisible(true);
    layer.setColouring("budget");
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    const built = layer.stats().totalRebuilt;
    const before = calls();
    layer.revalue();
    layer.update(camera, Infinity);
    expect(calls()).toBe(before + 1);
    expect(layer.stats().totalRebuilt).toBe(built);
    layer.dispose();
  });
});
