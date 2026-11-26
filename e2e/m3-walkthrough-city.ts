// The cities the M3 walkthrough opens (issue M3-22), built in Node through
// ordinary commands by the player id "fixture", so their logs replay from
// the seed. Nothing here holds the demand bars: M3's exit test is about
// demand, so every city runs on its own economy.
//
// The town sits on seed 2026's flat ground between the west outside
// connection, whose stub ends at (200, 3608) heading east, and the sea to
// the south. A street runs east from the stub, a spine runs south from it
// at x = 440, and four streets cross the spine, the last along the shore:
//
//   z = 3608  main street, from the stub east to x = 680
//   z = 3800  shops (south side) and offices and mixed ground (north side)
//   z = 4000  houses on both sides
//   z = 4200  houses (north side) and the R3 lot (south side)
//   z = 4400  the shore street, from x = 320, its north side by the water
//
// Factories go on the main street's south side, so its north side is the
// strip beside factories that step 7 compares with the shore. Each street
// is two pieces between junctions, west of the spine and east of it.

import {
  CELL_OPEN,
  ROAD_TYPES,
  TIME_BALANCE,
  ZONING_BALANCE,
  cellAt,
  createState,
  creditMilestones,
  demandPull,
  deserialize,
  isAbandoned,
  seeBuilding,
  serialize,
  step,
  submit,
  type BuildingSeen,
  type SimState,
} from "../packages/sim/src/index";
import { buildRoads } from "./road-fixtures";

export const SEED = 2026;
export const CELL = ZONING_BALANCE.cellSize;
export const HALF = (ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0) / 2;
const DAY = TIME_BALANCE.ticksPerDay;

/** West end, spine and east end of the town's streets. */
export const X0 = 200;
export const XM = 440;
export const X1 = 680;
/** The streets west to east, by their z. */
export const MAIN = 3608;
export const SHOPS = 3800;
export const HOMES = 4000;
export const UPPER = 4200;
export const SHORE = 4400;
/** The shore street starts east of the water's edge. */
export const SHORE_X0 = 320;

/** One side of one piece of a street: what the zone tool's fill takes in one click. */
export interface Strip {
  /** The street's z. */
  z: number;
  /** West or east of the spine. */
  piece: "west" | "east";
  /** North is -z, south +z. */
  side: "north" | "south";
}

const sign = (s: Strip): 1 | -1 => (s.side === "south" ? 1 : -1);
const span = (s: Strip): [number, number] => (s.piece === "west" ? [s.z === SHORE ? SHORE_X0 : X0, XM] : [XM, X1]);

/** The ground point in the middle of `strip`, in its `depth`th row of cells from the road (0 is the first), for a hover or a cell read. */
export function stripCell(s: Strip, depth = 0): [number, number] {
  const [a, b] = span(s);
  return [Math.round((a + b) / 2) + CELL / 2, s.z + sign(s) * (HALF + CELL / 2 + depth * CELL)];
}

/** Where the zone tool's fill is clicked for `strip`: beside the road's edge, half way along the piece. */
export function fillPoint(s: Strip): [number, number] {
  const [a, b] = span(s);
  return [(a + b) / 2, s.z + sign(s) * (HALF / 2)];
}

/** The town's streets, joined to the outside connection, nothing zoned. */
function townRoads(state: SimState): void {
  buildRoads(state, [
    [[X0, MAIN], [X1, MAIN], "street"],
    [[XM, MAIN], [XM, SHORE], "street"],
    [[X0, SHOPS], [X1, SHOPS], "street"],
    [[X0, HOMES], [X1, HOMES], "street"],
    [[X0, UPPER], [X1, UPPER], "street"],
    [[SHORE_X0, SHORE], [X1, SHORE], "street"],
  ]);
}

