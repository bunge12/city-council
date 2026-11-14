// Fixture cities for the road rendering walkthrough, built in Node with the
// sim itself and handed to the page as a city file. A city file is exactly
// the bytes `serialize` writes, so the page loads it as it would a player's.

import {
  createState,
  heightAt,
  serialize,
  syncCells,
  step,
  submit,
  generateTerrain,
  type SimState,
} from "../packages/sim/src/index";
import { addNode, addSegment, isNode, type RoadNetwork } from "../packages/sim/src/roads/network";
import { nextFloat, nextInt, seedRng } from "../packages/sim/src/rng";

/** Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000). The sim's tests rely on it too. */
export const SEED = 2026;
export const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };

/** Centre of the five-way junction. */
export const FIVE_WAY = { x: 4600, z: 4630 };

type Road = [from: [number, number], to: [number, number], type: string, control?: [number, number]];

/** The roads of the small fixture, in build order. */
export function fixtureRoads(): Road[] {
  const roads: Road[] = [];
  // A street grid of 2 x 3 blocks, 100 m apart, across the chunk line z = 4500.
  for (const x of [4150, 4250, 4350]) roads.push([[x, 4450], [x, 4750], "street"]);
  for (const z of [4450, 4550, 4650, 4750]) roads.push([[4150, z], [4350, z], "street"]);
  // A dead end off the grid's east side.
  roads.push([[4350, 4600], [4410, 4600], "street"]);
  // An avenue north to south and one east to west, meeting in a four-way.
  roads.push([[4450, 4420], [4450, 4980], "avenue"]);
  roads.push([[4150, 4850], [4660, 4850], "avenue"]);
  // A one-way across the avenue, ending in two dead ends.
  roads.push([[4380, 4930], [4530, 4930], "oneWay"]);
  // Five roads meeting at one node, 72 degrees apart, of mixed types.
  const arms: [number, number, string][] = [
    [60, 0, "avenue"],
    [19, 57, "street"],
    [-49, 35, "oneWay"],
    [-49, -35, "street"],
    [19, -57, "street"],
  ];
  for (const [dx, dz, type] of arms) roads.push([[FIVE_WAY.x, FIVE_WAY.z], [FIVE_WAY.x + dx, FIVE_WAY.z + dz], type]);
  return roads;
}

/** Runs BuildRoad for each road, one tick apiece, and throws on a refusal. */
export function buildRoads(state: SimState, roads: Road[]): void {
  let seq = 0;
  for (const [from, to, type, control] of roads) {
    const payload = {
      from: { x: from[0], z: from[1] },
      to: { x: to[0], z: to[1] },
      type,
      ...(control ? { control: { x: control[0], z: control[1] } } : {}),
    };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "BuildRoad", payload });
    if (!result.ok) throw new Error(`fixture road ${JSON.stringify([from, to, type, control])} refused: ${result.reason}`);
    step(state);
  }
}

/** The small fixture city: a grid, a five-way junction, dead ends, an avenue and a one-way. */
export function fixtureCity(): { bytes: Buffer; state: SimState } {
  const state = createState(SEED);
  buildRoads(state, fixtureRoads());
  // Roads written straight into the graph need their zoning cells laid out before a save.
  syncCells(state);
  return { bytes: Buffer.from(serialize(state)), state };
}

/** Middle of the curved fixture, where the arch avenue meets the straight street. */
export const CURVED_JUNCTION = { x: 4250, z: 4850 };

/** The roads of the curved fixture, in build order. Issue M1-09. */
export function curvedRoads(): Road[] {
  return [
    // An avenue arching north, from (4150, 4900) to (4350, 4900) with its apex at (4250, 4850).
    [[4150, 4900], [4350, 4900], "avenue", [4250, 4800]],
    // A straight street through the apex: a four-way junction with two curved arms.
    [[4250, 4770], [4250, 4970], "street"],
    // A street sagging south across the arch twice and the street once.
    [[4150, 4820], [4350, 4820], "street", [4250, 4930]],
    // A curved one-way off to the east, with arrows along the curve.
    [[4400, 4780], [4400, 4960], "oneWay", [4480, 4870]],
    // A street ending on the arch's body, a T-junction on a curve.
    [[4330, 4960], [4330, 4882], "street"],
  ];
}

