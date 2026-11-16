// Levels of detail for buildings (issue M2-13): which form a chunk takes,
// the fade between forms, and the merged geometry. building-lod.ts.

import { describe, expect, it } from "vitest";
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "@city-council/sim";
import { Matrix4, Quaternion, Vector3 } from "three";
import { chunkDistance, draws, fadeOf, formFor, isNear, mergeFlats, mergeModels, modelExtent, stepFade, type ChunkFade, type MergedItem } from "../src/render/building-lod";
import { FACADE, ModelBuilder, SURFACE, simplify } from "../src/theme/model";
import { NORTH_AMERICAN } from "../src/theme/north-american";
import { tower } from "../src/theme/north-american/generators";
import { BUILDINGS } from "../src/render/config";

describe("a chunk's form", () => {
  it("is full only near the camera in the street band", () => {
    expect(formFor("street", true)).toBe("full");
    expect(formFor("street", false)).toBe("simple");
    expect(formFor("district", true)).toBe("simple");
    expect(formFor("city", true)).toBe("flat");
  });

  it("counts nearness from the nearest point of the chunk, and keeps a near chunk near a little further", () => {
    const c = 3 * CHUNKS_PER_SIDE + 2;
    const x0 = 2 * CHUNK_SIZE;
    const z0 = 3 * CHUNK_SIZE;
    expect(chunkDistance(c, x0 + 10, z0 + 10)).toBe(0);
    expect(chunkDistance(c, x0 - 300, z0 + 10)).toBe(300);
    expect(chunkDistance(c, x0 - 300, z0 - 400)).toBe(500);
    expect(isNear(c, x0 - 650, z0, false, 600, 150)).toBe(false);
    expect(isNear(c, x0 - 650, z0, true, 600, 150)).toBe(true);
    expect(isNear(c, x0 - 800, z0, true, 600, 150)).toBe(false);
  });
});

describe("the fade between forms", () => {
  const all = () => true;

  it("shows a chunk's first form at once, with no fade", () => {
    const f: ChunkFade = { shown: null, next: null, t: 0 };
    stepFade(f, "simple", all, 0.01, 0.35);
    expect(f).toEqual({ shown: "simple", next: null, t: 0 });
  });

  it("waits for the new form to be built, then fades it in and lets the old one go", () => {
    const f: ChunkFade = { shown: "simple", next: null, t: 0 };
    expect(stepFade(f, "full", () => false, 0.1, 0.4).released).toBeNull();
    expect(f.next).toBeNull();
    stepFade(f, "full", all, 0.1, 0.4);
    expect(f).toEqual({ shown: "simple", next: "full", t: 0.25 });
    // The two share the screen: the new one the pixels under its fade, the old one the rest.
    expect(fadeOf(f, "full")).toBe(0.25);
    expect(fadeOf(f, "simple")).toBe(2.25);
    expect(fadeOf(f, "flat")).toBe(0);
    expect(draws(f, "simple") && draws(f, "full")).toBe(true);
    stepFade(f, "full", all, 0.2, 0.4);
    expect(stepFade(f, "full", all, 0.2, 0.4).released).toBe("simple");
    expect(f).toEqual({ shown: "full", next: null, t: 0 });
    expect(fadeOf(f, "full")).toBe(1);
  });

  it("runs back the way it came when the chunk wants its old form again", () => {
    const f: ChunkFade = { shown: "simple", next: "full", t: 0.5 };
    expect(stepFade(f, "simple", all, 0.1, 0.4).released).toBeNull();
    expect(f.t).toBeCloseTo(0.25);
    expect(stepFade(f, "simple", all, 0.2, 0.4).released).toBe("full");
    expect(f).toEqual({ shown: "simple", next: null, t: 0 });
  });
});

