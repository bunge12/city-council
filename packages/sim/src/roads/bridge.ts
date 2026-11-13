// Bridges over water (issue 11). Where a road crosses water the sim makes
// that stretch one segment at the bridge level, from a node on each bank.
// Its deck runs level at `bridgeClearance` above the water, and at each end
// a ramp at the road type's slope limit joins it to the bank node, which
// sits on the ground. The planner in build.ts picks the banks so each ramp
// reaches the deck before the water starts.
//
// The deck's height is not stored. It follows from the water level, the
// bank nodes' heights and the type's slope limit, so the renderer works it
// out with the same function. Exact arithmetic only (CLAUDE.md rule 6).

import { ROAD_BUILD } from "./balance";

/** Height in metres of a bridge deck over water whose surface is at `waterLevel`. */
export function bridgeDeckLevel(waterLevel: number): number {
  return waterLevel + ROAD_BUILD.bridgeClearance;
}

/**
 * How far along a bridge, in metres from each end, its ramps run: from the
 * bank node at height `hA` (or `hB`) to the deck at height `deck`, at grade
 * `grade`. If the two would overlap they share the length in proportion.
 */
export function bridgeRamps(hA: number, hB: number, length: number, deck: number, grade: number): { a: number; b: number } {
  let a = (deck > hA ? deck - hA : hA - deck) / grade;
  let b = (deck > hB ? deck - hB : hB - deck) / grade;
  if (a + b > length && a + b > 0) {
    const k = length / (a + b);
    a *= k;
    b *= k;
  }
  return { a, b };
}

/**
 * Height of a bridge's deck at `s` metres along it from node A, for a bridge
 * `length` metres long between bank nodes at heights `hA` and `hB`.
 */
export function bridgeDeckHeight(hA: number, hB: number, length: number, s: number, deck: number, grade: number): number {
  const ramps = bridgeRamps(hA, hB, length, deck, grade);
  if (s <= 0) return hA;
  if (s >= length) return hB;
  if (s < ramps.a) return hA + ((deck - hA) * s) / ramps.a;
  if (s > length - ramps.b) return hB + ((deck - hB) * (length - s)) / ramps.b;
  return deck;
}
