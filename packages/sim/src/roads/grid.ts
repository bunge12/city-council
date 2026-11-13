// BuildRoadGrid (issue 20): a whole street grid as one command, with one
// validation, one log entry and one undo.
//
// The command carries three corners of a rectangle on the build grid, the
// block size and a road type. The client works out the rectangle's angle,
// so the sim needs no trigonometry: every lattice point is the origin plus
// a share of each side, which is only add, multiply and divide.
//
// Streets run along both sides at the block spacing, measured between road
// edges, so their centre lines are a block plus a road width apart. The last
// block along a side takes what is left. Less than `gridMinBlockShare` of a
// block, it joins its neighbour.
//
// Each street is cut into links between the points where it meets the
// grid's other streets. A link on water or on a slope too steep for the type
// is dropped, and a short stub reaches from the last junction toward the
// water, stopping at least the minimum length short of the next street. So
// every street of the grid ends at a lattice point or well clear of one, and
// streets only meet at lattice points. A link that lies along an existing
// road is left out, so a grid started on a road joins it.
//
// The grid is built one link at a time through the BuildRoad path
// (`planRoad` then `buildRoad`): first the streets along the origin to
// `along` side, from the origin out, then the ones across. Each link joins
// the node the link before it made, so the junctions come out exact and new
// ids come out in a set order. Every link must pass: anything that refuses
// one, other than the ground cuts made here, refuses the whole grid.
//
// Checks feed command validation, so only exact arithmetic (CLAUDE.md
// rule 6). Lint enforces it in this folder.

import { ROAD_BUILD, ROAD_TYPES, type RoadType } from "./balance";
import { buildRoad, cosDegrees, groundProblem, planRoad, snapToGrid, type BuildPoint } from "./build";
import { isStraight, nearestOnQuad, segmentQuad, straightQuad, type Quad } from "./curve";
import { LEVEL_GROUND, NETWORK_ROAD, endJournal, reverseOps, segmentAtLevel, startJournal, type RoadNetwork } from "./network";
import { NETWORKS_ROAD, nearestNode, roadIndexOf, segmentsInBox } from "./spatial";
import { heightAt, mapSize, type Terrain } from "../terrain/terrain";

/** What a BuildRoadGrid command carries besides the player id. */
export interface BuildRoadGridPayload {
  /** The corner the grid is laid out from. Leftover blocks end up on the far sides. */
  origin: BuildPoint;
  /** The corner along one side from the origin. */
  along: BuildPoint;
  /** The corner along the other side from the origin. */
  across: BuildPoint;
  /** Metres between road edges from one street to the next along the origin to `across` side. */
  depth: number;
  /** Metres between road edges from one street to the next along the origin to `along` side. */
  width: number;
  /** A road type id from the balance file, such as "street". */
  type: string;
}

/** One straight street of a planned grid, as it will be built. */
export interface GridStreet {
  /**
   * Its points in order, on the build grid: its two ends and each junction
   * with the grid's other streets between them. Each pair in turn is built
   * as one BuildRoad.
   */
  points: BuildPoint[];
  /** 0 runs parallel to the origin to `along` side, 1 parallel to the origin to `across` side. */
  axis: 0 | 1;
  /** Whether it stops at its first point because of water or steep ground. */
  cutStart: boolean;
  /** Whether it stops at its last point because of water or steep ground. */
  cutEnd: boolean;
}

/** A grid that passed its own checks, ready to rehearse and build. */
export interface GridPlan {
  type: RoadType;
  /** In the order they are built. Streets parallel to the origin to `along` side come first. */
  streets: GridStreet[];
  /** Grid lines, the count held to `gridMaxStreets`. */
  lines: number;
  /** Plan length of every street added up, metres. */
  length: number;
  /** Whole 2026 dollars. Not charged until the treasury arrives in M4. */
  cost: number;
}

export type GridPlanResult = { ok: true; plan: GridPlan } | { ok: false; reason: string };

/** Why a grid that passed `planRoadGrid` cannot be built, and the street it came from. */
export interface GridProblem {
  /** Index into `GridPlan.streets`. */
  street: number;
  reason: string;
}

