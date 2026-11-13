// Outside connections (issue 16): the fixed highway stubs at the map edge
// where new residents and trade will arrive from M3 on.
//
// Each connection is a fixed node on the edge of the map and one fixed
// highway segment, `stubLength` long, running straight into the map to a
// node the player builds from. The player cannot bulldoze or upgrade the
// stub (edit.ts), nor join or cross it anywhere but at its inner end
// (build.ts). `SimState.connections` lists the edge nodes.
//
// Placement is a pure function of the seed, the terrain and the roads
// already there. Its random choices come from a generator seeded from the
// city's seed, not the one in state, so an old save that gains its
// connections in a migration gets the ones a new city of its seed would,
// unless its own roads are in the way. Candidates sit every
// `candidateStep` metres along each side. A candidate whose whole stub is on
// dry, gentle ground qualifies. The count is drawn first, then the sides in
// a random order, and each side in turn gives one qualifying candidate at
// random that keeps `minSpacing` from those already chosen. Only once every
// side has had its turn does a side give a second, so the connections
// spread across the sides the terrain allows. If too few qualify, the slope
// limit relaxes to the highway's own.
//
// Feeds state on every machine, so only exact arithmetic (CLAUDE.md rule 6).

import balance from "../../balance/connections.json" with { type: "json" };
import { ROAD_BUILD, ROAD_TYPES, type RoadType } from "./balance";
import { groundProblem } from "./build";
import { straightQuad } from "./curve";
import { LEVEL_GROUND, NETWORK_ROAD, NODE_FIXED, NONE, SEG_FIXED, addNode, addSegment, isNode, nextSegmentAt, otherEnd, type RoadNetwork } from "./network";
import { findRoute, routingGraphOf } from "./routing";
import { NETWORKS_ALL, NETWORKS_ROAD, nearestNode, roadIndexOf, segmentsInBox } from "./spatial";
import { nextInt, seedRng } from "../rng";
import { heightAt, slopeAt, type Terrain } from "../terrain/terrain";
import { mixSeed } from "../terrain/noise";

/** Outside connection parameters, as stored in `balance/connections.json`. */
export interface ConnectionBalance {
  count: { min: number; max: number };
  /** Plan length of the highway stub, metres. */
  stubLength: number;
  /** Metres between candidate places along a side. */
  candidateStep: number;
  /** No candidate this close to a corner, metres. */
  cornerMargin: number;
  /** Least distance between two connections' edge nodes, metres. */
  minSpacing: number;
  /** Steepest ground anywhere along a stub, rise over run. */
  maxSlope: number;
  /** Least height of the ground above the water along a stub, metres. */
  minHeightAboveWater: number;
  /** Metres a stub keeps from roads already built. */
  clearance: number;
  /** Road type id of the stub. */
  type: string;
}

/** Problems with connection balance data, as messages. Empty when it is fine. */
export function checkConnectionBalance(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return ["connection balance is not an object"];
  const b = data as Record<string, unknown>;
  const problems: string[] = [];
  const positive = (key: string) => {
    const v = b[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) problems.push(`${key} must be a positive number`);
  };
  for (const key of ["stubLength", "candidateStep", "cornerMargin", "minSpacing", "maxSlope", "clearance"]) positive(key);
  const h = b["minHeightAboveWater"];
  if (typeof h !== "number" || !Number.isFinite(h) || h < 0) problems.push("minHeightAboveWater must be zero or more");
  const count = b["count"] as Record<string, unknown> | undefined;
  const min = count?.["min"];
  const max = count?.["max"];
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 1 || (max as number) < (min as number)) {
    problems.push("count needs whole numbers min of at least 1 and max of at least min");
  }
  if (!ROAD_TYPES.some((t) => t.id === b["type"])) problems.push(`there is no road type "${String(b["type"])}"`);
  return problems;
}

const connectionProblems = checkConnectionBalance(balance);
if (connectionProblems.length > 0) throw new TypeError(`balance/connections.json: ${connectionProblems.join("; ")}`);

/** The parameters the game uses. */
export const CONNECTION_BALANCE: ConnectionBalance = balance;

/** Gives connection placement its own stream from the city's seed. */
const SALT_CONNECTIONS = 101;

/** North (z = 0), east, south and west, as the edge each side lies on. */
export const SIDE_NORTH = 0;
export const SIDE_EAST = 1;
export const SIDE_SOUTH = 2;
export const SIDE_WEST = 3;
const SIDES = 4;

