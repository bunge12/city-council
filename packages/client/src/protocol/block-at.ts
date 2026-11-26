// Which block a point on the ground is in, for the budget overlay's readout
// (issue M4-18). The blocks are the sim's own face walk on the mirror's copy
// of the roads (roads/blocks.ts); this only tests a point against their
// boundaries. A point inside a block a road ring sits in, such as a block
// round a smaller one, takes the smallest block round it.

import { CHUNKS_PER_SIDE, CHUNK_SIZE, blockIndexOf, listBlocks, quadPoint, segmentQuad, type Block, type RoadNetwork } from "@city-council/sim";

/** Points along each curved segment of a boundary. A straight one is its two ends. */
const CURVE_STEPS = 8;

/** Whether (x, z) is inside `block`, by the even-odd rule along its boundary. A dead end inside it is walked out and back, so it crosses a ray twice and changes nothing. */
export function inBlock(net: RoadNetwork, block: Block, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0; i < block.segments.length; i++) {
    const seg = block.segments[i] ?? 0;
    const q = segmentQuad(net, seg);
    const forward = block.forward[i] ?? true;
    const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
    const steps = straight ? 1 : CURVE_STEPS;
    let p = quadPoint(q, forward ? 0 : 1);
    for (let k = 1; k <= steps; k++) {
      const n = quadPoint(q, forward ? k / steps : 1 - k / steps);
      if (p.z > z !== n.z > z && x < p.x + ((z - p.z) * (n.x - p.x)) / (n.z - p.z)) inside = !inside;
      p = n;
    }
  }
  return inside;
}

/** The id of the smallest block of `net` round (x, z), or -1 for none. */
export function blockContaining(net: RoadNetwork, x: number, z: number): number {
  let best = -1;
  let bestArea = Infinity;
  for (const block of listBlocks(blockIndexOf(net))) {
    if (block.area < bestArea && inBlock(net, block, x, z)) {
      best = block.id;
      bestArea = block.area;
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
