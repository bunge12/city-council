// Snapping for the road tool (issue M1-08). Client work only: it reads the
// mirror's read-only copy of the roads through the sim's spatial index and
// returns a plain point, which the tool sends to the sim like any other.
//
// A snap is a list of sources tried in priority order. The first one that
// catches the cursor gives the point:
//
//   1. node     an existing node
//   2. segment  a point on an existing segment, or the point where the road
//               would meet it at a right angle
//   3. angle    a guide ray from the start at a step from the source road
//   4. grid     the terrain grid, when its toggle is on
//
// After that, length snap rounds the road's length to whole cells along its
// direction, for an angle snap or for no snap at all. A node, a segment or
// the grid fixes the point, so length snap leaves it alone.
//
// Issue M1-19 adds guide lines and parallel offset as more sources in the
// same list.
//
// Holding the free-hand key turns every guide off. Node and segment snaps
// still show inside the sim's merge distance, because the sim joins those
// itself whatever the client sends.
//
// Trigonometry is fine here: the sim only ever sees the resulting point,
// which it rounds to its build grid.

import {
  NETWORKS_ROAD,
  NONE,
  ROAD_BUILD,
  nearestOnQuad,
  roadIndexOf,
  LEVEL_BRIDGE,
  segmentQuad,
  segmentsInBox,
  type BuildPoint,
  type RoadNetwork,
} from "@city-council/sim";
import { liveNode, liveRoadSegment, roadSegmentsAt, type RoadNet } from "../render/road-geometry";
import { SNAP, type GuideToggles } from "./config";

/** `tangent` is the curve tool's lock: a control point held in line with the road a curve leaves from (issue M1-10). */
export type SnapKind = "node" | "segment" | "angle" | "tangent" | "grid" | "none";

/** What a source caught. */
export interface SnapHit {
  kind: SnapKind;
  x: number;
  z: number;
  /** The node caught, for a node snap. */
  node?: number;
  /** The segment caught, for a segment snap. */
  segment?: number;
  /** A segment snap at the point where the road meets the segment at a right angle. */
  perpendicular?: boolean;
  /** For a segment snap, the segment's unit direction, for the marker. */
  along?: { dx: number; dz: number };
  /** For an angle or tangent snap, the guide ray's unit direction from the start. Length snap slides along it. */
  ray?: { dx: number; dz: number };
}

/** What the road starts from, as the sim would join it: the directions of the road there. */
export interface StartSource {
  kind: "node" | "segment";
  /** The node or the segment. */
  id: number;
  /** Unit directions leaving the start along the source road. A segment gives both ways along it. */
  dirs: { dx: number; dz: number }[];
}

/** Everything the snap knows about the moment. */
export interface SnapContext {
  net: RoadNet;
  /** Where the road starts, or null when the click would set the start. */
  start: BuildPoint | null;
  /** The source road at the start, or null on open ground. */
  source: StartSource | null;
  /** Metres one CSS pixel covers at the cursor. */
  metresPerPixel: number;
  guides: GuideToggles;
  /** The free-hand key is held. */
  free: boolean;
  /** The terrain grid's step in metres. */
  gridStep: number;
}

/** A snap source: catches the cursor or returns null. */
export interface SnapSource {
  id: string;
  find(x: number, z: number, ctx: SnapContext): SnapHit | null;
}

/** The point the tool uses, what caught it and what the readout shows. */
export interface Snap extends SnapHit {
  /** Length snap moved the point. */
  lengthSnapped: boolean;
  /** The road's source at the start, or null. */
  source: StartSource | null;
  /** Smallest angle in degrees between the road and its source road, or null with no source or no road yet. */
  angle: number | null;
  /** The road is square to its source: the right-angle marker shows. */
  square: boolean;
  /** For the right-angle marker: the source direction at 90 degrees to the road. */
  squareTo: { dx: number; dz: number } | null;
}

// ---- Reading the network ----

function asNetwork(net: RoadNet): RoadNetwork {
  // The index only reads the network. It is typed for live state; the copy is never written.
  return net as unknown as RoadNetwork;
}

