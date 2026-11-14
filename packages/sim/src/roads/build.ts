// BuildRoad: a road between two points, straight or one quadratic curve
// through a control point (issue 09), split into a chain of segments
// wherever it crosses or meets another road (issue 04).
//
// Positions are rounded to the build grid first, so two points are either
// the same node or apart, with no tolerance in later comparisons. An end
// within the merge distance of an existing road node joins that node.
//
// A road follows the ground (PRD, "How a road meets the ground"). Its nodes
// take the terrain height, and the slope check samples the ground along the
// path at no more than `groundSampleStep` metres and refuses a road whose
// grade between two samples passes its type's limit. A curve is sampled
// along its shape, and one tighter than its type's minimum radius is refused.
//
// A curved segment split in two becomes two curves that trace its path: the
// split point is the exact point on the curve, not rounded to the grid, and
// each piece takes the control point of its part of the curve (curve.ts).
// Where only straight segments meet, everything is as it was before curves.
//
// A road that crosses water becomes a bridge there (issue 11, bridge.ts).
// Each piece between junctions is sampled as the slope check samples it.
// Each run of wet samples is spanned by one bridge segment, at the bridge
// level, from a new node on each bank. A bank node is the sample nearest the
// water from which a ramp at the type's slope limit reaches the deck by the
// shore; failing that the road is refused. Two runs too close together for
// ground between them share one bridge. Only the ground pieces get the slope
// check.
//
// Every segment has a level (issue 22, levels.ts). A road splits and joins
// only segments on its own level. Where it crosses one on another level, or
// a bridge, their heights there are compared: with `levels.clearance` between
// them they pass with no junction, and closer than that the road is refused.
// A BuildRoad payload may name a level other than the ground; no player tool
// does in M1, but tests and the debug panel build raised roads that way. A
// road at any level but the ground makes no bridges, so it may not cross
// water.
//
// Checks feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Lint enforces it in this folder.

import { ROAD_BUILD, ROAD_LEVELS, ROAD_TYPES, type RoadType } from "./balance";
import { bridgeDeckLevel } from "./bridge";
import { BUILD_LEVELS, LEVELS_ALL, LEVELS_SURFACE, clearanceReason, heightAlong, segmentShape, type LevelledShape } from "./levels";
import {
  LEVEL_BRIDGE,
  LEVEL_GROUND,
  segmentAtLevel,
  NETWORK_ROAD,
  NODE_FIXED,
  NONE,
  SEG_FIXED,
  addNode,
  addSegment,
  curveLength,
  nextSegmentAt,
  otherEnd,
  removeSegment,
  type RoadNetwork,
} from "./network";
import {
  curveBox,
  hullBox,
  isStraight,
  minRadius,
  nearestOnQuad,
  orient,
  quadMeetings,
  quadPoint,
  quadsMeetAwayFrom,
  segmentQuad,
  segmentsMeet,
  straightQuad,
  subControl,
  type Quad,
} from "./curve";
import { NETWORKS_ROAD, nearestNode, roadIndexOf, segmentsInBox } from "./spatial";
import { heightAt, mapSize, type Terrain } from "../terrain/terrain";

/** A point in a command: metres east and south. */
export interface BuildPoint {
  x: number;
  z: number;
}

/** What a BuildRoad command carries besides the player id. */
export interface BuildRoadPayload {
  from: BuildPoint;
  to: BuildPoint;
  /** A road type id from the balance file, such as "street". */
  type: string;
  /**
   * The control point of a curved road. Leave it out for a straight one.
   * The road is the quadratic curve from its start through this to its end.
   */
  control?: BuildPoint;
  /**
   * The level to build at, a key of BUILD_LEVELS such as "elevated1". The
   * ground if left out. No player tool sets it in M1.
   */
  level?: string;
}

/**
 * A stop along a planned road: one of its ends, or a junction on the way.
 * Consecutive stops are joined by one new segment.
 */
export interface PlanStop {
  /** On the build grid, or at the existing node. */
  x: number;
  z: number;
  /** The existing node here, or NONE for a new one. */
  node: number;
  /**
   * Existing segments that split here, ascending. Each becomes pieces that
   * meet at this stop. A segment the road meets more than once, as a curve
   * can, is in more than one stop.
   */
  splits: number[];
  /** Where each segment in `splits` splits, as its curve parameter from node A (0) to node B (1). */
  splitAt: number[];
  /** Where the stop is along the new road, as its curve parameter: 0 at the start, 1 at the end. */
  t: number;
}

/** A road that passed every check, ready to build. */
export interface RoadPlan {
  type: RoadType;
  /**
   * The control point of the whole road from the first stop to the last, or
   * null for a straight road. Each piece takes the control point of its part.
   */
  control: BuildPoint | null;
  /** From the start to the end, in order along the road. At least two. */
  stops: PlanStop[];
  /**
   * The level of each piece of the new road: `levels[i]` is the piece from
   * stop i to stop i + 1. LEVEL_BRIDGE over water, the road's level elsewhere.
   */
  levels: number[];
  /** The level the road was asked for: LEVEL_GROUND unless the payload named another. */
  level: number;
  /** Plan length of the new road in metres, every piece added up. */
  length: number;
  /** The part of `length` that is bridge, metres. */
  bridgeLength: number;
  /** Whole 2026 dollars. Not charged until the treasury arrives in M4. */
  cost: number;
}

export type RoadPlanResult = { ok: true; plan: RoadPlan } | { ok: false; reason: string };

/** `v` rounded to the nearest multiple of the build grid. Never -0. */
export function snapToGrid(v: number): number {
  const step = ROAD_BUILD.gridStep;
  return Math.round(v / step) * step + 0;
}

/**
 * Cosine of an angle in degrees, from its Taylor series. Only exact
 * operations, so every engine gets the same number, unlike Math.cos.
 * Accurate to well under 1e-12 from 0 to 180 degrees.
 */
export function cosDegrees(degrees: number): number {
  const x = (degrees * Math.PI) / 180;
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 24; k++) {
    term *= -x2 / ((2 * k - 1) * (2 * k));
    sum += term;
  }
  return sum;
}

const MIN_ANGLE_COS = cosDegrees(ROAD_BUILD.minAngleDegrees);

function isPoint(value: unknown): value is BuildPoint {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return Number.isFinite(p["x"]) && Number.isFinite(p["z"]);
}

