// Which homes newcomers can move into (M3-08, PRD "M3 Demand").
//
// A home takes newcomers while it has room left and its road is on a piece
// that reaches an outside connection (roads/outside.ts): people arrive
// through the connections, so a street joined to nothing builds and stays
// empty. A home of a type with `oneHousehold`, the single family home,
// takes one household however few people it holds, so it has no room left
// once anyone lives there.
//
// Everything here is worked out from state when it is asked for, with one
// pass over the buildings, and nothing is kept: the arrivals system asks on
// the ticks people are due, and the grower once on a tick it adds a home.

import { BUILDING_TYPES } from "../buildings/balance";
import { BUILDING_ALIVE, isBuilding } from "../buildings/buildings";
import { NETWORK_ROAD } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { popIndexOf } from "./where";

/** By type index: 1 for a type one household lives in. */
const ONE_HOUSEHOLD = Uint8Array.from(BUILDING_TYPES, (t) => (t.oneHousehold ? 1 : 0));

/** Whether live building `id`'s road reaches an outside connection, read from `reach` (`outsideReachByNode`). */
function roadReaches(state: SimState, reach: Uint8Array, id: number): boolean {
  const net = state.roads;
  const seg = state.buildings.firstSeg[id] ?? -1;
  return net.segNetwork[seg] === NETWORK_ROAD && reach[net.segA[seg] ?? -1] === 1;
}

/** The people live home `id` may still take, beside the `people` living there now. */
function roomFor(state: SimState, id: number, people: number): number {
  const b = state.buildings;
  if (people > 0 && ONE_HOUSEHOLD[b.type[id] ?? 0] === 1) return 0;
  const room = (b.residents[id] ?? 0) - people;
  return room > 0 ? room : 0;
}

/** Whether live building `id`'s road reaches an outside connection: a home newcomers can reach, or a workplace they can (M3-09). */
export function buildingReachesOutside(state: SimState, id: number): boolean {
  return isBuilding(state.buildings, id) && roadReaches(state, outsideReachByNode(state), id);
}

/** Whether live building `id` is a home whose road reaches an outside connection, so newcomers can reach it. */
export function homeReachesOutside(state: SimState, id: number): boolean {
  if (!isBuilding(state.buildings, id) || (state.buildings.residents[id] ?? 0) <= 0) return false;
  return roadReaches(state, outsideReachByNode(state), id);
}

/** The people building `id` may still take: 0 for a building nobody lives in or one that is not there. */
export function homeRoomLeft(state: SimState, id: number): number {
  if (!isBuilding(state.buildings, id)) return 0;
  return roomFor(state, id, popIndexOf(state).people[id] ?? 0);
}

/** The homes newcomers can reach: their room, and how much of it is empty. */
export interface ReachableRoom {
  /** The people they hold room for. */
  capacity: number;
  /** The people they may still take. A household home with anyone in it has none. */
  empty: number;
}

/**
 * One pass over the buildings: calls `visit` with each live home whose road
 * reaches outside, its room and the room it has left, in id order. The one
 * loop both questions below share, kept tight: it runs over every building
 * on the ticks people are due and before each home the grower adds.
 */
function eachReachableHome(state: SimState, visit: (id: number, room: number, left: number) => void): void {
  const b = state.buildings;
  const net = state.roads;
  const people = popIndexOf(state).people;
  const reach = outsideReachByNode(state);
  const { flags, residents, firstSeg, type } = b;
  const { segNetwork, segA } = net;
  // Imported constants as locals: under the test runner each import is a
  // property read on a module object (roads/outside.ts).
  const alive = BUILDING_ALIVE;
  const road = NETWORK_ROAD;
  const oneHousehold = ONE_HOUSEHOLD;
  const n = flags.length;
  for (let id = 0; id < n; id++) {
    const room = residents[id] as number;
    if (room <= 0 || ((flags[id] as number) & alive) === 0) continue;
    const seg = firstSeg[id] as number;
    if (segNetwork[seg] !== road || reach[segA[seg] as number] !== 1) continue;
    const living = people[id] ?? 0;
    const left = living > 0 && oneHousehold[type[id] as number] === 1 ? 0 : room - living;
    visit(id, room, left > 0 ? left : 0);
  }
}

/** The room in every home newcomers can reach, and how much of it is empty. One pass over the buildings. */
export function reachableRoom(state: SimState): ReachableRoom {
  let capacity = 0;
  let empty = 0;
  eachReachableHome(state, (_, room, left) => {
    capacity += room;
    empty += left;
  });
  return { capacity, empty };
}

/**
 * The homes newcomers can move into now, ascending by id: each with room
 * left, on a road that reaches outside. One pass over the buildings.
 */
export function homesWithRoom(state: SimState): number[] {
  const out: number[] = [];
  eachReachableHome(state, (id, _, left) => {
    if (left > 0) out.push(id);
  });
  return out;
}

/**
 * Why no newcomer would move into home `id` today, whatever room it has:
 * `noRoute` when its road does not reach an outside connection, `noDemand`
 * when the residential bar is at or below zero. Null when newcomers would
 * come, or `id` is not a home. Reads only the buildings, the roads, the
 * outside connections and the bars, so a client's copy answers it too
 * (M3-08).
 */
export function whyNoNewcomers(state: SimState, id: number): "noRoute" | "noDemand" | null {
  if (!isBuilding(state.buildings, id) || (state.buildings.residents[id] ?? 0) <= 0) return null;
  if (!homeReachesOutside(state, id)) return "noRoute";
  if (state.demand.residential.value <= 0) return "noDemand";
  return null;
}
