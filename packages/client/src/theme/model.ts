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
  /**
   * The first vertex of each part of the model, in order. A part is one
   * shape a generator asked for: a box, a roof, a prism or a lone face. Its
   * vertices run to the next part's first, and its triangles use only them.
   * `simplify` drops whole parts. A model without it is one part.
   */
  parts?: Uint32Array;
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
  private readonly parts: number[] = [];
  /** Above zero while a shape adds its faces, so they make one part. */
  private depth = 0;

  /** Starts a part, unless a shape that started one is adding its faces. */
  private open(): void {
    if (this.depth++ === 0) this.parts.push(this.positions.length / 3);
  }

  private close(): void {
    this.depth--;
  }

  /**
   * One flat face, a triangle or a convex quad, wound so its normal points
   * away from `inside`. Its facade coordinates come from `facade`, measured
   * from the bottom at `base`.
   */
  face(points: readonly Vec3[], surface: Surface, inside: Vec3, facade: Facade = NO_FACADE, base = 0): void {
    this.open();
    this.addFace(points, surface, inside, facade, base);
    this.close();
  }

  private addFace(points: readonly Vec3[], surface: Surface, inside: Vec3, facade: Facade, base: number): void {
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
    this.open();
    const mid: Vec3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], wall, mid, facade, y0);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], wall, mid, facade, y0);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], wall, mid, facade, y0);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], wall, mid, facade, y0);
    if (top !== null) this.face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], top, [mid[0], y0, mid[2]]);
    this.close();
  }

  /**
   * A gable roof over x0..x1, z0..z1 from height `y`, rising `rise` metres
   * to a ridge along x (`alongX`) or along z, overhanging by `eave`. The
   * slopes are `roof` and the gable ends `wall`.
   */
  gable(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, alongX: boolean, roof: Surface, wall: Surface, eave = 0.4): void {
    const top = y + rise;
    this.open();
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
    this.close();
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
    this.open();
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
    this.close();
  }

  /** An upright prism of `sides` sides around (x, z), radius `r`, from y0 to y1, with a lid of `top`. */
  prism(x: number, z: number, r: number, y0: number, y1: number, sides: number, wall: Surface, top: Surface | null): void {
    const inside: Vec3 = [x, (y0 + y1) / 2, z];
    this.open();
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
    if (top !== null) this.lid(x, z, y0, y1, ring, sides, top);
    this.close();
  }

  private lid(x: number, z: number, y0: number, y1: number, ring: readonly Vec3[], sides: number, top: Surface): void {
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
      parts: Uint32Array.from(this.parts),
    };
  }
}

/**
 * What `simplify` drops, in metres. A part's size is measured above the
 * ground, so a base that reaches down to meet a slope counts only what shows.
 */
export interface SimplifyLimits {
  /** A part whose middle size is under this is a post, a mast, a stoop or a canopy. */
  minSpan: number;
  /** A part whose largest size is under this is a small fitting. */
  minSize: number;
  /** A part at least this tall above the ground stays whatever its other sizes, so masts and chimneys keep the skyline. */
  keepHeight: number;
}

/**
 * A model with its small parts and its paving left out, for drawing far
 * from the camera (render/building-lod.ts). What stays is the model's own
 * geometry, so its shape, colours and window pattern are the full model's.
 * A part goes when it is all paving, or small by `limits` and not tall. A model with
 * no parts, or with nothing left, is returned as it is.
 */
export function simplify(m: ModelArrays, limits: SimplifyLimits): ModelArrays {
  const total = m.surfaces.length;
  const starts = m.parts && m.parts.length > 0 ? m.parts : Uint32Array.of(0);
  const keep = new Uint8Array(total);
  for (let p = 0; p < starts.length; p++) {
    const from = starts[p] ?? 0;
    const to = p + 1 < starts.length ? (starts[p + 1] ?? total) : total;
    if (!m.parts || keepPart(m, from, to, limits)) keep.fill(1, from, to);
  }
  const map = new Int32Array(total).fill(-1);
  let n = 0;
  for (let v = 0; v < total; v++) if (keep[v]) map[v] = n++;
  if (n === total || n === 0) return m;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const surfaces = new Float32Array(n);
  const facades = new Float32Array(n * 4);
  for (let v = 0; v < total; v++) {
    const to = map[v] ?? -1;
    if (to < 0) continue;
    positions.set(m.positions.subarray(v * 3, v * 3 + 3), to * 3);
    normals.set(m.normals.subarray(v * 3, v * 3 + 3), to * 3);
    surfaces[to] = m.surfaces[v] ?? 0;
    facades.set(m.facades.subarray(v * 4, v * 4 + 4), to * 4);
  }
  const indices: number[] = [];
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const a = map[m.indices[k] ?? 0] ?? -1;
    const b = map[m.indices[k + 1] ?? 0] ?? -1;
    const c = map[m.indices[k + 2] ?? 0] ?? -1;
    if (a >= 0 && b >= 0 && c >= 0) indices.push(a, b, c);
  }
  return {
    positions,
    normals,
    surfaces,
    facades,
    indices: n > 0xffff ? Uint32Array.from(indices) : Uint16Array.from(indices),
    parts: Uint32Array.from(starts.filter((s) => keep[s] === 1 && s < total).map((s) => map[s] ?? 0)),
  };
}

/** Whether vertices `from` to `to` of a model make a part worth drawing far away. */
function keepPart(m: ModelArrays, from: number, to: number, limits: SimplifyLimits): boolean {
  if (to <= from) return false;
  let paving = true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let v = from; v < to; v++) {
    if (m.surfaces[v] !== SURFACE.paving) paving = false;
    const x = m.positions[v * 3] ?? 0;
    const y = m.positions[v * 3 + 1] ?? 0;
    const z = m.positions[v * 3 + 2] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (paving || maxY <= 0) return false;
  const height = maxY - Math.max(minY, 0);
  if (height >= limits.keepHeight) return true;
  const sizes = [maxX - minX, height, maxZ - minZ].sort((a, b) => a - b);
  return (sizes[1] ?? 0) >= limits.minSpan && (sizes[2] ?? 0) >= limits.minSize;
}
