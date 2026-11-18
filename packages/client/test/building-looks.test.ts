// Issue #137: the look and detail of the buildings. No model can be seen
// into or draws its windows on another face, every building's windows have
// a look of their own, a building stands clear of the ground under its
// whole lot, and the downtown types come in more shapes.
import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, generateTerrain, heightAt } from "@city-council/sim";
import { LOOKS, STYLES, lookFor } from "../src/render/building-tint";
import { placeLot } from "../src/render/building-place";
import { buildChunk, surfaceHeightAt } from "../src/render/terrain-chunks";
import { SURFACE, type ModelArrays } from "../src/theme/model";
import { NORTH_AMERICAN } from "../src/theme/north-american";
import { tower } from "../src/theme/north-american/generators";

const theme = NORTH_AMERICAN;
/** The looks of ids 0, 1, 2, 3 and 123456. */
const FIXED_LOOKS = [23, 1, 24, 23, 10];

type V3 = [number, number, number];

/**
 * Rays from above the ground, at four heights of sun and eight bearings,
 * aimed at a grid of points over the model's ground. Returns the rays whose
 * first face is seen from behind: a ray that went in through a gap and
 * shows the inside of a wall or a roof. With back faces culled, such a ray
 * shows whatever is beyond the model instead, grass or sky. Faces under
 * the ground are hidden by the terrain and do not count.
 */
function seeThrough(m: ModelArrays): V3[] {
  const p = m.positions;
  const tris: { a: V3; e1: V3; e2: V3; n: V3 }[] = [];
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const at = (i: number): V3 => {
      const v = m.indices[k + i] ?? 0;
      return [p[v * 3] ?? 0, p[v * 3 + 1] ?? 0, p[v * 3 + 2] ?? 0];
    };
    const [a, b, c] = [at(0), at(1), at(2)];
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    tris.push({ a, e1, e2, n: cross(e1, e2) });
    for (const q of [a, b, c]) {
      [minX, maxX, minZ, maxZ] = [Math.min(minX, q[0]), Math.max(maxX, q[0]), Math.min(minZ, q[2]), Math.max(maxZ, q[2])];
    }
  }
  const leaks: V3[] = [];
  const steps = 12;
  for (const rise of [0.25, 0.6, 1, 1.5]) {
    for (let bearing = 0; bearing < 8; bearing++) {
      const turn = (bearing / 8) * Math.PI * 2 + 0.1;
      const d: V3 = [Math.cos(turn) * Math.cos(rise), -Math.sin(rise), Math.sin(turn) * Math.cos(rise)];
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const target: V3 = [minX + ((maxX - minX) * (i + 0.37)) / (steps + 1), 0, minZ + ((maxZ - minZ) * (j + 0.61)) / (steps + 1)];
          const o: V3 = [target[0] - d[0] * 400, -d[1] * 400, target[2] - d[2] * 400];
          let best = Infinity;
          let facing = 0;
          for (const t of tris) {
            const hit = intersect(o, d, t.a, t.e1, t.e2);
            if (hit === null || o[1] + d[1] * hit < 0) continue;
            const f = dot(t.n, d) / Math.hypot(...t.n);
            // Where two faces meet at the hit, the one facing the ray decides.
            if (hit < best - 1e-6) [best, facing] = [hit, f];
            else if (Math.abs(hit - best) <= 1e-6) facing = Math.min(facing, f);
          }
          if (best < Infinity && facing > 1e-3) leaks.push([o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best]);
        }
      }
    }
  }
  return leaks;
}

function cross(u: V3, v: V3): V3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function dot(u: V3, v: V3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

/** Distance along the ray from `o` in direction `d` to the triangle at `a` with edges `e1`, `e2`, or null. */
function intersect(o: V3, d: V3, a: V3, e1: V3, e2: V3): number | null {
  const q = cross(d, e2);
  const det = dot(e1, q);
  if (Math.abs(det) < 1e-12) return null;
  const s: V3 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = dot(s, q) / det;
  if (u < 0 || u > 1) return null;
  const r = cross(s, e1);
  const v = dot(d, r) / det;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, r) / det;
  return t > 0 ? t : null;
}

/**
 * Pairs of faces of a model that lie on one plane, face the same way and
 * overlap, where one of them draws a facade: the depth test cannot tell them
 * apart, so each pixel shows one or the other, and windows break up into
 * speckle (issue #137). Faces under the ground, and two halves of one quad,
 * do not count.
 */