const MAX_STREETS = ROAD_BUILD.gridMaxStreets;
// Sides closer to square than this count as square. The corners are on the
// build grid, so a rectangle the client turned to any angle is a hair off.
const SQUARE_COS = cosDegrees(89);
// A link counts as along an existing road where every sample this far apart
// is within the merge distance of one that runs within the minimum angle.
const COVER_STEP = ROAD_BUILD.mergeDistance / 2;
const ALONG_COS = cosDegrees(ROAD_BUILD.minAngleDegrees);
/** A sample this close to a road's end is on it. */
const AT_POINT = 1e-3;

function isPoint(value: unknown): value is BuildPoint {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return Number.isFinite(p["x"]) && Number.isFinite(p["z"]);
}

function readPayload(payload: unknown): BuildRoadGridPayload | string {
  const usage = "BuildRoadGrid needs three corners, a block depth and width, and a road type";
  if (typeof payload !== "object" || payload === null) return usage;
  const p = payload as Record<string, unknown>;
  const { origin, along, across, depth, width, type } = p;
  if (!isPoint(origin) || !isPoint(along) || !isPoint(across)) return "BuildRoadGrid needs three corners, each with a finite x and z";
  if (typeof depth !== "number" || !Number.isFinite(depth) || typeof width !== "number" || !Number.isFinite(width)) return usage;
  if (typeof type !== "string") return "BuildRoadGrid needs a road type";
  return { origin, along, across, depth, width, type };
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

function onMap(terrain: Terrain, x: number, z: number): boolean {
  const size = mapSize(terrain);
  return x >= 0 && x <= size && z >= 0 && z <= size;
}

/**
 * Where the grid lines fall along a side `length` long, in metres from the
 * origin: every `spacing`, and the far side. A last block whose clear size,
 * `length` less the last line and a road width, is under the share of
 * `block` joins the one before it.
 */
export function gridLines(length: number, spacing: number, block: number, roadWidth: number): number[] {
  const n = Math.floor(length / spacing);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(i * spacing);
  const left = length - n * spacing;
  if (left > 0) {
    if (left - roadWidth >= ROAD_BUILD.gridMinBlockShare * block) out.push(length);
    else out[n] = length;
  }
  return out;
}

/** How many lines `gridLines` gives, without making them. */
function lineCount(length: number, spacing: number, block: number, roadWidth: number): number {
  const n = Math.floor(length / spacing);
  const left = length - n * spacing;
  return n + 1 + (left > 0 && left - roadWidth >= ROAD_BUILD.gridMinBlockShare * block ? 1 : 0);
}

/** How a link between two lattice points fares. */
type LinkState =
  | { kind: "kept" }
  | { kind: "ground" }
  | { kind: "covered" }
  /** Built from `from` to `to`: the rest lies along an existing road. */
  | { kind: "trimmed"; from: BuildPoint; to: BuildPoint };

/** The tangent of `q` at parameter `t`: 2(1 - t)(C - A) + 2t(B - C), halved. */
function tangentAt(q: Quad, t: number): { x: number; z: number } {
  return { x: (1 - t) * (q.cx - q.ax) + t * (q.bx - q.cx), z: (1 - t) * (q.cz - q.az) + t * (q.bz - q.cz) };
}

/** Whether (tx, tz) runs within the minimum angle of (dx, dz), either way. */
function runsAlong(tx: number, tz: number, dx: number, dz: number): boolean {
  const dot = tx * dx + tz * dz;
  return (dot < 0 ? -dot : dot) >= ALONG_COS * Math.sqrt((tx * tx + tz * tz) * (dx * dx + dz * dz));
}

/**
 * Which samples along the link from `a` to `b` lie along an existing road:
 * within the merge distance of a ground-level road that runs within the
 * minimum angle of the link there. Also the samples' points. Sample 0 is
 * `a` and the last is `b`.
 */
function coverage(net: RoadNetwork, a: BuildPoint, b: BuildPoint): { covered: boolean[]; points: BuildPoint[] } {
  const r = ROAD_BUILD.mergeDistance;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // Only roads near the link that could run along it. A straight one runs
  // one way all along, so most are ruled out here.
  const near: Quad[] = [];
  const minX = a.x < b.x ? a.x : b.x;
  const maxX = a.x < b.x ? b.x : a.x;
  const minZ = a.z < b.z ? a.z : b.z;
  const maxZ = a.z < b.z ? b.z : a.z;
  for (const seg of segmentsInBox(roadIndexOf(net), minX - r, minZ - r, maxX + r, maxZ + r, NETWORKS_ROAD)) {
    if (net.segNetwork[seg] !== NETWORK_ROAD || !segmentAtLevel(net, seg, LEVEL_GROUND)) continue;
    const q = segmentQuad(net, seg);
    if (isStraight(q) && !runsAlong(q.bx - q.ax, q.bz - q.az, dx, dz)) continue;
    near.push(q);
  }
  const length = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.ceil(length / COVER_STEP);
  const covered: boolean[] = [];
  const points: BuildPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    points.push({ x, z });
    covered.push(
      near.some((q) => {
        const found = nearestOnQuad(q, x, z);
        if (found.d2 > r * r) return false;
        // Past a road's end is not along it, though it may be near.
        if ((found.t === 0 || found.t === 1) && found.d2 > AT_POINT * AT_POINT) return false;
        const tangent = tangentAt(q, found.t);
        return (tangent.x !== 0 || tangent.z !== 0) && runsAlong(tangent.x, tangent.z, dx, dz);
      }),
    );
  }
  return { covered, points };
}

