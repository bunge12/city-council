// The shapes a theme's building generators are made of (issue M2-12): boxes,
// gable and hip roofs and prisms, written into flat arrays a BufferGeometry
// takes as they are. No mesh or texture files: every model is built here,
// in code, from the numbers its generator passes.
//
// A model stands on a lot with its origin at the middle of the lot, on the
// ground. +x runs along the road, +z points at the road, so the front of a
// building faces +z, and y is up. All in metres.
//
// Each vertex says which surface it belongs to, so a building can tint its
// walls, its roof and its trim on their own (PRD, "Art direction"), and
// where it is on its facade, from which the shader draws a window pattern
// (render/building-meshes.ts). Faces are flat shaded: a face has vertices
// of its own, with the face's normal.

/** The surfaces of a model. Wall, roof and trim take the building's tints; glass and paving are the theme's. */
export const SURFACE = { wall: 0, roof: 1, trim: 2, glass: 3, paving: 4 } as const;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];

/**
 * What a wall face shows. `windows` is a grid of windows, one per floor and
 * per `spacing` metres; `storefront` large panes of glass at street level;
 * `curtain` a glass wall with thin frames; `doors` wide loading or garage
 * doors.
 */
export const FACADE = { none: 0, windows: 1, storefront: 2, curtain: 3, doors: 4 } as const;
export type FacadeKind = (typeof FACADE)[keyof typeof FACADE];

/** How a box's walls are drawn: the pattern and its rhythm in metres. */
export interface Facade {
  kind: FacadeKind;
  /** Metres from one window to the next along the wall. */
  spacing: number;
  /** Metres from one floor to the next. */
  floor: number;
}

/** One model's geometry, ready for a BufferGeometry. */
export interface ModelArrays {
  /** x, y, z per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  /** The vertex's `SURFACE`. */
  surfaces: Float32Array;
  /**
   * Per vertex: where it sits along its wall, in windows from the model's
   * middle; how high, in floors from the bottom of its box; which axis the
   * wall runs along, 0 for x and 1 for z, so the shader can undo a stretch
   * of the lot (render/building-meshes.ts); and its `FACADE`.
   */
  facades: Float32Array;
  indices: Uint16Array | Uint32Array;
}

type Vec3 = readonly [number, number, number];

const NO_FACADE: Facade = { kind: FACADE.none, spacing: 1, floor: 1 };