function unit(dx: number, dz: number): { dx: number; dz: number } | null {
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { dx: dx / len, dz: dz / len } : null;
}

/** Unit direction leaving `node` along segment `seg`, toward its control point as the sim measures angles. */
function leaving(net: RoadNet, seg: number, node: number): { dx: number; dz: number } | null {
  return unit((net.segCX[seg] ?? 0) - (net.nodeX[node] ?? 0), (net.segCZ[seg] ?? 0) - (net.nodeZ[node] ?? 0));
}

/** The nearest point on segment `seg` to (x, z), straight or curved, and its curve parameter, 0 to 1. */
function closestOn(net: RoadNet, seg: number, x: number, z: number): { x: number; z: number; t: number; d2: number } {
  return nearestOnQuad(segmentQuad(asNetwork(net), seg), x, z);
}

/** Unit direction of segment `seg` toward node B at curve parameter `t`: along it when straight, the tangent on a curve. */
function segmentDir(net: RoadNet, seg: number, t = 0): { dx: number; dz: number } {
  const q = segmentQuad(asNetwork(net), seg);
  const dx = q.cx - q.ax + t * (q.ax - 2 * q.cx + q.bx);
  const dz = q.cz - q.az + t * (q.az - 2 * q.cz + q.bz);
  return unit(dx, dz) ?? unit(q.bx - q.ax, q.bz - q.az) ?? { dx: 1, dz: 0 };
}

/** Road segments touching the square of half-side `r` around (x, z). */
function roadSegmentsNear(net: RoadNet, x: number, z: number, r: number): number[] {
  // Nothing joins a bridge but at its bank nodes, so a bridge's body catches nothing.
  return segmentsInBox(roadIndexOf(asNetwork(net)), x - r, z - r, x + r, z + r, NETWORKS_ROAD).filter(
    (s) => liveRoadSegment(net, s) && net.segLevel[s] !== LEVEL_BRIDGE,
  );
}

/**
 * What a road starting at `start` starts from, found as the sim joins an
 * end: a node within the merge distance, failing that a segment within it.
 */
export function startSource(net: RoadNet, start: BuildPoint): StartSource | null {
  const r = ROAD_BUILD.mergeDistance;
  const near = nearestRoadNode(net, start.x, start.z, r, NONE);
  if (near !== NONE) {
    const dirs = roadSegmentsAt(net, near).flatMap((seg) => leaving(net, seg, near) ?? []);
    return dirs.length > 0 ? { kind: "node", id: near, dirs } : null;
  }
  let best = NONE;
  let bestD2 = r * r;
  let bestT = 0;
  for (const seg of roadSegmentsNear(net, start.x, start.z, r)) {
    const c = closestOn(net, seg, start.x, start.z);
    if (c.d2 <= bestD2 && (best === NONE || c.d2 < bestD2)) {
      best = seg;
      bestD2 = c.d2;
      bestT = c.t;
    }
  }
  if (best === NONE) return null;
  const d = segmentDir(net, best, bestT);
  return { kind: "segment", id: best, dirs: [d, { dx: -d.dx, dz: -d.dz }] };
}

/**
 * Where a road leaving `source` carries straight on, when the source is the
 * end of a road: a node with one road segment. The unit direction out of the
 * node, opposite the segment's tangent there, and the node itself. Null for a
 * junction, a segment's body or open ground.
 */
export function roadEnd(net: RoadNet, source: StartSource | null): { x: number; z: number; dx: number; dz: number } | null {
  if (source?.kind !== "node" || source.dirs.length !== 1) return null;
  const dir = source.dirs[0];
  if (!dir) return null;
  return { x: net.nodeX[source.id] ?? 0, z: net.nodeZ[source.id] ?? 0, dx: -dir.dx, dz: -dir.dz };
}