function readPayload(payload: unknown): (BuildRoadPayload & { levelValue: number }) | string {
  if (typeof payload !== "object" || payload === null) return "BuildRoad needs a start, an end and a road type";
  const p = payload as Record<string, unknown>;
  if (!isPoint(p["from"]) || !isPoint(p["to"])) return "BuildRoad needs a start and an end, each with a finite x and z";
  if (typeof p["type"] !== "string") return "BuildRoad needs a road type";
  const level = p["level"];
  let levelValue = LEVEL_GROUND;
  if (level !== undefined) {
    if (typeof level !== "string" || !Object.hasOwn(BUILD_LEVELS, level)) {
      return `A road's level must be one of ${Object.keys(BUILD_LEVELS).join(", ")}`;
    }
    levelValue = BUILD_LEVELS[level] ?? LEVEL_GROUND;
  }
  const control = p["control"];
  if (control === undefined) return { from: p["from"], to: p["to"], type: p["type"], levelValue };
  if (!isPoint(control)) return "A curved road's control point needs a finite x and z";
  return { from: p["from"], to: p["to"], type: p["type"], control, levelValue };
}

function onMap(terrain: Terrain, x: number, z: number): boolean {
  const size = mapSize(terrain);
  return x >= 0 && x <= size && z >= 0 && z <= size;
}

export { segmentsMeet } from "./curve";

/**
 * Where straight segments pq and rs meet, rounded to the build grid. They
 * must meet and must not run along each other. The answer depends only on
 * the two segments as sets of points: each one's ends are put in a fixed
 * order, then the two segments, before any arithmetic. So the crossing of
 * two roads lands on the same grid point whichever was drawn first.
 */
export function crossingPoint(
  px: number,
  pz: number,
  qx: number,
  qz: number,
  rx: number,
  rz: number,
  sx: number,
  sz: number,
): { x: number; z: number } {
  const before = (ax: number, az: number, bx: number, bz: number): boolean => ax < bx || (ax === bx && az < bz);
  let u = before(qx, qz, px, pz) ? [qx, qz, px, pz] : [px, pz, qx, qz];
  let v = before(sx, sz, rx, rz) ? [sx, sz, rx, rz] : [rx, rz, sx, sz];
  const [u0x = 0, u0z = 0, u1x = 0, u1z = 0] = u;
  const [v0x = 0, v0z = 0, v1x = 0, v1z = 0] = v;
  const vFirst =
    before(v0x, v0z, u0x, u0z) || (v0x === u0x && v0z === u0z && before(v1x, v1z, u1x, u1z));
  if (vFirst) [u, v] = [v, u];
  const [ax = 0, az = 0, bx = 0, bz = 0] = u;
  const [cx = 0, cz = 0, dx = 0, dz = 0] = v;
  const d1 = orient(cx, cz, dx, dz, ax, az);
  const d2 = orient(cx, cz, dx, dz, bx, bz);
  const t = d1 / (d1 - d2);
  return { x: snapToGrid(ax + (bx - ax) * t), z: snapToGrid(az + (bz - az) * t) };
}

// What the new road is built as. Its pieces over water are bridges instead,
// but only segments on the road's level split or are split: nothing branches
// off a bridge. Only segments on the same network and level split each other.
const NEW_NETWORK = NETWORK_ROAD;

const SHORT_ROAD = `Too short: a road must be at least ${ROAD_BUILD.minLength} m long`;
const SHORT_PIECE = `Too close to a junction: every piece of road between junctions must be at least ${ROAD_BUILD.minLength} m long`;
const DUPLICATE = "A road already joins these two points";
const ALONG = "The road runs along another road";
const AT_CONNECTION = "The highway at an outside connection cannot be joined or crossed: build from the end of it";
const SHARP = `The angle with the road it joins is too sharp: it must be at least ${ROAD_BUILD.minAngleDegrees} degrees`;
const SHALLOW = `The road crosses another road at too shallow an angle: it must be at least ${ROAD_BUILD.minAngleDegrees} degrees`;
const TANGLED = "The road passes too close to another junction to join it cleanly";

/**
 * Whether a segment is on the layer the new road is built on, `level` at both
 * ends, and so can split or be split.
 */
function onNewLayer(net: RoadNetwork, seg: number, level: number): boolean {
  return net.segNetwork[seg] === NEW_NETWORK && segmentAtLevel(net, seg, level);
}

/**
 * The level filter for the nodes a road at `level` can join: those with a
 * segment at that level there. A bridge's bank nodes sit on the ground, so a
 * ground road joins them too.
 */
function nodeLevels(level: number): number {
  return level === LEVEL_GROUND ? LEVELS_SURFACE : 1 << level;
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Whether a live segment already joins nodes `a` and `b`, either way round. */
function joined(net: RoadNetwork, a: number, b: number): boolean {
  for (let seg = net.nodeFirstSeg[a] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, a)) {
    if (otherEnd(net, seg, a) === b) return true;
  }
  return false;
}

export const TIGHT = (type: RoadType, radius: number) =>
  `The curve is too tight: a ${Math.round(radius)} m radius, and the ${type.name.toLowerCase()} limit is ${type.minCurveRadius} m`;

/** A new stop with no existing node. */
function newStop(x: number, z: number, t: number): PlanStop {
  return { x, z, node: NONE, splits: [], splitAt: [], t };
}

/** Plan length of `q`, measured the way `addSegment` stores it. */
function quadLength(q: Quad): number {
  return curveLength(q.ax, q.az, q.cx, q.cz, q.bx, q.bz);
}

/**
 * Where segment `seg` would split at point (x, z), which is parameter `u`
 * along it. A split that leaves a piece shorter than the minimum length
 * moves to that end's node if it is within the merge distance, and the stop
 * is the node with no split. Otherwise it is refused. A curved segment's
 * pieces are measured along the curve.
 */
function splitStop(net: RoadNetwork, seg: number, x: number, z: number, u: number): PlanStop | string {
  const p = net.segA[seg] ?? NONE;
  const q = net.segB[seg] ?? NONE;
  const shape = segmentQuad(net, seg);
  const straight = isStraight(shape);
  const dp = straight ? distance(x, z, net.nodeX[p] ?? 0, net.nodeZ[p] ?? 0) : quadLength(subQuadTo(shape, 0, u, x, z, true));
  const dq = straight ? distance(x, z, net.nodeX[q] ?? 0, net.nodeZ[q] ?? 0) : quadLength(subQuadTo(shape, u, 1, x, z, false));
  if (dp >= ROAD_BUILD.minLength && dq >= ROAD_BUILD.minLength) return { x, z, node: NONE, splits: [seg], splitAt: [u], t: 0 };
  const node = dp <= dq ? p : q;
  if ((dp <= dq ? dp : dq) > ROAD_BUILD.mergeDistance) return SHORT_PIECE;
  return { x: net.nodeX[node] ?? 0, z: net.nodeZ[node] ?? 0, node, splits: [], splitAt: [], t: 0 };
}

/**
 * The part of curve `q` from `t0` to `t1`, with the end at the split point
 * (x, z) put exactly there: at its end when `toSplit`, else at its start.
 */
