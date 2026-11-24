// Which homes newcomers can move into (M3-08, PRD "M3 Demand").
//
// A home takes newcomers while it has room left and its road is on a piece
// that reaches an outside connection (roads/outside.ts): people arrive
// through the connections, so a street joined to nothing builds and stays
// empty. A home of a type with `oneHousehold`, the single family home,
// takes one household however few people it holds, so it has no room left
// once anyone lives there. An abandoned home (M3-24) offers no room at all,
// so newcomers pass it by and it holds no new homes back here: it waits
// for the vacancy check to bring it back into use (buildings/vacancy.ts).
//
// Everything here is worked out from state when it is asked for, with one
// pass over the buildings, and nothing is kept: the arrivals system asks on
// the ticks people are due, and the grower once on a tick it adds a home.
// `reachableRoom` also counts the homes still filling, which hold new homes
// back (M3-21, `homeUnfilled`), and its empty room sets how many people
// arrive a day (arrivals.ts).

import { BUILDING_TYPES } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE, homeRoom, isAbandoned, isBuilding } from "../buildings/buildings";
import { NETWORK_ROAD } from "../roads/network";
import { outsideReachByNode } from "../roads/outside";
import type { SimState } from "../state";
import { DEMAND_BALANCE } from "../demand/balance";
import { POPS_BALANCE } from "./balance";
import { popIndexOf } from "./where";

/** By type index: 1 for a type one household lives in. */
const ONE_HOUSEHOLD = Uint8Array.from(BUILDING_TYPES, (t) => (t.oneHousehold ? 1 : 0));

/**
 * By density, 1 to 3: the fewest people a newcomer household holds there,
 * the least of `newcomer.size` in pops.json. A home takes newcomers only
 * while its room left fits that many (M3-11): a place freed by a death in a
 * tower waits for others beside it rather than taking a pop of one, so pops
 * do not wear down to single people as turnover runs.
 */
export function leastNewcomers(density: number): number {
  const sizes = POPS_BALANCE.newcomer.size;
  return sizes[Math.min(sizes.length, Math.max(1, density)) - 1]?.[0] ?? 1;
}

/** `left`, the room a home of `density` has left, as newcomers can use it: 0 when it is below the least household there. */
function usableRoom(left: number, density: number): number {
  return left >= leastNewcomers(density) ? left : 0;
}

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
  const room = homeRoom(b, id) - people;
  return room > 0 ? room : 0;
}

/** Whether live building `id`'s road reaches an outside connection: a home newcomers can reach, or a workplace they can (M3-09). */
export function buildingReachesOutside(state: SimState, id: number): boolean {
  return isBuilding(state.buildings, id) && roadReaches(state, outsideReachByNode(state), id);
}

/** Whether live building `id` is a home whose road reaches an outside connection, so newcomers can reach it. */
export function homeReachesOutside(state: SimState, id: number): boolean {
  if (!isBuilding(state.buildings, id) || homeRoom(state.buildings, id) <= 0) return false;
  return roadReaches(state, outsideReachByNode(state), id);
}

/** The people building `id` may still take: 0 for a building nobody lives in or one that is not there. */
export function homeRoomLeft(state: SimState, id: number): number {
  if (!isBuilding(state.buildings, id)) return 0;
  return roomFor(state, id, popIndexOf(state).people[id] ?? 0);
}

/** The room building `id` has left for a newcomer household: `homeRoomLeft`, or 0 when that is below the least household for its density. */
export function newcomerRoomLeft(state: SimState, id: number): number {
  return usableRoom(homeRoomLeft(state, id), state.buildings.density[id] ?? 1);
}

/** The homes newcomers can reach: their room, how much of it is empty, and how many of them are still filling. */
export interface ReachableRoom {
  /** The people they hold room for. */
  capacity: number;
  /** The people they may still take. A household home with anyone in it has none, and nor does a home with less room left than the least newcomer household there. */
  empty: number;
  /** The homes still filling: room left for a newcomer household, and fewer people than `homeFullShare` of their room (M3-21, `homeUnfilled`). */
  unfilled: number;
}

/**
 * Whether a home of `room` places with `left` of them usable by a newcomer
 * household is still filling, for the grower's hold on new homes (M3-21):
 * it has room left for a household and fewer people in it than
 * `homeFullShare` of its room (demand.json). A tower that a death or two
 * has left a few places short counts as full, so turnover does not hold the
 * city's new homes back.
 */
