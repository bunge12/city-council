// Snapping to zoning cells (issue M2-08). Two sources in the snap list
// (snap.ts): the corners of zoned areas and the edges of zoned areas. Both
// read the mirror's cells through the sim's entry file and return a plain
// point, as every other source does.
//
// Only zoned, open cells count. Each edge of such a cell is one of:
//
//   road      the edge at the road's side of a cell in the first row. The
//             road is there already, so it gives no line.
//   inside    an edge another zoned cell shares. Across the road, between
//             two cells of one row, it is a cell line: a road on it crosses
//             the strip between two lots. Along the road, between two rows,
//             it gives nothing, since a road there would cut every lot.
//   outside   an edge no zoned cell shares: the back or the end of the zoned
//             area. Its line sits out from the cells by half the width of
//             the road being drawn, plus `CELL_SNAP.clearance`, so a road
//             drawn on it runs beside the cells and leaves them all whole.
//
// The edge source catches the cursor on an inside or outside line. The
// corner source catches it where two of those lines meet, and where a cell
// line meets the road the strip belongs to: that point is on the road's
// centre line, where the sim joins a new road, so a road started or ended
// there crosses the strip on a cell line.
//
// Trigonometry-free, but not exact: the sim rounds the point to its build
// grid like any other, and the clearance covers that rounding.