function subQuadTo(q: Quad, t0: number, t1: number, x: number, z: number, toSplit: boolean): Quad {
  const a = toSplit ? quadPoint(q, t0) : { x, z };
  const b = toSplit ? { x, z } : quadPoint(q, t1);
  const c = subControl(q, t0, t1);
  return { ax: a.x, az: a.z, cx: c.x, cz: c.z, bx: b.x, bz: b.z };
}

/**
 * The end of a new road at grid point (x, z). It joins a road node within
 * the merge distance. Failing that, it joins the nearest segment body within
 * the merge distance, which splits there into a T-junction. Otherwise it is
 * a new node. On a straight segment the junction is rounded to the grid; on
 * a curve it is the exact point on the curve, so the pieces trace it.
 */
function resolveEnd(net: RoadNetwork, x: number, z: number, t: number, level: number): PlanStop | string {
  const index = roadIndexOf(net);
  const radius = ROAD_BUILD.mergeDistance;
  const near = nearestNode(index, x, z, radius, NETWORKS_ROAD, nodeLevels(level));
  if (near) return { x: net.nodeX[near.node] ?? 0, z: net.nodeZ[near.node] ?? 0, node: near.node, splits: [], splitAt: [], t };

  // The nearest point on a segment body, as `nearestPointOnSegment` finds it
  // but only on the new road's layer. Ties go to the lower id.
  let best = NONE;
  let bestD2 = radius * radius;
  let bestX = 0;
  let bestZ = 0;
  let bestU = 0;
  for (const seg of segmentsInBox(index, x - radius, z - radius, x + radius, z + radius, NETWORKS_ROAD, 1 << level)) {
    if (!onNewLayer(net, seg, level)) continue;
    const found = nearestOnQuad(segmentQuad(net, seg), x, z);
    if (found.d2 > bestD2 || (found.d2 === bestD2 && best !== NONE)) continue;
    best = seg;
    bestD2 = found.d2;
    bestX = found.x;
    bestZ = found.z;
    bestU = found.t;
  }
  if (best === NONE) return newStop(x, z, t);
  const stop = isStraight(segmentQuad(net, best))
    ? splitStop(net, best, snapToGrid(bestX), snapToGrid(bestZ), bestU)
    : splitStop(net, best, bestX, bestZ, bestU);
  if (typeof stop !== "string") stop.t = t;
  return stop;
}

/** The parameter on straight segment `seg` of point (x, z), from its projection. */
function projectOnto(net: RoadNetwork, seg: number, x: number, z: number): number {
  return nearestOnQuad(segmentQuad(net, seg), x, z).t;
}

/** Whether two points are within `AT_POINT` metres. */
function samePlace(ax: number, az: number, bx: number, bz: number): boolean {
  return (ax - bx) * (ax - bx) + (az - bz) * (az - bz) <= AT_POINT * AT_POINT;
}

/** Meetings this close to a node or a split point are at it. */
const AT_POINT = 1e-3;

/**
 * Takes a meeting near an end of the new road into that end, or returns
 * the stop for it. A meeting within the minimum length of an end joins that
 * end if it is within the merge distance, and is refused otherwise.
 */
function placeCrossing(stop: PlanStop, start: PlanStop, end: PlanStop, seg: number, u: number): "joined" | string | null {
  if (stop.node !== NONE) return null;
  const ds = distance(stop.x, stop.z, start.x, start.z);
  const de = distance(stop.x, stop.z, end.x, end.z);
  if (ds >= ROAD_BUILD.minLength && de >= ROAD_BUILD.minLength) return null;
  if ((ds <= de ? ds : de) > ROAD_BUILD.mergeDistance) return SHORT_PIECE;
  const into = ds <= de ? start : end;
  into.splits.push(seg);
  into.splitAt.push(u);
  return "joined";
}

/**
 * The junctions between the two ends, in no particular order: one for each
 * place the new road crosses or touches a segment on its layer. A crossing
 * within the minimum length of an end of the new road joins that end if it
 * is within the merge distance, and is refused otherwise. Adds those splits
 * to the end stops.
 *
 * Between two straight segments this is the issue 04 test, and the crossing
 * is rounded to the grid the same way whichever came first. Where a curve
 * is involved, the curves are met (curve.ts), and a curve may be met more
 * than once. A crossing on a curved segment is the exact point on it; one
 * on a straight segment is rounded to the grid.
 */