let seq = 10_000;
/** Submits a command as the fixture player and steps once, throwing on a refusal. */
function send(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, { seq: ++seq, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
}

/** Zones `strip` `depth` cells deep in one ZoneCells, as the zone tool's fill would. */
function zone(state: SimState, s: Strip, zoneId: string, density: number, depth: number): void {
  const [a, b] = span(s);
  const mid = s.z + sign(s) * (HALF + (depth * CELL) / 2);
  send(state, "ZoneCells", { zone: zoneId, density, rects: [{ from: { x: a + 6, z: mid }, to: { x: b - 6, z: mid }, width: depth * CELL - 2 }] });
}

/**
 * A new city on the walkthrough's seed with every milestone credited, without
 * grants (M4-12), so the town zones densities 2 and 3 as it did before the
 * locks. The page's replay starts from one credited the same way.
 */
export function creditedCity(): SimState {
  const state = createState(SEED);
  creditMilestones(state);
  return state;
}

/** The town as step 1 opens it: streets, nothing zoned, paused by a command so a replay pauses too. */
export function townCity(): SimState {
  const state = creditedCity();
  townRoads(state);
  send(state, "SetSpeed", { speed: 0 });
  return state;
}

/** Live buildings of `zone` (1 is residential) whose lot starts on `strip`'s run of cells, optionally of one density. */
export function onStrip(state: SimState, s: Strip, zoneNumber: number, density?: number): number[] {
  const [x, z] = stripCell(s);
  const cell = cellAt(state, x, z);
  const out: number[] = [];
  if (!cell) return out;
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) {
    if (!b.flags[id] || b.zone[id] !== zoneNumber || (density !== undefined && b.density[id] !== density)) continue;
    if (b.firstSeg[id] === cell.segment && b.firstSide[id] === cell.side) out.push(id);
  }
  return out;
}

/** The houses step 11 rezones: the home street's north side west of the spine. */
export const REZONED: Strip = { z: HOMES, piece: "west", side: "north" };

const runDay = (state: SimState): void => {
  const until = state.tick + DAY;
  while (state.tick < until) step(state);
};

/**
 * Step 11's city: the town grown with homes, shops, factories and offices
 * until residential demand is high, then the houses of `REZONED` zoned up to
 * R3, and run on until the first of them is about to give way to a tower.
 * Returned at the start of the game day it does, paused, so the page has
 * at most a game day to run. Redevelopment is a daily draw that took game
 * months on this town, which the walkthrough cannot wait for in the page.
 */
export function redevelopmentCity(): { bytes: Uint8Array; rezonedOnDay: number; houses: number[] } {
  const state = creditedCity();
  townRoads(state);
  for (const piece of ["west", "east"] as const) {
    zone(state, { z: HOMES, piece, side: "north" }, "residential", 1, 6);
    zone(state, { z: HOMES, piece, side: "south" }, "residential", 1, 6);
    zone(state, { z: UPPER, piece, side: "north" }, "residential", 1, 6);
  }
  for (let d = 0; d < 40; d++) runDay(state);
  for (const piece of ["west", "east"] as const) {
    zone(state, { z: SHOPS, piece, side: "south" }, "commercial", 1, 6);
    zone(state, { z: MAIN, piece, side: "south" }, "industrial", 1, 6);
  }
  zone(state, { z: SHOPS, piece: "west", side: "north" }, "office", 1, 5);
  zone(state, { z: UPPER, piece: "east", side: "south" }, "office", 2, 5);
  zone(state, { z: SHORE, piece: "east", side: "south" }, "office", 2, 4);
  zone(state, { z: MAIN, piece: "west", side: "north" }, "industrial", 1, 5);
  // Until homes are wanted, then the houses zoned up.
  // The pull, not the bar as shown: since #420 the bar's last part takes away what the homes still filling hold back.
  for (let d = 0; d < 400 && demandPull(state.demand, "residential") <= 15; d++) runDay(state);
  if (demandPull(state.demand, "residential") <= 15) throw new Error(`residential demand did not rise past 15: ${demandPull(state.demand, "residential")}`);
  const houses = onStrip(state, REZONED, 1, 1);
  if (houses.length < 4) throw new Error(`only ${houses.length} houses to rezone`);
  zone(state, REZONED, "residential", 3, 6);
  const rezonedOnDay = Math.floor(state.tick / DAY);
  // Run whole days, keeping the city as it was at the start of each, until a tower stands on the strip.
  while (state.tick % DAY !== 0) step(state);
  for (let d = 0; d < 600; d++) {
    const dayStart = serialize(state);
    runDay(state);
    if (onStrip(state, REZONED, 1, 3).length > 0) {
      const city = deserialize(dayStart).state;
      // Paused by a command, so the page runs only what it asks for and a replay pauses too.
      send(city, "SetSpeed", { speed: 0 });
      return { bytes: serialize(city), rezonedOnDay, houses };
    }
  }
  throw new Error("no tower replaced a house in 600 game days");
}

