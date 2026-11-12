// BuildRoad: a straight road between two points.
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
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  nextSegmentAt,
  otherEnd,
  type RoadNetwork,
} from "./network";
import { NETWORKS_ALL, NETWORKS_ROAD, nearestNode, roadIndexOf, segmentsInBox } from "./spatial";
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

/** A road that passed every check, ready to build. */
export interface RoadPlan {
  type: RoadType;
  /** Each end on the build grid, or at the node it joins. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** The node each end joins, or NONE for a new one. */
  nodeA: number;
  nodeB: number;
  /** Plan length in metres. */
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

/** Whether a live segment already joins nodes `a` and `b`, either way round. */
function joined(net: RoadNetwork, a: number, b: number): boolean {
  for (let seg = net.nodeFirstSeg[a] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, a)) {
    if (otherEnd(net, seg, a) === b) return true;
  }
  return false;
}

/**
 * Whether a new segment leaving `node` toward (tx, tz) makes too sharp an
 * angle with a segment already there. An existing segment leaves the node
 * toward its control point, which for a straight one is its midpoint and for
 * a curve is the tangent.
 */
function tooSharpAt(net: RoadNetwork, node: number, tx: number, tz: number): boolean {
  const nx = net.nodeX[node] ?? 0;
  const nz = net.nodeZ[node] ?? 0;
  const dx = tx - nx;
  const dz = tz - nz;
  const d2 = dx * dx + dz * dz;
  for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
    const ex = (net.segCX[seg] ?? 0) - nx;
    const ez = (net.segCZ[seg] ?? 0) - nz;
    const dot = dx * ex + dz * ez;
    if (dot > MIN_ANGLE_COS * Math.sqrt(d2 * (ex * ex + ez * ez))) return true;
  }
  return false;
}

/** Whether the new road meets a segment that does not share one of its nodes. */
function crossesRoad(net: RoadNetwork, plan: Omit<RoadPlan, "length" | "cost">): boolean {
  const { ax, az, bx, bz, nodeA, nodeB } = plan;
  const index = roadIndexOf(net);
  const found = segmentsInBox(index, ax < bx ? ax : bx, az < bz ? az : bz, ax > bx ? ax : bx, az > bz ? az : bz, NETWORKS_ALL);
  for (const seg of found) {
    const a = net.segA[seg] ?? NONE;
    const b = net.segB[seg] ?? NONE;
    // A segment at a shared node meets the new road there by design. If it
    // also runs along it, the angle check has already refused the road.
    if (a === nodeA || a === nodeB || b === nodeA || b === nodeB) continue;
    const met = segmentsMeet(
      ax,
      az,
      bx,
      bz,
      net.nodeX[a] ?? 0,
      net.nodeZ[a] ?? 0,
      net.nodeX[b] ?? 0,
      net.nodeZ[b] ?? 0,
    );
    if (met) return true;
  }
  return false;
}

/** As a whole percentage, for a reason a player reads. */
function percent(grade: number): string {
  return `${Math.round(grade * 100)}%`;
}

/**
 * The ground under the road, checked at no more than `groundSampleStep`
 * apart: a reason if it crosses water or is too steep, otherwise null.
 */
function groundProblem(terrain: Terrain, type: RoadType, plan: Omit<RoadPlan, "cost">): string | null {
  const { ax, az, bx, bz, length } = plan;
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
 */
export function planStraightRoad(net: RoadNetwork, terrain: Terrain, payload: unknown): RoadPlanResult {
  const input = readPayload(payload);
  if (typeof input === "string") return { ok: false, reason: input };
  const type = ROAD_TYPES.find((t) => t.id === input.type);
  if (!type) return { ok: false, reason: `There is no road type "${input.type}"` };
  if (!type.buildable) return { ok: false, reason: `${type.name}s cannot be built yet` };

  let ax = snapToGrid(input.from.x);
  let az = snapToGrid(input.from.z);
  let bx = snapToGrid(input.to.x);
  let bz = snapToGrid(input.to.z);
  if (!onMap(terrain, ax, az) || !onMap(terrain, bx, bz)) return { ok: false, reason: "The road runs off the map" };

  const index = roadIndexOf(net);
  const radius = ROAD_BUILD.mergeDistance;
  const nodeA = nearestNode(index, ax, az, radius, NETWORKS_ROAD)?.node ?? NONE;
  const nodeB = nearestNode(index, bx, bz, radius, NETWORKS_ROAD)?.node ?? NONE;
  if (nodeA !== NONE) {
    ax = net.nodeX[nodeA] ?? 0;
    az = net.nodeZ[nodeA] ?? 0;
  }
  if (nodeB !== NONE) {
    bx = net.nodeX[nodeB] ?? 0;
    bz = net.nodeZ[nodeB] ?? 0;
  }

  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (length < ROAD_BUILD.minLength) {
    return { ok: false, reason: `Too short: a road must be at least ${ROAD_BUILD.minLength} m long` };
  }
  if (nodeA !== NONE && nodeB !== NONE && joined(net, nodeA, nodeB)) {
    return { ok: false, reason: "A road already joins these two points" };
  }
  if ((nodeA !== NONE && tooSharpAt(net, nodeA, bx, bz)) || (nodeB !== NONE && tooSharpAt(net, nodeB, ax, az))) {
    return {
      ok: false,
      reason: `The angle with the road it joins is too sharp: it must be at least ${ROAD_BUILD.minAngleDegrees} degrees`,
    };
  }
  const placed = { type, ax, az, bx, bz, nodeA, nodeB, length };
  if (crossesRoad(net, placed)) {
    return { ok: false, reason: "The road crosses another road, and intersections are not available yet" };
  }
  const ground = groundProblem(terrain, type, placed);
  if (ground !== null) return { ok: false, reason: ground };
  return { ok: true, plan: { ...placed, cost: Math.round(length * type.buildCostPerMetre) } };
}

/** Builds a plan from `planStraightRoad`: new nodes on the ground, then the segment. Returns the segment id. */
export function buildRoad(net: RoadNetwork, terrain: Terrain, plan: RoadPlan): number {
  const a = plan.nodeA !== NONE ? plan.nodeA : addNode(net, plan.ax, plan.az, heightAt(terrain, plan.ax, plan.az));
  const b = plan.nodeB !== NONE ? plan.nodeB : addNode(net, plan.bx, plan.bz, heightAt(terrain, plan.bx, plan.bz));
  return addSegment(net, a, b, { type: plan.type.index, network: NETWORK_ROAD });
}
