// Upkeep (M4-04, PRD "Upkeep is a share of build cost").
//
// Every road costs a share of its build cost each year to keep: its length
// times its type's price per metre, times the bridge multiplier on a
// bridge, times its type's `upkeepShare` (balance/roads.json), rounded to
// whole dollars per segment. The city pays it a day at a time: on each
// day's first tick the UPKEEP system moves that day's share of the yearly
// total onto the road upkeep line, with the exact daily share of M4-02
// (`dailyShare`), so the days of a year add up to the yearly total to the
// dollar. City-owned buildings pay theirs the same way, on the building
// upkeep line.
//
// The yearly total is a running sum, kept by network object like the
// spatial index: built from the segments on first use and kept current by
// the network's observers as segments come, go and change type, so the
// system never walks the segments. It is derived data, never saved or
// hashed. Each segment's figure is whole dollars, so the sum kept through a
// city's history is exactly the one a city loaded from its save builds.
//
// The fixed stubs of the outside connections are not the city's to keep:
// the player never built them and cannot change them, so they cost nothing.
// Rail and paths have no prices yet and cost nothing either.

import { TIME_BALANCE, yearDays } from "../calendar";
import { ROAD_TYPES, type RoadType } from "../roads/balance";
import { LEVEL_BRIDGE, NETWORK_ROAD, SEG_ALIVE, SEG_FIXED, observeNetwork, segmentIdLimit, type RoadNetwork } from "../roads/network";
import type { SimState } from "../state";
import type { System } from "../step";
import { dailyShare, moveMoney } from "./budget";

/**
 * What segment `seg` costs a year to keep, in whole dollars: its build cost,
 * with the bridge multiplier on a bridge, times its type's upkeep share. 0
 * for an outside connection's fixed stub, rail, a path or a removed id. For
 * the road readout and the budget overlay (M4-18).
 *
 * Only multiplication and one rounding, in one fixed order, so every engine
 * gets the same number (CLAUDE.md rule 6).
 */
export function segmentUpkeepPerYear(net: RoadNetwork, seg: number): number {
  const flags = net.segFlags[seg] ?? 0;
  if ((flags & SEG_ALIVE) === 0 || (flags & SEG_FIXED) !== 0 || net.segNetwork[seg] !== NETWORK_ROAD) return 0;
  const type = ROAD_TYPES[net.segType[seg] ?? 0] as RoadType;
  const perMetre = net.segLevelA[seg] === LEVEL_BRIDGE ? type.buildCostPerMetre * type.bridge.costMultiplier : type.buildCostPerMetre;
  return Math.round((net.segLength[seg] ?? 0) * perMetre * type.upkeepShare);
}

/** The yearly upkeep of every segment of `net`, counted from the arrays. For tests and the first build of the running sum. */
export function recountRoadUpkeep(net: RoadNetwork): number {
  let total = 0;
  const limit = segmentIdLimit(net);
  for (let seg = 0; seg < limit; seg++) total += segmentUpkeepPerYear(net, seg);
  return total;
}

/** The running sum for one network. Derived data: not state. */
interface UpkeepSum {
  total: number;
}

const sums = new WeakMap<RoadNetwork, UpkeepSum>();

function sumOf(net: RoadNetwork): UpkeepSum {
  let sum = sums.get(net);
  if (!sum) {
    const made: UpkeepSum = { total: recountRoadUpkeep(net) };
    // Told after a segment is added and before one is removed, while its
    // fields hold their values; a change of type is a removal and an add.
    observeNetwork(net, {
      nodeAdded: () => undefined,
      nodeRemoving: () => undefined,
      segmentAdded: (seg) => void (made.total += segmentUpkeepPerYear(net, seg)),
      segmentRemoving: (seg) => void (made.total -= segmentUpkeepPerYear(net, seg)),
    });
    sums.set(net, made);
    sum = made;
  }
  return sum;
}

/** What the roads of `net` cost a year to keep, in whole dollars: the running sum. Built on first use. */
export function roadUpkeepPerYear(net: RoadNetwork): number {
  return sumOf(net).total;
}

/**
 * What the city's own buildings cost a year to keep, in whole dollars. The
 * city owns none yet: City Hall (M4-13) adds its upkeep here, reading it
 * from the city's state, and services add theirs when they arrive.
 */
export function buildingUpkeepPerYear(): number {
  return 0;
}

/**
 * On a day's first tick, moves that day's share of the yearly road upkeep
 * onto the road upkeep line and of the yearly building upkeep onto the
 * building upkeep line. Does nothing on any other tick. Runs past the
 * overdraft too: a broke city still pays to keep its roads (PRD).
 */
export function chargeUpkeep(state: SimState): void {
  const perDay = TIME_BALANCE.ticksPerDay;
  if (state.tick % perDay !== 0) return;
  const day = Math.floor(state.tick / perDay) % yearDays();
  const roads = dailyShare(roadUpkeepPerYear(state.roads), day);
  if (roads !== 0) moveMoney(state, "roadUpkeep", roads);
  const buildings = dailyShare(buildingUpkeepPerYear(), day);
  if (buildings !== 0) moveMoney(state, "buildingUpkeep", buildings);
}

/** The name the timer hook reports for the upkeep system, as the debug panel shows it. */
export const UPKEEP_SYSTEM = "upkeep";

export const UPKEEP: System = { name: UPKEEP_SYSTEM, run: chargeUpkeep };