function crossings(net: RoadNetwork, start: PlanStop, end: PlanStop, road: Quad, curved: boolean, level: number): PlanStop[] | string {
  const { x: ax, z: az } = start;
  const { x: bx, z: bz } = end;
  const box = curveBox(road);
  const found = segmentsInBox(roadIndexOf(net), box.minX, box.minZ, box.maxX, box.maxZ, NETWORKS_ROAD, 1 << level);
  const stops: PlanStop[] = [];
  for (const seg of found) {
    if (!onNewLayer(net, seg, level)) continue;
    const p = net.segA[seg] ?? NONE;
    const q = net.segB[seg] ?? NONE;
    const shape = segmentQuad(net, seg);
    const straightSeg = isStraight(shape);

    if (!curved && straightSeg) {
      if (start.splits.includes(seg) || end.splits.includes(seg)) continue;
      // A segment at an end node meets the road there by design. If it also
      // runs along it, the angle check refuses the road.
      if (start.node !== NONE && (p === start.node || q === start.node)) continue;
      if (end.node !== NONE && (p === end.node || q === end.node)) continue;
      const px = net.nodeX[p] ?? 0;
      const pz = net.nodeZ[p] ?? 0;
      const qx = net.nodeX[q] ?? 0;
      const qz = net.nodeZ[q] ?? 0;
      if (!segmentsMeet(ax, az, bx, bz, px, pz, qx, qz)) continue;
      if (orient(ax, az, bx, bz, px, pz) === 0 && orient(ax, az, bx, bz, qx, qz) === 0) return ALONG;

      const at = crossingPoint(ax, az, bx, bz, px, pz, qx, qz);
      const u = projectOnto(net, seg, at.x, at.z);
      const stop = splitStop(net, seg, at.x, at.z, u);
      if (typeof stop === "string") return stop;
      stop.t = ((at.x - ax) * (bx - ax) + (at.z - az) * (bz - az)) / ((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      const placed = placeCrossing(stop, start, end, seg, u);
      if (placed === "joined") continue;
      if (placed !== null) return placed;
      stops.push(stop);
      continue;
    }

    // A curve is involved. Meetings at a node or split point the two already
    // share are the joins made there, not crossings.
    const shared: { x: number; z: number }[] = [];
    if (start.node !== NONE && (p === start.node || q === start.node)) shared.push(start);
    if (end.node !== NONE && (p === end.node || q === end.node)) shared.push(end);
    if (start.splits.includes(seg)) shared.push(start);
    if (end.splits.includes(seg)) shared.push(end);
    const met = quadMeetings(road, shape);
    if (met.along) return ALONG;
    for (const m of met.at) {
      const onSeg = quadPoint(shape, m.u);
      if (shared.some((s) => samePlace(onSeg.x, onSeg.z, s.x, s.z))) continue;
      let x = onSeg.x;
      let z = onSeg.z;
      let u = m.u;
      if (straightSeg) {
        const onRoad = quadPoint(road, m.t);
        x = snapToGrid(onRoad.x);
        z = snapToGrid(onRoad.z);
        u = projectOnto(net, seg, x, z);
      }
      const stop = splitStop(net, seg, x, z, u);
      if (typeof stop === "string") return stop;
      stop.t = m.t;
      const placed = placeCrossing(stop, start, end, seg, u);
      if (placed === "joined") continue;
      if (placed !== null) return placed;
      stops.push(stop);
    }
  }
  return stops;
}

/**
 * The stops from `start` to `end` in order along the road. Junctions at the
 * same existing node, or at the same new point, become one stop. A straight
 * road orders them by distance along it, a curve by its parameter.
 */
function orderStops(start: PlanStop, end: PlanStop, middle: PlanStop[], curved: boolean): PlanStop[] {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const along = (s: PlanStop): number => (curved ? s.t : (s.x - start.x) * dx + (s.z - start.z) * dz);
  const sorted = [...middle].sort((p, q) => along(p) - along(q) || p.x - q.x || p.z - q.z || p.node - q.node);
  const out: PlanStop[] = [start];
  for (const stop of sorted) {
    const same = out.find((s) => (stop.node !== NONE ? s.node === stop.node : s.node === NONE && s.x === stop.x && s.z === stop.z));
    if (same) {
      same.splits.push(...stop.splits);
      same.splitAt.push(...stop.splitAt);
    } else out.push(stop);
  }
  const last = out.find((s) => end.node !== NONE && s.node === end.node);
  if (last && last !== start) {
    // A junction at the end node: the road ends there anyway.
    end.splits.push(...last.splits);
    end.splitAt.push(...last.splitAt);
    out.splice(out.indexOf(last), 1);
  }
  out.push(end);
  for (const stop of out) sortSplits(stop);
  return out;
}

/** Puts a stop's splits in ascending segment order, each with its parameter. */
function sortSplits(stop: PlanStop): void {
  const pairs = stop.splits.map((seg, i) => [seg, stop.splitAt[i] ?? 0] as const);
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  stop.splits = pairs.map((p) => p[0]);
  stop.splitAt = pairs.map((p) => p[1]);
}

/** One end of a segment the plan would add. */
interface PlannedEnd {
  /** The existing node id, or -2 minus the stop's place for a new node. */
  key: number;
  node: number;
  x: number;
  z: number;
}

/** A segment the plan would add. */
interface PlannedSegment {
  a: PlannedEnd;
  b: PlannedEnd;
  /** Its control point, or null for a straight segment. */
  control: { x: number; z: number } | null;
}

function stopEnd(stops: PlanStop[], i: number): PlannedEnd {
  const s = stops[i] as PlanStop;
  return { key: s.node !== NONE ? s.node : -2 - i, node: s.node, x: s.x, z: s.z };
}

function nodeEnd(net: RoadNetwork, node: number): PlannedEnd {
  return { key: node, node, x: net.nodeX[node] ?? 0, z: net.nodeZ[node] ?? 0 };
}

function plannedQuad(s: PlannedSegment): Quad {
  return s.control
    ? { ax: s.a.x, az: s.a.z, cx: s.control.x, cz: s.control.z, bx: s.b.x, bz: s.b.z }
    : straightQuad(s.a.x, s.a.z, s.b.x, s.b.z);
}

/**
 * Whether two directions leaving the same point are closer than the minimum
 * angle. Directions are vectors from the point.
 */
function tooSharp(dx: number, dz: number, ex: number, ez: number): boolean {
  const dot = dx * ex + dz * ez;
  return dot > MIN_ANGLE_COS * Math.sqrt((dx * dx + dz * dz) * (ex * ex + ez * ez));
}

/**
 * Checks the angles at every node the plan touches. Each new segment is
 * checked against every other segment there once the plan is built, old
 * ones included. A segment leaves a node toward its control point, which for
 * a straight one is along it and for a curve is the tangent.
 */
function angleProblem(net: RoadNetwork, planned: PlannedSegment[], removed: number[], crossingKeys: number[]): string | null {
  const keys = [...new Set(planned.flatMap((s) => [s.a.key, s.b.key]))];
  for (const key of keys) {
    const here = planned.find((s) => s.a.key === key)?.a ?? planned.find((s) => s.b.key === key)?.b;
    if (!here) continue;
    const fresh: [number, number][] = [];
    for (const s of planned) {
      if (s.a.key === key) fresh.push(s.control ? [s.control.x - here.x, s.control.z - here.z] : [s.b.x - here.x, s.b.z - here.z]);
      if (s.b.key === key) fresh.push(s.control ? [s.control.x - here.x, s.control.z - here.z] : [s.a.x - here.x, s.a.z - here.z]);
    }
    const old: [number, number][] = [];
    if (here.node !== NONE) {
      for (let seg = net.nodeFirstSeg[here.node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, here.node)) {
        if (!removed.includes(seg)) old.push([(net.segCX[seg] ?? 0) - here.x, (net.segCZ[seg] ?? 0) - here.z]);
      }
    }
    const reason = crossingKeys.includes(key) ? SHALLOW : SHARP;
    for (let i = 0; i < fresh.length; i++) {
      const [dx = 0, dz = 0] = fresh[i] ?? [];
      for (let j = i + 1; j < fresh.length; j++) {
        const [ex = 0, ez = 0] = fresh[j] ?? [];
        if (tooSharp(dx, dz, ex, ez)) return reason;
      }
      for (const [ex, ez] of old) if (tooSharp(dx, dz, ex, ez)) return reason;
    }
  }
  return null;
}

/**
 * Whether a planned segment would meet, anywhere but a shared node, an
 * existing segment that stays or another planned segment. A crossing moved
 * to a nearby node bends the pieces around it, and this makes sure the bend
 * did not run into something else. Two curves that share a node can still
 * meet elsewhere, so where a curve is involved only the shared points are
 * let off.
 */
function tangled(net: RoadNetwork, planned: PlannedSegment[], removed: number[], level: number): boolean {
  const index = roadIndexOf(net);
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i] as PlannedSegment;
    const { a, b } = s;
    const shape = plannedQuad(s);
    const box = hullBox(shape);
    const near = segmentsInBox(index, box.minX, box.minZ, box.maxX, box.maxZ, NETWORKS_ROAD, 1 << level);
    for (const seg of near) {
      if (!onNewLayer(net, seg, level) || removed.includes(seg)) continue;
      const p = net.segA[seg] ?? NONE;
      const q = net.segB[seg] ?? NONE;
      const other = segmentQuad(net, seg);
      const sharesNode = p === a.key || p === b.key || q === a.key || q === b.key;
      if (s.control === null && isStraight(other)) {
        if (sharesNode) continue;
        if (segmentsMeet(a.x, a.z, b.x, b.z, other.ax, other.az, other.bx, other.bz)) return true;
        continue;
      }
      const shared = [a, b].filter((e) => e.key === p || e.key === q);
      if (quadsMeetAwayFrom(shape, other, shared)) return true;
    }
    for (let j = i + 1; j < planned.length; j++) {
      const t = planned[j] as PlannedSegment;
      const { a: c, b: d } = t;
      if (s.control === null && t.control === null) {
        if (c.key === a.key || c.key === b.key || d.key === a.key || d.key === b.key) continue;
        if (segmentsMeet(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) return true;
        continue;
      }
      const shared = [a, b].filter((e) => e.key === c.key || e.key === d.key);
      if (quadsMeetAwayFrom(shape, plannedQuad(t), shared)) return true;
    }
  }
  return false;
}

/** As a whole percentage, for a reason a player reads. */
function percent(grade: number): string {
  return `${Math.round(grade * 100)}%`;
}

const WATER = "The road runs too close along the water's edge";
const END_IN_WATER = "A road cannot start or end in water";
const JUNCTION_IN_WATER = "The road would meet another road over water";

export function bridgeTooLong(type: RoadType, length: number): string {
  return `Too long for a bridge: ${Math.round(length)} m, and the ${type.name.toLowerCase()} limit is ${type.bridge.maxLength} m`;
}

export function rampProblem(type: RoadType, grade: number, up: boolean): string {
  const limit = `the ${type.name.toLowerCase()} limit is ${percent(type.maxSlope)}`;
  if (grade === Infinity) return `There is no room on the bank for the ramp ${up ? "up" : "down"} to the bridge`;
  if (up) return `Not enough room on the bank for the ramp up to the bridge: it would be a ${percent(grade)} grade, and ${limit}`;
  return `The bank is too steep for the bridge: the ramp down to the deck would be a ${percent(grade)} grade, and ${limit}`;
}

/** A ground sample along a piece of road. */
export interface Sample {
  /** The piece's curve parameter, 0 to 1. */
  tau: number;
  x: number;
  z: number;
  h: number;
  /** Metres along the piece. */
  s: number;
  wet: boolean;
}

/**
 * The ground under `q` at the same points `groundProblem` reads: even steps
 * of no more than `groundSampleStep` on a straight piece, and even steps of
 * the parameter on a curve.
 */
export function sampleGround(terrain: Terrain, q: Quad): Sample[] {
  const step = ROAD_BUILD.groundSampleStep;
  const out: Sample[] = [];
  const at = (tau: number, x: number, z: number, s: number): void => {
    const h = heightAt(terrain, x, z);
    out.push({ tau, x, z, h, s, wet: h <= terrain.waterLevel });
  };
  if (isStraight(q)) {
    const length = distance(q.ax, q.az, q.bx, q.bz);
    const steps = Math.ceil(length / step);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      at(t, q.ax + (q.bx - q.ax) * t, q.az + (q.bz - q.az) * t, length * t);
    }
    return out;
  }
  const ea = distance(q.ax, q.az, q.cx, q.cz);
  const eb = distance(q.cx, q.cz, q.bx, q.bz);
  const steps = Math.ceil((2 * (ea > eb ? ea : eb)) / step);
  let s = 0;
  let px = q.ax;
  let pz = q.az;
  for (let i = 0; i <= steps; i++) {
    const p = quadPoint(q, i / steps);
    s += distance(px, pz, p.x, p.z);
    at(i / steps, p.x, p.z, s);
    px = p.x;
    pz = p.z;
  }
  return out;
}