/** A place on the edge a connection could take. */
export interface ConnectionSite {
  side: number;
  /** The edge node. */
  x: number;
  z: number;
  /** The stub's inner end. */
  innerX: number;
  innerZ: number;
}

/** The far edge of the terrain: the last sample row and column, metres. */
export function mapEdge(terrain: Pick<Terrain, "samples" | "spacing">): number {
  return (terrain.samples - 1) * terrain.spacing;
}

function site(side: number, along: number, edge: number, length: number): ConnectionSite {
  switch (side) {
    case SIDE_NORTH:
      return { side, x: along, z: 0, innerX: along, innerZ: length };
    case SIDE_EAST:
      return { side, x: edge, z: along, innerX: edge - length, innerZ: along };
    case SIDE_SOUTH:
      return { side, x: along, z: edge, innerX: along, innerZ: edge - length };
    default:
      return { side, x: 0, z: along, innerX: length, innerZ: along };
  }
}

/** Whether the ground under a stub is dry and no steeper than `maxSlope` at every sample. */
function gentleGround(terrain: Terrain, s: ConnectionSite, b: ConnectionBalance, maxSlope: number): boolean {
  const dx = s.innerX - s.x;
  const dz = s.innerZ - s.z;
  const steps = Math.ceil(b.stubLength / ROAD_BUILD.groundSampleStep);
  const dry = terrain.waterLevel + b.minHeightAboveWater;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = s.x + dx * t;
    const z = s.z + dz * t;
    if (heightAt(terrain, x, z) < dry) return false;
    if (slopeAt(terrain, x, z) > maxSlope) return false;
  }
  return true;
}

/** Whether a stub keeps `clearance` from every road node and segment already in `net`. */
function clearOfRoads(net: RoadNetwork, s: ConnectionSite, clearance: number): boolean {
  const index = roadIndexOf(net);
  const minX = (s.x < s.innerX ? s.x : s.innerX) - clearance;
  const maxX = (s.x > s.innerX ? s.x : s.innerX) + clearance;
  const minZ = (s.z < s.innerZ ? s.z : s.innerZ) - clearance;
  const maxZ = (s.z > s.innerZ ? s.z : s.innerZ) + clearance;
  if (segmentsInBox(index, minX, minZ, maxX, maxZ, NETWORKS_ALL).length > 0) return false;
  const mx = (s.x + s.innerX) / 2;
  const mz = (s.z + s.innerZ) / 2;
  const reach = (maxX - minX > maxZ - minZ ? maxX - minX : maxZ - minZ) / 2 + clearance;
  const near = nearestNode(index, mx, mz, reach, NETWORKS_ALL);
  if (!near) return true;
  const nx = net.nodeX[near.node] ?? 0;
  const nz = net.nodeZ[near.node] ?? 0;
  return nx < minX || nx > maxX || nz < minZ || nz > maxZ;
}

/** Every candidate on each side whose ground qualifies under `maxSlope` and that is clear of roads, in order along the side. */
function candidates(net: RoadNetwork, terrain: Terrain, b: ConnectionBalance, type: RoadType, maxSlope: number): ConnectionSite[][] {
  const edge = mapEdge(terrain);
  const out: ConnectionSite[][] = [];
  for (let side = 0; side < SIDES; side++) {
    const list: ConnectionSite[] = [];
    for (let along = b.cornerMargin; along <= edge - b.cornerMargin; along += b.candidateStep) {
      const s = site(side, along, edge, b.stubLength);
      if (!gentleGround(terrain, s, b, maxSlope)) continue;
      // Checked as a road of its type is when built, so the stub is one a player could have built.
      if (groundProblem(terrain, type, straightQuad(s.x, s.z, s.innerX, s.innerZ)) !== null) continue;
      if (clearOfRoads(net, s, b.clearance)) list.push(s);
    }
    out.push(list);
  }
  return out;
}

function farEnough(s: ConnectionSite, chosen: readonly ConnectionSite[], spacing: number): boolean {
  for (const c of chosen) {
    const dx = s.x - c.x;
    const dz = s.z - c.z;
    if (dx * dx + dz * dz < spacing * spacing) return false;
  }
  return true;
}

/**
 * Where the connections for `seed` go, in the order they are placed. Reads
 * `net` only to keep clear of roads already there. Changes nothing.
 */