/** Collects faces and writes them out as a `ModelArrays`. */
export class ModelBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly surfaces: number[] = [];
  private readonly facades: number[] = [];
  private readonly indices: number[] = [];

  /**
   * One flat face, a triangle or a convex quad, wound so its normal points
   * away from `inside`. Its facade coordinates come from `facade`, measured
   * from the bottom at `base`.
   */
  face(points: readonly Vec3[], surface: Surface, inside: Vec3, facade: Facade = NO_FACADE, base = 0): void {
    let pts = points;
    const [a, b, c] = pts as [Vec3, Vec3, Vec3];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len;
    ny /= len;
    nz /= len;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0] / pts.length;
      cy += p[1] / pts.length;
      cz += p[2] / pts.length;
    }
    if ((cx - inside[0]) * nx + (cy - inside[1]) * ny + (cz - inside[2]) * nz < 0) {
      pts = [...pts].reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // A wall runs along x when it faces ±z, and along z when it faces ±x.
    const axis = Math.abs(nz) >= Math.abs(nx) ? 0 : 1;
    const start = this.positions.length / 3;
    for (const p of pts) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      this.surfaces.push(surface);
      const along = (axis === 0 ? p[0] : p[2]) / facade.spacing;
      this.facades.push(along, (p[1] - base) / facade.floor, axis, facade.kind);
    }
    for (let k = 1; k + 1 < pts.length; k++) this.indices.push(start, start + k, start + k + 1);
  }

  /**
   * A box from (x0, y0, z0) to (x1, y1, z1). Its four walls are `wall` with
   * `facade`; its top is `top`, or left open when null. No bottom: it stands
   * on something.
   */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, wall: Surface, top: Surface | null, facade: Facade = NO_FACADE): void {
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return;
    const mid: Vec3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], wall, mid, facade, y0);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], wall, mid, facade, y0);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], wall, mid, facade, y0);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], wall, mid, facade, y0);
    if (top !== null) this.face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], top, [mid[0], y0, mid[2]]);
  }

  /**
   * A gable roof over x0..x1, z0..z1 from height `y`, rising `rise` metres
   * to a ridge along x (`alongX`) or along z, overhanging by `eave`. The
   * slopes are `roof` and the gable ends `wall`.
   */
  gable(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, alongX: boolean, roof: Surface, wall: Surface, eave = 0.4): void {
    const top = y + rise;
    if (alongX) {
      const zm = (z0 + z1) / 2;
      const inside: Vec3 = [(x0 + x1) / 2, y, zm];
      const e0 = x0 - eave;
      const e1 = x1 + eave;
      this.face([[e0, y, z1 + eave], [e1, y, z1 + eave], [e1, top, zm], [e0, top, zm]], roof, inside);
      this.face([[e1, y, z0 - eave], [e0, y, z0 - eave], [e0, top, zm], [e1, top, zm]], roof, inside);
      this.face([[x0, y, z0], [x0, y, z1], [x0, top, zm]], wall, inside);
      this.face([[x1, y, z1], [x1, y, z0], [x1, top, zm]], wall, inside);
    } else {
      const xm = (x0 + x1) / 2;
      const inside: Vec3 = [xm, y, (z0 + z1) / 2];
      const e0 = z0 - eave;
      const e1 = z1 + eave;
      this.face([[x1 + eave, y, e1], [x1 + eave, y, e0], [xm, top, e0], [xm, top, e1]], roof, inside);
      this.face([[x0 - eave, y, e0], [x0 - eave, y, e1], [xm, top, e1], [xm, top, e0]], roof, inside);
      this.face([[x0, y, z1], [x1, y, z1], [xm, top, z1]], wall, inside);
      this.face([[x1, y, z0], [x0, y, z0], [xm, top, z0]], wall, inside);
    }
  }

  /**
   * A hip roof over x0..x1, z0..z1 from height `y`, rising `rise` metres to
   * a ridge along the longer side, or to a point over a square.
   */
  hip(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, roof: Surface, eave = 0.4): void {
    const a0 = x0 - eave;
    const a1 = x1 + eave;
    const b0 = z0 - eave;
    const b1 = z1 + eave;
    const w = a1 - a0;
    const d = b1 - b0;
    const top = y + rise;
    const inside: Vec3 = [(x0 + x1) / 2, y, (z0 + z1) / 2];
    if (w >= d) {
      const zm = (b0 + b1) / 2;
      const r0 = a0 + d / 2;
      const r1 = Math.max(r0, a1 - d / 2);
      this.face([[a0, y, b1], [a1, y, b1], [r1, top, zm], [r0, top, zm]], roof, inside);
      this.face([[a1, y, b0], [a0, y, b0], [r0, top, zm], [r1, top, zm]], roof, inside);
      this.face([[a0, y, b0], [a0, y, b1], [r0, top, zm]], roof, inside);
      this.face([[a1, y, b1], [a1, y, b0], [r1, top, zm]], roof, inside);
    } else {
      const xm = (a0 + a1) / 2;
      const r0 = b0 + w / 2;
      const r1 = Math.max(r0, b1 - w / 2);
      this.face([[a1, y, b1], [a1, y, b0], [xm, top, r0], [xm, top, r1]], roof, inside);
      this.face([[a0, y, b0], [a0, y, b1], [xm, top, r1], [xm, top, r0]], roof, inside);
      this.face([[a0, y, b1], [a1, y, b1], [xm, top, r1]], roof, inside);
      this.face([[a1, y, b0], [a0, y, b0], [xm, top, r0]], roof, inside);
    }
  }

  /** An upright prism of `sides` sides around (x, z), radius `r`, from y0 to y1, with a lid of `top`. */
  prism(x: number, z: number, r: number, y0: number, y1: number, sides: number, wall: Surface, top: Surface | null): void {
    const inside: Vec3 = [x, (y0 + y1) / 2, z];
    const ring: Vec3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = ((k + 0.5) / sides) * Math.PI * 2;
      ring.push([x + Math.cos(a) * r, 0, z + Math.sin(a) * r]);
    }
    for (let k = 0; k < sides; k++) {
      const p = ring[k] as Vec3;
      const q = ring[(k + 1) % sides] as Vec3;
      this.face([[p[0], y0, p[2]], [q[0], y0, q[2]], [q[0], y1, q[2]], [p[0], y1, p[2]]], wall, inside);
    }
    if (top === null) return;
    // A fan from the middle, so the lid is a convex set of triangles.
    for (let k = 0; k < sides; k++) {
      const p = ring[k] as Vec3;
      const q = ring[(k + 1) % sides] as Vec3;
      this.face([[x, y1, z], [p[0], y1, p[2]], [q[0], y1, q[2]]], top, [x, y0, z]);
    }
  }

  /** Vertices so far. */
  get vertexCount(): number {
    return this.positions.length / 3;
  }

  build(): ModelArrays {
    const n = this.vertexCount;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      surfaces: new Float32Array(this.surfaces),
      facades: new Float32Array(this.facades),
      indices: n > 0xffff ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
    };
  }
}