function overlaps(m: ModelArrays): string[] {
  const p = m.positions;
  const faces: { n: V3; d: number; pts: V3[]; kind: number }[] = [];
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const vs = [m.indices[k] ?? 0, m.indices[k + 1] ?? 0, m.indices[k + 2] ?? 0];
    const pts = vs.map((v): V3 => [p[v * 3] ?? 0, p[v * 3 + 1] ?? 0, p[v * 3 + 2] ?? 0]);
    if (pts.every((q) => q[1] <= 0.31)) continue;
    const v0 = vs[0] ?? 0;
    const n: V3 = [m.normals[v0 * 3] ?? 0, m.normals[v0 * 3 + 1] ?? 0, m.normals[v0 * 3 + 2] ?? 0];
    faces.push({ n, d: dot(n, pts[0] as V3), pts, kind: m.facades[v0 * 4 + 3] ?? 0 });
  }
  const out: string[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i] as (typeof faces)[number];
      const b = faces[j] as (typeof faces)[number];
      if (a.kind === 0 && b.kind === 0) continue;
      if (Math.abs(a.n[0] - b.n[0]) + Math.abs(a.n[1] - b.n[1]) + Math.abs(a.n[2] - b.n[2]) > 1e-4 || Math.abs(a.d - b.d) > 0.06) continue;
      const shared = a.pts.filter((q) => b.pts.some((r) => Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]) < 1e-6)).length;
      if (shared >= 2) continue;
      let area = 1;
      for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(a.n[axis] ?? 0) > 0.9) continue;
        const lo = Math.max(Math.min(...a.pts.map((q) => q[axis] ?? 0)), Math.min(...b.pts.map((q) => q[axis] ?? 0)));
        const hi = Math.min(Math.max(...a.pts.map((q) => q[axis] ?? 0)), Math.max(...b.pts.map((q) => q[axis] ?? 0)));
        area *= Math.max(0, hi - lo);
      }
      if (area > 0.05) out.push(`facing ${a.n.join(", ")} at ${a.d.toFixed(2)}, facades ${a.kind} and ${b.kind}`);
    }
  }
  return out;
}

