// Issue M3-18: the land value overlay. Its colour scale, its hover text, how
// it is chosen beside zoning, and how it recolours the zoning overlay's
// cell meshes in place instead of building a second set.
import { describe, expect, it } from "vitest";
import { BufferAttribute, Mesh, Scene, type Object3D } from "three/webgpu";
import { CELL_OPEN, CHUNKS_PER_SIDE, LAND_VALUE_MAX, ROAD_TYPES, type ChunkCellShapes, type LandValue } from "@city-council/sim";
import { cellColour, landValueColour } from "../src/render/cell-geometry";
import { createCellLayer, type CellSource } from "../src/render/cell-meshes";
import { LAND_VALUE_SCALE } from "../src/render/config";
import { landValueLines } from "../src/ui/land-value-text";
import { OVERLAYS, colouringOf, overlayAfterTool, toggledOverlay } from "../src/ui/overlays";
import { SHORTCUTS } from "../src/ui/shortcuts";

const rgb = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
/** Relative luminance-ish lightness, enough to say one colour is darker than another. */
const light = (hex: number) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

describe("the land value colour scale", () => {
  it("takes each stop's colour at its value and the ends beyond them", () => {
    for (const s of LAND_VALUE_SCALE.stops) expect(landValueColour(s.value)).toBe(s.colour);
    const first = LAND_VALUE_SCALE.stops[0]?.colour;
    const last = LAND_VALUE_SCALE.stops.at(-1)?.colour;
    expect(landValueColour(-5)).toBe(first);
    expect(landValueColour(LAND_VALUE_MAX + 5)).toBe(last);
  });

  it("mixes in a straight line between two stops", () => {
    const stops = [
      { value: 0, colour: 0x000000 },
      { value: 10, colour: 0xff8000 },
    ];
    expect(landValueColour(5, stops)).toBe(0x804000);
    expect(landValueColour(1, stops)).toBe(0x1a0d00);
  });

  it("is one sequential scale: darker at every whole value up the scale, and none of the zones' colours", () => {
    let before = Infinity;
    for (let v = 0; v <= LAND_VALUE_MAX; v++) {
      const l = light(landValueColour(v));
      expect(l, `value ${v}`).toBeLessThanOrEqual(before);
      before = l;
    }
    expect(light(landValueColour(LAND_VALUE_MAX))).toBeLessThan(light(landValueColour(0)) - 80);
    const zoneColours = new Set<number>();
    for (let z = 1; z <= 5; z++) for (let d = 1; d <= 3; d++) zoneColours.add(cellColour(z, d));
    for (const s of LAND_VALUE_SCALE.stops) expect(zoneColours.has(s.colour)).toBe(false);
  });
});

describe("the land value readout", () => {
  const street = ROAD_TYPES.findIndex((t) => t.id === "street");
  const avenue = ROAD_TYPES.findIndex((t) => t.id === "avenue");
  const v = (p: Partial<LandValue>): LandValue => ({ value: 0, base: 30, road: 0, water: 0, centre: 0, pollution: 0, ...p });

  it("gives the value and each part that adds or takes something, in the issue's words", () => {
    const lines = landValueLines(v({ value: 40, road: 10, water: 12, centre: 8, pollution: 20 }), street);
    expect(lines.title).toBe("Land value 40 of 100");
    expect(lines.parts).toBe("Base 30, Street +10, Water +12, Centre +8, Industry −20");
  });

  it("leaves out parts that add nothing and names the road the cell fronts", () => {
    expect(landValueLines(v({ value: 45, road: 15 }), avenue).parts).toBe("Base 30, Avenue +15");
    expect(landValueLines(v({ value: 30 }), street).parts).toBe("Base 30");
  });

  it("says when the parts add up past an end of the scale", () => {
    expect(landValueLines(v({ value: 0, road: 10, pollution: 60 }), street).parts).toBe("Base 30, Street +10, Industry −60, held at 0");
  });
});