/** The live road node nearest (x, z) within `r` metres, other than `skip`, or NONE. Ties go to the lower id. */
function nearestRoadNode(net: RoadNet, x: number, z: number, r: number, skip: number): number {
  let best = NONE;
  let bestD2 = r * r;
  const seen = new Set<number>();
  for (const seg of roadSegmentsNear(net, x, z, r)) {
    for (const node of [net.segA[seg] ?? NONE, net.segB[seg] ?? NONE]) {
      if (node === skip || seen.has(node) || !liveNode(net, node)) continue;
      seen.add(node);
      const dx = (net.nodeX[node] ?? 0) - x;
      const dz = (net.nodeZ[node] ?? 0) - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2 || (d2 === bestD2 && (best === NONE || node < best))) {
        best = node;
        bestD2 = d2;
      }
    }
  }
  return best;
}

// ---- Sources ----

/** How far a pixel distance reaches in metres, or the sim's merge distance when free-hand. */
function reach(ctx: SnapContext, px: number): number {
  return ctx.free ? ROAD_BUILD.mergeDistance : px * ctx.metresPerPixel;
}

/** Segments the road may not end on: those at its start node, or the one it starts from. */
function startSegments(ctx: SnapContext): number[] {
  if (!ctx.source) return [];
  return ctx.source.kind === "segment" ? [ctx.source.id] : roadSegmentsAt(ctx.net, ctx.source.id);
}

export const nodeSource: SnapSource = {
  id: "node",
  find(x, z, ctx) {
    const skip = ctx.source?.kind === "node" ? ctx.source.id : NONE;
    const node = nearestRoadNode(ctx.net, x, z, reach(ctx, SNAP.nodePx), skip);
    if (node === NONE) return null;
    return { kind: "node", x: ctx.net.nodeX[node] ?? 0, z: ctx.net.nodeZ[node] ?? 0, node };
  },
};

export const segmentSource: SnapSource = {
  id: "segment",
  find(x, z, ctx) {
    const r = reach(ctx, ctx.free ? 0 : Math.max(SNAP.segmentPx, SNAP.perpendicularPx));
    const skip = startSegments(ctx);
    const near = roadSegmentsNear(ctx.net, x, z, r).filter((s) => !skip.includes(s));
    const start = ctx.start;
    // The point where the road would meet a segment square, when the cursor is near it.
    if (start && ctx.guides.angle && !ctx.free) {
      const rp = SNAP.perpendicularPx * ctx.metresPerPixel;
      let best: SnapHit | null = null;
      let bestD2 = rp * rp;
      for (const seg of near) {
        const foot = closestOn(ctx.net, seg, start.x, start.z);
        if (foot.t <= 0 || foot.t >= 1) continue;
        const d2 = (foot.x - x) * (foot.x - x) + (foot.z - z) * (foot.z - z);
        if (d2 > bestD2) continue;
        best = { kind: "segment", x: foot.x, z: foot.z, segment: seg, perpendicular: true, along: segmentDir(ctx.net, seg, foot.t) };
        bestD2 = d2;
      }
      if (best) return best;
    }
    const rs = reach(ctx, SNAP.segmentPx);
    let best: SnapHit | null = null;
    let bestD2 = rs * rs;
    for (const seg of near) {
      const c = closestOn(ctx.net, seg, x, z);
      if (c.d2 > bestD2) continue;
      best = { kind: "segment", x: c.x, z: c.z, segment: seg, along: segmentDir(ctx.net, seg, c.t) };
      bestD2 = c.d2;
    }
    return best;
  },
};

const MIN_ANGLE_COS = Math.cos((ROAD_BUILD.minAngleDegrees * Math.PI) / 180);

