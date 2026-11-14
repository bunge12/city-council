// Public entry for the sim package. Client and server import the sim only
// through this file. Lint enforces it.

/** Game time advanced by one sim tick at 1x, in milliseconds. */
export const TICK_MS = 100;

/** Name and version of the sim, shown by the placeholder page. */
export function simInfo(): { name: string; tickMs: number } {
  return { name: "city-council sim", tickMs: TICK_MS };
}

export { SNAPSHOT_VERSION, SPEEDS, captureState, createBareState, createState } from "./state";
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
export { BALANCE_STAMP, replaysUnderThisBalance } from "./balance-stamp";
export { migrateState } from "./migrate";
export {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotError,
  deserialize,
  readSnapshotHeader,
  serialize,
  serializeDetached,
  serializeDetachedSteps,
  serializeSteps,
} from "./snapshot";
export type { Snapshot, SnapshotErrorCode, SnapshotHeader, SnapshotSteps } from "./snapshot";
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
export { ZONING_BALANCE, checkZoningBalance } from "./zoning/balance";
export type { DensityBalance, ZoneBalance, ZoningBalance } from "./zoning/balance";
export { CELL_LEFT, CELL_RIGHT, DENSITY_NONE, ZONE_NONE, cellCountOf, cellSlot, placesAlong } from "./zoning/cells";
export type { CellRef, CellState } from "./zoning/cells";
export {
  CELL_BEND,
  CELL_OFF_MAP,
  CELL_OPEN,
  CELL_ROAD,
  CELL_STEEP,
  CELL_TAKEN,
  CELL_WATER,
  cellAt,
  cellCorners,
  cellStatuses,
  cellsInBox,
  cellsInChunk,
  syncCells,
} from "./zoning/cell-index";
export type { CellIndex, CellInfo } from "./zoning/cell-index";
export { ROAD_BALANCE, ROAD_BUILD, ROAD_LEVELS, ROAD_TYPES, roadTypeIndex } from "./roads/balance";
export type { BalancePrice, BridgeBalance, RoadBalance, RoadBuildBalance, RoadType, RoadTypeBalance } from "./roads/balance";
export { planRoad, snapToGrid } from "./roads/build";
export { bridgeDeckHeight, bridgeDeckLevel, bridgeRamps } from "./roads/bridge";
export { curveBox, isStraight, minRadius, nearestOnQuad, quadPoint, segmentQuad, subControl } from "./roads/curve";
export type { Box, Quad, QuadNearest } from "./roads/curve";
export type { BuildPoint, BuildRoadPayload, PlanStop, RoadPlan, RoadPlanResult } from "./roads/build";
export { gridLines, planRoadGrid } from "./roads/grid";
export type { BuildRoadGridPayload, GridPlan, GridPlanResult, GridProblem, GridStreet } from "./roads/grid";
export { planBulldoze, planUpgrade } from "./roads/edit";
export type {
  BulldozePlan,
  BulldozePlanResult,
  BulldozeRoadPayload,
  UpgradePlan,
  UpgradePlanResult,
  UpgradeRoadPayload,
} from "./roads/edit";
export {
  LEVEL_BRIDGE,
  LEVEL_COUNT,
  LEVEL_ELEVATED_1,
  LEVEL_ELEVATED_2,
  LEVEL_GROUND,
  LEVEL_TUNNEL,
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  NODE_ALIVE,
  NODE_FIXED,
  NONE,
  SEG_ALIVE,
  SEG_FIXED,
  curveLength,
} from "./roads/network";
export type { RoadNetwork } from "./roads/network";
export {
  BUILD_LEVELS,
  LEVELS_ALL,
  LEVELS_BRIDGE,
  LEVELS_ELEVATED_1,
  LEVELS_ELEVATED_2,
  LEVELS_GROUND,
  LEVELS_SURFACE,
  LEVELS_TUNNEL,
  clearanceReason,
  heightAlong,
  levelOffset,
  segmentShape,
} from "./roads/levels";
export type { LevelledShape } from "./roads/levels";
export { applyRoadDelta, drainRoadChanges, encodeRoadDelta, mergeRoadChanges, recordRoadChanges } from "./roads/delta";
export type { RoadChanges, RoadDelta } from "./roads/delta";
export { CHUNKS_PER_SIDE, CHUNK_SIZE } from "./chunks";
export { UNDO_STEPS, planUndo } from "./undo";
export type { UndoPlanResult, UndoRecord } from "./undo";
export type { NetworkOp, SegmentRow } from "./roads/network";
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
export {
  NO_EDGE,
  NO_ROUTE,
  ROUTING_BALANCE,
  buildRoutingGraph,
  findRoute,
  findRouteBetween,
  freeFlowSpeedKmh,
  freeFlowTime,
  routingGraphOf,
  sameRoutingGraph,
} from "./roads/routing";
export type { EdgeCost, PointRoute, PointRouteOptions, Route, RouteEnd, RouteResult, RoutingBalance, RoutingGraph } from "./roads/routing";
export {
  CONNECTION_BALANCE,
  SIDE_EAST,
  SIDE_NORTH,
  SIDE_SOUTH,
  SIDE_WEST,
  chooseConnectionSites,
  connectionEnd,
  connectionStub,
  mapEdge,
  nearestOutside,
  reachesOutside,
} from "./roads/connections";
export type { ConnectionBalance, ConnectionSite } from "./roads/connections";
export { SCALE_PLAYER, SCALE_SEED, SCALE_SEGMENTS, buildScaleCity } from "./scale";
export type { ScaleCity, ScaleCounts } from "./scale";
export { BLOCK_MIN_AREA, blockById, blockIndexOf, boundsBlocks, buildBlockIndex, listBlocks, sameBlocks } from "./roads/blocks";
export type { Block, BlockIndex } from "./roads/blocks";
