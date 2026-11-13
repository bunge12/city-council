// Public entry for the sim package. Client and server import the sim only
// through this file. Lint enforces it.

/** Game time advanced by one sim tick at 1x, in milliseconds. */
export const TICK_MS = 100;

/** Name and version of the sim, shown by the placeholder page. */
export function simInfo(): { name: string; tickMs: number } {
  return { name: "city-council sim", tickMs: TICK_MS };
}

export { SNAPSHOT_VERSION, SPEEDS, createState } from "./state";
export type { SimState, Speed } from "./state";
export { COMMANDS, MAX_PENDING_COMMANDS, submit, validateCommand } from "./commands";
export type { Command, CommandDef, CommandResult } from "./commands";
export { COMMANDS_SYSTEM, SYSTEMS, step } from "./step";
export type { System, SystemTimer } from "./step";
export { RNG_WORDS, nextFloat, nextInt, nextU32, seedRng } from "./rng";
export { LOG_LIVE_LIMIT, LOG_PAGE_SIZE, isLogEntry, logLength, readLog } from "./log";
export type { LogEntry } from "./log";
export { TIME_BALANCE, gameDate } from "./calendar";
export type { GameDate, TimeBalance } from "./calendar";
export { fnv1a64, hashState } from "./hash";
export { replay } from "./replay";
export { migrateState } from "./migrate";
export {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotError,
  deserialize,
  readSnapshotHeader,
  serialize,
  serializeDetached,
} from "./snapshot";
export type { Snapshot, SnapshotErrorCode, SnapshotHeader } from "./snapshot";
export { PROTOCOL_VERSION, parseToSimMessage } from "./protocol";
export type {
  CommandMessage,
  CommandResultMessage,
  DeltaMessage,
  FromSimMessage,
  RequestSnapshotMessage,
  SnapshotMessage,
  SystemTiming,
  ToSimMessage,
} from "./protocol";
export {
  TERRAIN_BALANCE,
  generateTerrain,
  hashTerrain,
  heightAt,
  isWaterAt,
  mapSize,
  slopeAt,
} from "./terrain/terrain";
export type { Terrain, TerrainBalance } from "./terrain/terrain";
export { ROAD_BALANCE, ROAD_BUILD, ROAD_TYPES, roadTypeIndex } from "./roads/balance";
export type { BalancePrice, RoadBalance, RoadBuildBalance, RoadType, RoadTypeBalance } from "./roads/balance";
export { planRoad, snapToGrid } from "./roads/build";
export { curveBox, isStraight, minRadius, nearestOnQuad, quadPoint, segmentQuad, subControl } from "./roads/curve";
export type { Box, Quad, QuadNearest } from "./roads/curve";
export type { BuildPoint, BuildRoadPayload, PlanStop, RoadPlan, RoadPlanResult } from "./roads/build";
export {
  LEVEL_BRIDGE,
  LEVEL_ELEVATED,
  LEVEL_GROUND,
  LEVEL_TUNNEL,
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  NODE_ALIVE,
  NODE_FIXED,
  NONE,
  SEG_ALIVE,
} from "./roads/network";
export type { RoadNetwork } from "./roads/network";
export { applyRoadDelta, drainRoadChanges, encodeRoadDelta, mergeRoadChanges, recordRoadChanges } from "./roads/delta";
export type { RoadChanges, RoadDelta } from "./roads/delta";
export { CHUNKS_PER_SIDE, CHUNK_SIZE } from "./chunks";
export { prepareDerived } from "./derived";
export {
  NETWORKS_ALL,
  NETWORKS_PATH,
  NETWORKS_RAIL,
  NETWORKS_ROAD,
  buildRoadIndex,
  chunkOfNode,
  forSegmentChunks,
  indexNode,
  indexSegment,
  nearestNode,
  nearestPointOnSegment,
  nodeOnNetworks,
  roadIndexOf,
  segmentTouchesBox,
  segmentsInBox,
  unindexNode,
  unindexSegment,
} from "./roads/spatial";
export type { NearestNode, NearestPoint, RoadIndex } from "./roads/spatial";
