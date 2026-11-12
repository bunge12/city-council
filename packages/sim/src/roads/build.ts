// BuildRoad: a straight road between two points, split into a chain of
// segments wherever it crosses or meets another road (issue 04).
//
// Positions are rounded to the build grid first, so two points are either
// the same node or apart, with no tolerance in later comparisons. An end
// within the merge distance of an existing road node joins that node.
//
// A road follows the ground (PRD, "How a road meets the ground"). Its nodes
// take the terrain height, and the slope check samples the ground along the
// path at no more than `groundSampleStep` metres and refuses a road whose
// grade between two samples passes its type's limit.
//
// Checks feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Lint enforces it in this folder.

import { ROAD_BUILD, ROAD_TYPES, type RoadType } from "./balance";
import {
  LEVEL_GROUND,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  nextSegmentAt,
  otherEnd,
  removeSegment,
  type RoadNetwork,
} from "./network";
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
  /** Existing segments that split here, ascending. Each becomes two pieces that meet at this stop. */
  splits: number[];
}

/** A road that passed every check, ready to build. */
export interface RoadPlan {
  type: RoadType;
  /** From the start to the end, in order along the road. At least two. */
  stops: PlanStop[];
  /** Plan length of the new road in metres, every piece added up. */
  length: number;
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

function readPayload(payload: unknown): BuildRoadPayload | string {
  if (typeof payload !== "object" || payload === null) return "BuildRoad needs a start, an end and a road type";
  const p = payload as Record<string, unknown>;
  if (!isPoint(p["from"]) || !isPoint(p["to"])) return "BuildRoad needs a start and an end, each with a finite x and z";
  if (typeof p["type"] !== "string") return "BuildRoad needs a road type";
  return { from: p["from"], to: p["to"], type: p["type"] };
}

function onMap(terrain: Terrain, x: number, z: number): boolean {
  const size = mapSize(terrain);
  return x >= 0 && x <= size && z >= 0 && z <= size;
}

/** Twice the signed area of triangle p, q, r. Its sign says which side of pq r is on. */
function orient(px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number {
  return (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
}

/** Whether r, known to be on the line through p and q, lies between them. */
function within(px: number, pz: number, qx: number, qz: number, rx: number, rz: number): boolean {
  return (
    (px < qx ? px : qx) <= rx && rx <= (px > qx ? px : qx) && (pz < qz ? pz : qz) <= rz && rz <= (pz > qz ? pz : qz)
  );
}

/** Whether straight segments pq and rs meet anywhere, ends included. */
export function segmentsMeet(
  px: number,
  pz: number,
  qx: number,
  qz: number,
  rx: number,
  rz: number,
  sx: number,
  sz: number,
): boolean {
  const d1 = orient(rx, rz, sx, sz, px, pz);
  const d2 = orient(rx, rz, sx, sz, qx, qz);
  const d3 = orient(px, pz, qx, qz, rx, rz);
  const d4 = orient(px, pz, qx, qz, sx, sz);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && within(rx, rz, sx, sz, px, pz)) return true;
  if (d2 === 0 && within(rx, rz, sx, sz, qx, qz)) return true;
  if (d3 === 0 && within(px, pz, qx, qz, rx, rz)) return true;
  if (d4 === 0 && within(px, pz, qx, qz, sx, sz)) return true;
  return false;
}

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

// What the new road is built as. M1 builds ground roads only; bridges are
// issue 11. Only segments on the same network and level split each other.
const NEW_NETWORK = NETWORK_ROAD;
const NEW_LEVEL = LEVEL_GROUND;

const SHORT_ROAD = `Too short: a road must be at least ${ROAD_BUILD.minLength} m long`;
const SHORT_PIECE = `Too close to a junction: every piece of road between junctions must be at least ${ROAD_BUILD.minLength} m long`;
const DUPLICATE = "A road already joins these two points";
const ALONG = "The road runs along another road";
const SHARP = `The angle with the road it joins is too sharp: it must be at least ${ROAD_BUILD.minAngleDegrees} degrees`;
const SHALLOW = `The road crosses another road at too shallow an angle: it must be at least ${ROAD_BUILD.minAngleDegrees} degrees`;
const TANGLED = "The road passes too close to another junction to join it cleanly";

/** Whether a segment is on the layer the new road is built on, and so can split or be split. */
function onNewLayer(net: RoadNetwork, seg: number): boolean {
  return net.segNetwork[seg] === NEW_NETWORK && net.segLevel[seg] === NEW_LEVEL;
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

/**
 * Where segment `seg` would split at grid point (x, z). A split that leaves
 * a piece shorter than the minimum length moves to that end's node if it is
 * within the merge distance, and the stop is the node with no split.
 * Otherwise it is refused.
 */
function splitStop(net: RoadNetwork, seg: number, x: number, z: number): PlanStop | string {
  const p = net.segA[seg] ?? NONE;
  const q = net.segB[seg] ?? NONE;
  const dp = distance(x, z, net.nodeX[p] ?? 0, net.nodeZ[p] ?? 0);
  const dq = distance(x, z, net.nodeX[q] ?? 0, net.nodeZ[q] ?? 0);
  if (dp >= ROAD_BUILD.minLength && dq >= ROAD_BUILD.minLength) return { x, z, node: NONE, splits: [seg] };
  const node = dp <= dq ? p : q;
  if ((dp <= dq ? dp : dq) > ROAD_BUILD.mergeDistance) return SHORT_PIECE;
  return { x: net.nodeX[node] ?? 0, z: net.nodeZ[node] ?? 0, node, splits: [] };
}

/**
 * The end of a new road at grid point (x, z). It joins a road node within
 * the merge distance. Failing that, it joins the nearest segment body within
 * the merge distance, which splits there into a T-junction. Otherwise it is
 * a new node.
 */
function resolveEnd(net: RoadNetwork, x: number, z: number): PlanStop | string {
  const index = roadIndexOf(net);
  const radius = ROAD_BUILD.mergeDistance;
  const near = nearestNode(index, x, z, radius, NETWORKS_ROAD);
  if (near) return { x: net.nodeX[near.node] ?? 0, z: net.nodeZ[near.node] ?? 0, node: near.node, splits: [] };

  // The nearest point on a segment body, as `nearestPointOnSegment` finds it
  // but only on the new road's layer. Ties go to the lower id.
  let best = NONE;
  let bestD2 = radius * radius;
  let bestX = 0;
  let bestZ = 0;
  for (const seg of segmentsInBox(index, x - radius, z - radius, x + radius, z + radius, NETWORKS_ROAD)) {
    if (!onNewLayer(net, seg)) continue;
    const a = net.segA[seg] ?? NONE;
    const b = net.segB[seg] ?? NONE;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const sx = (net.nodeX[b] ?? 0) - ax;
    const sz = (net.nodeZ[b] ?? 0) - az;
    const len2 = sx * sx + sz * sz;
    let t = len2 > 0 ? ((x - ax) * sx + (z - az) * sz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * sx;
    const pz = az + t * sz;
    const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d2 > bestD2 || (d2 === bestD2 && best !== NONE)) continue;
    best = seg;
    bestD2 = d2;
    bestX = px;
    bestZ = pz;
  }
  if (best === NONE) return { x, z, node: NONE, splits: [] };
  return splitStop(net, best, snapToGrid(bestX), snapToGrid(bestZ));
}

/**
 * The junctions between the two ends, in no particular order: one for each
 * segment the straight line from `start` to `end` crosses or touches, on the
 * new road's layer. A crossing within the minimum length of an end of the new
 * road joins that end if it is within the merge distance, and is refused
 * otherwise. Adds those splits to the end stops.
 */
function crossings(net: RoadNetwork, start: PlanStop, end: PlanStop): PlanStop[] | string {
  const { x: ax, z: az } = start;
  const { x: bx, z: bz } = end;
  const found = segmentsInBox(
    roadIndexOf(net),
    ax < bx ? ax : bx,
    az < bz ? az : bz,
    ax > bx ? ax : bx,
    az > bz ? az : bz,
    NETWORKS_ROAD,
  );
  const stops: PlanStop[] = [];
  for (const seg of found) {
    if (!onNewLayer(net, seg) || start.splits.includes(seg) || end.splits.includes(seg)) continue;
    const p = net.segA[seg] ?? NONE;
    const q = net.segB[seg] ?? NONE;
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
    const stop = splitStop(net, seg, at.x, at.z);
    if (typeof stop === "string") return stop;
    if (stop.node === NONE) {
      const ds = distance(at.x, at.z, ax, az);
      const de = distance(at.x, at.z, bx, bz);
      if (ds < ROAD_BUILD.minLength || de < ROAD_BUILD.minLength) {
        if ((ds <= de ? ds : de) > ROAD_BUILD.mergeDistance) return SHORT_PIECE;
        (ds <= de ? start : end).splits.push(seg);
        continue;
      }
    }
    stops.push(stop);
  }
  return stops;
}

/**
 * The stops from `start` to `end` in order along the road. Junctions at the
 * same existing node, or at the same new point, become one stop.
 */
function orderStops(start: PlanStop, end: PlanStop, middle: PlanStop[]): PlanStop[] {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const along = (s: PlanStop): number => (s.x - start.x) * dx + (s.z - start.z) * dz;
  const sorted = [...middle].sort((p, q) => along(p) - along(q) || p.x - q.x || p.z - q.z || p.node - q.node);
  const out: PlanStop[] = [start];
  for (const stop of sorted) {
    const same = out.find((s) => (stop.node !== NONE ? s.node === stop.node : s.node === NONE && s.x === stop.x && s.z === stop.z));
    if (same) same.splits.push(...stop.splits);
    else out.push(stop);
  }
  const last = out.find((s) => end.node !== NONE && s.node === end.node);
  if (last && last !== start) {
    // A junction at the end node: the road ends there anyway.
    end.splits.push(...last.splits);
    out.splice(out.indexOf(last), 1);
  }
  out.push(end);
  for (const stop of out) stop.splits.sort((p, q) => p - q);
  return out;
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
}

function stopEnd(stops: PlanStop[], i: number): PlannedEnd {
  const s = stops[i] as PlanStop;
  return { key: s.node !== NONE ? s.node : -2 - i, node: s.node, x: s.x, z: s.z };
}

function nodeEnd(net: RoadNetwork, node: number): PlannedEnd {
  return { key: node, node, x: net.nodeX[node] ?? 0, z: net.nodeZ[node] ?? 0 };
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
 * ones included. An existing segment leaves a node toward its control
 * point, which for a straight one is its midpoint and for a curve is the
 * tangent.
 */
function angleProblem(net: RoadNetwork, planned: PlannedSegment[], removed: number[], crossingKeys: number[]): string | null {
  const keys = [...new Set(planned.flatMap((s) => [s.a.key, s.b.key]))];
  for (const key of keys) {
    const here = planned.find((s) => s.a.key === key)?.a ?? planned.find((s) => s.b.key === key)?.b;
    if (!here) continue;
    const fresh: [number, number][] = [];
    for (const s of planned) {
      if (s.a.key === key) fresh.push([s.b.x - here.x, s.b.z - here.z]);
      if (s.b.key === key) fresh.push([s.a.x - here.x, s.a.z - here.z]);
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
 * did not run into something else.
 */
function tangled(net: RoadNetwork, planned: PlannedSegment[], removed: number[]): boolean {
  const index = roadIndexOf(net);
  for (let i = 0; i < planned.length; i++) {
    const { a, b } = planned[i] as PlannedSegment;
    const near = segmentsInBox(
      index,
      a.x < b.x ? a.x : b.x,
      a.z < b.z ? a.z : b.z,
      a.x > b.x ? a.x : b.x,
      a.z > b.z ? a.z : b.z,
      NETWORKS_ROAD,
    );
    for (const seg of near) {
      if (!onNewLayer(net, seg) || removed.includes(seg)) continue;
      const p = net.segA[seg] ?? NONE;
      const q = net.segB[seg] ?? NONE;
      if (p === a.key || p === b.key || q === a.key || q === b.key) continue;
      const met = segmentsMeet(
        a.x,
        a.z,
        b.x,
        b.z,
        net.nodeX[p] ?? 0,
        net.nodeZ[p] ?? 0,
        net.nodeX[q] ?? 0,
        net.nodeZ[q] ?? 0,
      );
      if (met) return true;
    }
    for (let j = i + 1; j < planned.length; j++) {
      const { a: c, b: d } = planned[j] as PlannedSegment;
      if (c.key === a.key || c.key === b.key || d.key === a.key || d.key === b.key) continue;
      if (segmentsMeet(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) return true;
    }
  }
  return false;
}

/** As a whole percentage, for a reason a player reads. */
function percent(grade: number): string {
  return `${Math.round(grade * 100)}%`;
}

/**
 * The ground under a straight piece of road, checked at no more than
 * `groundSampleStep` apart: a reason if it crosses water or is too steep,
 * otherwise null.
 */
function groundProblem(terrain: Terrain, type: RoadType, ax: number, az: number, bx: number, bz: number): string | null {
  const length = distance(ax, az, bx, bz);
  const steps = Math.ceil(length / ROAD_BUILD.groundSampleStep);
  const run = length / steps;
  let steepest = 0;
  let previous = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const h = heightAt(terrain, ax + (bx - ax) * t, az + (bz - az) * t);
    if (h <= terrain.waterLevel) return "The road crosses water, and bridges are not available yet";
    if (i > 0) {
      const grade = (h > previous ? h - previous : previous - h) / run;
      if (grade > steepest) steepest = grade;
    }
    previous = h;
  }
  if (steepest > type.maxSlope) {
    return `Too steep: a ${percent(steepest)} grade, and the ${type.name.toLowerCase()} limit is ${percent(type.maxSlope)}`;
  }
  return null;
}

/**
 * Checks a straight road against the network and the ground. Returns the
 * plan to build it, or the reason it cannot be built in words a player reads.
 * Changes nothing.
 *
 * The road becomes a chain of segments. It stops at every segment on its
 * layer that it crosses or touches, and that segment splits there and keeps
 * its type, network and level. An end on a segment's body makes a T-junction.
 */
export function planStraightRoad(net: RoadNetwork, terrain: Terrain, payload: unknown): RoadPlanResult {
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
  const start = resolveEnd(net, fx, fz);
  if (typeof start === "string") return { ok: false, reason: start };
  const end = resolveEnd(net, tx, tz);
  if (typeof end === "string") return { ok: false, reason: end };
  if (distance(start.x, start.z, end.x, end.z) < ROAD_BUILD.minLength) return { ok: false, reason: SHORT_ROAD };
  if (start.node !== NONE && end.node !== NONE && joined(net, start.node, end.node)) {
    return { ok: false, reason: DUPLICATE };
  }

  const middle = crossings(net, start, end);
  if (typeof middle === "string") return { ok: false, reason: middle };
  const stops = orderStops(start, end, middle);

  // A segment split twice, or split at its own end, runs along the road.
  const removed = stops.flatMap((s) => s.splits);
  if (new Set(removed).size !== removed.length) return { ok: false, reason: ALONG };
  for (const s of stops) {
    for (const seg of s.splits) if (s.node === net.segA[seg] || s.node === net.segB[seg]) return { ok: false, reason: ALONG };
  }

  const pieces: PlannedSegment[] = [];
  const planned: PlannedSegment[] = [];
  const crossingKeys: number[] = [];
  let length = 0;
  for (let i = 0; i < stops.length; i++) {
    const here = stopEnd(stops, i);
    if (i > 0) {
      const back = stopEnd(stops, i - 1);
      const piece = distance(back.x, back.z, here.x, here.z);
      if (piece < ROAD_BUILD.minLength) return { ok: false, reason: stops.length === 2 ? SHORT_ROAD : SHORT_PIECE };
      if (back.node !== NONE && here.node !== NONE && joined(net, back.node, here.node)) {
        return { ok: false, reason: stops.length === 2 ? DUPLICATE : ALONG };
      }
      length += piece;
      pieces.push({ a: back, b: here });
    }
    const splits = stops[i]?.splits ?? [];
    if (splits.length > 0) crossingKeys.push(here.key);
    for (const seg of splits) {
      const p = nodeEnd(net, net.segA[seg] ?? NONE);
      const q = nodeEnd(net, net.segB[seg] ?? NONE);
      if (distance(p.x, p.z, here.x, here.z) < ROAD_BUILD.minLength || distance(here.x, here.z, q.x, q.z) < ROAD_BUILD.minLength) {
        return { ok: false, reason: SHORT_PIECE };
      }
      planned.push({ a: p, b: here }, { a: here, b: q });
    }
  }
  planned.push(...pieces);

  const angle = angleProblem(net, planned, removed, crossingKeys);
  if (angle !== null) return { ok: false, reason: angle };
  if (tangled(net, planned, removed)) return { ok: false, reason: TANGLED };
  // Only the new road's ground is checked. A split piece follows the line of
  // the segment it came from to within a few metres, and that was checked
  // when it was built.
  for (const { a, b } of pieces) {
    const ground = groundProblem(terrain, type, a.x, a.z, b.x, b.z);
    if (ground !== null) return { ok: false, reason: ground };
  }
  return { ok: true, plan: { type, stops, length, cost: Math.round(length * type.buildCostPerMetre) } };
}

/**
 * Builds a plan from `planStraightRoad` and returns the new road's segment
 * ids from start to end.
 *
 * Ids are handed out in a fixed order, so every machine that applies the
 * plan makes the same ones. First a node for each new stop, from start to
 * end. Then each split, stop by stop and by ascending segment id within a
 * stop: the segment is removed and its two pieces added, the piece at its
 * node A first, which takes back the id the removal freed. Then the pieces
 * of the new road from start to end.
 */
export function buildRoad(net: RoadNetwork, terrain: Terrain, plan: RoadPlan): number[] {
  const nodes = plan.stops.map((s) => (s.node !== NONE ? s.node : addNode(net, s.x, s.z, heightAt(terrain, s.x, s.z))));
  plan.stops.forEach((stop, i) => {
    const k = nodes[i] ?? NONE;
    for (const seg of stop.splits) {
      const p = net.segA[seg] ?? NONE;
      const q = net.segB[seg] ?? NONE;
      // Straight segments only until curves land (issue 09).
      const spec = { type: net.segType[seg] ?? 0, network: net.segNetwork[seg] ?? 0, level: net.segLevel[seg] ?? 0 };
      removeSegment(net, seg);
      addSegment(net, p, k, spec);
      addSegment(net, k, q, spec);
    }
  });
  const road: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    road.push(addSegment(net, nodes[i - 1] ?? NONE, nodes[i] ?? NONE, { type: plan.type.index, network: NEW_NETWORK, level: NEW_LEVEL }));
  }
  return road;
}
