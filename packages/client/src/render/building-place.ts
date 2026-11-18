// Where a building stands (issue M2-12): on its lot, facing its road, at the
// ground under it. The lot comes from the mirror as four corners
// (`BuildingInfo.corners`): at the road and at the back of the first
// column's near edge, then at the back and at the road of the last column's
// far edge. On a straight road that is a rectangle; on a bend it is a
// quadrilateral, and the building takes the rectangle that fits it best.

/** A building's place: the middle of its lot on the ground, which way it faces, and the lot's size. */
export interface Placement {
  x: number;
  /** The highest ground under the lot. The model's base reaches down from there (theme generators). */
  y: number;
  z: number;
  /** Turn about +y that takes the model's +z, its front, to face the road. */
  angle: number;
  /** Metres along the road and back from it. */
  width: number;
  depth: number;
}

/** The placement of a lot with `corners`, over ground `height`. */
export function placeLot(corners: ArrayLike<number>, height: (x: number, z: number) => number): Placement {
  const c = (k: number) => corners[k] ?? 0;
  const [x0, z0, x1, z1, x2, z2, x3, z3] = [c(0), c(1), c(2), c(3), c(4), c(5), c(6), c(7)];
  const x = (x0 + x1 + x2 + x3) / 4;
  const z = (z0 + z1 + z2 + z3) / 4;
  // From the back of the lot to the road.
  const fx = (x0 + x3 - x1 - x2) / 2;
  const fz = (z0 + z3 - z1 - z2) / 2;
  const width = (Math.hypot(x3 - x0, z3 - z0) + Math.hypot(x2 - x1, z2 - z1)) / 2;
  const depth = (Math.hypot(x1 - x0, z1 - z0) + Math.hypot(x2 - x3, z2 - z3)) / 2;
  // A little in from each corner, a tenth of the way to the middle and no
  // more than `inset` metres: the road's edge drops away at the corner itself.
  const share = (k: number) => Math.min(0.1, inset / (Math.hypot(c(k * 2) - x, c(k * 2 + 1) - z) || 1));
  const pull = (k: number) => [c(k * 2) + (x - c(k * 2)) * share(k), c(k * 2 + 1) + (z - c(k * 2 + 1)) * share(k)] as const;
  const [[ax, az], [bx, bz], [cx, cz], [dx, dz]] = [pull(0), pull(1), pull(2), pull(3)];
  // The ground over the whole lot, not only its middle and corners: a rise
  // between them would come up through the bottom of the walls (issue
  // #137). A grid of samples no more than `step` metres apart.
  const across = Math.max(1, Math.ceil(width / step));
  const back = Math.max(1, Math.ceil(depth / step));
  let y = height(x, z);
  for (let i = 0; i <= across; i++) {
    const a = i / across;
    // Along the road at the front, and at the back.
    const fx0 = ax + (dx - ax) * a;
    const fz0 = az + (dz - az) * a;
    const bx0 = bx + (cx - bx) * a;
    const bz0 = bz + (cz - bz) * a;
    for (let j = 0; j <= back; j++) {
      const t = j / back;
      y = Math.max(y, height(fx0 + (bx0 - fx0) * t, fz0 + (bz0 - fz0) * t));
    }
  }
  return { x, y, z, angle: Math.atan2(fx, fz), width, depth };
}

/** Metres between the samples of the ground under a lot, and the most the samples keep in from a corner. */
const step = 5;
const inset = 1;