describe("the North American theme's models", () => {
  it("cannot be seen into from above the ground, by any model of any type at its narrowest and widest", () => {
    const leaks: string[] = [];
    for (const t of BUILDING_TYPES) {
      for (let model = 0; model < theme.modelCount(t.id); model++) {
        for (const w of new Set([t.width[0], t.width[1]])) {
          const found = seeThrough(theme.model(t.id, model, w, theme.modelDepth(t.id)));
          if (found.length > 0) leaks.push(`${t.id} model ${model} width ${w}: ${found.length} rays, first at ${found[0]?.map((x) => x.toFixed(1)).join(", ")}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it("draws no facade on a plane another face of the model lies on", () => {
    const found: string[] = [];
    for (const t of BUILDING_TYPES) {
      for (let model = 0; model < theme.modelCount(t.id); model++) {
        for (const w of new Set([t.width[0], t.width[1]])) {
          const pairs = overlaps(theme.model(t.id, model, w, theme.modelDepth(t.id)));
          if (pairs.length > 0) found.push(`${t.id} model ${model} width ${w}: ${pairs.length}, ${pairs[0] ?? ""}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("closes a tower's top under every crown, and the scan finds a roof left open", () => {
    const lot = { w: 32, d: 32 };
    for (const crown of ["flat", "step", "mast", "pyramid"] as const) {
      const m = tower(lot, { podium: 0, shops: false, floors: 12, share: 1, curtain: false, spacing: 3, storey: 3.2, crown });
      expect(seeThrough(m), crown).toEqual([]);
    }
    // The check itself: the same tower with its roof faces taken out is seen into.
    const m = tower(lot, { podium: 0, shops: false, floors: 12, share: 1, curtain: false, spacing: 3, storey: 3.2, crown: "flat" });
    const indices: number[] = [];
    for (let k = 0; k + 2 < m.indices.length; k += 3) {
      const v = m.indices[k] ?? 0;
      if (m.surfaces[v] === SURFACE.roof) continue;
      indices.push(m.indices[k] ?? 0, m.indices[k + 1] ?? 0, m.indices[k + 2] ?? 0);
    }
    expect(seeThrough({ ...m, indices: Uint16Array.from(indices) }).length).toBeGreaterThan(0);
  });

  it("gives the downtown types five models each, no two alike", () => {
    for (const id of ["mid-rise-office-tower", "slim-office-tower", "office-tower", "tall-office-tower", "low-tower", "high-tower", "tall-podium-tower", "mid-rise-office", "office-slab"]) {
      expect(theme.modelCount(id), id).toBeGreaterThanOrEqual(5);
      // No two models of a type are the same: in shape, or in what their walls show.
      const t = BUILDING_TYPES.find((b) => b.id === id);
      const w = t?.width[1] ?? 3;
      const shapes = new Set<string>();
      for (let k = 0; k < theme.modelCount(id); k++) {
        const m = theme.model(id, k, w, theme.modelDepth(id));
        shapes.add(`${[...m.positions].map((x) => x.toFixed(2)).join()}/${[...m.facades].filter((_, i) => i % 4 === 3).join()}`);
      }
      expect(shapes.size, id).toBe(theme.modelCount(id));
    }
  });
});

describe("a building's look", () => {
  it("is a function of the id alone, with fixed numbers", () => {
    expect(lookFor(7)).toBe(lookFor(7));
    // Fixed: a look may not move between versions of the game without every street's windows changing.
    expect([0, 1, 2, 3, 123456].map(lookFor)).toEqual(FIXED_LOOKS);
  });

  it("takes every style and every look, about evenly", () => {
    const styles = new Array<number>(STYLES).fill(0);
    const looks = new Set<number>();
    for (let id = 0; id < 4000; id++) {
      const look = lookFor(id);
      expect(Number.isInteger(look) && look >= 0 && look < LOOKS).toBe(true);
      looks.add(look);
      styles[look % STYLES] = (styles[look % STYLES] ?? 0) + 1;
    }
    expect(looks.size).toBe(LOOKS);
    for (const n of styles) expect(n).toBeGreaterThan(800);
  });

  it("has glass in tints of its own and a sky to reflect, lighter than the roads' asphalt", () => {
    const luma = (hex: number) => 0.2126 * ((hex >> 16) & 0xff) + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);
    expect(theme.fixed.glassTints.length).toBeGreaterThan(1);
    // The old glass, 0x41566b, was darker than the avenue's asphalt, 0x4f5156, and read as road.
    for (const tint of theme.fixed.glassTints) expect(luma(tint)).toBeGreaterThan(luma(0x4f5156) * 1.2);
    expect(luma(theme.fixed.sky)).toBeGreaterThan(luma(theme.fixed.glassTints[0] ?? 0));
  });
});

describe("the ground under a lot", () => {
  it("is found under the whole lot, so a rise between its middle and its corners stays under the floor", () => {
    // A 16 x 32 lot from (0, 0), flat but for a mound 3 m high a quarter of the way in, away from the middle and the corners, rising 1 in 4.
    const mound = (x: number, z: number) => Math.max(0, 3 - 0.25 * Math.hypot(x - 4, z - 8));
    const corners = [0, 0, 0, 32, 16, 32, 16, 0];
    // The middle and the corners alone are well down its sides.
    expect(Math.max(mound(8, 16), mound(0, 0), mound(0, 32), mound(16, 32), mound(16, 0))).toBeLessThan(2);
    expect(placeLot(corners, mound).y).toBeGreaterThan(2.5);
  });

  it("is the ground as the nearest terrain draws it: its triangles, not the bilinear surface between them", () => {
    const terrain = generateTerrain(2026);
    const segments = 32;
    const ci = 8;
    const cj = 9;
    const chunk = buildChunk(terrain, ci, cj, segments);
    const n = segments + 1;
    let above = 0;
    for (let r = 0; r < segments; r += 3) {
      for (let c = 0; c < segments; c += 5) {
        const v = (k: number) => [chunk.positions[k * 3] ?? 0, chunk.positions[k * 3 + 1] ?? 0, chunk.positions[k * 3 + 2] ?? 0] as const;
        const [a, b, d, e] = [v(r * n + c), v(r * n + c + 1), v((r + 1) * n + c), v((r + 1) * n + c + 1)];
        // At a vertex, the vertex's height; on the diagonal from b to d, halfway between them; past it, on the triangle b, d, e.
        expect(surfaceHeightAt(terrain, a[0], a[2], segments)).toBeCloseTo(a[1], 3);
        expect(surfaceHeightAt(terrain, (b[0] + d[0]) / 2, (b[2] + d[2]) / 2, segments)).toBeCloseTo((b[1] + d[1]) / 2, 3);
        const x = b[0] * 0.2 + d[0] * 0.2 + e[0] * 0.6;
        const z = b[2] * 0.2 + d[2] * 0.2 + e[2] * 0.6;
        expect(surfaceHeightAt(terrain, x, z, segments)).toBeCloseTo(b[1] * 0.2 + d[1] * 0.2 + e[1] * 0.6, 3);
        if (surfaceHeightAt(terrain, (b[0] + d[0]) / 2, (b[2] + d[2]) / 2, segments) > heightAt(terrain, (b[0] + d[0]) / 2, (b[2] + d[2]) / 2) + 1e-3) above++;
      }
    }
    // Somewhere on it the drawn ground stands above the bilinear surface, which is why a building asks for it.
    expect(above).toBeGreaterThan(0);
  });
});
