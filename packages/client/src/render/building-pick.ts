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

/**
 * How far along `ray` it enters `box`, in units of the ray's direction, or
 * null when it misses or the box is behind the origin. Zero when the
 * origin is inside.
 */
export function rayBoxDistance(ray: Ray, box: PickBox): number | null {
  // Into the model's frame: undo the move, the turn and the stretch.
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const px = ray.ox - box.x;
  const pz = ray.oz - box.z;
  const sx = box.sx || 1;
  const sz = box.sz || 1;
  // The inverse of three.js's turn about +y: x = x' cos - z' sin, z = x' sin + z' cos.
  const o = [(px * c - pz * s) / sx, ray.oy - box.y, (px * s + pz * c) / sz];
  const d = [(ray.dx * c - ray.dz * s) / sx, ray.dy, (ray.dx * s + ray.dz * c) / sz];
  const lo = [box.extent.minX, box.extent.minY, box.extent.minZ];
  const hi = [box.extent.maxX, box.extent.maxY, box.extent.maxZ];
  let near = 0;
  let far = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = o[a] ?? 0;
    const da = d[a] ?? 0;
    const l = lo[a] ?? 0;
    const h = hi[a] ?? 0;
    if (Math.abs(da) < 1e-12) {
      if (oa < l || oa > h) return null;
      continue;
    }
    let t0 = (l - oa) / da;
    let t1 = (h - oa) / da;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return null;
  }
  return near;
}

/** The id of the box `ray` enters first, or -1. Ties go to the lower id. */
export function pickBox(ray: Ray, boxes: Iterable<{ id: number; box: PickBox }>): number {
  let best = -1;
  let bestT = Infinity;
  for (const { id, box } of boxes) {
    const t = rayBoxDistance(ray, box);
    if (t === null) continue;
    if (t < bestT || (t === bestT && id < best)) {
      best = id;
      bestT = t;
    }
  }
  return best;
}