/**
 * The bridges a piece needs, as pairs of sample indices from bank to bank,
 * in order. Both ends of the piece must be dry. A bank is the sample nearest
 * the water from which a ramp at `grade` reaches `deck` by the shore sample,
 * and it leaves at least the minimum length of ground to the piece's ends
 * and to the bridge before. A run of water with no room for its first bank
 * after the bridge before joins that bridge, and one whose second bank would
 * be past more water takes that water in too.
 */
function findSpans(smp: Sample[], deck: number, grade: number): [number, number][] | { grade: number; up: boolean } {
  const minLength = ROAD_BUILD.minLength;
  const n = smp.length - 1;
  const get = (k: number): Sample => smp[k] as Sample;
  const fits = (k: number, run: number): boolean => {
    const h = get(k).h;
    return (deck > h ? deck - h : h - deck) <= grade * run;
  };
  const failure = (k: number, run: number) => {
    const h = get(k).h;
    const rise = deck > h ? deck - h : h - deck;
    return { grade: run > 0 ? rise / run : Infinity, up: deck > h };
  };
  const spans: [number, number][] = [];
  let i = 1;
  while (i < n) {
    if (!get(i).wet) {
      i++;
      continue;
    }
    const shoreA = i - 1;
    const last = spans[spans.length - 1];
    const floor = last ? last[1] : 0;
    let bankA = NONE;
    for (let k = shoreA; k >= floor; k--) {
      const room = get(k).s - get(floor).s;
      if (last ? room < minLength : k !== 0 && room < minLength) continue;
      if (fits(k, get(shoreA).s - get(k).s)) {
        bankA = k;
        break;
      }
    }
    if (bankA === NONE && !last) return failure(0, get(shoreA).s);
    let j = i;
    let bankB = NONE;
    for (;;) {
      while (get(j).wet) j++;
      const shoreB = j;
      let k = shoreB;
      for (; k <= n && !get(k).wet; k++) {
        if (k !== n && get(n).s - get(k).s < minLength) continue;
        if (fits(k, get(k).s - get(shoreB).s)) {
          bankB = k;
          break;
        }
      }
      if (bankB !== NONE) break;
      if (k > n) return failure(n, get(n).s - get(shoreB).s);
      j = k;
    }
    if (bankA === NONE && last) last[1] = bankB;
    else spans.push([bankA, bankB]);
    i = bankB + 1;
  }
  return spans;
}

/**
 * The stops with a bank node added at each end of every bridge, and the
 * level of each piece between them, or the reason the road cannot cross the
 * water. On a straight road a bank node is on the build grid. On a curve it
 * is the exact point on the whole road's curve, so the pieces trace it.
 */