import {
  CELL_OPEN,
  DENSITY_NONE,
  LEVELS_GROUND,
  NETWORKS_ROAD,
  ROAD_BUILD,
  ROAD_TYPES,
  ZONE_NONE,
  ZONING_BALANCE,
  cellCorners,
  cellsInBox,
  nearestOnQuad,
  roadIndexOf,
  segmentQuad,
  segmentsInBox,
  type RoadNetwork,
  type SimState,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import { CELL_SNAP } from "./config";
import { liveRoadSegment, roadSegmentsAt } from "../render/road-geometry";
import type { SnapContext, SnapHit, SnapSource } from "./snap";

/** A zoned, open cell near the cursor: its corners as `cellCorners` gives them, and where it sits. */
export interface SnapCell {
  /** x0, z0, ..., x3, z3: inner start, inner end, outer end, outer start. */
  corners: ArrayLike<number>;
  segment: number;
  /** Rows back from the road's edge, 0 for the row at the road. */
  depth: number;
}

/** The zoned, open cells whose centres lie in the box. */
export type CellLookup = (minX: number, minZ: number, maxX: number, maxZ: number) => readonly SnapCell[];

/** A cell edge the cursor can snap onto, as drawn on the map: the line and the cell edge it comes from. */
export interface CellEdge {
  /** The line a road would run along, from a to b. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** The cell edge itself, which the marker draws. */
  cell: { ax: number; az: number; bx: number; bz: number };
  /** Outside the zoned area, set back by half a road; or a cell line across it. */
  kind: "outside" | "inside";
}

/**
 * The cell lookup for the mirror's copy of the city: zoned, open cells with
 * their corners, worked out by the sim's own code.
 */
export function zonedCellLookup(city: ReadonlyDeep<SimState>): CellLookup {
  // The queries only read; they are typed for live state, and the copy is never written.
  const state = city as unknown as SimState;
  return (minX, minZ, maxX, maxZ) => {
    const out: SnapCell[] = [];
    for (const info of cellsInBox(state, minX, minZ, maxX, maxZ)) {
      if (info.status !== CELL_OPEN) continue;
      if ((state.cells.zone[info.index] ?? ZONE_NONE) === ZONE_NONE || (state.cells.density[info.index] ?? DENSITY_NONE) === DENSITY_NONE) continue;
      const corners = cellCorners(state, info);
      if (corners) out.push({ corners, segment: info.segment, depth: info.depth });
    }
    return out;
  };
}

// ---- Working out the lines ----

const CELL = ZONING_BALANCE.cellSize;
/** A cell's centre is never further than this from any of its points: its half diagonal, with room for a bend. */
const CELL_REACH = CELL;
/** How far past an edge to look for the cell beyond it, metres: well inside a neighbour, well short of the next row. */
const PROBE = 1;
/** Shapes overlap only by more than this many metres, as the sim counts it (`OVERLAP_TOLERANCE` in its shape code). */
const OVERLAP = 0.01;
/** Lines meet at a corner only when they cross at more than this angle, as a sine. */
const MIN_MEETING_SINE = Math.sin((20 * Math.PI) / 180);
/** Points tried along a road band when checking it against the roads there, one every this many metres. */
const BAND_STEP = 2;

const INNER = 0;
const END = 1;
const START = 3;

type Piece = { ax: number; az: number; bx: number; bz: number };
type Quad = ArrayLike<number>;

/** One edge of one cell, sorted out. */
interface Edge extends Piece {
  /** Unit normal pointing out of the cell. */
  nx: number;
  nz: number;
  /**
   * road: the first row's edge at the road. front: a later row's edge
   * facing the road, which gives no line, since a road there would run
   * beside the road already there. inside: a zoned cell lies beyond it.
   * outside: none does.
   */
  role: "road" | "front" | "inside" | "outside";
  /** Across the road: the start or end of a cell. */
  across: boolean;
}

/** What the cell sources see near one cursor position. */
interface CellGuides {
  edges: CellEdge[];
  corners: SnapHit[];
  /** The roads near the cells, for checking a point against their surfaces. */
  roads: number[];
}

/** How far out from the cells a road on an outside line runs: its centre, half its width and the clearance past the cell edge. */
function setBack(ctx: SnapContext): number {
  return ctx.roadWidth / 2 + CELL_SNAP.clearance;
}

/** Whether (x, z) is strictly inside the convex quad `q`. */
function inQuad(q: Quad, x: number, z: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[k * 2] ?? 0;
    const az = q[k * 2 + 1] ?? 0;
    const bx = q[((k + 1) % 4) * 2] ?? 0;
    const bz = q[((k + 1) % 4) * 2 + 1] ?? 0;
    const c = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (Math.abs(c) < 1e-9) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Whether two convex quads overlap by more than `OVERLAP`, by separating axes. */
function quadsOverlap(p: Quad, q: Quad): boolean {
  for (const shape of [p, q]) {
    for (let k = 0; k < 4; k++) {
      const ex = (shape[((k + 1) % 4) * 2] ?? 0) - (shape[k * 2] ?? 0);
      const ez = (shape[((k + 1) % 4) * 2 + 1] ?? 0) - (shape[k * 2 + 1] ?? 0);
      const len = Math.hypot(ex, ez);
      if (len < 1e-9) continue;
      const nx = -ez / len;
      const nz = ex / len;
      let pMin = Infinity;
      let pMax = -Infinity;
      let qMin = Infinity;
      let qMax = -Infinity;
      for (let i = 0; i < 4; i++) {
        const dp = (p[i * 2] ?? 0) * nx + (p[i * 2 + 1] ?? 0) * nz;
        const dq = (q[i * 2] ?? 0) * nx + (q[i * 2 + 1] ?? 0) * nz;
        pMin = Math.min(pMin, dp);
        pMax = Math.max(pMax, dp);
        qMin = Math.min(qMin, dq);
        qMax = Math.max(qMax, dq);
      }
      if (Math.min(pMax, qMax) - Math.max(pMin, qMin) <= OVERLAP) return false;
    }
  }
  return true;
}

/** The surface of a road of half width `half` along the piece: a quad, corners in order. */
function bandOf(l: Piece, half: number): number[] {
  const len = Math.hypot(l.bx - l.ax, l.bz - l.az) || 1;
  const nx = (-(l.bz - l.az) / len) * half;
  const nz = ((l.bx - l.ax) / len) * half;
  return [l.ax + nx, l.az + nz, l.bx + nx, l.bz + nz, l.bx - nx, l.bz - nz, l.ax - nx, l.az - nz];
}

/** The four edges of `cell`, each sorted by what lies beyond it among `cells`. */
function edgesOf(cell: SnapCell, cells: readonly SnapCell[]): Edge[] {
  const c = cell.corners;
  const cx = ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4;
  const cz = ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4;
  const out: Edge[] = [];
  for (let e = 0; e < 4; e++) {
    const ax = c[e * 2] ?? 0;
    const az = c[e * 2 + 1] ?? 0;
    const bx = c[((e + 1) % 4) * 2] ?? 0;
    const bz = c[((e + 1) % 4) * 2 + 1] ?? 0;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let nx = (bz - az) / len;
    let nz = -(bx - ax) / len;
    if (((ax + bx) / 2 - cx) * nx + ((az + bz) / 2 - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const across = e === END || e === START;
    let role: Edge["role"];
    if (e === INNER) role = cell.depth === 0 ? "road" : "front";
    else {
      // Whatever cell lies just past the middle of the edge, whether or not
      // it shares the edge's corners: strips of two roads seldom line up.
      const px = (ax + bx) / 2 + nx * PROBE;
      const pz = (az + bz) / 2 + nz * PROBE;
      role = cells.some((o) => o !== cell && inQuad(o.corners, px, pz)) ? "inside" : "outside";
    }
    out.push({ ax, az, bx, bz, nx, nz, role, across });
  }
  return out;
}

/** The line an edge gives, set back from the cell by `off`, or null when it gives none. */
function lineOf(e: Edge, off: number): Piece | null {
  if (e.role === "road" || e.role === "front" || (e.role === "inside" && !e.across)) return null;
  const d = e.role === "outside" ? off : 0;
  return { ax: e.ax + e.nx * d, az: e.az + e.nz * d, bx: e.bx + e.nx * d, bz: e.bz + e.nz * d };
}

/** Where two lines through a-b and c-d meet, or null when they run too near parallel. */
function meet(p: Piece, q: Piece): { x: number; z: number } | null {
  const dx1 = p.bx - p.ax;
  const dz1 = p.bz - p.az;
  const dx2 = q.bx - q.ax;
  const dz2 = q.bz - q.az;
  const l1 = Math.hypot(dx1, dz1);
  const l2 = Math.hypot(dx2, dz2);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const cross = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(cross) / (l1 * l2) < MIN_MEETING_SINE) return null;
  const t = ((q.ax - p.ax) * dz2 - (q.az - p.az) * dx2) / cross;
  return { x: p.ax + dx1 * t, z: p.az + dz1 * t };
}

/** The point on segment `seg`'s centre line nearest (x, z). */
function onRoad(ctx: SnapContext, seg: number, x: number, z: number): { x: number; z: number } {
  const q = segmentQuad(ctx.net as unknown as RoadNetwork, seg);
  const n = nearestOnQuad(q, x, z);
  return { x: n.x, z: n.z };
}

/** The live ground road segments touching the box. */
function roadsIn(ctx: SnapContext, minX: number, minZ: number, maxX: number, maxZ: number): number[] {
  const net = ctx.net as unknown as RoadNetwork;
  return segmentsInBox(roadIndexOf(net), minX, minZ, maxX, maxZ, NETWORKS_ROAD, LEVELS_GROUND).filter((s) => liveRoadSegment(ctx.net, s));
}

/**
 * Whether a road of half width `half` centred at (x, z) would lie on the
 * surface of a road already there, `skip` aside. A point within the sim's
 * merge distance of a centre line joins that road instead, and is fine.
 */
function onRoadSurface(ctx: SnapContext, roads: readonly number[], x: number, z: number, half: number, skip = -1): boolean {
  const net = ctx.net as unknown as RoadNetwork;
  for (const seg of roads) {
    if (seg === skip) continue;
    const n = nearestOnQuad(segmentQuad(net, seg), x, z);
    const d = Math.sqrt(n.d2);
    if (d <= ROAD_BUILD.mergeDistance) continue;
    if (d < (ROAD_TYPES[net.segType[seg] ?? 0]?.width ?? 0) / 2 + half - OVERLAP) return true;
  }
  return false;
}

/**
 * Whether a road of half width `half` along the piece would cover a zoned
 * cell or lie on a road other than `skip`. A line across the strip runs into
 * the strip's own road at its end, which is where it joins it.
 */
function bandBlocked(ctx: SnapContext, cells: readonly SnapCell[], roads: readonly number[], l: Piece, half: number, skip: number): boolean {
  const band = bandOf(l, half);
  if (cells.some((c) => quadsOverlap(band, c.corners))) return true;
  const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
  const steps = Math.max(1, Math.ceil(len / BAND_STEP));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (onRoadSurface(ctx, roads, l.ax + (l.bx - l.ax) * t, l.az + (l.bz - l.az) * t, half, skip)) return true;
  }
  return false;
}

/** Whether a road end of half width `half` at (x, z) would cover a zoned cell. */
function endBlocked(cells: readonly SnapCell[], x: number, z: number, half: number): boolean {
  const r = half - OVERLAP;
  return cells.some((c) => inQuad(c.corners, x, z) || [0, 1, 2, 3].some((k) => crossesDisc(c.corners, k, x, z, r)));
}

/** Whether edge `k` of quad `q` passes within `r` of (x, z). */
function crossesDisc(q: Quad, k: number, x: number, z: number, r: number): boolean {
  const ax = q[k * 2] ?? 0;
  const az = q[k * 2 + 1] ?? 0;
  const bx = q[((k + 1) % 4) * 2] ?? 0;
  const bz = q[((k + 1) % 4) * 2 + 1] ?? 0;
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return px * px + pz * pz < r * r;
}

/** Lines and corners from the zoned cells within `r` metres of (x, z). */
function cellGuidesAt(x: number, z: number, r: number, ctx: SnapContext): CellGuides {
  const lookup = ctx.cells;
  if (!lookup) return { edges: [], corners: [], roads: [] };
  const off = setBack(ctx);
  const half = ctx.roadWidth / 2;
  // Pad by a cell and a road so the neighbours of every cell that can catch
  // are found too, and every cell a road on its lines could cover.
  const pad = r + off + CELL_REACH + CELL + ctx.roadWidth;
  const cells = lookup(x - pad, z - pad, x + pad, z + pad);
  const roads = cells.length > 0 ? roadsIn(ctx, x - pad, z - pad, x + pad, z + pad) : [];
  const near = r + off + CELL_REACH;
  const edges: CellEdge[] = [];
  const corners: SnapHit[] = [];
  for (const cell of cells) {
    const c = cell.corners;
    const cx = ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4;
    const cz = ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4;
    if (Math.abs(cx - x) > near || Math.abs(cz - z) > near) continue;
    const sides = edgesOf(cell, cells);
    // An outside line whose road would still cover a zoned cell, as at a
    // bend or beside a strip that does not line up, or lie on a road, is
    // dropped: it would not leave the cells whole.
    const lines = sides.map((e) => {
      const line = lineOf(e, off);
      return line && e.role === "outside" && bandBlocked(ctx, cells, roads, line, half, e.across ? cell.segment : -1) ? null : line;
    });
    sides.forEach((e, i) => {
      const line = lines[i];
      if (line) edges.push({ ...line, cell: { ax: e.ax, az: e.az, bx: e.bx, bz: e.bz }, kind: e.role === "outside" ? "outside" : "inside" });
    });
    // Corner k joins edge k - 1, which ends there, and edge k, which starts there.
    for (let k = 0; k < 4; k++) {
      const before = sides[(k + 3) % 4];
      const after = sides[k];
      const lb = lines[(k + 3) % 4];
      const la = lines[k];
      if (!before || !after) continue;
      const marks = [before, after].filter((e) => e.role !== "road").map((e) => ({ ax: e.ax, az: e.az, bx: e.bx, bz: e.bz }));
      const road = before.role === "road" ? before : after.role === "road" ? after : null;
      if (road) {
        // A cell line, or the end of the zoned area, meeting the road: the
        // point on the road's centre line the line leads to.
        const line = road === before ? la : lb;
        if (!line) continue;
        const end = road === before ? { x: line.ax, z: line.az } : { x: line.bx, z: line.bz };
        const foot = onRoad(ctx, cell.segment, end.x, end.z);
        corners.push({ kind: "corner", x: foot.x, z: foot.z, segment: cell.segment, cellEdges: marks });
        continue;
      }
      // Two lines meeting at the outline of the zoned area. Two inside
      // edges meet only inside it, which is no corner.
      if (!lb || !la || (before.role !== "outside" && after.role !== "outside")) continue;
      const p = meet(lb, la);
      const ox = (before.role === "outside" ? before.nx * off : 0) + (after.role === "outside" ? after.nx * off : 0);
      const oz = (before.role === "outside" ? before.nz * off : 0) + (after.role === "outside" ? after.nz * off : 0);
      const at = p ?? { x: (c[k * 2] ?? 0) + ox, z: (c[k * 2 + 1] ?? 0) + oz };
      // A road ending there would cover a zoned cell or lie on a road: no corner.
      if (endBlocked(cells, at.x, at.z, half) || onRoadSurface(ctx, roads, at.x, at.z, half)) continue;
      corners.push({ kind: "corner", x: at.x, z: at.z, cellEdges: marks });
    }
  }
  return { edges, corners, roads };
}

/** The cell lines near the cursor, worked out once per snap: both cell sources read them. */
const cache = new WeakMap<SnapContext, { x: number; z: number; guides: CellGuides }>();

/** Whether the cell sources look at all: toggled on, not free-hand, a lookup to read and near enough to see the cells. */
function cellsOn(ctx: SnapContext): boolean {
  return Boolean(ctx.cells) && ctx.guides.cells && !ctx.free && ctx.metresPerPixel <= CELL_SNAP.maxMetresPerPixel;
}

/** How near a corner catches, metres: its pixels at the cursor, never more than `CELL_SNAP.cornerMaxMetres`. */
function cornerReach(ctx: SnapContext): number {
  return Math.min(CELL_SNAP.cornerPx * ctx.metresPerPixel, CELL_SNAP.cornerMaxMetres);
}

/** How near an edge catches, metres, never more than `CELL_SNAP.edgeMaxMetres`. */
function edgeReach(ctx: SnapContext): number {
  return Math.min(CELL_SNAP.edgePx * ctx.metresPerPixel, CELL_SNAP.edgeMaxMetres);
}

function guidesAt(x: number, z: number, ctx: SnapContext): CellGuides {
  const hit = cache.get(ctx);
  if (hit?.x === x && hit.z === z) return hit.guides;
  const r = Math.max(cornerReach(ctx), edgeReach(ctx));
  const guides = cellGuidesAt(x, z, r, ctx);
  cache.set(ctx, { x, z, guides });
  return guides;
}

/** The roads a new road may not end on: those at its start node, or the one it starts from. */
function startRoads(ctx: SnapContext): number[] {
  if (!ctx.source) return [];
  return ctx.source.kind === "segment" ? [ctx.source.id] : roadSegmentsAt(ctx.net, ctx.source.id);
}

/** The nearest point to (x, z) on the piece of line from a to b. */
function onPiece(x: number, z: number, l: { ax: number; az: number; bx: number; bz: number }): { x: number; z: number } {
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - l.ax) * dx + (z - l.az) * dz) / len2));
  return { x: l.ax + dx * t, z: l.az + dz * t };
}