/**
 * Where a link trimmed back to `p`, the last of its samples along an
 * existing road, starts or ends: on the build grid, or at the road node
 * there that BuildRoad would join, so the plan shows what is built.
 */
function joinPoint(net: RoadNetwork, p: BuildPoint): BuildPoint {
  const x = snapToGrid(p.x);
  const z = snapToGrid(p.z);
  const near = nearestNode(roadIndexOf(net), x, z, ROAD_BUILD.mergeDistance, NETWORKS_ROAD);
  return near ? { x: net.nodeX[near.node] ?? 0, z: net.nodeZ[near.node] ?? 0 } : { x, z };
}

function linkState(net: RoadNetwork, terrain: Terrain, type: RoadType, a: BuildPoint, b: BuildPoint): LinkState {
  const { covered, points } = coverage(net, a, b);
  const n = covered.length - 1;
  if (covered.every((c) => c)) return { kind: "covered" };
  let from = a;
  let to = b;
  if (covered[0]) {
    let k = 0;
    while (covered[k + 1]) k++;
    from = joinPoint(net, points[k] as BuildPoint);
  } else if (covered[n]) {
    let k = n;
    while (covered[k - 1]) k--;
    to = joinPoint(net, points[k] as BuildPoint);
  }
  if (distance(from.x, from.z, to.x, to.z) < ROAD_BUILD.minLength) return { kind: "covered" };
  if (groundProblem(terrain, type, straightQuad(from.x, from.z, to.x, to.z)) !== null) return { kind: "ground" };
  return same(from, a) && same(to, b) ? { kind: "kept" } : { kind: "trimmed", from, to };
}

/**
 * The end of a stub from `a` toward `b` that stops before water or a slope
 * too steep for `type`, at least the minimum length short of `b` and at
 * most `limit` metres long. Null when it would be under the minimum length.
 */
function stubEnd(terrain: Terrain, type: RoadType, a: BuildPoint, b: BuildPoint, limit: number): BuildPoint | null {
  const length = distance(a.x, a.z, b.x, b.z);
  const steps = Math.ceil(length / ROAD_BUILD.groundSampleStep);
  const run = length / steps;
  let good = 0;
  let previous = heightAt(terrain, a.x, a.z);
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const h = heightAt(terrain, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (h <= terrain.waterLevel) break;
    if ((h > previous ? h - previous : previous - h) / run > type.maxSlope) break;
    good = k;
    previous = h;
  }
  let reach = good * run;
  const most = length - ROAD_BUILD.minLength < limit ? length - ROAD_BUILD.minLength : limit;
  if (reach > most) reach = most;
  // The stub's own samples fall elsewhere than these, so check it as BuildRoad
  // will, and pull it back a sample at a time until it passes.
  while (reach >= ROAD_BUILD.minLength) {
    const end = { x: snapToGrid(a.x + ((b.x - a.x) * reach) / length), z: snapToGrid(a.z + ((b.z - a.z) * reach) / length) };
    if (distance(a.x, a.z, end.x, end.z) >= ROAD_BUILD.minLength && groundProblem(terrain, type, straightQuad(a.x, a.z, end.x, end.z)) === null) {
      return end;
    }
    reach -= run;
  }
  return null;
}

/** A piece of a grid line between two points, before pieces that meet are joined into streets. */
interface Edge {
  a: BuildPoint;
  b: BuildPoint;
  cutA: boolean;
  cutB: boolean;
}

