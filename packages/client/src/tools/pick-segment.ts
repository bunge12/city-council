// Picking a road segment under the pointer, for the bulldoze and upgrade
// tools (issue M1-13). Client work only: it reads the mirror's read-only
// copy of the roads through the sim's spatial index and returns a segment
// id, which the tools put in a command the sim checks like any other.
//
// The spatial index finds the segments near the point on the ground under
// the pointer, and near the point where the pointer's ray crosses the level
// of a bridge deck, since a deck stands above the water the ground pick
// lands on. Each of those is then measured on screen: points along it, at
// the height it is drawn at, are projected, and the pointer's distance to
// that line less half the road's drawn width is its distance. So the pick
// distance is in screen pixels at every zoom and tilt, a curve is measured
// along the curve, a bridge where its deck is drawn, and of two roads close
// together the one the pointer is over wins. Ties go to the nearer centre
// line, then the lower id. A drag passes `prefer`, the segment it took last,
// which wins while the pointer is still on it: at a junction every road
// meeting there is under the pointer, and a drag along one road should not
// take the roads that cross it.
//
// Trigonometry and rounding are fine here: only the id reaches the sim.

import {
  LEVEL_BRIDGE,
  NETWORKS_ROAD,
  NONE,
  ROAD_TYPES,
  bridgeDeckHeight,
  bridgeDeckLevel,
  heightAt,
  roadIndexOf,
  segmentsInBox,
  type RoadNetwork,
  type Terrain,
} from "@city-council/sim";
import { liveRoadSegment, segPath, type RoadNet, type SegPath } from "../render/road-geometry";
import { PICK } from "./config";

/** What picking needs from the view at the pointer. */
export interface PickView {
  /** The pointer over the canvas, CSS pixels. */
  pointer: { x: number; y: number };
  /** The ground under the pointer, or null when the pointer is on sky. */
  ground: { x: number; z: number } | null;
  /** Where the pointer's ray crosses the bridge deck level, or null. */
  deck: { x: number; z: number } | null;
  /** Metres one CSS pixel covers on the ground near the pointer. */
  metresPerPixel: number;
  /** Screen point, CSS pixels, where world point (x, y, z) is drawn. */
  project(x: number, y: number, z: number): { x: number; y: number };
}

/** Half the widest road's width, metres: how far past a centre line a road's surface reaches. */
const MAX_HALF_WIDTH = Math.max(...ROAD_TYPES.map((t) => t.width)) / 2;

/** The height segment `seg` is drawn at, `s` metres along it from node A. */
export function drawnHeight(net: RoadNet, terrain: Terrain, path: SegPath, s: number): number {
  const seg = path.seg;
  if (net.segLevel[seg] === LEVEL_BRIDGE) {
    const hA = net.nodeHeight[net.segA[seg] ?? 0] ?? 0;
    const hB = net.nodeHeight[net.segB[seg] ?? 0] ?? 0;
    return bridgeDeckHeight(hA, hB, path.length, s, bridgeDeckLevel(terrain.waterLevel), path.type.maxSlope);
  }
  const p = path.point(s);
  return heightAt(terrain, p.x, p.z);
}

/** Distance in pixels from `p` to the line from `a` to `b`. */
function toLine(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y);
}

/** How far the pointer is from segment `seg` as drawn: to its centre line, and to its edge. */
export function screenDistance(net: RoadNet, terrain: Terrain, seg: number, view: PickView): { centre: number; edge: number } {
  const path = segPath(net, seg);
  const step = Math.max(PICK.sampleStep, view.metresPerPixel * 2);
  const n = Math.min(PICK.maxSamples, Math.max(PICK.minSamples, Math.ceil(path.length / step)));
  let centre = Infinity;
  let prev: { x: number; y: number } | null = null;
  for (let i = 0; i <= n; i++) {
    const s = (path.length * i) / n;
    const p = path.point(s);
    const q = view.project(p.x, drawnHeight(net, terrain, path, s), p.z);
    if (prev) centre = Math.min(centre, toLine(view.pointer, prev, q));
    prev = q;
  }
  const halfPx = path.half / (view.metresPerPixel > 0 ? view.metresPerPixel : 1);
  return { centre, edge: Math.max(0, centre - halfPx) };
}

/**
 * The road segment under the pointer, within `px` CSS pixels of its drawn
 * edge, or NONE. Segment `prefer` wins while the pointer is on it. Reads the
 * network only.
 */
export function pickSegment(
  net: RoadNet,
  terrain: Terrain,
  view: PickView,
  px: number = PICK.segmentPx,
  prefer: number = NONE,
): number {
  if (prefer !== NONE && liveRoadSegment(net, prefer) && screenDistance(net, terrain, prefer, view).edge === 0) return prefer;
  const index = roadIndexOf(net as unknown as RoadNetwork);
  // Generous on the ground: the screen test below has the final say.
  const reach = px * view.metresPerPixel * 2 + MAX_HALF_WIDTH;
  const candidates = new Set<number>();
  for (const c of [view.ground, view.deck]) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    for (const seg of segmentsInBox(index, c.x - reach, c.z - reach, c.x + reach, c.z + reach, NETWORKS_ROAD)) {
      candidates.add(seg);
    }
  }
  let best = NONE;
  let bestEdge = Infinity;
  let bestCentre = Infinity;
  for (const seg of [...candidates].sort((a, b) => a - b)) {
    if (!liveRoadSegment(net, seg)) continue;
    const d = screenDistance(net, terrain, seg, view);
    if (d.edge > px) continue;
    if (d.edge < bestEdge || (d.edge === bestEdge && d.centre < bestCentre)) {
      best = seg;
      bestEdge = d.edge;
      bestCentre = d.centre;
    }
  }
  return best;
}

/**
 * Screen points from `from` to `to`, no more than `step` pixels apart, both
 * ends included. A drag is picked at each, so a fast one skips no road.
 */
export function dragSamples(
  from: { x: number; y: number },
  to: { x: number; y: number },
  step: number = PICK.dragStepPx,
): { x: number; y: number }[] {
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  return out;
}