/** Whether every cell of `strip`, `depth` rows deep, is open ground: a check on the layout, for the fixture's test. */
export function stripOpen(state: SimState, s: Strip, depth: number): { open: number; all: number } {
  const [a, b] = span(s);
  let open = 0;
  let all = 0;
  for (let x = a + CELL; x < b - CELL; x += CELL) {
    for (let d = 0; d < depth; d++) {
      all++;
      const c = cellAt(state, x, s.z + sign(s) * (HALF + CELL / 2 + d * CELL));
      if (c && c.status === CELL_OPEN) open++;
    }
  }
  return { open, all };
}

/**
 * Step 9's abandonment: the town grown with homes, shops and factories,
 * then every workplace bulldozed and its ground unzoned, and run on until
 * the first home is about to be abandoned. Returned at the start of that
 * game day, paused. A home is abandoned after 90 game days vacant while the
 * residential bar is at or below zero: game months the walkthrough does not
 * wait for in the page. Until #361 the pull from outside also refilled the
 * town's homes before any stood vacant that long.
 */
export function abandonmentCity(): { bytes: Uint8Array; bulldozedOnDay: number } {
  const state = creditedCity();
  townRoads(state);
  for (const piece of ["west", "east"] as const) {
    zone(state, { z: HOMES, piece, side: "north" }, "residential", 1, 6);
    zone(state, { z: HOMES, piece, side: "south" }, "residential", 1, 6);
    zone(state, { z: UPPER, piece, side: "north" }, "residential", 1, 6);
    // Apartments and towers, so the town grows well past the 500 residents of the pull from outside, and plenty of homes stand empty once the work goes.
    zone(state, { z: UPPER, piece, side: "south" }, "residential", 3, 5);
    zone(state, { z: SHORE, piece, side: "north" }, "residential", 2, 4);
  }
  for (let d = 0; d < 40; d++) runDay(state);
  const work: Strip[] = [];
  for (const piece of ["west", "east"] as const) {
    work.push({ z: SHOPS, piece, side: "south" }, { z: MAIN, piece, side: "south" });
    zone(state, { z: SHOPS, piece, side: "south" }, "commercial", 1, 6);
    zone(state, { z: MAIN, piece, side: "south" }, "industrial", 1, 6);
    work.push({ z: SHOPS, piece, side: "north" });
    zone(state, { z: SHOPS, piece, side: "north" }, "office", 2, 5);
  }
  for (let d = 0; d < 120; d++) runDay(state);
  const b = state.buildings;
  const seen: BuildingSeen[] = [];
  for (let id = 0; id < b.flags.length; id++) {
    if (!b.flags[id] || b.zone[id] === 1) continue;
    const one = seeBuilding(b, id);
    if (one) seen.push(one);
  }
  if (seen.length < 10) throw new Error(`only ${seen.length} workplaces to bulldoze`);
  if ((state.stats.totals["population"] ?? 0) < 1000) throw new Error(`only ${state.stats.totals["population"]} residents before the bulldoze`);
  send(state, "BulldozeBuilding", { buildings: seen });
  for (const strip of work) zone(state, strip, "none", 1, 6);
  const bulldozedOnDay = Math.floor(state.tick / DAY);
  while (state.tick % DAY !== 0) step(state);
  const abandoned = (s: SimState): number => {
    let n = 0;
    for (let id = 0; id < s.buildings.flags.length; id++) if (s.buildings.flags[id] && isAbandoned(s.buildings, id)) n++;
    return n;
  };
  for (let d = 0; d < 600; d++) {
    const dayStart = serialize(state);
    runDay(state);
    if (abandoned(state) > 0) {
      const city = deserialize(dayStart).state;
      send(city, "SetSpeed", { speed: 0 });
      return { bytes: serialize(city), bulldozedOnDay };
    }
  }
  throw new Error("no home was abandoned in 600 game days");
}