const same = (p: BuildPoint, q: BuildPoint): boolean => p.x === q.x && p.z === q.z;

/**
 * Turns a BuildRoadGrid payload into the straight streets it lays, or the
 * reason it cannot. Pure: changes nothing, so the grid tool's preview runs it
 * on the mirror and shows what the sim will build.
 *
 * It checks the payload, the cap and the ground, and leaves out what lies
 * along an existing road. How each street meets the existing network is
 * checked when the grid is rehearsed (`checkRoadGrid`).
 */
export function planRoadGrid(net: RoadNetwork, terrain: Terrain, payload: unknown): GridPlanResult {
  const input = readPayload(payload);
  if (typeof input === "string") return { ok: false, reason: input };
  const type = ROAD_TYPES.find((t) => t.id === input.type);
  if (!type) return { ok: false, reason: `There is no road type "${input.type}"` };
  if (!type.buildable) return { ok: false, reason: `${type.name}s cannot be built yet` };
  if (input.depth < ROAD_BUILD.minLength || input.width < ROAD_BUILD.minLength) {
    return { ok: false, reason: `Blocks must be at least ${ROAD_BUILD.minLength} m deep and wide` };
  }

  const o = { x: snapToGrid(input.origin.x), z: snapToGrid(input.origin.z) };
  const p = { x: snapToGrid(input.along.x), z: snapToGrid(input.along.z) };
  const q = { x: snapToGrid(input.across.x), z: snapToGrid(input.across.z) };
  const e1x = p.x - o.x;
  const e1z = p.z - o.z;
  const e2x = q.x - o.x;
  const e2z = q.z - o.z;
  const corners = [o, p, q, { x: p.x + e2x, z: p.z + e2z }];
  if (!corners.every((c) => onMap(terrain, c.x, c.z))) return { ok: false, reason: "The grid runs off the map" };
  const l1 = Math.sqrt(e1x * e1x + e1z * e1z);
  const l2 = Math.sqrt(e2x * e2x + e2z * e2z);
  const s1 = input.width + type.width;
  const s2 = input.depth + type.width;
  if (l1 < s1 || l2 < s2) return { ok: false, reason: "The grid must be at least one block deep and one block wide" };
  const dot = e1x * e2x + e1z * e2z;
  if ((dot < 0 ? -dot : dot) > SQUARE_COS * l1 * l2) return { ok: false, reason: "The grid's corners must make a rectangle" };

  const lines = lineCount(l1, s1, input.width, type.width) + lineCount(l2, s2, input.depth, type.width);
  if (lines > MAX_STREETS) {
    return { ok: false, reason: `Too many streets: the grid has ${lines}, and the most one grid can lay is ${MAX_STREETS}` };
  }
  const at1 = gridLines(l1, s1, input.width, type.width);
  const at2 = gridLines(l2, s2, input.depth, type.width);
  const n1 = at1.length;
  const n2 = at2.length;
  const lattice: BuildPoint[] = [];
  for (let j = 0; j < n2; j++) {
    const f2 = (at2[j] ?? 0) / l2;
    for (let i = 0; i < n1; i++) {
      const f1 = (at1[i] ?? 0) / l1;
      lattice.push({ x: snapToGrid(o.x + e1x * f1 + e2x * f2), z: snapToGrid(o.z + e1z * f1 + e2z * f2) });
    }
  }
  // Each line's lattice points in order, the lines along the origin to
  // `along` side first, from the origin out.
  const lineList: { axis: 0 | 1; ids: number[] }[] = [];
  for (let j = 0; j < n2; j++) lineList.push({ axis: 0, ids: Array.from({ length: n1 }, (_, i) => j * n1 + i) });
  for (let i = 0; i < n1; i++) lineList.push({ axis: 1, ids: Array.from({ length: n2 }, (_, j) => j * n1 + i) });

  // First how every link fares, then which lattice points a kept link
  // reaches. A stub reaches toward water only from one of those.
  const states = lineList.map((line) =>
    line.ids.slice(1).map((id, k) => linkState(net, terrain, type, lattice[line.ids[k] ?? 0] as BuildPoint, lattice[id] as BuildPoint)),
  );
  const anchors = new Set<number>();
  lineList.forEach((line, l) => {
    (states[l] ?? []).forEach((s, k) => {
      if (s.kind === "ground") return;
      anchors.add(line.ids[k] ?? 0);
      anchors.add(line.ids[k + 1] ?? 0);
    });
  });

  const streets: GridStreet[] = [];
  let length = 0;
  lineList.forEach((line, l) => {
    const linkStates = states[l] ?? [];
    const isGround = (k: number) => linkStates[k]?.kind === "ground";
    const edges: Edge[] = [];
    linkStates.forEach((s, k) => {
      const a = lattice[line.ids[k] ?? 0] as BuildPoint;
      const b = lattice[line.ids[k + 1] ?? 0] as BuildPoint;
      if (s.kind === "kept") edges.push({ a, b, cutA: isGround(k - 1), cutB: isGround(k + 1) });
      else if (s.kind === "trimmed") {
        edges.push({ a: s.from, b: s.to, cutA: same(s.from, a) && isGround(k - 1), cutB: same(s.to, b) && isGround(k + 1) });
      } else if (s.kind === "ground") {
        const len = distance(a.x, a.z, b.x, b.z);
        const forward = anchors.has(line.ids[k] ?? 0) ? stubEnd(terrain, type, a, b, len) : null;
        // The stub back from the far end stays the minimum length clear of
        // the one forward, so neither end joins the other.
        const room = forward ? len - distance(a.x, a.z, forward.x, forward.z) - ROAD_BUILD.minLength : len;
        const back = anchors.has(line.ids[k + 1] ?? 0) ? stubEnd(terrain, type, b, a, room) : null;
        if (forward) edges.push({ a, b: forward, cutA: false, cutB: true });
        if (back) edges.push({ a: back, b, cutA: true, cutB: false });
      }
    });
    // Edges that meet end to start are one street.
    let current: { points: BuildPoint[]; cutStart: boolean; cutEnd: boolean } | null = null;
    const close = () => {
      if (current) streets.push({ points: current.points, axis: line.axis, cutStart: current.cutStart, cutEnd: current.cutEnd });
      current = null;
    };
    for (const e of edges) {
      length += distance(e.a.x, e.a.z, e.b.x, e.b.z);
      const open = current as { points: BuildPoint[]; cutStart: boolean; cutEnd: boolean } | null;
      if (open && same(open.points[open.points.length - 1] as BuildPoint, e.a)) {
        open.points.push(e.b);
        open.cutEnd = e.cutB;
      } else {
        close();
        current = { points: [e.a, e.b], cutStart: e.cutA, cutEnd: e.cutB };
      }
    }
    close();
  });
  const cost = Math.round(length * type.buildCostPerMetre);
  return { ok: true, plan: { type, streets, lines, length, cost } };
}

