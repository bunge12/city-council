// Issue M2-06: the zoning overlay's mesh for a chunk, built from the
// mirror's cells, and the colours it draws them in.
import { describe, expect, it } from "vitest";
import {
  CELL_OPEN,
  CELL_ROAD,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  ZONING_BALANCE,
  cellShapesInChunk,
  createState,
  step,
  submit,
  type ChunkCellShapes,
} from "@city-council/sim";
import { buildCellChunk, cellColour } from "../src/render/cell-geometry";
import { CELLS } from "../src/render/config";

const flat = () => 10;

/** Two cells side by side, as `cellShapesInChunk` lays them out, at slots 0 and 1, and a blocked one at slot 2. */
function twoCells(): ChunkCellShapes {
  return {
    slots: Int32Array.of(0, 1, 2),
    statuses: Uint8Array.of(CELL_OPEN, CELL_OPEN, CELL_ROAD),
    corners: Float64Array.of(0, 0, 8, 0, 8, 8, 0, 8, 8, 0, 16, 0, 16, 8, 8, 8, 0, 0, 1, 0, 1, 1, 0, 1),
  };
}

describe("cell chunk geometry", () => {
  it("draws each open cell as a quad on the ground, and no blocked cell", () => {
    const g = buildCellChunk(twoCells(), [1, 0, 1], [2, 0, 2], (x, z) => x + z);
    expect(g.zoned).toBe(1);
    expect(g.unzoned).toBe(1);
    expect(g.positions).toHaveLength(2 * 4 * 3);
    expect(g.indices).toHaveLength(2 * 6);
    expect(Array.from(g.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    // Each corner sits on the ground under it.
    expect(Array.from(g.positions.subarray(0, 12))).toEqual([0, 0, 0, 8, 8, 0, 8, 16, 8, 0, 8, 8]);
    // Where each corner is in its cell: u along the road, v back from it.
    expect(Array.from(g.corners.subarray(0, 8))).toEqual([0, 0, 255, 0, 255, 255, 0, 255]);
  });

  it("fills a zoned cell with its zone's shade for its density, and gives an unzoned one the outline colour with no fill", () => {
    const g = buildCellChunk(twoCells(), [1, 0], [2, 0], flat);
    const rgba = (v: number) => Array.from(g.fills.subarray(v * 4, v * 4 + 4));
    const hex = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const r2 = CELLS.zones["residential"]?.[1] ?? 0;
    for (let v = 0; v < 4; v++) expect(rgba(v)).toEqual([...hex(r2), 255]);
    for (let v = 4; v < 8; v++) expect(rgba(v)).toEqual([...hex(CELLS.unzoned), 0]);
  });

  it("uses 32-bit indices only when a chunk has more vertices than 16 bits reach", () => {
    expect(buildCellChunk(twoCells(), [0, 0], [0, 0], flat).indices).toBeInstanceOf(Uint16Array);
    const n = 20_000;
    const many: ChunkCellShapes = { slots: new Int32Array(n), statuses: new Uint8Array(n), corners: new Float64Array(n * 8) };
    const g = buildCellChunk(many, [0], [0], flat);
    expect(g.indices).toBeInstanceOf(Uint32Array);
    expect(g.indices[g.indices.length - 1]).toBe(n * 4 - 1);
  });

  it("draws a real street's cells from the sim's chunk query: twelve per place, none under the crossing road", () => {
    const state = createState(2026);
    const road = (seq: number, from: [number, number], to: [number, number]) => {
      const r = submit(state, { seq, playerId: "p", type: "BuildRoad", payload: { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" } });
      expect(r.ok).toBe(true);
      step(state);
    };
    road(1, [4200, 4600], [4392, 4600]);
    const chunk = Math.floor(4600 / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(4300 / CHUNK_SIZE);
    const before = buildCellChunk(cellShapesInChunk(state, chunk), state.cells.zone, state.cells.density, flat);
    expect(before.zoned).toBe(0);
    expect(before.unzoned).toBe((192 / ZONING_BALANCE.cellSize) * 2 * ZONING_BALANCE.zoneDepthCells);
    road(2, [4300, 4500], [4300, 4700]);
    const after = buildCellChunk(cellShapesInChunk(state, chunk), state.cells.zone, state.cells.density, flat);
    expect(after.unzoned).toBeLessThan(before.unzoned + (200 / ZONING_BALANCE.cellSize) * 2 * ZONING_BALANCE.zoneDepthCells);
  });
});

// ---- The palette ----
//
// Colours are compared in OKLab, where a distance of about 0.02 is just
// noticeable. Colour blindness is simulated with the full-severity matrices
// of Machado, Oliveira and Fernandes (2009), applied in linear sRGB.

type Rgb = [number, number, number];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex: number): Rgb => [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];
function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const VISION: Record<string, readonly (readonly number[])[] | null> = {
  normal: null,
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const clamp = (v: number) => Math.min(1, Math.max(0, v));
function seen(hex: number, m: readonly (readonly number[])[] | null): Rgb {
  const c = linear(hex);
  if (!m) return oklab(c);
  const row = (k: number) => clamp((m[k]?.[0] ?? 0) * c[0] + (m[k]?.[1] ?? 0) * c[1] + (m[k]?.[2] ?? 0) * c[2]);
  return oklab([row(0), row(1), row(2)]);
}
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The ground and road colours the cells lie beside: sand, grass, upland, forest canopy and the road greys. */
const SURROUNDINGS = [0xb09a6a, 0xd9cb9b, 0x86a95c, 0x8f9a6a, 0x4a7436, 0x6d6f73, 0x4f5156];

describe("zone colours", () => {
  const zones = ZONING_BALANCE.zones.map((z, i) => ({ id: z.id, index: i + 1 }));
  const densities = ZONING_BALANCE.densities.map((d) => d.level);

  it("has three shades for every zone in zoning.json, and nothing else", () => {
    expect(Object.keys(CELLS.zones).sort()).toEqual(zones.map((z) => z.id).sort());
    for (const z of zones) expect(CELLS.zones[z.id]).toHaveLength(densities.length);
    expect(cellColour(1, 1)).toBe(CELLS.zones["residential"]?.[0]);
    expect(cellColour(0, 0)).toBe(CELLS.unzoned);
  });

  it("makes density lighter or darker, never another hue: density 1 is the lightest", () => {
    for (const z of zones) {
      const labs = densities.map((d) => oklab(linear(cellColour(z.index, d))));
      for (let d = 1; d < labs.length; d++) expect(labs[d]?.[0] ?? 0).toBeLessThan(labs[d - 1]?.[0] ?? 0);
      const hues = labs.map(([, a, b]) => (Math.atan2(b, a) * 180) / Math.PI);
      expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(15);
    }
  });

  it("keeps two cells of one zone, or of one density, apart under normal vision and three kinds of colour blindness", () => {
    const worst: string[] = [];
    for (const [vision, m] of Object.entries(VISION)) {
      for (const a of zones) {
        for (const da of densities) {
          for (const b of zones) {
            for (const db of densities) {
              if (b.index * 10 + db <= a.index * 10 + da || (a.index !== b.index && da !== db)) continue;
              const d = distance(seen(cellColour(a.index, da), m), seen(cellColour(b.index, db), m));
              if (d < 0.045) worst.push(`${vision}: ${a.id} ${da} and ${b.id} ${db}, ${d.toFixed(3)}`);
            }
          }
        }
      }
    }
    expect(worst).toEqual([]);
  });

  it("keeps every shade apart from the ground and roads around the cells, under each kind of vision", () => {
    const worst: string[] = [];
    for (const [vision, m] of Object.entries(VISION)) {
      for (const z of zones) {
        for (const d of densities) {
          for (const ground of SURROUNDINGS) {
            const gap = distance(seen(cellColour(z.index, d), m), seen(ground, m));
            if (gap < 0.04) worst.push(`${vision}: ${z.id} ${d} and #${ground.toString(16)}, ${gap.toFixed(3)}`);
          }
        }
      }
    }
    expect(worst).toEqual([]);
  });
});
