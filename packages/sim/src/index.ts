// Public entry for the sim package. Client and server import the sim only
// through this file. Lint enforces it.

/** Game time advanced by one sim tick at 1x, in milliseconds. */
export const TICK_MS = 100;

/** Name and version of the sim, shown by the placeholder page. */
export function simInfo(): { name: string; tickMs: number } {
  return { name: "city-council sim", tickMs: TICK_MS };
}

export { SNAPSHOT_VERSION, SPEEDS, captureState, createBareState, createCaptureBuffers, createState } from "./state";
export type { CaptureBuffers } from "./state";
export type { SimState, Speed } from "./state";
export { COMMANDS, MAX_PENDING_COMMANDS, submit, validateCommand } from "./commands";
export type { Command, CommandDef, CommandResult, DroppedCommand } from "./commands";
export { BUILDINGS_SYSTEM, CELLS_SYSTEM, COMMANDS_SYSTEM, SYSTEMS, TRAVEL_SYSTEM, step } from "./step";
export {
  TRAVEL_ZONES,
  buildingTravelTime,
  buildingTravelZone,
  prepareTravelTimes,
  travelTimesReady,
  travelZoneSources,
  zoneTravelTime,
} from "./travel-times";
export type { System, SystemTimer } from "./step";
export { RNG_WORDS, nextFloat, nextInt, nextU32, seedRng } from "./rng";
export { LOG_LIVE_LIMIT, LOG_PAGE_SIZE, isLogEntry, logLength, readLog } from "./log";
export type { LogEntry } from "./log";
export { TIME_BALANCE, gameDate, isMonthStart, isYearStart, yearDays } from "./calendar";
export type { GameDate, TimeBalance } from "./calendar";
export { fnv1a64, hashMirrored, hashState } from "./hash";
export { replay } from "./replay";
export { BALANCE_STAMP, replaysUnderThisBalance } from "./balance-stamp";
export { BUDGETS, BUDGET_INHERITED_UP_TO, BUDGET_INHERITED_WITHIN, BUDGET_WARN_BELOW_HEADROOM, budgetFigure, judgeBudget } from "./budgets";
export type { BudgetFigure, BudgetRow, BudgetStatistic, BudgetTimings } from "./budgets";
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
export type { Snapshot, SnapshotBuffer, SnapshotErrorCode, SnapshotHeader, SnapshotSteps } from "./snapshot";
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
export { terrainOf } from "./terrain/cache";
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
  cellShapesInChunk,
  cellStatuses,
  cellsInBox,
  cellsInChunk,
  cellsSettled,
  cellsWalked,
  syncCells,
} from "./zoning/cell-index";
export type { CellIndex, CellInfo, ChunkCellShapes } from "./zoning/cell-index";
export { applyCellDelta, drainCellDelta, recordCellChanges } from "./zoning/delta";
export type { CellDelta } from "./zoning/delta";
export { ZONE_CLEAR, planZoneCells } from "./zoning/zone";
export { BUILDINGS_BALANCE, BUILDING_TYPES, EDUCATION_LEVELS, JOB_KINDS, checkBuildingsBalance, typesFor } from "./buildings/balance";
export type { BuildingType, BuildingTypeBalance, BuildingsBalance, EducationLevel, EducationShares, JobKind } from "./buildings/balance";
export { buildingJobs, jobsByEducation, jobsByKind, jobsForLot, lotJobs } from "./buildings/jobs";
export type { JobsByEducation, JobsByKind } from "./buildings/jobs";
export { POPS_BALANCE, checkPopsBalance } from "./pops/balance";
export type { PopsBalance } from "./pops/balance";
export {
  NO_HOME,
  NO_WORK,
  POP_ALIVE,
  POP_LEVELS,
  POP_ROW_BYTES,
  SATISFACTION_MAX,
  NO_LEAVING,
  cutPeople,
  isPop,
  popCount,
  popIdLimit,
  popSizeCap,
  popWorkers,
  readPop,
  workersFor,
} from "./pops/pops";
export type { PopProfile, PopRow, PopState } from "./pops/pops";
export { buildingPeople, jobsFilled, popsAtHome, popsAtWork } from "./pops/where";
export { applyPopDelta, countOccupancy, drainPopDelta, popDeltaProblem, recordPopChanges } from "./pops/delta";
export type { Occupancy, PopDelta } from "./pops/delta";
// The changes the systems that move people make. Exported for a host's
// tests, which play turnover before M3-11 builds it. UI code may not
// import them (eslint.config.js).
export { addPop, removePop, setPopDaysLow, setPopHousehold, setPopProfile, setPopSatisfaction, setPopSize, setPopWork } from "./pops/pops";
export type { NewPop } from "./pops/pops";
export { POPS_SYSTEM, popSlice } from "./pops/sweep";
export { ARRIVALS, ARRIVALS_SYSTEM, dayArrivals, drawProfile, drawSize } from "./pops/arrivals";
export { DISPLACED, DISPLACED_SYSTEM, placeDisplaced } from "./pops/displaced";
export { buildingReachesOutside, homeReachesOutside, homeRoomLeft, homesWithRoom, leastNewcomers, newcomerRoomLeft, reachableRoom, whyNoNewcomers } from "./pops/room";
export { JOBS, JOBS_SYSTEM, jobWeight, matchJobs, partThatFits } from "./pops/matching";
export { SATISFACTION, SATISFACTION_SYSTEM, dayDepartures, jobFits, satisfactionTarget, stepScore, updateSatisfaction } from "./pops/satisfaction";
export { TURNOVER, TURNOVER_SYSTEM, dayChances, turnOver, turnoverEvent } from "./pops/turnover";
export type { DayChances, TurnoverEvent } from "./pops/turnover";
export { jobsUpToLevel, openJobsFor, workplacesHeld, zoneJobs } from "./pops/open-jobs";
export type { ZoneJobs } from "./pops/open-jobs";
export type { ReachableRoom } from "./pops/room";
export { DEMAND_BALANCE, checkDemandBalance } from "./demand/balance";
export type { DemandBalance } from "./demand/balance";
export {
  DEMAND,
  DEMAND_BARS,
  DEMAND_PARTS,
  DEMAND_SYSTEM,
  checkDemand,
  copyDemand,
  createDemand,
  demandTargets,
  moveDemand,
  type BarState,
  type DemandBar,
  type DemandInputs,
  type DemandState,
  type DemandTargets,
} from "./demand/demand";
export { nodeReachesOutside, prepareOutside, segmentReachesOutside, segmentsReachingOutside } from "./roads/outside";
export { BUILDING_ABANDONED, BUILDING_ALIVE, BUILDING_FLAG_VALUES, BUILDING_UNZONED, BUILDING_VACANT, buildingCount, buildingIdLimit, homeRoom, isAbandoned, isBuilding, isVacant, readBuilding } from "./buildings/buildings";
export { VACANCY, VACANCY_SYSTEM, abandonedWaiting, buildingEmpty, checkVacancy, mayComeBack } from "./buildings/vacancy";
export { REDEVELOP, REDEVELOP_SYSTEM, checkRedevelopment, planRedevelopment, type RedevelopmentPlan } from "./buildings/redevelop";
export type { BuildingRow, BuildingState } from "./buildings/buildings";
export { findLot, lotOptions } from "./buildings/lots";
export { lotMarkAt, lotMarksInChunk } from "./buildings/lot-marks";
export type { Lot, LotOptions, LotProblem, LotResult } from "./buildings/lots";
export { GROWER_SYSTEM, dayOf, dayQuotas, homesHeld, freeFrontCells, growthOnTick, residentsFor, zoneBar } from "./buildings/grower";
export { LAND_VALUE_BALANCE, LAND_VALUE_MAX, checkLandValueBalance } from "./landvalue/balance";
export type { Falloff, IndustrySource, LandValueBalance } from "./landvalue/balance";
export { createCentre, type CentreState } from "./landvalue/centre";
export { prepareWaterMap } from "./landvalue/water";
export {
  HISTORY_LENGTH,
  STATS_SYSTEM,
  STAT_TOTALS,
  YEAR_COUNTS,
  applyStatsDelta,
  createStats,
  encodeStatsDelta,
  historyOf,
  statsDeltaProblem,
  recountTotals,
  sampleCount,
  type StatTotals,
  type StatsDelta,
  type StatsState,
  type YearCount,
  type YearCounts,
} from "./stats/stats";
export { LAND_VALUE_SYSTEM, falloff, findCentre, landValueAt, landValueAtPoint, landValuesOfShapes, nextMonth, type LandValue } from "./landvalue/land-value";
export { NO_BUILDING, buildingGround, buildingInfo, buildingOnSlot, buildingsInChunk, buildingsOnSlots, cellBuildings, zonedUpTo, type BuildingGround } from "./buildings/where";
export type { BuildingInfo } from "./buildings/where";
export {
  BUILDING_CHANGED,
  bulldozeClears,
  gridCells,
  gridClears,
  planBulldozeBuildings,
  previewBuildRoad,
  previewBuildRoadGrid,
  previewBulldozeRoad,
  roadCells,
  roadClears,
  seeBuilding,
} from "./buildings/bulldoze";
export type { BuildingSeen, BuildingsInTheWay, BulldozeBuildingPayload, PeopleIn } from "./buildings/bulldoze";
export { applyBuildingDelta, drainBuildingDelta, recordBuildingChanges } from "./buildings/delta";
export type { BuildingDelta } from "./buildings/delta";
export type { ZoneCellsPayload, ZonePlan, ZonePlanResult, ZonePoint, ZoneRect } from "./zoning/zone";
export { ROAD_BALANCE, ROAD_BUILD, ROAD_LEVELS, ROAD_TYPES, roadTypeIndex } from "./roads/balance";
export type { BalancePrice, BridgeBalance, RoadBalance, RoadBuildBalance, RoadType, RoadTypeBalance } from "./roads/balance";
export { planRoad, snapToGrid } from "./roads/build";
export { bridgeDeckHeight, bridgeDeckLevel, bridgeRamps } from "./roads/bridge";
export { curveBox, isStraight, minRadius, nearestOnQuad, quadPoint, segmentQuad, subControl, subQuad } from "./roads/curve";
export type { Box, Quad, QuadNearest } from "./roads/curve";
export type { BuildPoint, BuildRoadPayload, PlanStop, RoadPlan, RoadPlanResult } from "./roads/build";
export { gridLines, planRoadGrid } from "./roads/grid";
export type { BuildRoadGridPayload, GridPlan, GridPlanResult, GridProblem, GridStreet } from "./roads/grid";
export {
  SEGMENT_CHANGED,
  SHORT_SECTION,
  WHOLE_ONLY,
  WHOLE_REVERSE,
  planBulldoze,
  planSection,
  planUpgrade,
  sectionable,
  segmentEnds,
  segmentTypeId,
} from "./roads/edit";
export type {
  BulldozePlan,
  BulldozePlanResult,
  BulldozeRoadPayload,
  Section,
  SectionCut,
  SectionPlan,
  SegmentEnds,
  SegmentEndsNetwork,
  SegmentLevelsNetwork,
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
export { UNDO_STEPS, applyUndoDelta, diffUndo, planUndo } from "./undo";
export type { UndoDelta, UndoPlanResult, UndoRecord } from "./undo";
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
export { SCALE_BUILDINGS, SCALE_PLAYER, SCALE_SEED, SCALE_SEGMENTS, buildScaleCity, growScaleCity } from "./scale";
export type { ScaleCity, ScaleCounts, ScaleTown } from "./scale";
export { BLOCK_MIN_AREA, blockById, blockIndexOf, boundsBlocks, buildBlockIndex, listBlocks, sameBlocks } from "./roads/blocks";
export type { Block, BlockIndex } from "./roads/blocks";
