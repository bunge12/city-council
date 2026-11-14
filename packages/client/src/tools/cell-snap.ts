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
  ZONE_NONE,
  ZONING_BALANCE,
  cellCorners,
  cellsInBox,
  nearestOnQuad,
  segmentQuad,
  type RoadNetwork,
  type SimState,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import { CELL_SNAP } from "./config";
import { roadSegmentsAt } from "../render/road-geometry";
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
/** Edges whose ends agree to this many metres are one edge. */
const SHARED = 0.05;
/** Lines meet at a corner only when they cross at more than this angle, as a sine. */
const MIN_MEETING_SINE = Math.sin((20 * Math.PI) / 180);

const INNER = 0;
const END = 1;
const START = 3;

/** One edge of one cell, sorted out. */
interface Edge {
  /** The cell's corners at its ends, in order round the cell. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal pointing out of the cell. */
  nx: number;
  nz: number;
  role: "road" | "inside" | "outside";
  /** Across the road: the start or end of a cell. */
  across: boolean;
}

/** What the cell sources see near one cursor position. */
interface CellGuides {
  edges: CellEdge[];
  corners: SnapHit[];
}

function edgeKey(ax: number, az: number, bx: number, bz: number): string {
  const r = (v: number) => Math.round(v / SHARED);
  const p = `${r(ax)},${r(az)}`;
  const q = `${r(bx)},${r(bz)}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
}

/** How far out from the cells a road on an outside line runs: its centre, half its width and the clearance past the cell edge. */
function setBack(ctx: SnapContext): number {
  return ctx.roadWidth / 2 + CELL_SNAP.clearance;
}

/** The four edges of `cell`, with `shared` saying which edges another zoned cell has too. */
function edgesOf(cell: SnapCell, shared: Map<string, number>): Edge[] {
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
    const role = e === INNER && cell.depth === 0 ? "road" : (shared.get(edgeKey(ax, az, bx, bz)) ?? 0) > 1 ? "inside" : "outside";
    out.push({ ax, az, bx, bz, nx, nz, role, across });
  }
  return out;
}

/** The line an edge gives, set back from the cell by `off`, or null when it gives none. */
function lineOf(e: Edge, off: number): { ax: number; az: number; bx: number; bz: number } | null {
  if (e.role === "road" || (e.role === "inside" && !e.across)) return null;
  const d = e.role === "outside" ? off : 0;
  return { ax: e.ax + e.nx * d, az: e.az + e.nz * d, bx: e.bx + e.nx * d, bz: e.bz + e.nz * d };
}

/** Where two lines through a-b and c-d meet, or null when they run too near parallel. */
function meet(
  p: { ax: number; az: number; bx: number; bz: number },
  q: { ax: number; az: number; bx: number; bz: number },
): { x: number; z: number } | null {
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

/** Lines and corners from the zoned cells within `r` metres of (x, z). */
function cellGuidesAt(x: number, z: number, r: number, ctx: SnapContext): CellGuides {
  const lookup = ctx.cells;
  if (!lookup) return { edges: [], corners: [] };
  const off = setBack(ctx);
  // Pad by a cell so the neighbours of every cell that can catch are found
  // too: without them an inside edge would look like an outside one.
  const pad = r + off + CELL_REACH + CELL;
  const cells = lookup(x - pad, z - pad, x + pad, z + pad);
  const shared = new Map<string, number>();
  for (const cell of cells) {
    const c = cell.corners;
    for (let e = 0; e < 4; e++) {
      const key = edgeKey(c[e * 2] ?? 0, c[e * 2 + 1] ?? 0, c[((e + 1) % 4) * 2] ?? 0, c[((e + 1) % 4) * 2 + 1] ?? 0);
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  const near = r + off + CELL_REACH;
  const edges: CellEdge[] = [];
  const corners: SnapHit[] = [];
  for (const cell of cells) {
    const c = cell.corners;
    const cx = ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4;
    const cz = ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4;
    if (Math.abs(cx - x) > near || Math.abs(cz - z) > near) continue;
    const sides = edgesOf(cell, shared);
    const lines = sides.map((e) => lineOf(e, off));
    sides.forEach((e, i) => {
      const line = lines[i];
      if (line && e.role !== "road") {
        edges.push({ ...line, cell: { ax: e.ax, az: e.az, bx: e.bx, bz: e.bz }, kind: e.role === "outside" ? "outside" : "inside" });
      }
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
      corners.push({ kind: "corner", x: at.x, z: at.z, cellEdges: marks });
    }
  }
  return { edges, corners };
}

/** The cell lines near the cursor, worked out once per snap: both cell sources read them. */
const cache = new WeakMap<SnapContext, { x: number; z: number; guides: CellGuides }>();

/** Whether the cell sources look at all: toggled on, not free-hand, a lookup to read and near enough to see the cells. */
function cellsOn(ctx: SnapContext): boolean {
  return Boolean(ctx.cells) && ctx.guides.cells && !ctx.free && ctx.metresPerPixel <= CELL_SNAP.maxMetresPerPixel;
}

function guidesAt(x: number, z: number, ctx: SnapContext): CellGuides {
  const hit = cache.get(ctx);
  if (hit?.x === x && hit.z === z) return hit.guides;
  const r = Math.max(CELL_SNAP.cornerPx, CELL_SNAP.edgePx) * ctx.metresPerPixel;
  const guides = cellGuidesAt(x, z, r, ctx);
  cache.set(ctx, { x, z, guides });
  return guides;
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
    const r = CELL_SNAP.cornerPx * ctx.metresPerPixel;
    // A road may not end on the road it starts from, so a cell line meeting that one is no corner for it.
    const skip = !ctx.source ? [] : ctx.source.kind === "segment" ? [ctx.source.id] : roadSegmentsAt(ctx.net, ctx.source.id);
    let best: SnapHit | null = null;
    let bestD2 = r * r;
    for (const c of guidesAt(x, z, ctx).corners) {
      if (c.segment !== undefined && skip.includes(c.segment)) continue;
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
    const r = CELL_SNAP.edgePx * ctx.metresPerPixel;
    let best: SnapHit | null = null;
    let bestD2 = r * r;
    for (const e of guidesAt(x, z, ctx).edges) {
      const p = onPiece(x, z, e);
      const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d2 < bestD2) {
        best = { kind: "edge", x: p.x, z: p.z, cellEdges: [e.cell], edgeLine: { ax: e.ax, az: e.az, bx: e.bx, bz: e.bz } };
        bestD2 = d2;
      }
    }
    return best;
  },
};