function placeBridges(
  terrain: Terrain,
  type: RoadType,
  stops: PlanStop[],
  control: BuildPoint | null,
  level: number,
): { stops: PlanStop[]; levels: number[] } | string {
  // Only a ground road becomes a bridge over water. Any other level keeps
  // its level, and the ground check refuses it over water.
  if (level !== LEVEL_GROUND) return { stops, levels: stops.slice(1).map(() => level) };
  const road = roadQuad(stops, control);
  const deck = bridgeDeckLevel(terrain.waterLevel);
  const out: PlanStop[] = [stops[0] as PlanStop];
  const levels: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1] as PlanStop;
    const b = stops[i] as PlanStop;
    const c = pieceControl(stops, control, i);
    const q = c ? { ax: a.x, az: a.z, cx: c.x, cz: c.z, bx: b.x, bz: b.z } : straightQuad(a.x, a.z, b.x, b.z);
    const smp = sampleGround(terrain, q);
    const n = smp.length - 1;
    if ((smp[0] as Sample).wet) return i === 1 ? END_IN_WATER : JUNCTION_IN_WATER;
    if ((smp[n] as Sample).wet) return i === stops.length - 1 ? END_IN_WATER : JUNCTION_IN_WATER;
    const spans = findSpans(smp, deck, type.maxSlope);
    if (!Array.isArray(spans)) return rampProblem(type, spans.grade, spans.up);
    const bank = (k: number): PlanStop => {
      const sample = smp[k] as Sample;
      const t = a.t + sample.tau * (b.t - a.t);
      if (control) {
        const p = quadPoint(road, t);
        return newStop(p.x, p.z, t);
      }
      return newStop(snapToGrid(sample.x), snapToGrid(sample.z), t);
    };
    let reachedEnd = false;
    for (const [sa, sb] of spans) {
      if (sa > 0) {
        out.push(bank(sa));
        levels.push(LEVEL_GROUND);
      }
      if (sb < n) out.push(bank(sb));
      else {
        out.push(b);
        reachedEnd = true;
      }
      levels.push(LEVEL_BRIDGE);
    }
    if (!reachedEnd) {
      out.push(b);
      levels.push(LEVEL_GROUND);
    }
  }
  return { stops: out, levels };
}

/**
 * Why a new piece may not cross a road on another level, or null. Each
 * piece is met with every road segment near it that the plan does not
 * split, away from the nodes they share. At each meeting the two surfaces'
 * heights are compared (levels.ts): `levels.clearance` apart or more, they
 * pass with no junction. Closer than that the road is refused, and so is a
 * meeting at the same height with a segment the road cannot split, such as
 * a bridge. Segments on the road's own level at both ends that it meets
 * were split by `crossings`, so they meet it only at a shared stop, and the
 * index query leaves them out: in a city mostly on the ground this check
 * then looks at almost nothing.
 */
function levelProblem(
  net: RoadNetwork,
  terrain: Terrain,
  type: RoadType,
  pieces: PlannedSegment[],
  levels: number[],
  removed: number[],
  level: number,
): string | null {
  const index = roadIndexOf(net);
  const clearance = ROAD_LEVELS.clearance;
  // Every level but the road's own. A ramp with the road's level at one end
  // still has another level's bit, so it is kept.
  const others = LEVELS_ALL & ~(1 << level);
  // One query over the box round every piece, which on a city mostly on the
  // road's own level finds nothing, then each piece in order.
  const shapes = pieces.map(plannedQuad);
  const boxes = shapes.map(hullBox);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const b of boxes) {
    minX = b.minX < minX ? b.minX : minX;
    minZ = b.minZ < minZ ? b.minZ : minZ;
    maxX = b.maxX > maxX ? b.maxX : maxX;
    maxZ = b.maxZ > maxZ ? b.maxZ : maxZ;
  }
  if (pieces.length === 0) return null;
  const near = segmentsInBox(index, minX, minZ, maxX, maxZ, NETWORKS_ROAD, others).filter((seg) => !removed.includes(seg));
  if (near.length === 0) return null;
  for (let i = 0; i < pieces.length; i++) {
    const s = pieces[i] as PlannedSegment;
    const pieceLevel = levels[i] ?? level;
    const q = shapes[i] as Quad;
    let mine: LevelledShape | null = null;
    for (const seg of near) {
      const p = net.segA[seg] ?? NONE;
      const r = net.segB[seg] ?? NONE;
      const other = segmentQuad(net, seg);
      const shared = [s.a, s.b].filter((e) => e.key === p || e.key === r);
      if (s.control === null && isStraight(other)) {
        // The common case: two straight lines meet once at most.
        if (shared.length > 0) continue;
        if (!segmentsMeet(s.a.x, s.a.z, s.b.x, s.b.z, other.ax, other.az, other.bx, other.bz)) continue;
      }
      const met = quadMeetings(q, other);
      for (const m of met.at) {
        const at = quadPoint(other, m.u);
        if (shared.some((e) => samePlace(at.x, at.z, e.x, e.z))) continue;
        mine ??= plannedShape(net, terrain, type, s, pieceLevel);
        const gap = heightAlong(terrain, mine, m.t) - heightAlong(terrain, segmentShape(net, seg), m.u);
        if ((gap < 0 ? -gap : gap) >= clearance) continue;
        return clearanceReason(gap, net.segLevelA[seg] ?? LEVEL_GROUND, net.segLevelB[seg] ?? LEVEL_GROUND);
      }
      // Running along a road on another level is no crossing: they never meet.
    }
  }
  return null;
}

/** The levelled shape a planned piece would have once built at `level`. */
function plannedShape(net: RoadNetwork, terrain: Terrain, type: RoadType, s: PlannedSegment, level: number): LevelledShape {
  const q = plannedQuad(s);
  const h = (e: PlannedEnd): number => (e.node !== NONE ? (net.nodeHeight[e.node] ?? 0) : heightAt(terrain, e.x, e.z));
  return { q, levelA: level, levelB: level, hA: h(s.a), hB: h(s.b), length: quadLength(q), type: type.index };
}

function tooSteep(type: RoadType, steepest: number): string | null {
  if (steepest <= type.maxSlope) return null;
  return `Too steep: a ${percent(steepest)} grade, and the ${type.name.toLowerCase()} limit is ${percent(type.maxSlope)}`;
}

/**
 * The ground under a piece of road, checked at no more than
 * `groundSampleStep` apart: a reason if it crosses water or is too steep,
 * otherwise null. A curve is sampled at even steps of its parameter, enough
 * of them that even its fastest stretch, at an end, has samples close
 * enough, and each grade is over the distance between its two samples.
 */