export function chooseConnectionSites(
  net: RoadNetwork,
  terrain: Terrain,
  seed: number,
  b: ConnectionBalance = CONNECTION_BALANCE,
): ConnectionSite[] {
  const rng = seedRng(mixSeed(seed, SALT_CONNECTIONS));
  const count = b.count.min + nextInt(rng, b.count.max - b.count.min + 1);
  const sides = [0, 1, 2, 3];
  for (let i = SIDES - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const swap = sides[i] as number;
    sides[i] = sides[j] as number;
    sides[j] = swap;
  }
  const chosen: ConnectionSite[] = [];
  const highway = ROAD_TYPES.find((t) => t.id === b.type) as RoadType;
  // Strict ground first. Below the minimum, the highway's own limit.
  for (const maxSlope of [b.maxSlope, highway.maxSlope]) {
    const pools = candidates(net, terrain, b, highway, maxSlope);
    for (let round = 0; round < 2 && chosen.length < count; round++) {
      for (const side of sides) {
        if (chosen.length >= count) break;
        if (round === 0 && chosen.some((c) => c.side === side)) continue;
        const pool = (pools[side] ?? []).filter((s) => farEnough(s, chosen, b.minSpacing));
        if (pool.length === 0) continue;
        chosen.push(pool[nextInt(rng, pool.length)] as ConnectionSite);
      }
    }
    if (chosen.length >= b.count.min) break;
  }
  return chosen;
}

/**
 * Places the outside connections for `seed` into `net` and returns their
 * edge node ids. Each is a fixed edge node, then the stub's inner node, then
 * the fixed highway segment between them, so ids follow placement order.
 */
export function placeConnections(net: RoadNetwork, terrain: Terrain, seed: number, b: ConnectionBalance = CONNECTION_BALANCE): Int32Array {
  const type = ROAD_TYPES.find((t) => t.id === b.type) as RoadType;
  const sites = chooseConnectionSites(net, terrain, seed, b);
  const edges = new Int32Array(sites.length);
  sites.forEach((s, i) => {
    const edge = addNode(net, s.x, s.z, heightAt(terrain, s.x, s.z), true);
    const inner = addNode(net, s.innerX, s.innerZ, heightAt(terrain, s.innerX, s.innerZ));
    addSegment(net, edge, inner, { type: type.index, network: NETWORK_ROAD, level: LEVEL_GROUND, fixed: true });
    edges[i] = edge;
  });
  return edges;
}

/** The stub segment at connection edge node `edge`, or NONE if it is not one. */
export function connectionStub(net: RoadNetwork, edge: number): number {
  if (!isNode(net, edge) || ((net.nodeFlags[edge] ?? 0) & NODE_FIXED) === 0) return NONE;
  const seg = net.nodeFirstSeg[edge] ?? NONE;
  if (seg === NONE || nextSegmentAt(net, seg, edge) !== NONE) return NONE;
  return ((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0 ? seg : NONE;
}

/** The node at the inner end of connection `edge`'s stub, where the player builds from, or NONE. */
export function connectionEnd(net: RoadNetwork, edge: number): number {
  const seg = connectionStub(net, edge);
  return seg === NONE ? NONE : otherEnd(net, seg, edge);
}

/**
 * What is wrong with a state's connection list, given its network, or null.
 * Each entry is a live fixed node with exactly one segment, a fixed one,
 * and none is listed twice.
 */
export function checkConnections(value: unknown, net: RoadNetwork): string | null {
  if (!(value instanceof Int32Array)) return "the connection list is not an Int32Array";
  const seen = new Set<number>();
  for (const edge of value) {
    if (seen.has(edge)) return `connection node ${edge} is listed twice`;
    seen.add(edge);
    if (connectionStub(net, edge) === NONE) return `connection node ${edge} is not a fixed node with one fixed stub`;
  }
  return null;
}

/**
 * The outside connection that node `node` reaches quickest by road, as its
 * edge node id, or NONE when it reaches none. One-ways count only in their
 * own direction. Ties go to the earlier connection in the list.
 */
export function nearestOutside(net: RoadNetwork, connections: ArrayLike<number>, node: number): number {
  if (!isNode(net, node)) throw new RangeError(`node ${node} does not exist`);
  const graph = routingGraphOf(net);
  let best = NONE;
  let bestTime = Infinity;
  for (let i = 0; i < connections.length; i++) {
    const edge = connections[i] ?? NONE;
    if (!isNode(net, edge)) continue;
    const found = findRoute(graph, node, edge, NETWORKS_ROAD);
    if (found.ok && found.route.time < bestTime) {
      best = edge;
      bestTime = found.route.time;
    }
  }
  return best;
}

/** Whether node `node` can reach any outside connection by road. */
export function reachesOutside(net: RoadNetwork, connections: ArrayLike<number>, node: number): boolean {
  return nearestOutside(net, connections, node) !== NONE;
}
