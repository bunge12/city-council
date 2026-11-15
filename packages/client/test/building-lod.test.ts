// Levels of detail for buildings (issue M2-13): which form a chunk takes,
// the fade between forms, and the merged geometry. building-lod.ts.

import { describe, expect, it } from "vitest";
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "@city-council/sim";
import { chunkDistance, draws, fadeOf, formFor, isNear, mergeBoxes, mergeFlats, modelExtent, stepFade, type ChunkFade, type MergedItem } from "../src/render/building-lod";

describe("a chunk's form", () => {
  it("is full only near the camera in the street band", () => {
    expect(formFor("street", true)).toBe("full");
    expect(formFor("street", false)).toBe("box");
    expect(formFor("district", true)).toBe("box");
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
    stepFade(f, "box", all, 0.01, 0.35);
    expect(f).toEqual({ shown: "box", next: null, t: 0 });
  });

  it("waits for the new form to be built, then fades it in and lets the old one go", () => {
    const f: ChunkFade = { shown: "box", next: null, t: 0 };
    expect(stepFade(f, "full", () => false, 0.1, 0.4).released).toBeNull();
    expect(f.next).toBeNull();
    stepFade(f, "full", all, 0.1, 0.4);
    expect(f).toEqual({ shown: "box", next: "full", t: 0.25 });
    // The two share the screen: the new one the pixels under its fade, the old one the rest.
    expect(fadeOf(f, "full")).toBe(0.25);
    expect(fadeOf(f, "box")).toBe(2.25);
    expect(fadeOf(f, "flat")).toBe(0);
    expect(draws(f, "box") && draws(f, "full")).toBe(true);
    stepFade(f, "full", all, 0.2, 0.4);
    expect(stepFade(f, "full", all, 0.2, 0.4).released).toBe("box");
    expect(f).toEqual({ shown: "full", next: null, t: 0 });
    expect(fadeOf(f, "full")).toBe(1);
  });

  it("runs back the way it came when the chunk wants its old form again", () => {
    const f: ChunkFade = { shown: "box", next: "full", t: 0.5 };
    expect(stepFade(f, "box", all, 0.1, 0.4).released).toBeNull();
    expect(f.t).toBeCloseTo(0.25);
    expect(stepFade(f, "box", all, 0.2, 0.4).released).toBe("full");
    expect(f).toEqual({ shown: "box", next: null, t: 0 });
  });
});

describe("merged geometry", () => {
  const extent = { minX: -4, maxX: 4, minY: -1, maxY: 9, minZ: -6, maxZ: 6 };
  const item = (angle: number): MergedItem => ({ extent, x: 100, y: 20, z: 200, angle, sx: 1.5, sz: 1, wall: 0x112233, roof: 0x445566, flat: 0x778899 });

  it("takes a model's box without its paving", () => {
    const positions = Float32Array.of(-1, 0, -1, 1, 5, 1, -10, 0, -10, 10, 0, 10);
    const surfaces = Float32Array.of(0, 1, 4, 4);
    expect(modelExtent(positions, surfaces, 4)).toEqual({ minX: -1, maxX: 1, minY: 0, maxY: 5, minZ: -1, maxZ: 1 });
    expect(modelExtent(positions, Float32Array.of(4, 4, 4, 4), 4).maxX).toBe(10);
  });

  for (const angle of [0, 0.7, Math.PI / 2, 2.5]) {
    it(`makes a box of four walls and a roof, facing out, at angle ${angle}`, () => {
      const a = mergeBoxes([item(angle)]);
      expect(a.positions.length).toBe(5 * 4 * 3);
      expect(a.indices.length).toBe(5 * 6);
      const ys = a.positions.filter((_, k) => k % 3 === 1);
      expect(Math.min(...ys)).toBe(19);
      expect(Math.max(...ys)).toBe(29);
      // Stretched 1.5 times along the road: 12 m by 12 m, so every corner is the same distance from the middle across the ground.
      for (let v = 0; v < a.positions.length / 3; v++) {
        const dx = (a.positions[v * 3] ?? 0) - 100;
        const dz = (a.positions[v * 3 + 2] ?? 0) - 200;
        expect(Math.hypot(dx, dz)).toBeCloseTo(Math.hypot(6, 6), 4);
      }
      for (let f = 0; f < 5; f++) {
        const v = f * 4;
        const n = [0, 1, 2].map((k) => a.normals?.[v * 3 + k] ?? 0);
        const c = [0, 1, 2].map((k) => [0, 1, 2, 3].reduce((s, i) => s + (a.positions[(v + i) * 3 + k] ?? 0), 0) / 4);
        const out = (n[0] ?? 0) * ((c[0] ?? 0) - 100) + (n[1] ?? 0) * ((c[1] ?? 0) - 24) + (n[2] ?? 0) * ((c[2] ?? 0) - 200);
        expect(out).toBeGreaterThan(0);
        // The winding agrees with the normal, so the face is front-facing from outside.
        const p = (i: number, k: number) => a.positions[(v + i) * 3 + k] ?? 0;
        const cx = (p(1, 1) - p(0, 1)) * (p(2, 2) - p(0, 2)) - (p(1, 2) - p(0, 2)) * (p(2, 1) - p(0, 1));
        const cy = (p(1, 2) - p(0, 2)) * (p(2, 0) - p(0, 0)) - (p(1, 0) - p(0, 0)) * (p(2, 2) - p(0, 2));
        const cz = (p(1, 0) - p(0, 0)) * (p(2, 1) - p(0, 1)) - (p(1, 1) - p(0, 1)) * (p(2, 0) - p(0, 0));
        expect(cx * (n[0] ?? 0) + cy * (n[1] ?? 0) + cz * (n[2] ?? 0)).toBeGreaterThan(0);
      }
      // The roof is the last face, in the roof colour; walls take the wall colour.
      expect([...a.colours.slice(16 * 4, 16 * 4 + 4)]).toEqual([0x44, 0x55, 0x66, 255]);
      expect([...a.colours.slice(0, 4)]).toEqual([0x11, 0x22, 0x33, 255]);
    });
  }

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
