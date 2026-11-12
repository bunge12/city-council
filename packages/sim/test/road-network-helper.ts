// Random road networks for the spatial index tests and the timing run. Seeded,
// so every run builds the same network.

import { nextFloat, nextInt, seedRng } from "../src/rng";
import {
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  addNode,
  addSegment,
  isNode,
  isSegment,
  nodeIdLimit,
  removeNode,
  removeSegment,
  segmentIdLimit,
  segmentsAt,
  type RoadNetwork,
} from "../src/roads/network";

const MAP = 12_000;

/** A random number in [lo, hi). */
function between(rng: Uint32Array, lo: number, hi: number): number {
  return lo + nextFloat(rng) * (hi - lo);
}

function liveNodes(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id)) out.push(id);
  return out;
}

function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

function randomSpec(rng: Uint32Array): { type: number; network: number } {
  const roll = nextFloat(rng);
  const network = roll < 0.8 ? NETWORK_ROAD : roll < 0.9 ? NETWORK_RAIL : NETWORK_PATH;
  return { type: network === NETWORK_ROAD ? nextInt(rng, 3) : 0, network };
}

/**
 * Adds one random segment. Mostly a short road off an existing node to a new
 * one, sometimes a link between two existing nodes, sometimes a long road
 * across several chunks, and now and then one that runs off the map.
 */
export function addRandomSegment(net: RoadNetwork, rng: Uint32Array, nodes: number[]): number {
  const roll = nextFloat(rng);
  if (nodes.length < 2 || roll < 0.02) {
    // A fresh pair, sometimes partly off the map.
    const a = addNode(net, between(rng, -500, MAP + 500), between(rng, -500, MAP + 500), 0);
    const b = addNode(net, between(rng, -500, MAP + 500), between(rng, -500, MAP + 500), 0);
    nodes.push(a, b);
    return addSegment(net, a, b, randomSpec(rng));
  }
  const a = nodes[nextInt(rng, nodes.length)] ?? 0;
  if (roll < 0.15) {
    let b = nodes[nextInt(rng, nodes.length)] ?? 0;
    if (b === a) b = nodes[(nodes.indexOf(a) + 1) % nodes.length] ?? 0;
    return addSegment(net, a, b, randomSpec(rng));
  }
  const reach = roll < 0.2 ? 2500 : 200;
  const x = Math.min(MAP, Math.max(0, (net.nodeX[a] ?? 0) + between(rng, -reach, reach)));
  const z = Math.min(MAP, Math.max(0, (net.nodeZ[a] ?? 0) + between(rng, -reach, reach)));
  // Snap a fifth of new nodes to a chunk line, so segments run along and
  // end on cell edges.
  const snap = nextFloat(rng) < 0.2;
  const b = addNode(net, snap ? Math.round(x / 500) * 500 : x, z, 0);
  nodes.push(b);
  return addSegment(net, a, b, randomSpec(rng));
}

/** Adds `segments` random segments to `net`. */
export function growNetwork(net: RoadNetwork, seed: number, segments: number): void {
  const rng = seedRng(seed);
  const nodes = liveNodes(net);
  for (let i = 0; i < segments; i++) addRandomSegment(net, rng, nodes);
}

/**
 * `count` random changes: adds, segment removals and removals of nodes left
 * with no segments, so freed ids come back into use.
 */
export function churnNetwork(net: RoadNetwork, seed: number, count: number): void {
  const rng = seedRng(seed);
  for (let i = 0; i < count; i++) {
    const roll = nextFloat(rng);
    const nodes = liveNodes(net);
    if (roll < 0.45) {
      addRandomSegment(net, rng, nodes);
      continue;
    }
    const segs = liveSegments(net);
    if (roll < 0.9 && segs.length > 0) {
      const seg = segs[nextInt(rng, segs.length)] ?? 0;
      const ends = [net.segA[seg] ?? 0, net.segB[seg] ?? 0];
      removeSegment(net, seg);
      // Half the time, tidy away an end left bare.
      for (const node of ends) if (nextFloat(rng) < 0.5 && segmentsAt(net, node).length === 0) removeNode(net, node);
      continue;
    }
    const bare = nodes.filter((node) => segmentsAt(net, node).length === 0);
    if (bare.length > 0) removeNode(net, bare[nextInt(rng, bare.length)] ?? 0);
    else addNode(net, between(rng, 0, MAP), between(rng, 0, MAP), 0);
  }
}