describe("simplified models", () => {
  it("drop the small parts and the paving, and keep the building's own shape", () => {
    // A tower on a podium with a plant room and a mast, and paving: none of it is a plain box.
    const full = tower({ w: 40, d: 40 }, { podium: 3, shops: true, floors: 26, share: 0.6, curtain: true, spacing: 3, storey: 3.2, crown: "mast" });
    const simple = simplify(full, BUILDINGS.simplify);
    expect(simple.surfaces.length).toBeLessThan(full.surfaces.length);
    expect(simple.surfaces.length).toBeGreaterThan(0);
    // The mast is gone: nothing reaches above the plant room, and the tower is still as tall as it was.
    const top = (m: typeof full, skip = false) => {
      let y = -Infinity;
      for (let v = 0; v < m.surfaces.length; v++) {
        // Masts are the only thin trim; leave them out of the full model's height.
        if (skip && Math.abs(m.positions[v * 3] ?? 0) < 0.5 && Math.abs((m.positions[v * 3 + 2] ?? 0) - 0) < 40 && (m.positions[v * 3 + 1] ?? 0) > 95) continue;
        y = Math.max(y, m.positions[v * 3 + 1] ?? 0);
      }
      return y;
    };
    expect(top(simple)).toBeLessThan(top(full));
    expect(top(simple)).toBeGreaterThan(90);
    // The tower is narrower than the podium: the simplified model is two masses, not one box round both.
    const widthAt = (m: typeof full, y: number) => {
      let w = 0;
      for (let v = 0; v < m.surfaces.length; v++) if ((m.positions[v * 3 + 1] ?? 0) >= y) w = Math.max(w, Math.abs(m.positions[v * 3] ?? 0));
      return w * 2;
    };
    expect(widthAt(simple, 50)).toBeLessThan(widthAt(simple, 1) * 0.7);
    expect([...simple.surfaces]).not.toContain(SURFACE.paving);
    // Its triangles use only its own vertices.
    for (const i of simple.indices) expect(i).toBeLessThan(simple.surfaces.length);
  });

  it("leave a model with no parts as it is", () => {
    const b = new ModelBuilder();
    b.box(-0.1, 0.1, 0, 2, -0.1, 0.1, SURFACE.trim, SURFACE.trim);
    const built = b.build();
    const m = { positions: built.positions, normals: built.normals, surfaces: built.surfaces, facades: built.facades, indices: built.indices };
    expect(simplify(m, BUILDINGS.simplify)).toBe(m);
  });

  it("keep something of every model of every type, with walls and a roof", () => {
    const theme = NORTH_AMERICAN;
    for (const id of ["single-family-home", "high-tower", "shop-top-row", "tank-farm", "large-factory", "tall-podium-tower"]) {
      for (let model = 0; model < theme.modelCount(id); model++) {
        const s = simplify(theme.model(id, model, 4, theme.modelDepth(id)), BUILDINGS.simplify);
        expect(s.indices.length, `${id} ${model}`).toBeGreaterThan(0);
        expect([...s.surfaces], `${id} ${model}`).toContain(SURFACE.roof);
      }
    }
  });
});

