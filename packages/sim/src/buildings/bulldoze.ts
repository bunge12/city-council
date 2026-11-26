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
// under the cells' current zoning. Clearing is charged at the eminent
// domain price (economy/compensation.ts, M4-09).
//
// The previews give a road command's plan, the buildings it would clear
// with their compensation (M4-09), `price`, what the command charges: the
// plan's `cost` plus the compensation, and `refusal`: why the treasury
// cannot pay it, or null (M4-03). A refused plan is still a plan, so the
// tools can show its price and the reason together. The commands call the
// same functions, so the price shown is the price charged.

import { chargeCompensation, compensationFor, type Compensation } from "../economy/compensation";
import { spendingRefusal } from "../economy/spend";
import { planBulldoze, planUpgrade, upgradeRoad, type BulldozePlan, type UpgradePlan } from "../roads/edit";
import { buildRoad, planRoad, type RoadPlan } from "../roads/build";
import { buildRoadGrid, gridProblemReason, planRoadGrid, type GridPlan, type GridProblem } from "../roads/grid";
import { endJournal, reverseOps, startJournal, type NetworkOp, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { newCellsOf, openCellsUnder, syncCells, type CellIndex } from "../zoning/cell-index";
import { BUILDINGS_BALANCE } from "./balance";
import { popIndexOf } from "../pops/where";
import { isBuilding, removeBuildings, type BuildingState } from "./buildings";
import { buildingsOnCells, buildingsOnCellsBefore, buildingsOnSegments, buildingsOnStretch } from "./where";

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

/**
 * The people living in building `id`. The sim reads its own pops
 * (`buildingPeople`); a client's copy holds no pop rows, so it passes the
 * people its mirror keeps for each building (M3-05).
 */
export type PeopleIn = (id: number) => number;

/** The sim's own `PeopleIn`: the pop index read once, so a plan over thousands of buildings looks it up once. */
function peopleOf(state: SimState): PeopleIn {
  const people = popIndexOf(state).people;
  return (id) => people[id] ?? 0;
}

/**
 * The jobs filled in building `id`, as `PeopleIn` gives its residents: the
 * sim's from its pops (`jobsFilled`), a client's copy from its mirror.
 */
export type FilledIn = PeopleIn;

/** The sim's own `FilledIn`. */
function filledOf(state: SimState): FilledIn {
  const filled = popIndexOf(state).filled;
  return (id) => filled[id] ?? 0;
}

/**
 * The building ids a `BulldozeBuilding` payload names, ascending, the
 * people living in them, who would be displaced (M3-12), what clearing
 * them costs (M4-09), and why the treasury cannot pay it, or null; or the
 * reason it cannot apply to `state` at all. Changes nothing.
 */
export function planBulldozeBuildings(
  state: SimState,
  payload: unknown,
  people: PeopleIn = peopleOf(state),
  filled: FilledIn = filledOf(state),
): { ok: true; ids: number[]; residents: number; compensation: Compensation; refusal: Refusal } | { ok: false; reason: string } {
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
  const sorted = [...ids].sort((p, q) => p - q);
  let residents = 0;
  for (const id of sorted) residents += people(id);
  const compensation = compensationFor(state, sorted, people, filled);
  return { ok: true, ids: sorted, residents, compensation, refusal: spendingRefusal(state, compensation.total) };
}

/**
 * Charges what clearing `ids` costs, `compensation` as a plan priced it, on
 * the compensation line, and records each occupied one for `playerId`
 * (economy/compensation.ts). The commands call it before the buildings or
 * the road under them go, while their pops and lots are as the plan saw them.
 */
export function chargeClears(state: SimState, playerId: string, clears: Pick<BuildingsInTheWay, "ids" | "compensation">): void {
  chargeCompensation(state, playerId, clears.ids, clears.compensation, peopleOf(state), filledOf(state));
}

/** Removes the buildings a plan named, in ascending id order. */
export function bulldozeBuildings(state: SimState, ids: readonly number[]): void {
  removeBuildings(state, ids);
}

/** The buildings a road command would clear, for a preview. */
export interface BuildingsInTheWay {
  /** Building ids, ascending. */
  ids: number[];
  /** The people living in them, added up: the residents who would be displaced (M3-12), not the room the buildings hold. */
  residents: number;
  /** What clearing them costs, which the command charges on the compensation line (M4-09). */
  compensation: Compensation;
}

function inTheWay(state: SimState, ids: number[], people: PeopleIn, filled: FilledIn): BuildingsInTheWay {
  let residents = 0;
  for (const id of ids) residents += people(id);
  return { ids, residents, compensation: compensationFor(state, ids, people, filled) };
}

/**
 * The buildings that stand on the cells of the segments a bulldoze removes,
 * or of the stretch of each it cuts out. Their cells go with the road, so
 * the command removes them at once.
 */
export function bulldozeClears(state: SimState, plan: BulldozePlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): BuildingsInTheWay {
  const cut = new Set(plan.sections.map((s) => s.seg));
  const ids = new Set(buildingsOnSegments(state, plan.segments.filter((seg) => !cut.has(seg))));
  for (const s of plan.sections) for (const id of buildingsOnStretch(state, s.seg, s.from, s.to)) ids.add(id);
  return inTheWay(state, [...ids].sort((p, q) => p - q), people, filled);
}

/**
 * Builds on `net` with its journal open, hands `read` the segments the
 * build added, ascending, with the cell index as it was before the build,
 * and takes the build back. `read` must not sync the index, so once the
 * network is as it was the index has never seen the change.
 */
function rehearse<T>(state: SimState, build: (net: RoadNetwork) => boolean, read: (index: CellIndex, added: number[]) => T, none: T): T {
  const index = syncCells(state);
  const net = state.roads;
  startJournal(net);
  let ops: NetworkOp[] | null = null;
  try {
    if (!build(net)) return none;
    ops = endJournal(net);
    return read(index, segmentsAdded(ops));
  } finally {
    reverseOps(net, ops ?? endJournal(net));
  }
}

/**
 * The segments a journal added or restyled and left standing, ascending:
 * the ones whose surface may cover ground. A restyled segment counts, as an
 * upgrade's wider surface covers ground its old one did not.
 */
function segmentsAdded(ops: readonly NetworkOp[]): number[] {
  const added = new Set<number>();
  for (const op of ops) {
    if (op.op === "addSeg" || op.op === "restyle") added.add(op.id);
    else if (op.op === "removeSeg") added.delete(op.id);
  }
  return [...added].sort((p, q) => p - q);
}

/** The open cells the new segments' surfaces would cover, by key. */
function cellsCoveredBy(state: SimState, build: (net: RoadNetwork) => boolean): number[] {
  return rehearse(state, build, (index, added) => openCellsUnder(index, state.roads, added), []);
}

/** What a road or grid would do to the ground: the buildings it would clear and the cells it would open. */
export interface RoadEffects {
  clears: BuildingsInTheWay;
  /** The open cells on its own new segments, eight corner numbers a cell (`newCellsOf`). */
  cells: Float64Array;
}

/**
 * The buildings a build would clear and the cells it would open, from one
 * rehearsal. The pieces of a road it splits keep their cells, so only
 * segments with a new build order bring cells.
 */
function effectsOf(state: SimState, build: (net: RoadNetwork) => boolean, people: PeopleIn, filled: FilledIn): RoadEffects {
  const firstNew = state.roads.segOrderNext;
  const { lost, cells } = rehearse(
    state,
    build,
    (index, added) => {
      const net = state.roads;
      const lost = openCellsUnder(index, net, added);
      return { lost, cells: newCellsOf(index, net, added.filter((id) => (net.segOrder[id] ?? 0) >= firstNew), new Set(lost)) };
    },
    { lost: [] as number[], cells: new Float64Array(0) },
  );
  // Asked once the build is taken back: the building index follows the cell index, which must not see the rehearsal.
  return { clears: inTheWay(state, buildingsOnCells(state, lost, CELL_KEY_STRIDE), people, filled), cells };
}

/**
 * The buildings a new road would clear, as `roadClears` finds them, and
 * the cells it would bring that a player could zone: open, on its own
 * segments. For the road tool's preview, so the player sees the lots a
 * road makes before building it.
 */
export function roadEffects(state: SimState, plan: RoadPlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): RoadEffects {
  const terrain = terrainOf(state.seed);
  return effectsOf(
    state,
    (net) => {
      buildRoad(net, terrain, plan);
      return true;
    },
    people,
    filled,
  );
}

/** As `roadEffects`, for every street of a grid. Nothing for a grid a street of which is refused. */
export function gridEffects(state: SimState, plan: GridPlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): RoadEffects {
  const terrain = terrainOf(state.seed);
  return effectsOf(state, (net) => buildRoadGrid(net, terrain, plan) === null, people, filled);
}

/**
 * The buildings a new road would clear: the ones with a cell under its
 * surface. The command finds the same once the cells settle (upkeep.ts).
 * The pieces of a road it splits keep their cells, and the buildings on
 * them stand.
 */
export function roadClears(state: SimState, plan: RoadPlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): BuildingsInTheWay {
  const terrain = terrainOf(state.seed);
  const keys = cellsCoveredBy(state, (net) => {
    buildRoad(net, terrain, plan);
    return true;
  });
  return inTheWay(state, buildingsOnCells(state, keys, CELL_KEY_STRIDE), people, filled);
}

/** The buildings a grid would clear, as `roadClears` says for each street. None for a grid a street of which is refused. */
export function gridClears(state: SimState, plan: GridPlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): BuildingsInTheWay {
  return gridRehearsal(state, plan, people, filled).clears;
}

/**
 * One rehearsal of a grid: the street it is refused at, or null, and the
 * buildings it would clear, none when refused. For the grid tool's
 * preview and `BuildRoadGrid`'s `validate`.
 */
export function gridRehearsal(state: SimState, plan: GridPlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): { problem: GridProblem | null; clears: BuildingsInTheWay } {
  const terrain = terrainOf(state.seed);
  let problem: GridProblem | null = null;
  const keys = cellsCoveredBy(state, (net) => {
    problem = buildRoadGrid(net, terrain, plan);
    return problem === null;
  });
  return { problem, clears: inTheWay(state, buildingsOnCells(state, keys, CELL_KEY_STRIDE), people, filled) };
}

/**
 * The buildings an upgrade would clear: the ones with a cell under the
 * wider surface of a segment it restyles, or of a piece it cuts, as a new
 * road's (PRD, "Eminent domain": widening a road into a lot counts).
 */
export function upgradeClears(state: SimState, plan: UpgradePlan, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): BuildingsInTheWay {
  const terrain = terrainOf(state.seed);
  const keys = cellsCoveredBy(state, (net) => {
    upgradeRoad(net, terrain, plan);
    return true;
  });
  return inTheWay(state, buildingsOnCells(state, keys, CELL_KEY_STRIDE), people, filled);
}

/** Why the treasury of `state` cannot pay a plan's cost, or null: what the command would be refused with. */
export type Refusal = string | null;

/** What a road command's preview gives besides its plan: the buildings it clears, its price and why it is refused for money. */
export interface RoadPreview<P> {
  ok: true;
  plan: P;
  clears: BuildingsInTheWay;
  /** Whole dollars the command charges: the plan's `cost` plus the compensation for the buildings it clears. */
  price: number;
  refusal: Refusal;
}

function priced<P extends { cost: number }>(state: SimState, plan: P, clears: BuildingsInTheWay): RoadPreview<P> {
  const price = plan.cost + clears.compensation.total;
  return { ok: true, plan, clears, price, refusal: spendingRefusal(state, price) };
}

/**
 * `planRoad` on `state`, with the buildings the road would clear and their
 * compensation, the price, and why the treasury cannot pay it, or null.
 * For the road tool's preview, and what `BuildRoad` checks and charges.
 */
export function previewBuildRoad(state: SimState, payload: unknown, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): RoadPreview<RoadPlan> | { ok: false; reason: string } {
  const result = planRoad(state.roads, terrainOf(state.seed), payload);
  return result.ok ? priced(state, result.plan, roadClears(state, result.plan, people, filled)) : result;
}

/**
 * Why a grid that would clear `count` buildings is refused. A grid never
 * demolishes: it is drawn on open ground, and may cross or join streets
 * where no building stands on the ground it covers (M4-09).
 */
export function gridClearsReason(count: number): string {
  return `A grid can't demolish buildings, and this one would take ${count === 1 ? "1 building" : `${count} buildings`}. Move it, or bulldoze them first`;
}

/**
 * Builds the grid `plan` on `state` with the network's journal open and
 * returns what it wrote, or takes it back and says why it is refused: the
 * street a refusal came from, or the buildings it would clear
 * (`gridClearsReason`). One build, with no rehearsal: which cells it covers
 * is read with the build standing, against the cells and buildings as they
 * were before it (`buildingsOnCellsBefore`), as a rehearsal reads them.
 */
export function buildGridOnOpenGround(state: SimState, plan: GridPlan): { ok: true; ops: NetworkOp[] } | { ok: false; reason: string } {
  const terrain = terrainOf(state.seed);
  const index = syncCells(state);
  const buildingsOn = buildingsOnCellsBefore(state);
  const net = state.roads;
  startJournal(net);
  let problem: GridProblem | null = null;
  let ops: NetworkOp[];
  try {
    problem = buildRoadGrid(net, terrain, plan);
  } finally {
    ops = endJournal(net);
    if (problem !== null) reverseOps(net, ops);
  }
  if (problem !== null) return { ok: false, reason: gridProblemReason(plan, problem) };
  const clears = buildingsOn(openCellsUnder(index, net, segmentsAdded(ops)), CELL_KEY_STRIDE);
  if (clears.length > 0) {
    reverseOps(net, ops);
    return { ok: false, reason: gridClearsReason(clears.length) };
  }
  return { ok: true, ops };
}

/**
 * `planRoadGrid` on `state`, with the buildings it would clear, for the
 * grid tool's preview and `BuildRoadGrid`'s check. A grid a street of which
 * is refused clears nothing, and `problem` says where it is refused, or is
 * null. A grid never demolishes, so one that would clear a building is
 * refused (`gridClearsReason`), and `price` is the grid's cost alone.
 */
export function previewBuildRoadGrid(
  state: SimState,
  payload: unknown,
  people: PeopleIn = peopleOf(state),
  filled: FilledIn = filledOf(state),
): (RoadPreview<GridPlan> & { problem: GridProblem | null }) | { ok: false; reason: string } {
  const result = planRoadGrid(state.roads, terrainOf(state.seed), payload);
  if (!result.ok) return result;
  const { problem, clears } = gridRehearsal(state, result.plan, people, filled);
  const price = result.plan.cost;
  const refusal = clears.ids.length > 0 ? gridClearsReason(clears.ids.length) : spendingRefusal(state, price);
  return { ok: true, plan: result.plan, clears, price, refusal, problem };
}

/** `planBulldoze` on `state`, priced: the road's demolition less its refund, plus the compensation for the buildings on it. For the bulldoze tool's preview. */
export function previewBulldozeRoad(state: SimState, payload: unknown, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): RoadPreview<BulldozePlan> | { ok: false; reason: string } {
  const result = planBulldoze(state.roads, payload);
  return result.ok ? priced(state, result.plan, bulldozeClears(state, result.plan, people, filled)) : result;
}

/** `planUpgrade` on `state`, priced with the buildings a wider road clears. For the upgrade tool's preview. */
export function previewUpgradeRoad(state: SimState, payload: unknown, people: PeopleIn = peopleOf(state), filled: FilledIn = filledOf(state)): RoadPreview<UpgradePlan> | { ok: false; reason: string } {
  const result = planUpgrade(state.roads, terrainOf(state.seed), payload);
  return result.ok ? priced(state, result.plan, upgradeClears(state, result.plan, people, filled)) : result;
}
