// Picking a building under the pointer's ray (issue 116). Each building is
// tested as the box the box form draws for it (building-lod.ts,
// `mergeBoxes`): its model's extent without the paving, stretched to its
// lot, turned to face its road and set on the ground under it. In the city
// band, where buildings are drawn as flat blocks, the box is the block. The
// nearest box the ray enters wins, so at a tilt the facade in front wins
// over the road behind it on screen.
//
// Client work only: the id goes into a command the sim checks like any
// other, so trigonometry and rounding are fine here.

import type { Ray } from "../camera/pick";
import type { Extent } from "./building-lod";

/** A building as drawn: its model's extent and the place that takes the model's frame to the world, as in `MergedItem`. */
export interface PickBox {
  extent: Extent;
  x: number;
  y: number;
  z: number;
  angle: number;
  sx: number;
  sz: number;
}

/** The slab test on one axis: narrows [near, far] to where the ray is between `lo` and `hi`, or returns false when it misses. */
const slab = { near: 0, far: 0 };
function clip(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
  let t0 = (lo - o) / d;
  let t1 = (hi - o) / d;
  if (t0 > t1) {
    const t = t0;
    t0 = t1;
    t1 = t;
  }
  if (t0 > slab.near) slab.near = t0;
  if (t1 < slab.far) slab.far = t1;
  return slab.near <= slab.far;
}

/**
 * How far along `ray` it enters `box`, in units of the ray's direction, or
 * null when it misses, the box is behind the origin, or it is entered past
 * `limit`. Zero when the origin is inside. Allocates nothing: it runs for
 * every building along the ray while the camera moves.
 */
export function rayBoxDistance(ray: Ray, box: PickBox, limit = Infinity): number | null {
  // Into the model's frame: undo the move, the turn and the stretch.
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const px = ray.ox - box.x;
  const pz = ray.oz - box.z;
  const sx = box.sx || 1;
  const sz = box.sz || 1;
  const e = box.extent;
  slab.near = 0;
  slab.far = limit;
  // The inverse of three.js's turn about +y: x = x' cos - z' sin, z = x' sin + z' cos.
  if (!clip((px * c - pz * s) / sx, (ray.dx * c - ray.dz * s) / sx, e.minX, e.maxX)) return null;
  if (!clip(ray.oy - box.y, ray.dy, e.minY, e.maxY)) return null;
  if (!clip((px * s + pz * c) / sz, (ray.dx * s + ray.dz * c) / sz, e.minZ, e.maxZ)) return null;
  return slab.near;
}