describe("merged geometry", () => {
  const extent = { minX: -4, maxX: 4, minY: -1, maxY: 9, minZ: -6, maxZ: 6 };
  const b = new ModelBuilder();
  b.box(-4, 4, 0, 9, -6, 6, SURFACE.wall, SURFACE.roof, { kind: FACADE.windows, spacing: 2, floor: 3 });
  b.box(-4.2, 4.2, -1, 0.3, -6.2, 6.2, SURFACE.trim, null);
  const model = b.build();
  const fixed = { glass: 0x0a0b0c, paving: 0x999999 };
  const item = (angle: number): MergedItem => ({ model, extent, x: 100, y: 20, z: 200, angle, sx: 1.5, sz: 0.8, wall: 0x112233, roof: 0x445566, trim: 0xaabbcc, flat: 0x778899 });

  it("takes a model's box without its paving", () => {
    const positions = Float32Array.of(-1, 0, -1, 1, 5, 1, -10, 0, -10, 10, 0, 10);
    const surfaces = Float32Array.of(0, 1, 4, 4);
    expect(modelExtent(positions, surfaces, 4)).toEqual({ minX: -1, maxX: 1, minY: 0, maxY: 5, minZ: -1, maxZ: 1 });
    expect(modelExtent(positions, Float32Array.of(4, 4, 4, 4), 4).maxX).toBe(10);
  });

  for (const angle of [0, 0.7, Math.PI / 2, 2.5]) {
    it(`sets a model down where its full model's instance stands, facing out, at angle ${angle}`, () => {
      const a = mergeModels([item(angle), item(angle)], fixed);
      const n = model.surfaces.length;
      expect(a.positions.length).toBe(2 * n * 3);
      expect(a.indices.length).toBe(2 * model.indices.length);
      expect(a.indices).toBeInstanceOf(Uint16Array);
      expect(a.indices[model.indices.length]).toBe((model.indices[0] ?? 0) + n);
      // The same matrix the full form gives the instance (building-meshes.ts, `write`).
      const matrix = new Matrix4().compose(new Vector3(100, 20, 200), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle), new Vector3(1.5, 1, 0.8));
      const normalMatrix = new Matrix4().copy(matrix).invert().transpose();
      for (let v = 0; v < n; v++) {
        const p = new Vector3(model.positions[v * 3], model.positions[v * 3 + 1], model.positions[v * 3 + 2]).applyMatrix4(matrix);
        expect(a.positions[v * 3]).toBeCloseTo(p.x, 3);
        expect(a.positions[v * 3 + 1]).toBeCloseTo(p.y, 3);
        expect(a.positions[v * 3 + 2]).toBeCloseTo(p.z, 3);
        const want = new Vector3(model.normals[v * 3], model.normals[v * 3 + 1], model.normals[v * 3 + 2]).transformDirection(normalMatrix);
        const got = new Vector3(a.normals?.[v * 4] ?? 0, a.normals?.[v * 4 + 1] ?? 0, a.normals?.[v * 4 + 2] ?? 0).divideScalar(127);
        expect(got.distanceTo(want)).toBeLessThan(0.02);
        expect(a.normals?.[v * 4 + 3]).toBe(0);
      }
    });
  }

  it("colours each vertex by its surface and carries its window pattern", () => {
    const a = mergeModels([item(0.7)], fixed);
    const colour = (v: number) => [...a.colours.slice(v * 4, v * 4 + 3)];
    for (let v = 0; v < model.surfaces.length; v++) {
      const s = model.surfaces[v];
      expect(colour(v)).toEqual(s === SURFACE.wall ? [0x11, 0x22, 0x33] : s === SURFACE.roof ? [0x44, 0x55, 0x66] : [0xaa, 0xbb, 0xcc]);
      expect(a.colours[v * 4 + 3]).toBe(model.facades[v * 4 + 3]);
      // Windows along the wall in the lot's metres: the stretch along the wall's axis is taken out, as the full models' shader does.
      const stretch = model.facades[v * 4 + 2] === 0 ? 1.5 : 0.8;
      expect(a.facades?.[v * 2]).toBeCloseTo((model.facades[v * 4] ?? 0) * stretch, 5);
      expect(a.facades?.[v * 2 + 1]).toBeCloseTo(model.facades[v * 4 + 1] ?? 0, 5);
    }
    expect([...a.colours.slice(0, 4)]).toEqual([0x11, 0x22, 0x33, FACADE.windows]);
  });

  it("makes a flat block of the box's footprint, facing up, in its zone's colour", () => {
    const a = mergeFlats([item(0.7), item(2.5)]);
    expect(a.positions.length).toBe(2 * 4 * 3);
    expect(a.normals).toBeNull();
    for (let b = 0; b < 2; b++) {
      const p = (i: number, k: number) => a.positions[(b * 4 + i) * 3 + k] ?? 0;
      expect(p(0, 1)).toBe(20);
      const up = (p(1, 2) - p(0, 2)) * (p(2, 0) - p(0, 0)) - (p(1, 0) - p(0, 0)) * (p(2, 2) - p(0, 2));
      expect(up).toBeGreaterThan(0);
    }
    expect([...a.colours.slice(0, 4)]).toEqual([0x77, 0x88, 0x99, 255]);
    expect(a.radius).toBeGreaterThan(8);
  });
});
