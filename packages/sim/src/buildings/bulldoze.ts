// Clearing buildings (M2-11, PRD "Rezoning"): the `BulldozeBuilding`
// command, and what a road command would clear, for the tools' previews.
//
// A building id alone can name a different building a tick later, since ids
// are reused from a free list (issue 94 found the same with segment ids).
// So the command names each building by its id, its lot's first cell and
// the tick it was built on, as the player saw them, and refuses the whole
// command when any no longer match. The tick matters when the grower builds
// again on the lot it was cleared from: the new building can take the freed
// id and the same first cell (M2 review, #147). A cleared lot is free at once, and the grower may build on it
// under the cells' current zoning. Clearing costs nothing until the
// treasury and the eminent domain price arrive in M4.

import { planBulldoze, type BulldozePlan } from "../roads/edit";
import { buildRoad, planRoad, type RoadPlan } from "../roads/build";
import { buildRoadGrid, planRoadGrid, type GridPlan } from "../roads/grid";
import { endJournal, reverseOps, startJournal, type NetworkOp, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { openCellsUnder, syncCells } from "../zoning/cell-index";
import { BUILDINGS_BALANCE } from "./balance";
import { isBuilding, removeBuildings, type BuildingState } from "./buildings";
import { buildingsOnCells, buildingsOnSegments, buildingsOnStretch } from "./where";

/** One building a `BulldozeBuilding` names, as the player saw it: its id, its lot's first cell and the tick it was built on. */
export interface BuildingSeen {
  id: number;
  segment: number;
  side: number;
  place: number;
  builtAt: number;
}

/** Building `id` of `b` as a `BulldozeBuilding` names it, or null when no building has that id. */
export function seeBuilding(b: BuildingState, id: number): BuildingSeen | null {
  if (!isBuilding(b, id)) return null;
  return { id, segment: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0, builtAt: b.builtAt[id] ?? 0 };
}

/** What a `BulldozeBuilding` command carries besides the player id. */
export interface BulldozeBuildingPayload {
  buildings: BuildingSeen[];
}

/** Words for a building that is not what the sender saw: removed, or its id handed to another building. */
export const BUILDING_CHANGED = "This building changed after you picked it, so nothing was done";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The building ids a `BulldozeBuilding` payload names, ascending, or the reason it cannot apply to `state`. Changes nothing. */
export function planBulldozeBuildings(state: SimState, payload: unknown): { ok: true; ids: number[] } | { ok: false; reason: string } {
  const need = "BulldozeBuilding needs a list of buildings, each { id, segment, side, place, builtAt }";
  if (!isRecord(payload) || !Array.isArray(payload["buildings"]) || payload["buildings"].length === 0) return { ok: false, reason: need };
  const list = payload["buildings"] as unknown[];
  const most = BUILDINGS_BALANCE.bulldozeMaxBuildings;
  if (list.length > most) return { ok: false, reason: `BulldozeBuilding takes at most ${most} buildings at once, and this names ${list.length}` };
  const b = state.buildings;
  const ids = new Set<number>();
  for (const item of list) {
    if (!isRecord(item)) return { ok: false, reason: need };
    const { id, segment, side, place, builtAt } = item;
    if (![id, segment, side, place, builtAt].every((v) => Number.isSafeInteger(v))) return { ok: false, reason: need };
    if (ids.has(id as number)) return { ok: false, reason: `Building ${id} is named twice` };
    ids.add(id as number);
    if (!isBuilding(b, id as number)) return { ok: false, reason: BUILDING_CHANGED };
    const i = id as number;
    if (b.firstSeg[i] !== segment || b.firstSide[i] !== side || b.firstPlace[i] !== place || b.builtAt[i] !== builtAt) {
      return { ok: false, reason: BUILDING_CHANGED };
    }
  }
  return { ok: true, ids: [...ids].sort((p, q) => p - q) };
}

/** Removes the buildings a plan named, in ascending id order. */
export function bulldozeBuildings(state: SimState, ids: readonly number[]): void {
  removeBuildings(state, ids);
}

/** The buildings a road command would clear, for a preview. */
export interface BuildingsInTheWay {
  /** Building ids, ascending. */
  ids: number[];
  /** The people they hold room for, added up. M3 moves people in, so these are the residents that would be displaced. */
  residents: number;
}

function inTheWay(state: SimState, ids: number[]): BuildingsInTheWay {
  let residents = 0;
  for (const id of ids) residents += state.buildings.residents[id] ?? 0;
  return { ids, residents };
}

/**
 * The buildings that stand on the cells of the segments a bulldoze removes,
 * or of the stretch of each it cuts out. Their cells go with the road, so
 * the command removes them at once.
 */
export function bulldozeClears(state: SimState, plan: BulldozePlan): BuildingsInTheWay {
  const cut = new Set(plan.sections.map((s) => s.seg));
  const ids = new Set(buildingsOnSegments(state, plan.segments.filter((seg) => !cut.has(seg))));
  for (const s of plan.sections) for (const id of buildingsOnStretch(state, s.seg, s.from, s.to)) ids.add(id);
  return inTheWay(state, [...ids].sort((p, q) => p - q));
}

/**
 * Builds on `net` with its journal open, finds the open cells the new
 * segments' surfaces cover, and takes the build back. The cell index is
 * not asked until the network is as it was, so it never sees the change.
 */
function cellsCoveredBy(state: SimState, build: (net: RoadNetwork) => boolean): number[] {
  const index = syncCells(state);
  const net = state.roads;
  startJournal(net);
  let ops: NetworkOp[] | null = null;
  try {
    if (!build(net)) return [];
    ops = endJournal(net);
    const added = new Set<number>();
    for (const op of ops) {
      if (op.op === "addSeg") added.add(op.id);
      else if (op.op === "removeSeg") added.delete(op.id);
    }
    return openCellsUnder(index, net, [...added].sort((p, q) => p - q));
  } finally {
    reverseOps(net, ops ?? endJournal(net));
  }
}

/**
 * The buildings a new road would clear: the ones with a cell under its
 * surface. The command finds the same once the cells settle (upkeep.ts).
 * The pieces of a road it splits keep their cells, and the buildings on
 * them stand.
 */
export function roadClears(state: SimState, plan: RoadPlan): BuildingsInTheWay {
  const terrain = terrainOf(state.seed);
  const keys = cellsCoveredBy(state, (net) => {
    buildRoad(net, terrain, plan);
    return true;
  });
  return inTheWay(state, buildingsOnCells(state, keys, CELL_KEY_STRIDE));
}

/** The buildings a grid would clear, as `roadClears` says for each street. None for a grid a street of which is refused. */
export function gridClears(state: SimState, plan: GridPlan): BuildingsInTheWay {
  const terrain = terrainOf(state.seed);
  const keys = cellsCoveredBy(state, (net) => buildRoadGrid(net, terrain, plan) === null);
  return inTheWay(state, buildingsOnCells(state, keys, CELL_KEY_STRIDE));
}

/** `planRoad` on `state`, with the buildings the road would clear. For the road tool's preview. */
export function previewBuildRoad(state: SimState, payload: unknown): { ok: true; plan: RoadPlan; clears: BuildingsInTheWay } | { ok: false; reason: string } {
  const result = planRoad(state.roads, terrainOf(state.seed), payload);
  return result.ok ? { ...result, clears: roadClears(state, result.plan) } : result;
}

/** `planRoadGrid` on `state`, with the buildings the grid would clear. For the grid tool's preview. */
export function previewBuildRoadGrid(state: SimState, payload: unknown): { ok: true; plan: GridPlan; clears: BuildingsInTheWay } | { ok: false; reason: string } {
  const result = planRoadGrid(state.roads, terrainOf(state.seed), payload);
  return result.ok ? { ...result, clears: gridClears(state, result.plan) } : result;
}

/** `planBulldoze` on `state`, with the buildings the bulldoze would clear. For the bulldoze tool's preview. */
export function previewBulldozeRoad(state: SimState, payload: unknown): { ok: true; plan: BulldozePlan; clears: BuildingsInTheWay } | { ok: false; reason: string } {
  const result = planBulldoze(state.roads, payload);
  return result.ok ? { ...result, clears: bulldozeClears(state, result.plan) } : result;
}
