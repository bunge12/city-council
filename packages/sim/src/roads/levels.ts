// Levels and grade separation (issue 22, PRD "Levels and grade separation").
//
// Every segment stores a level at each end. Ground, tunnel and the two
// elevated levels sit a fixed height above or below the ground under the
// segment, from `levels` in roads.json, so an elevated road follows the
// ground at a set height. A bridge keeps its own level: its deck height
// comes from the water and its bank nodes (bridge.ts). Where a segment's two
// ends differ, as on a ramp M5 will build, its height above the ground runs
// evenly from one end's level to the other's along the curve's parameter.
//
// Two segments on the same network that cross are compared by their heights
// at the crossing. With at least `levels.clearance` between the surfaces they
// pass with no junction. At the same level they split and join as before.
// Anything else is refused.
//
// Feeds command validation, so only exact arithmetic (CLAUDE.md rule 6).

import { ROAD_LEVELS, ROAD_TYPES } from "./balance";
import { bridgeDeckHeight, bridgeDeckLevel } from "./bridge";
import { isStraight, segmentQuad, subQuad, type Quad } from "./curve";
import {
  LEVEL_BRIDGE,
  LEVEL_ELEVATED_1,
  LEVEL_ELEVATED_2,
  LEVEL_GROUND,
  LEVEL_TUNNEL,
  NONE,
  curveLength,
  type RoadNetwork,
} from "./network";
import { heightAt, type Terrain } from "../terrain/terrain";

/** A level filter bit for each level. Combine with `|`. */
export const LEVELS_GROUND = 1 << LEVEL_GROUND;
export const LEVELS_BRIDGE = 1 << LEVEL_BRIDGE;
export const LEVELS_TUNNEL = 1 << LEVEL_TUNNEL;
export const LEVELS_ELEVATED_1 = 1 << LEVEL_ELEVATED_1;
export const LEVELS_ELEVATED_2 = 1 << LEVEL_ELEVATED_2;
/** Everything on the ground's surface: ground roads, and bridges, whose bank nodes sit on the ground. */
export const LEVELS_SURFACE = LEVELS_GROUND | LEVELS_BRIDGE;
/** Every level. */
export const LEVELS_ALL = LEVELS_GROUND | LEVELS_BRIDGE | LEVELS_TUNNEL | LEVELS_ELEVATED_1 | LEVELS_ELEVATED_2;

/**
 * The names a BuildRoad payload uses for the levels a road can be built at.
 * A bridge is not one: the sim makes bridges itself over water.
 */
export const BUILD_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  ground: LEVEL_GROUND,
  tunnel: LEVEL_TUNNEL,
  elevated1: LEVEL_ELEVATED_1,
  elevated2: LEVEL_ELEVATED_2,
});

/** Height above the ground under it of a segment end at `level`, metres. Not for a bridge. */
export function levelOffset(level: number): number {
  switch (level) {
    case LEVEL_TUNNEL:
      return ROAD_LEVELS.tunnel;
    case LEVEL_ELEVATED_1:
      return ROAD_LEVELS.elevated1;
    case LEVEL_ELEVATED_2:
      return ROAD_LEVELS.elevated2;
    default:
      return ROAD_LEVELS.ground;
  }
}

/** The level filter bits a segment matches: one for each of its ends' levels. */
export function segmentLevelBits(net: RoadNetwork, seg: number): number {
  return (1 << (net.segLevelA[seg] ?? 0)) | (1 << (net.segLevelB[seg] ?? 0));
}

/** The level of segment `seg` at its end on node `node`. */
export function levelAtNode(net: RoadNetwork, seg: number, node: number): number {
  return (net.segA[seg] === node ? net.segLevelA[seg] : net.segLevelB[seg]) ?? 0;
}

/** A segment's shape and ends, enough to give its height anywhere along it. */
export interface LevelledShape {
  q: Quad;
  levelA: number;
  levelB: number;
  /** Ground height at each end node. */
  hA: number;
  hB: number;
  /** Plan length, metres, measured as `addSegment` measures it. */
  length: number;
  /** Index into ROAD_TYPES, for a bridge's ramp grade. */
  type: number;
}

/** The levelled shape of existing segment `seg`. */
export function segmentShape(net: RoadNetwork, seg: number): LevelledShape {
  return {
    q: segmentQuad(net, seg),
    levelA: net.segLevelA[seg] ?? 0,
    levelB: net.segLevelB[seg] ?? 0,
    hA: net.nodeHeight[net.segA[seg] ?? NONE] ?? 0,
    hB: net.nodeHeight[net.segB[seg] ?? NONE] ?? 0,
    length: net.segLength[seg] ?? 0,
    type: net.segType[seg] ?? 0,
  };
}

/**
 * The height of the road surface at parameter `u` along a segment, in
 * metres. On a bridge, the deck `bridgeDeckHeight` gives at that distance
 * along it; elsewhere the ground under that point plus the level's height,
 * which on a ramp runs evenly from one end's level to the other's.
 */
export function heightAlong(terrain: Terrain, shape: LevelledShape, u: number): number {
  const { q } = shape;
  if (shape.levelA === LEVEL_BRIDGE) {
    let s = shape.length * u;
    if (!isStraight(q) && u > 0) {
      const part = subQuad(q, 0, u);
      s = curveLength(part.ax, part.az, part.cx, part.cz, part.bx, part.bz);
    }
    const grade = ROAD_TYPES[shape.type]?.maxSlope ?? 1;
    return bridgeDeckHeight(shape.hA, shape.hB, shape.length, s, bridgeDeckLevel(terrain.waterLevel), grade);
  }
  const v = 1 - u;
  const x = v * v * q.ax + 2 * v * u * q.cx + u * u * q.bx;
  const z = v * v * q.az + 2 * v * u * q.cz + u * u * q.bz;
  const offsetA = levelOffset(shape.levelA);
  const offsetB = levelOffset(shape.levelB);
  return heightAt(terrain, x, z) + offsetA + (offsetB - offsetA) * u;
}

/** A short description of a segment with these end levels, for a reason a player reads. */
export function levelWords(levelA: number, levelB: number = levelA): string {
  if (levelA !== levelB) return "a ramp";
  switch (levelA) {
    case LEVEL_BRIDGE:
      return "a bridge";
    case LEVEL_TUNNEL:
      return "a tunnel";
    case LEVEL_ELEVATED_1:
    case LEVEL_ELEVATED_2:
      return "an elevated road";
    default:
      return "a road";
  }
}

/** Rounded to a tenth of a metre, for a reason a player reads. */
function metres(m: number): string {
  return `${Math.round(m * 10) / 10} m`;
}

/**
 * The reason a new road may not cross an existing one with `gap` metres
 * between their surfaces, the new one above when `gap` is positive. The
 * existing road has levels `levelA` and `levelB` at its ends.
 */
export function clearanceReason(gap: number, levelA: number, levelB: number): string {
  const what = levelWords(levelA, levelB);
  const need = `roads need ${metres(ROAD_LEVELS.clearance)} between them to cross without a junction`;
  if (gap === 0) return `The road would meet ${what} at the same height but cannot join it there, and ${need}`;
  const size = gap > 0 ? gap : -gap;
  return `The road would pass only ${metres(size)} ${gap > 0 ? "over" : "under"} ${what}, and ${need}`;
}