/**
 * A corner of the zoned area set back for the road, where a cell line meets
 * that outline, or where a cell line meets the road the strip is on.
 */
export const cellCornerSource: SnapSource = {
  id: "corner",
  find(x, z, ctx) {
    if (!cellsOn(ctx)) return null;
    const r = cornerReach(ctx);
    const skip = startRoads(ctx);
    // With a road being drawn and the angle guide on, the square join and
    // the angle steps say where it meets a road better than a cell line
    // does, so the points on roads are left to them.
    const onRoads = !ctx.start || !ctx.guides.angle;
    let best: SnapHit | null = null;
    let bestD2 = r * r;
    for (const c of guidesAt(x, z, ctx).corners) {
      if (c.segment !== undefined && (!onRoads || skip.includes(c.segment))) continue;
      const d2 = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d2 < bestD2) {
        best = c;
        bestD2 = d2;
      }
    }
    return best;
  },
};

/** The back or end of the zoned area set back for the road, or a cell line across a strip. */
export const cellEdgeSource: SnapSource = {
  id: "edge",
  find(x, z, ctx) {
    if (!cellsOn(ctx)) return null;
    const r = edgeReach(ctx);
    const guides = guidesAt(x, z, ctx);
    let best: SnapHit | null = null;
    let bestD2 = r * r;
    for (const e of guides.edges) {
      const p = onPiece(x, z, e);
      const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      // A point on a road's surface, off its centre line, would end the new
      // road on top of that road rather than join it.
      if (d2 < bestD2 && !onRoadSurface(ctx, guides.roads, p.x, p.z, ctx.roadWidth / 2)) {
        best = { kind: "edge", x: p.x, z: p.z, cellEdges: [e.cell], edgeLine: { ax: e.ax, az: e.az, bx: e.bx, bz: e.bz } };
        bestD2 = d2;
      }
    }
    return best;
  },
};
