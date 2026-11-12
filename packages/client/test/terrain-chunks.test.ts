// Chunk geometry checks that stand in for "no cracks": neighbours share edge
// vertices exactly, coarse levels are subsets of fine ones, and the skirts
// reach below any gap a level change can open.
import { beforeAll, describe, expect, it } from "vitest";
import { generateTerrain, heightAt, type Terrain } from "@city-council/sim";
import { CHUNK_SIZE, MAP_BASE_HEIGHT, SKIRT_FLARE, TERRAIN_LODS } from "../src/render/config";
import { buildChunk, chunksPerSide, type ChunkGeometry } from "../src/render/terrain-chunks";

let terrain: Terrain;
beforeAll(() => {
  terrain = generateTerrain(1);
});

/** Surface vertices of a chunk, keyed by world "x,z". */
function worldVertices(g: ChunkGeometry): Map<string, number> {
  const out = new Map<string, number>();
  for (let v = 0; v < g.surfaceVertices; v++) {
    const x = g.positions[v * 3] ?? 0;
    const z = g.positions[v * 3 + 2] ?? 0;
    out.set(`${x},${z}`, g.positions[v * 3 + 1] ?? 0);
  }
  return out;
}

/** Lowest y among a chunk's skirt vertices along one edge. Edges: 0 north, 1 east, 2 south, 3 west. */
function skirtBottom(g: ChunkGeometry, segments: number, edge: number): number {
  const n = segments + 1;
  let min = Infinity;
  for (let k = 0; k < n; k++) min = Math.min(min, g.positions[(g.surfaceVertices + edge * n + k) * 3 + 1] ?? 0);
  return min;
}

/** Heights along the east edge of chunk (ci, cj) as drawn at `segments`, sampled every metre. */
function eastEdgeProfile(ci: number, cj: number, segments: number): number[] {
  const x = (ci + 1) * CHUNK_SIZE;
  const step = CHUNK_SIZE / segments;
  const out: number[] = [];
  for (let m = 0; m <= CHUNK_SIZE; m++) {
    const s = Math.min(Math.floor(m / step), segments - 1);
    const z0 = cj * CHUNK_SIZE + s * step;
    const a = heightAt(terrain, x, z0);
    const b = heightAt(terrain, x, z0 + step);
    out.push(a + ((b - a) * (m - s * step)) / step);
  }
  return out;
}

describe("terrain chunks", () => {
  it("cuts the 12 km map into 24 x 24 chunks of 500 m", () => {
    expect(chunksPerSide(terrain)).toBe(24);
  });

  it("puts identical vertices on an edge two chunks share", () => {
    for (const { segments } of TERRAIN_LODS) {
      const a = worldVertices(buildChunk(terrain, 5, 7, segments));
      const b = worldVertices(buildChunk(terrain, 6, 7, segments));
      const below = worldVertices(buildChunk(terrain, 5, 8, segments));
      let shared = 0;
      for (const [key, y] of a) {
        for (const other of [b, below]) {
          if (other.has(key)) {
            shared++;
            expect(other.get(key)).toBe(y);
          }
        }
      }
      expect(shared).toBe(2 * (segments + 1));
    }
  });

  it("makes every coarse vertex a vertex of the finer levels at the same height", () => {
    const levels = TERRAIN_LODS.map(({ segments }) => worldVertices(buildChunk(terrain, 11, 3, segments)));
    for (let l = 1; l < levels.length; l++) {
      for (const [key, y] of levels[l] ?? []) expect(levels[l - 1]?.get(key)).toBe(y);
    }
  });

  it("hangs skirts below any gap between two levels of detail", () => {
    const per = chunksPerSide(terrain);
    for (let cj = 0; cj < per; cj++) {
      for (let ci = 0; ci < per - 1; ci++) {
        for (const fine of TERRAIN_LODS) {
          for (const coarse of TERRAIN_LODS) {
            if (coarse.segments >= fine.segments) continue;
            const pf = eastEdgeProfile(ci, cj, fine.segments);
            const pc = eastEdgeProfile(ci, cj, coarse.segments);
            let gapFloor = Infinity;
            for (let m = 0; m < pf.length; m++) gapFloor = Math.min(gapFloor, pf[m] ?? 0, pc[m] ?? 0);
            // The fine chunk on the west and the coarse one on the east, then the other way round.
            const west = skirtBottom(buildChunk(terrain, ci, cj, fine.segments), fine.segments, 1);
            const east = skirtBottom(buildChunk(terrain, ci + 1, cj, coarse.segments), coarse.segments, 3);
            expect(Math.min(west, east)).toBeLessThan(gapFloor);
          }
        }
      }
    }
  });

  it("drops skirts on the map border to the base height", () => {
    const g = buildChunk(terrain, 0, 0, 8);
    expect(skirtBottom(g, 8, 0)).toBeLessThanOrEqual(MAP_BASE_HEIGHT);
    expect(skirtBottom(g, 8, 3)).toBeLessThanOrEqual(MAP_BASE_HEIGHT);
  });

  it("flares each skirt outward, under the neighbour", () => {
    const g = buildChunk(terrain, 4, 9, 8);
    const n = 9;
    const x = (v: number) => g.positions[v * 3] ?? 0;
    const z = (v: number) => g.positions[v * 3 + 2] ?? 0;
    const s = g.surfaceVertices;
    expect(z(s)).toBe(9 * CHUNK_SIZE - SKIRT_FLARE);
    expect(x(s + n)).toBe(5 * CHUNK_SIZE + SKIRT_FLARE);
    expect(z(s + 2 * n)).toBe(10 * CHUNK_SIZE + SKIRT_FLARE);
    expect(x(s + 3 * n)).toBe(4 * CHUNK_SIZE - SKIRT_FLARE);
  });

  it("gives unit normals that point up", () => {
    const g = buildChunk(terrain, 12, 12, 16);
    for (let v = 0; v < g.surfaceVertices; v++) {
      const x = g.normals[v * 3] ?? 0;
      const y = g.normals[v * 3 + 1] ?? 0;
      const z = g.normals[v * 3 + 2] ?? 0;
      expect(Math.abs(x * x + y * y + z * z - 1)).toBeLessThan(1e-5);
      expect(y).toBeGreaterThan(0);
    }
  });

  it("winds surface triangles to face up", () => {
    const g = buildChunk(terrain, 2, 2, 8);
    const p = (i: number) => [g.positions[i * 3] ?? 0, g.positions[i * 3 + 1] ?? 0, g.positions[i * 3 + 2] ?? 0];
    for (let t = 0; t < 8 * 8 * 2; t++) {
      const [a, b, c] = [0, 1, 2].map((o) => p(g.indices[t * 3 + o] ?? 0));
      if (!a || !b || !c) throw new Error("missing vertex");
      const u = [(b[0] ?? 0) - (a[0] ?? 0), (b[2] ?? 0) - (a[2] ?? 0)];
      const w = [(c[0] ?? 0) - (a[0] ?? 0), (c[2] ?? 0) - (a[2] ?? 0)];
      // y component of (b - a) x (c - a).
      const ny = (u[1] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[1] ?? 0);
      expect(ny).toBeGreaterThan(0);
    }
  });
});