/** A city with curved roads and junctions with curved arms. */
export function curvedCity(): { bytes: Buffer; state: SimState } {
  const state = createState(SEED);
  buildRoads(state, curvedRoads());
  // Roads written straight into the graph need their zoning cells laid out before a save.
  syncCells(state);
  return { bytes: Buffer.from(serialize(state)), state };
}

/** Where the decorations fixture's avenue crosses its street, and its street T. Issue 87. */
export const SIGNAL_CROSS = { x: 4550, z: 4650 };
export const YIELD_TEE = { x: 4250, z: 4700 };

/**
 * The roads of the decorations fixture, in build order (issue 87): a street
 * running straight on into an avenue and one bent into another, a street
 * T, and an avenue crossing a street.
 */
export function decorationRoads(): Road[] {
  return [
    // Street into avenue, straight on.
    [[4150, 4450], [4250, 4450], "street"],
    [[4250, 4450], [4420, 4450], "avenue"],
    // Street into avenue, bent 20 degrees.
    [[4150, 4560], [4250, 4560], "street"],
    [[4250, 4560], [4391, 4611], "avenue"],
    // A T of streets: a yield sign on each of its three roads.
    [[4150, YIELD_TEE.z], [4350, YIELD_TEE.z], "street"],
    [[YIELD_TEE.x, YIELD_TEE.z], [YIELD_TEE.x, 4820], "street"],
    // An avenue crossing a street: a traffic light on each of its four roads.
    [[SIGNAL_CROSS.x, 4500], [SIGNAL_CROSS.x, 4850], "avenue"],
    [[4460, SIGNAL_CROSS.z], [4660, SIGNAL_CROSS.z], "street"],
  ];
}

/** The decorations fixture city. */
export function decorationCity(): { bytes: Buffer; state: SimState } {
  const state = createState(SEED);
  buildRoads(state, decorationRoads());
  // Roads written straight into the graph need their zoning cells laid out before a save.
  syncCells(state);
  return { bytes: Buffer.from(serialize(state)), state };
}

/** Ground height at (x, z) on the fixture seed's map. */
export function groundAt(x: number, z: number): number {
  return heightAt(generateTerrain(SEED), x, z);
}

/**
 * A city with `segments` road segments spread over the whole map, made
 * straight into the graph arrays without BuildRoad, the way the sim's scale
 * tests make theirs. Roads cross without junctions; only the count and the
 * spread matter here.
 */
export function scaleCity(segments: number, seed = 7): Buffer {
  return Buffer.from(serialize(scaleCityState(segments, seed)));
}

/** The state `scaleCity` saves. */
export function scaleCityState(segments: number, seed = 7): SimState {
  const state = createState(SEED);
  const net: RoadNetwork = state.roads;
  const terrain = generateTerrain(SEED);
  const rng = seedRng(seed);
  const map = 12_000;
  const nodes: number[] = [];
  const point = (x: number, z: number) => addNode(net, x, z, heightAt(terrain, x, z));
  while (net.segFlags.length < segments) {
    const roll = nextFloat(rng);
    if (nodes.length === 0 || roll < 0.02) {
      nodes.push(point(nextFloat(rng) * map, nextFloat(rng) * map));
      continue;
    }
    const a = nodes[nextInt(rng, nodes.length)] ?? 0;
    if (!isNode(net, a)) continue;
    const reach = roll < 0.06 ? 800 : 120;
    const x = Math.min(map, Math.max(0, (net.nodeX[a] ?? 0) + (nextFloat(rng) * 2 - 1) * reach));
    const z = Math.min(map, Math.max(0, (net.nodeZ[a] ?? 0) + (nextFloat(rng) * 2 - 1) * reach));
    const b = point(x, z);
    nodes.push(b);
    const typeRoll = nextFloat(rng);
    addSegment(net, a, b, { type: typeRoll < 0.6 ? 0 : typeRoll < 0.85 ? 1 : 2 });
  }
  // Roads written straight into the graph need their zoning cells laid out before a save.
  syncCells(state);
  return state;
}