export function groundProblem(terrain: Terrain, type: RoadType, q: Quad): string | null {
  const step = ROAD_BUILD.groundSampleStep;
  if (isStraight(q)) {
    const { ax, az, bx, bz } = q;
    const length = distance(ax, az, bx, bz);
    const steps = Math.ceil(length / step);
    const run = length / steps;
    let steepest = 0;
    let previous = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const h = heightAt(terrain, ax + (bx - ax) * t, az + (bz - az) * t);
      if (h <= terrain.waterLevel) return WATER;
      if (i > 0) {
        const grade = (h > previous ? h - previous : previous - h) / run;
        if (grade > steepest) steepest = grade;
      }
      previous = h;
    }
    return tooSteep(type, steepest);
  }
  // The speed along the curve is 2|(C - A) + t(A - 2C + B)|, largest at an end.
  const ea = distance(q.ax, q.az, q.cx, q.cz);
  const eb = distance(q.cx, q.cz, q.bx, q.bz);
  const steps = Math.ceil((2 * (ea > eb ? ea : eb)) / step);
  let steepest = 0;
  let previous = 0;
  let px = q.ax;
  let pz = q.az;
  for (let i = 0; i <= steps; i++) {
    const at = quadPoint(q, i / steps);
    const h = heightAt(terrain, at.x, at.z);
    if (h <= terrain.waterLevel) return WATER;
    if (i > 0) {
      const run = distance(px, pz, at.x, at.z);
      const grade = run > 0 ? (h > previous ? h - previous : previous - h) / run : 0;
      if (grade > steepest) steepest = grade;
    }
    previous = h;
    px = at.x;
    pz = at.z;
  }
  return tooSteep(type, steepest);
}

/** The segments a plan splits, each with its stops in order along it, by first stop and then id. */
function splitChains(stops: PlanStop[]): { seg: number; at: { stop: number; u: number }[] }[] {
  const chains: { seg: number; at: { stop: number; u: number }[] }[] = [];
  stops.forEach((stop, i) => {
    stop.splits.forEach((seg, k) => {
      let chain = chains.find((c) => c.seg === seg);
      if (!chain) {
        chain = { seg, at: [] };
        chains.push(chain);
      }
      chain.at.push({ stop: i, u: stop.splitAt[k] ?? 0 });
    });
  });
  for (const chain of chains) chain.at.sort((p, q) => p.u - q.u || p.stop - q.stop);
  return chains;
}

/** The whole new road as a curve from its first stop to its last. */
function roadQuad(stops: PlanStop[], control: BuildPoint | null): Quad {
  const a = stops[0] as PlanStop;
  const b = stops[stops.length - 1] as PlanStop;
  return control ? { ax: a.x, az: a.z, cx: control.x, cz: control.z, bx: b.x, bz: b.z } : straightQuad(a.x, a.z, b.x, b.z);
}

/** The control point of the new road's piece between stops `i - 1` and `i`, or null when straight. */
function pieceControl(stops: PlanStop[], control: BuildPoint | null, i: number): { x: number; z: number } | null {
  if (!control) return null;
  return subControl(roadQuad(stops, control), (stops[i - 1] as PlanStop).t, (stops[i] as PlanStop).t);
}

/**
 * Checks a road against the network and the ground. Returns the plan to
 * build it, or the reason it cannot be built in words a player reads.
 * Changes nothing.
 *
 * With a control point the road is one quadratic curve from its start
 * through that point to its end. Without one it is straight.
 *
 * The road becomes a chain of segments. It stops at every segment on its
 * layer that it crosses or touches, and that segment splits there and keeps
 * its type, network and level. An end on a segment's body makes a T-junction.
 */