/**
 * Builds the streets of `plan` in order, one link at a time through the
 * BuildRoad path, and stops at the first link that is refused. Returns that
 * refusal, or null once the whole grid is built.
 */
export function buildRoadGrid(net: RoadNetwork, terrain: Terrain, plan: GridPlan): GridProblem | null {
  for (let s = 0; s < plan.streets.length; s++) {
    const points = (plan.streets[s] as GridStreet).points;
    for (let k = 1; k < points.length; k++) {
      const result = planRoad(net, terrain, { from: points[k - 1], to: points[k], type: plan.type.id });
      if (!result.ok) return { street: s, reason: result.reason };
      // The links are dry where they were sampled, but a piece between a
      // junction with an existing road and the next is sampled elsewhere.
      if (result.plan.levels.some((level) => level !== LEVEL_GROUND)) {
        return { street: s, reason: "The street would need a bridge, and a grid never builds one" };
      }
      buildRoad(net, terrain, result.plan);
    }
  }
  return null;
}

/** A refusal as a player reads it: which street, then why. */
export function gridProblemReason(plan: GridPlan, problem: GridProblem): string {
  return `Street ${problem.street + 1} of ${plan.streets.length} in the grid: ${problem.reason}`;
}

/**
 * Rehearses the grid on `net`: builds it with a journal open, notes the
 * first refusal, and reverses every change. The network ends byte for byte
 * as it was, free lists included. Observers see the changes and their
 * reverse. Must not be called while a journal is open.
 */
export function checkRoadGrid(net: RoadNetwork, terrain: Terrain, plan: GridPlan): GridProblem | null {
  startJournal(net);
  let problem: GridProblem | null;
  try {
    problem = buildRoadGrid(net, terrain, plan);
  } finally {
    reverseOps(net, endJournal(net));
  }
  return problem;
}
