// Terrain chunk geometry, as plain typed arrays. No three.js here, so the
// geometry can be tested in Node.
//
// A chunk is a regular grid of `segments` quads per side over a 500 m
// square. Vertex heights come from the sim's `heightAt`, a pure function of
// world position, so two chunks that share an edge put identical vertices on
// it. Normals come from the same surface at a fixed step, so shading does not
// change with the level of detail.
//
// Where a fine chunk meets a coarser one, the fine edge has vertices the
// coarse edge lacks, which can open hairline gaps. Every chunk carries a
// skirt: a strip hanging down and slightly outward from each edge, under the
// neighbour, that fills any such gap.
//
// Positions are in world metres. Every chunk is drawn with the same
// (identity) model matrix, so a vertex two chunks share lands on the same
// pixel in both and same-level seams are watertight.

import { heightAt, mapSize, type Terrain } from "@city-council/sim";
import { CHUNK_SIZE, MAP_BASE_HEIGHT, SKIRT_DEPTH, SKIRT_FLARE } from "./config";

/** Geometry for one chunk at one level of detail. Positions are in world metres. */
export interface ChunkGeometry {
  positions: Float32Array;
  normals: Float32Array;
  /**
   * Height of the surface each vertex belongs to. Equal to y on the surface;
   * on the skirt it is the height of the edge vertex above. The material
   * colours by this, so a skirt glimpsed at a seam has the seam's colour.
   */
  surfaceHeights: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Number of vertices on the surface grid, before the skirt. */
  surfaceVertices: number;
}

/** Chunks along each side of the map. */
export function chunksPerSide(terrain: Pick<Terrain, "samples" | "spacing">): number {
  return Math.ceil(mapSize(terrain) / CHUNK_SIZE);
}

/** World position of the centre of chunk (ci, cj), at height 0. */
export function chunkCentre(ci: number, cj: number): { x: number; z: number } {
  return { x: (ci + 0.5) * CHUNK_SIZE, z: (cj + 0.5) * CHUNK_SIZE };
}

/** Unit surface normal at world (x, z), from central differences one sample apart. */
export function normalAt(terrain: Terrain, x: number, z: number, out: Float32Array, offset: number): void {
  const d = terrain.spacing;
  const dhdx = (heightAt(terrain, x + d, z) - heightAt(terrain, x - d, z)) / (2 * d);
  const dhdz = (heightAt(terrain, x, z + d) - heightAt(terrain, x, z - d)) / (2 * d);
  const len = Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
  out[offset] = -dhdx / len;
  out[offset + 1] = 1 / len;
  out[offset + 2] = -dhdz / len;
}

/** Builds the mesh for chunk (ci, cj) with `segments` quads per side. */
export function buildChunk(terrain: Terrain, ci: number, cj: number, segments: number): ChunkGeometry {
  const n = segments + 1;
  const step = CHUNK_SIZE / segments;
  const x0 = ci * CHUNK_SIZE;
  const z0 = cj * CHUNK_SIZE;
  const last = chunksPerSide(terrain) - 1;

  const surface = n * n;
  const skirt = 4 * n;
  const total = surface + skirt;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const surfaceHeights = new Float32Array(total);

  // Surface grid, row by row along z.
  let minEdge = Infinity;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = r * n + c;
      const x = x0 + c * step;
      const z = z0 + r * step;
      const y = heightAt(terrain, x, z);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      surfaceHeights[v] = y;
      normalAt(terrain, x, z, normals, v * 3);
      if ((r === 0 || r === n - 1 || c === 0 || c === n - 1) && y < minEdge) minEdge = y;
    }
  }

  // Skirt: four edges, each a copy of the edge row dropped below the chunk.
  // Edge order: z = min (north), x = max (east), z = max (south), x = min (west).
  // `out` is the outward direction (x, z) the skirt flares towards.
  const edges: { cells: (k: number) => number; outer: boolean; out: readonly [number, number] }[] = [
    { cells: (k) => k, outer: cj === 0, out: [0, -1] },
    { cells: (k) => k * n + (n - 1), outer: ci === last, out: [1, 0] },
    { cells: (k) => (n - 1) * n + k, outer: cj === last, out: [0, 1] },
    { cells: (k) => k * n, outer: ci === 0, out: [-1, 0] },
  ];
  const inner = minEdge - SKIRT_DEPTH;
  const base = Math.min(MAP_BASE_HEIGHT, inner);
  edges.forEach((edge, e) => {
    const bottom = edge.outer ? base : inner;
    for (let k = 0; k < n; k++) {
      const src = edge.cells(k);
      const dst = surface + e * n + k;
      positions[dst * 3] = (positions[src * 3] ?? 0) + edge.out[0] * SKIRT_FLARE;
      positions[dst * 3 + 1] = bottom;
      positions[dst * 3 + 2] = (positions[src * 3 + 2] ?? 0) + edge.out[1] * SKIRT_FLARE;
      surfaceHeights[dst] = surfaceHeights[src] ?? 0;
      normals[dst * 3] = normals[src * 3] ?? 0;
      normals[dst * 3 + 1] = normals[src * 3 + 1] ?? 0;
      normals[dst * 3 + 2] = normals[src * 3 + 2] ?? 0;
    }
  });

  // Skirt quads are wound both ways, so they show from either side with the
  // surface normal intact. (A double-sided material would flip the normal on
  // back faces and draw the seams dark.)
  const triangles = segments * segments * 2 + 4 * segments * 4;
  const indices = total > 0xffff ? new Uint32Array(triangles * 3) : new Uint16Array(triangles * 3);
  let t = 0;
  // Counter-clockwise seen from above (+y), so the surface faces up.
  for (let r = 0; r < segments; r++) {
    for (let c = 0; c < segments; c++) {
      const a = r * n + c;
      const b = a + 1;
      const d = a + n;
      const e = d + 1;
      indices[t++] = a;
      indices[t++] = d;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = d;
      indices[t++] = e;
    }
  }
  edges.forEach((edge, e) => {
    for (let k = 0; k < segments; k++) {
      const top0 = edge.cells(k);
      const top1 = edge.cells(k + 1);
      const bot0 = surface + e * n + k;
      const bot1 = bot0 + 1;
      indices[t++] = top0;
      indices[t++] = bot0;
      indices[t++] = top1;
      indices[t++] = top1;
      indices[t++] = bot0;
      indices[t++] = bot1;
      indices[t++] = top0;
      indices[t++] = top1;
      indices[t++] = bot0;
      indices[t++] = top1;
      indices[t++] = bot1;
      indices[t++] = bot0;
    }
  });

  return { positions, normals, surfaceHeights, indices, surfaceVertices: surface };
}

/**
 * Packs the resource masks into an RGBA texture, one texel per height
 * sample: red fertile, green forest, blue ore. Alpha is unused.
 */
export function resourceTexels(terrain: Terrain): Uint8Array {
  const count = terrain.samples * terrain.samples;
  const out = new Uint8Array(count * 4);
  for (let k = 0; k < count; k++) {
    out[k * 4] = (terrain.fertile[k] ?? 0) * 255;
    out[k * 4 + 1] = (terrain.forest[k] ?? 0) * 255;
    out[k * 4 + 2] = (terrain.ore[k] ?? 0) * 255;
    out[k * 4 + 3] = 255;
  }
  return out;
}