export const angleSource: SnapSource = {
  id: "angle",
  find(x, z, ctx) {
    const { start, source } = ctx;
    if (!start || !source || !ctx.guides.angle || ctx.free) return null;
    const vx = x - start.x;
    const vz = z - start.z;
    if (Math.hypot(vx, vz) < 1e-6) return null;
    const strongR = SNAP.strongAnglePx * ctx.metresPerPixel;
    const lightR = SNAP.lightAnglePx * ctx.metresPerPixel;
    type Candidate = { d: number; t: number; dx: number; dz: number };
    let strong: Candidate | null = null;
    let light: Candidate | null = null;
    const steps = Math.round(360 / SNAP.lightAngleStep);
    for (const dir of source.dirs) {
      for (let k = 0; k < steps; k++) {
        const deg = k * SNAP.lightAngleStep;
        const a = (deg * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const dx = dir.dx * c - dir.dz * s;
        const dz = dir.dx * s + dir.dz * c;
        // A direction the sim would refuse as too sharp against the source road.
        if (source.dirs.some((o) => o.dx * dx + o.dz * dz > MIN_ANGLE_COS)) continue;
        const t = vx * dx + vz * dz;
        if (t <= 0) continue;
        const d = Math.abs(vx * dz - vz * dx);
        const isStrong = deg % SNAP.strongAngleStep === 0;
        if (isStrong && d <= strongR && (!strong || d < strong.d)) strong = { d, t, dx, dz };
        if (!isStrong && d <= lightR && (!light || d < light.d)) light = { d, t, dx, dz };
      }
    }
    const pick = strong ?? light;
    if (!pick) return null;
    return { kind: "angle", x: start.x + pick.dx * pick.t, z: start.z + pick.dz * pick.t, ray: { dx: pick.dx, dz: pick.dz } };
  },
};

export const gridSource: SnapSource = {
  id: "grid",
  find(x, z, ctx) {
    if (!ctx.guides.grid || ctx.free) return null;
    const step = ctx.gridStep;
    return { kind: "grid", x: Math.round(x / step) * step + 0, z: Math.round(z / step) * step + 0 };
  },
};

/** Every source, in priority order. */
export const SNAP_SOURCES: readonly SnapSource[] = [nodeSource, segmentSource, angleSource, gridSource];

// ---- The snap ----

/** Smallest angle in degrees between direction (dx, dz) and any of `dirs`, and the source direction nearest square. */
function angleTo(dirs: readonly { dx: number; dz: number }[], dx: number, dz: number): { angle: number; square: { dx: number; dz: number } | null; off: number } {
  let angle = 180;
  let square: { dx: number; dz: number } | null = null;
  let off = Infinity;
  for (const d of dirs) {
    const cos = Math.max(-1, Math.min(1, d.dx * dx + d.dz * dz));
    const a = (Math.acos(cos) * 180) / Math.PI;
    if (a < angle) angle = a;
    if (Math.abs(a - 90) < off) {
      off = Math.abs(a - 90);
      square = d;
    }
  }
  return { angle, square, off };
}

/** How near 90 degrees counts as square, for the marker. Rounding to the sim's grid stays well inside it. */
const SQUARE_TOLERANCE_DEGREES = 0.05;

/**
 * Where the cursor at (x, z) lands, given the context. Sources are tried in
 * order; `sources` defaults to every source.
 */
export function snapPoint(x: number, z: number, ctx: SnapContext, sources: readonly SnapSource[] = SNAP_SOURCES): Snap {
  let hit: SnapHit = { kind: "none", x, z };
  for (const source of sources) {
    const found = source.find(x, z, ctx);
    if (found) {
      hit = found;
      break;
    }
  }
  const { start } = ctx;
  let lengthSnapped = false;
  if (start && ctx.guides.length && !ctx.free && (hit.kind === "angle" || hit.kind === "none")) {
    const dir = hit.ray ?? unit(hit.x - start.x, hit.z - start.z);
    if (dir) {
      const len = Math.hypot(hit.x - start.x, hit.z - start.z);
      const snapped = Math.max(1, Math.round(len / SNAP.cellSize)) * SNAP.cellSize;
      hit = { ...hit, x: start.x + dir.dx * snapped, z: start.z + dir.dz * snapped };
      lengthSnapped = true;
    }
  }
  let angle: number | null = null;
  let square = false;
  let squareTo: { dx: number; dz: number } | null = null;
  const dir = start ? unit(hit.x - start.x, hit.z - start.z) : null;
  if (ctx.source && dir) {
    const a = angleTo(ctx.source.dirs, dir.dx, dir.dz);
    angle = a.angle;
    square = a.off <= SQUARE_TOLERANCE_DEGREES;
    squareTo = square ? a.square : null;
  }
  return { ...hit, lengthSnapped, source: ctx.source, angle, square, squareTo };
}