describe("choosing an overlay", () => {
  it("is a list with a key for each entry, and the keys are shortcuts", () => {
    expect(OVERLAYS.map((o) => o.id)).toContain("landValue");
    for (const o of OVERLAYS) {
      const s = SHORTCUTS.find((k) => k.codes.includes(o.code));
      expect(s?.action).toEqual({ kind: "overlay", id: o.id });
      // No other shortcut takes the key.
      expect(SHORTCUTS.filter((k) => k.codes.includes(o.code))).toHaveLength(1);
    }
    expect(colouringOf("landValue")).toBe("landValue");
    expect(colouringOf("zoning")).toBe("zoning");
    expect(colouringOf(null)).toBe("zoning");
  });

  it("shows one at a time: land value puts zoning away, and the zone tool brings it back", () => {
    // With the zone tool on, zoning shows; land value replaces it, and turning land value off goes back to zoning.
    expect(overlayAfterTool(null, "zone", null)).toBe("zoning");
    expect(toggledOverlay("zoning", "landValue", "zone")).toBe("landValue");
    expect(toggledOverlay("landValue", "landValue", "zone")).toBe("zoning");
    expect(toggledOverlay("landValue", "landValue", null)).toBeNull();
    expect(toggledOverlay("landValue", "landValue", "bulldoze")).toBeNull();
    // Picking the zone tool with land value on brings zoning back.
    expect(overlayAfterTool("landValue", "zone", "road")).toBe("zoning");
    // Leaving the zone tool puts zoning away, but not land value.
    expect(overlayAfterTool("zoning", null, "zone")).toBeNull();
    expect(overlayAfterTool("landValue", null, "zone")).toBe("landValue");
    expect(overlayAfterTool("landValue", "road", null)).toBe("landValue");
  });

  it("comes with the road and grid tools, so a road's cells show beside the ones already there", () => {
    expect(overlayAfterTool(null, "road", null)).toBe("zoning");
    expect(overlayAfterTool(null, "grid", "bulldoze")).toBe("zoning");
    // From one tool that brings it to another, it stays.
    expect(overlayAfterTool("zoning", "grid", "road")).toBe("zoning");
    expect(overlayAfterTool("zoning", "road", "zone")).toBe("zoning");
    // Leaving them puts it away.
    expect(overlayAfterTool("zoning", null, "road")).toBeNull();
    expect(overlayAfterTool("zoning", "bulldoze", "grid")).toBeNull();
    // Turning land value off with the road tool on goes back to zoning.
    expect(toggledOverlay("landValue", "landValue", "road")).toBe("zoning");
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

/** Every chunk is built once when the overlay first shows, most of them empty here. */
const ALL = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;

const fillOf = (m: Mesh) => (m.geometry.getAttribute("cellFill") as BufferAttribute).array as Uint8Array;

describe("the land value overlay on the zoning overlay's meshes", () => {
  const camera = { x: 0, z: 0 };

  function setup() {
    // Chunk 0: ten cells, the first five zoned R1 and the rest not.
    const shapes = row(0, 10, 100, 100);
    const zone = new Uint8Array(10).fill(0, 5).fill(1, 0, 5);
    const density = new Uint8Array(10).fill(0, 5).fill(1, 0, 5);
    const values = Uint8Array.from({ length: 10 }, (_, k) => k * 10);
    let valueCalls = 0;
    let markCalls = 0;
    const source: CellSource = {
      shapes: (c) => (c === 0 ? shapes : { slots: new Int32Array(0), statuses: new Uint8Array(0), corners: new Float64Array(0) }),
      cells: () => ({ zone, density }),
      marks: (_c, s) => {
        markCalls++;
        return new Uint8Array(s.slots.length);
      },
      values: () => {
        valueCalls++;
        return values;
      },
    };
    const scene = new Scene();
    const layer = createCellLayer(scene, source, () => 0);
    return { scene, layer, values, calls: () => ({ values: valueCalls, marks: markCalls }) };
  }

  it("colours every cell by its value, filled, on the meshes zoning built, and back again, building nothing", () => {
    const { scene, layer, calls } = setup();
    layer.setVisible(true);
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    const [mesh] = meshes(scene, "cells ");
    if (!mesh) throw new Error("no chunk mesh");
    const geometry = mesh.geometry;
    const zoning = Uint8Array.from(fillOf(mesh));
    expect(layer.stats()).toMatchObject({ totalRebuilt: ALL, colouring: "zoning" });
    // Unzoned cells are outlines: alpha 0.
    expect(zoning[5 * 16 + 3]).toBe(0);

    layer.setColouring("landValue");
    expect(layer.stats().pending).toBe(1);
    layer.update(camera, Infinity);
    expect(meshes(scene, "cells ")[0]).toBe(mesh);
    expect(mesh.geometry).toBe(geometry);
    expect(layer.stats()).toMatchObject({ totalRebuilt: ALL, totalRecoloured: 1, pending: 0, colouring: "landValue" });
    const fill = fillOf(mesh);
    for (let k = 0; k < 10; k++) {
      expect([...fill.subarray(k * 16, k * 16 + 4)], `cell ${k}`).toEqual([...rgb(landValueColour(k * 10)), 255]);
    }
    // Zoning again: the very colours it had.
    layer.setColouring("zoning");
    layer.update(camera, Infinity);
    expect([...fillOf(mesh)]).toEqual([...zoning]);
    expect(layer.stats()).toMatchObject({ totalRebuilt: ALL, totalRecoloured: 2 });
    expect(calls()).toEqual({ values: 1, marks: 1 });
    layer.dispose();
  });

  it("follows values that change without their cells, a chunk at a time, only while it colours by them", () => {
    const { scene, layer, values, calls } = setup();
    layer.setVisible(true);
    layer.setColouring("landValue");
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    // Built for land value: no lot marks looked up.
    expect(calls()).toEqual({ values: 1, marks: 0 });
    const [mesh] = meshes(scene, "cells ");
    if (!mesh) throw new Error("no chunk mesh");
    values[0] = 100;
    layer.revalue([0]);
    layer.update(camera, Infinity);
    expect([...fillOf(mesh).subarray(0, 3)]).toEqual(rgb(landValueColour(100)));
    // A chunk with no mesh, and every chunk at once, are taken too.
    values[1] = 100;
    layer.revalue();
    layer.update(camera, Infinity);
    expect([...fillOf(mesh).subarray(16, 19)]).toEqual(rgb(landValueColour(100)));
    expect(layer.stats()).toMatchObject({ totalRebuilt: ALL, totalRecoloured: 2 });
    // Back to zoning, the chunk is built again for the lot marks it skipped, and a change of values is ignored.
    layer.setColouring("zoning");
    layer.update(camera, Infinity);
    expect(calls().marks).toBe(1);
    expect(layer.stats().totalRebuilt).toBe(ALL + 1);
    layer.revalue([0]);
    expect(layer.stats().pending).toBe(0);
    layer.dispose();
  });

  it("reads a chunk's slots again before it colours it, since a layout elsewhere can move them", () => {
    // The same ten cells, at slots moved up by 5, as after a lower segment was laid out again; zoning moves with them.
    const shapes = row(0, 10, 100, 100);
    const moved = row(5, 10, 100, 100);
    let now = shapes;
    const zone = new Uint8Array(15);
    const density = new Uint8Array(15);
    zone.fill(1, 0, 5);
    density.fill(1, 0, 5);
    const source: CellSource = {
      shapes: (c) => (c === 0 ? now : { slots: new Int32Array(0), statuses: new Uint8Array(0), corners: new Float64Array(0) }),
      cells: () => ({ zone, density }),
      values: (s) => new Uint8Array(s.slots.length),
    };
    const scene = new Scene();
    const layer = createCellLayer(scene, source, () => 0);
    layer.setVisible(true);
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    const [mesh] = meshes(scene, "cells ");
    if (!mesh) throw new Error("no chunk mesh");
    const before = Uint8Array.from(fillOf(mesh));
    now = moved;
    zone.fill(0).fill(1, 5, 10);
    density.fill(0).fill(1, 5, 10);
    layer.setColouring("landValue");
    layer.update(camera, Infinity);
    layer.setColouring("zoning");
    layer.update(camera, Infinity);
    expect([...fillOf(mesh)]).toEqual([...before]);
    // Cells that differ are built again, not coloured.
    const built = layer.stats().totalRebuilt;
    now = row(5, 9, 100, 100);
    layer.setColouring("landValue");
    // The frame that finds them different queues the build; the next builds it.
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    expect(layer.stats().totalRebuilt).toBe(built + 1);
    layer.dispose();
  });

  it("gives the city band one colour per chunk, its cells' mean value", () => {
    const { scene, layer } = setup();
    layer.setVisible(true);
    layer.setBand("city");
    layer.setColouring("landValue");
    layer.update(camera, Infinity);
    layer.update(camera, Infinity);
    const [city] = meshes(scene, "city cells ");
    if (!city) throw new Error("no city band mesh");
    const fill = fillOf(city);
    // The five zoned cells are one run; the mean is over the ten cells drawn, 0 to 90: 45.
    expect([...fill.subarray(0, 3)]).toEqual(rgb(landValueColour(45)));
    layer.dispose();
  });
});