export function homeUnfilled(room: number, left: number): boolean {
  return left > 0 && room - left < DEMAND_BALANCE.homeFullShare * room;
}

/**
 * One pass over the buildings: calls `visit` with each live home, abandoned ones aside, whose road
 * reaches outside, its room and the room it has left, in id order. The one
 * loop both questions below share, kept tight: it runs over every building
 * on the ticks people are due and before each home the grower adds.
 */
function eachReachableHome(state: SimState, visit: (id: number, room: number, left: number) => void, people: ArrayLike<number> = popIndexOf(state).people): void {
  const b = state.buildings;
  const net = state.roads;
  const reach = outsideReachByNode(state);
  const { flags, residents, firstSeg, type, density } = b;
  const { segNetwork, segA } = net;
  // Imported constants as locals: under the test runner each import is a
  // property read on a module object (roads/outside.ts).
  const alive = BUILDING_ALIVE;
  const abandoned = BUILDING_ABANDONED;
  const road = NETWORK_ROAD;
  const oneHousehold = ONE_HOUSEHOLD;
  const n = flags.length;
  for (let id = 0; id < n; id++) {
    const room = residents[id] as number;
    const f = flags[id] as number;
    if (room <= 0 || (f & alive) === 0 || (f & abandoned) !== 0) continue;
    const seg = firstSeg[id] as number;
    if (segNetwork[seg] !== road || reach[segA[seg] as number] !== 1) continue;
    const living = people[id] ?? 0;
    const left = living > 0 && oneHousehold[type[id] as number] === 1 ? 0 : room - living;
    visit(id, room, left > 0 ? usableRoom(left, density[id] as number) : 0);
  }
}

/** The room in every home newcomers can reach, and how much of it is empty. One pass over the buildings. */
export function reachableRoom(state: SimState): ReachableRoom {
  return reachableRoomWith(state, popIndexOf(state).people);
}

/**
 * `reachableRoom`, with the people living in each building read from
 * `people`, by building id, and not from the pops. A client's copy holds
 * no current pops, only each building's people (M3-05), so its residential
 * tooltip asks this to say when new homes are held (#330). Reads only the
 * buildings, the roads and the outside connections besides.
 */
export function reachableRoomWith(state: SimState, people: ArrayLike<number>): ReachableRoom {
  let capacity = 0;
  let empty = 0;
  let unfilled = 0;
  eachReachableHome(
    state,
    (_, room, left) => {
      capacity += room;
      empty += left;
      if (homeUnfilled(room, left)) unfilled++;
    },
    people,
  );
  return { capacity, empty, unfilled };
}

/**
 * The homes newcomers can move into now, ascending by id: each with room
 * left for at least the least newcomer household there, on a road that
 * reaches outside. One pass over the buildings.
 */
export function homesWithRoom(state: SimState): number[] {
  return homesAndEmptyRoom(state).homes;
}

/** `homesWithRoom` and the room they have left for households, `reachableRoom`'s `empty`, from one pass over the buildings, for arrivals (M3-21). */
export function homesAndEmptyRoom(state: SimState): { homes: number[]; empty: number } {
  const homes: number[] = [];
  let empty = 0;
  eachReachableHome(state, (id, _, left) => {
    if (left > 0) {
      homes.push(id);
      empty += left;
    }
  });
  return { homes, empty };
}

/**
 * Why no newcomer would move into home `id` today, whatever room it has:
 * `abandoned` while it is abandoned and offers no room (M3-24), `noRoute`
 * when its road does not reach an outside connection, `noDemand`
 * when the residential bar is at or below zero. Null when newcomers would
 * come, or `id` is not a home. Reads only the buildings, the roads, the
 * outside connections and the bars, so a client's copy answers it too
 * (M3-08).
 */
export function whyNoNewcomers(state: SimState, id: number): "abandoned" | "noRoute" | "noDemand" | null {
  if (!isBuilding(state.buildings, id) || (state.buildings.residents[id] ?? 0) <= 0) return null;
  if (isAbandoned(state.buildings, id)) return "abandoned";
  if (!homeReachesOutside(state, id)) return "noRoute";
  if (state.demand.residential.value <= 0) return "noDemand";
  return null;
}
