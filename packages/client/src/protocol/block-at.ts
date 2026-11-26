// Which block a point on the ground is in, for the budget overlay's readout
// (issue M4-18). The blocks are the sim's own face walk on the mirror's copy
// of the roads (roads/blocks.ts); this only tests a point against their
// boundaries. A point inside a block a road ring sits in, such as a block
// round a smaller one, takes the smallest block round it.

import { CHUNKS_PER_SIDE, CHUNK_SIZE, blockIndexOf, listBlocks, quadPoint, segmentQuad, type Block, type RoadNetwork } from "@city-council/sim";

/** Points along each curved segment of a boundary. A straight one is its two ends. */
const CURVE_STEPS = 8;

/** One block's boundary as a closed run of points, and its box. */
export interface BlockOutline {
  id: number;
  area: number;
  xs: Float64Array;
  zs: Float64Array;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** `block`'s boundary as points, curves followed through `CURVE_STEPS` points. A dead end inside it is walked out and back. */
function outlineOf(net: RoadNetwork, block: Block): BlockOutline {
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < block.segments.length; i++) {
    const q = segmentQuad(net, block.segments[i] ?? 0);
    const forward = block.forward[i] ?? true;
    const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
    const steps = straight ? 1 : CURVE_STEPS;
    for (let k = 0; k < steps; k++) {
      const p = quadPoint(q, forward ? k / steps : 1 - k / steps);
      xs.push(p.x);
      zs.push(p.z);
    }
  }
  return {
    id: block.id,
    area: block.area,
    xs: Float64Array.from(xs),
    zs: Float64Array.from(zs),
    minX: Math.min(...xs),
    minZ: Math.min(...zs),
    maxX: Math.max(...xs),
    maxZ: Math.max(...zs),
  };
}

/** Every block of `net` as an outline with its box. Read it again when the roads change. */
export function blockOutlines(net: RoadNetwork): BlockOutline[] {
  return listBlocks(blockIndexOf(net)).map((b) => outlineOf(net, b));
}

/** Whether (x, z) is inside `o`, by the even-odd rule: a dead end crosses a ray twice and changes nothing. */
export function inOutline(o: BlockOutline, x: number, z: number): boolean {
  if (x < o.minX || x > o.maxX || z < o.minZ || z > o.maxZ) return false;
  let inside = false;
  const n = o.xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const px = o.xs[j] ?? 0;
    const pz = o.zs[j] ?? 0;
    const qx = o.xs[i] ?? 0;
    const qz = o.zs[i] ?? 0;
    if (pz > z !== qz > z && x < px + ((z - pz) * (qx - px)) / (qz - pz)) inside = !inside;
  }
  return inside;
}

/** The id of the smallest of `outlines` round (x, z), or -1 for none. */
export function blockContaining(outlines: readonly BlockOutline[], x: number, z: number): number {
  let best = -1;
  let bestArea = Infinity;
  for (const o of outlines) {
    if (o.area < bestArea && inOutline(o, x, z)) {
      best = o.id;
      bestArea = o.area;
    }
  }
  return best;
}

/** The 500 m chunk (x, z) is in, as the sim numbers chunks, off-map points in the nearest edge chunk. */
export function cellChunkOf(x: number, z: number): number {
  const clamp = (v: number) => {
    const c = Math.floor(v / CHUNK_SIZE);
    return c < 0 ? 0 : c >= CHUNKS_PER_SIDE ? CHUNKS_PER_SIDE - 1 : c;
  };
  return clamp(z) * CHUNKS_PER_SIDE + clamp(x);
}