export function planRoad(net: RoadNetwork, terrain: Terrain, payload: unknown): RoadPlanResult {
  const input = readPayload(payload);
  if (typeof input === "string") return { ok: false, reason: input };
  const type = ROAD_TYPES.find((t) => t.id === input.type);
  if (!type) return { ok: false, reason: `There is no road type "${input.type}"` };
  if (!type.buildable) return { ok: false, reason: `${type.name}s cannot be built yet` };

  const fx = snapToGrid(input.from.x);
  const fz = snapToGrid(input.from.z);
  const tx = snapToGrid(input.to.x);
  const tz = snapToGrid(input.to.z);
  if (!onMap(terrain, fx, fz) || !onMap(terrain, tx, tz)) return { ok: false, reason: "The road runs off the map" };

  // Too short as drawn, before either end moves to join something.
  if (distance(fx, fz, tx, tz) < ROAD_BUILD.minLength) return { ok: false, reason: SHORT_ROAD };
  const level = input.levelValue;
  const start = resolveEnd(net, fx, fz, 0, level);
  if (typeof start === "string") return { ok: false, reason: start };
  const end = resolveEnd(net, tx, tz, 1, level);
  if (typeof end === "string") return { ok: false, reason: end };
  if (distance(start.x, start.z, end.x, end.z) < ROAD_BUILD.minLength) return { ok: false, reason: SHORT_ROAD };
  if (start.node !== NONE && end.node !== NONE && joined(net, start.node, end.node)) {
    return { ok: false, reason: DUPLICATE };
  }

  // The curve between the ends as they joined. A control point on the line
  // between them, the midpoint included, makes a straight road.
  let control: BuildPoint | null = input.control ? { x: snapToGrid(input.control.x), z: snapToGrid(input.control.z) } : null;
  // A curve stays inside the triangle of its ends and its control point, so
  // a control point within one map width of the map is as far as any curve
  // on the map needs. This also refuses one so large that the arithmetic
  // below overflows.
  if (control) {
    const size = mapSize(terrain);
    if (!(control.x >= -size && control.x <= 2 * size && control.z >= -size && control.z <= 2 * size)) {
      return { ok: false, reason: "The road runs off the map" };
    }
  }
  let road = roadQuad([start, end], control);
  if (control) {
    const radius = minRadius(road);
    if (radius === Infinity) {
      control = null;
      road = roadQuad([start, end], null);
    } else {
      if (radius < type.minCurveRadius) return { ok: false, reason: TIGHT(type, radius) };
      const box = curveBox(road);
      if (!onMap(terrain, box.minX, box.minZ) || !onMap(terrain, box.maxX, box.maxZ)) {
        return { ok: false, reason: "The road runs off the map" };
      }
    }
  }
  const curved = control !== null;

  const middle = crossings(net, start, end, road, curved, level);
  if (typeof middle === "string") return { ok: false, reason: middle };
  const bridged = placeBridges(terrain, type, orderStops(start, end, middle, curved), control, level);
  if (typeof bridged === "string") return { ok: false, reason: bridged };
  const { stops, levels } = bridged;
  // A fixed node or segment, as at an outside connection, never gains a road.
  for (const s of stops) {
    if (s.node !== NONE && ((net.nodeFlags[s.node] ?? 0) & NODE_FIXED) !== 0) return { ok: false, reason: AT_CONNECTION };
    for (const seg of s.splits) if (((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0) return { ok: false, reason: AT_CONNECTION };
  }

  // A segment split at its own end runs along the road. So does a straight
  // one split twice by a straight road. A curve can meet a segment twice,
  // but not twice at one stop or at one point.
  const chains = splitChains(stops);
  const removed = chains.map((c) => c.seg);
  for (const s of stops) {
    for (const seg of s.splits) if (s.node === net.segA[seg] || s.node === net.segB[seg]) return { ok: false, reason: ALONG };
  }
  for (const { seg, at } of chains) {
    if (at.length < 2) continue;
    if (!curved && isStraight(segmentQuad(net, seg))) return { ok: false, reason: ALONG };
    for (let k = 1; k < at.length; k++) {
      const p = at[k - 1] as { stop: number; u: number };
      const q = at[k] as { stop: number; u: number };
      if (p.stop === q.stop || p.u === q.u) return { ok: false, reason: ALONG };
    }
  }

  const pieces: PlannedSegment[] = [];
  const planned: PlannedSegment[] = [];
  const crossingKeys: number[] = [];
  let length = 0;
  let groundLength = 0;
  let bridgeLength = 0;
  for (let i = 0; i < stops.length; i++) {
    const here = stopEnd(stops, i);
    if (i > 0) {
      const back = stopEnd(stops, i - 1);
      const piece: PlannedSegment = { a: back, b: here, control: pieceControl(stops, control, i) };
      const pieceLength = piece.control ? quadLength(plannedQuad(piece)) : distance(back.x, back.z, here.x, here.z);
      if (pieceLength < ROAD_BUILD.minLength) return { ok: false, reason: stops.length === 2 ? SHORT_ROAD : SHORT_PIECE };
      if (back.node !== NONE && here.node !== NONE && joined(net, back.node, here.node)) {
        return { ok: false, reason: stops.length === 2 ? DUPLICATE : ALONG };
      }
      length += pieceLength;
      if (levels[i - 1] === LEVEL_BRIDGE) {
        if (pieceLength > type.bridge.maxLength) return { ok: false, reason: bridgeTooLong(type, pieceLength) };
        bridgeLength += pieceLength;
      } else groundLength += pieceLength;
      pieces.push(piece);
    }
    const splits = stops[i]?.splits ?? [];
    if (splits.length > 0) crossingKeys.push(here.key);
    // Each split segment's pieces, at the first stop that splits it.
    for (const { seg, at } of chains) {
      if ((at[0] as { stop: number }).stop !== i) continue;
      for (const piece of splitPieces(net, stops, seg, at)) {
        const pieceLength = piece.control ? quadLength(plannedQuad(piece)) : distance(piece.a.x, piece.a.z, piece.b.x, piece.b.z);
        if (pieceLength < ROAD_BUILD.minLength) return { ok: false, reason: SHORT_PIECE };
        planned.push(piece);
      }
    }
  }
  planned.push(...pieces);

  const angle = angleProblem(net, planned, removed, crossingKeys);
  if (angle !== null) return { ok: false, reason: angle };
  if (tangled(net, planned, removed, level)) return { ok: false, reason: TANGLED };
  const passing = levelProblem(net, terrain, type, pieces, levels, removed, level);
  if (passing !== null) return { ok: false, reason: passing };
  // Only the new road's ground is checked. A split piece follows the line of
  // the segment it came from to within a few metres, and that was checked
  // when it was built. A bridge's ramps were checked when its banks were
  // placed.
  for (let i = 0; i < pieces.length; i++) {
    if (levels[i] === LEVEL_BRIDGE) continue;
    const ground = groundProblem(terrain, type, plannedQuad(pieces[i] as PlannedSegment));
    if (ground !== null) return { ok: false, reason: ground };
  }
  const price = type.buildCostPerMetre;
  const cost = Math.round(groundLength * price + bridgeLength * price * type.bridge.costMultiplier);
  return { ok: true, plan: { type, control, stops, levels, level, length, bridgeLength, cost } };
}

/**
 * The pieces segment `seg` splits into at its stops, from node A to node B.
 * A curved segment's pieces each take the control point of their part of
 * the curve, so together they trace it.
 */
function splitPieces(net: RoadNetwork, stops: PlanStop[], seg: number, at: { stop: number; u: number }[]): PlannedSegment[] {
  const shape = segmentQuad(net, seg);
  const straight = isStraight(shape);
  const ends = [nodeEnd(net, net.segA[seg] ?? NONE), ...at.map((s) => stopEnd(stops, s.stop)), nodeEnd(net, net.segB[seg] ?? NONE)];
  const params = [0, ...at.map((s) => s.u), 1];
  const out: PlannedSegment[] = [];
  for (let k = 1; k < ends.length; k++) {
    out.push({
      a: ends[k - 1] as PlannedEnd,
      b: ends[k] as PlannedEnd,
      control: straight ? null : subControl(shape, params[k - 1] ?? 0, params[k] ?? 1),
    });
  }
  return out;
}

/**
 * Builds a plan from `planRoad` and returns the new road's segment ids from
 * start to end.
 *
 * Ids are handed out in a fixed order, so every machine that applies the
 * plan makes the same ones. First a node for each new stop, from start to
 * end. Then each split segment, in the order of the first stop that splits
 * it and by ascending id within a stop: the segment is removed and its
 * pieces added from its node A to its node B, so the first takes back the id
 * the removal freed. Then the pieces of the new road from start to end,
 * each at its level, so the ones over water are bridges.
 */
export function buildRoad(net: RoadNetwork, terrain: Terrain, plan: RoadPlan): number[] {
  const nodes = plan.stops.map((s) => (s.node !== NONE ? s.node : addNode(net, s.x, s.z, heightAt(terrain, s.x, s.z))));
  for (const { seg, at } of splitChains(plan.stops)) {
    const shape = segmentQuad(net, seg);
    const straight = isStraight(shape);
    const ends = [net.segA[seg] ?? NONE, ...at.map((s) => nodes[s.stop] ?? NONE), net.segB[seg] ?? NONE];
    const params = [0, ...at.map((s) => s.u), 1];
    const base = {
      type: net.segType[seg] ?? 0,
      network: net.segNetwork[seg] ?? 0,
      level: net.segLevelA[seg] ?? 0,
      levelB: net.segLevelB[seg] ?? 0,
      fixed: ((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0,
    };
    removeSegment(net, seg);
    for (let k = 1; k < ends.length; k++) {
      const c = straight ? null : subControl(shape, params[k - 1] ?? 0, params[k] ?? 1);
      addSegment(net, ends[k - 1] ?? NONE, ends[k] ?? NONE, c ? { ...base, cx: c.x, cz: c.z } : base);
    }
  }
  const road: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const c = pieceControl(plan.stops, plan.control, i);
    const spec = { type: plan.type.index, network: NEW_NETWORK, level: plan.levels[i - 1] ?? plan.level };
    road.push(addSegment(net, nodes[i - 1] ?? NONE, nodes[i] ?? NONE, c ? { ...spec, cx: c.x, cz: c.z } : spec));
  }
  return road;
}
