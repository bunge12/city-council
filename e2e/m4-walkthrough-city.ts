// The cities the M4 walkthrough opens (issue M4-20), built in Node with the
// sim and handed to the page as city files.
//
// `newCity` is the city step 1 starts: seed 2026 and nothing on it, with
// the starting grant in its treasury, paused by a command so a replay of
// its log pauses too. Every road, zone, rate, charge and loan after that
// comes from the page's own tools, so step 15 replays the whole log from
// `newCityStart`. The town the page lays on it is the M3 walkthrough's
// streets off the west outside connection (m3-walkthrough-city.ts), drawn
// with the road tool, and zoned with the zone tool's fill.
//
// Steps 9 to 12 run on the town of the money and City Hall specs a game day
// short of its first milestone (city-hall-fixtures.ts), funded so it can
// pay City Hall's price: at honest prices City Hall costs more than the
// starting grant and the Village grant together (M4.md, "City Hall's
// lot"), and the new city's credit limit is a few million. Step 13 runs on
// the budget overlay's town (packages/sim/test/budget-town.ts), which
// isolates a compact block and a long cul-de-sac, as issue M4-18 asks.

import { createState, serialize, step, submit, type SimState } from "../packages/sim/src/index";
import { HOMES, MAIN, SHOPS, SHORE, SHORE_X0, UPPER, X0, X1, XM, type Strip } from "./m3-walkthrough-city";

export { HALF, HOMES, MAIN, SHOPS, SHORE, UPPER, X0, X1, XM, fillPoint, stripCell, type Strip } from "./m3-walkthrough-city";

export const SEED = 2026;

/** A city on the walkthrough's seed with nothing on it: what step 1 opens and what step 15's replay starts from. */
export function newCityStart(): SimState {
  return createState(SEED);
}

/** The new city as step 1 opens it, paused by a command of the player "fixture", so a replay pauses too. */
export function newCity(): Uint8Array {
  const state = newCityStart();
  const result = submit(state, { seq: 1, playerId: "fixture", type: "SetSpeed", payload: { speed: 0 } });
  if (!result.ok) throw new Error(`fixture SetSpeed refused: ${result.reason}`);
  step(state);
  return serialize(state);
}

/**
 * The town's streets in the order step 2 draws them with the road tool,
 * each from its first click to its second: main street east from the west
 * connection's stub, the spine south from it, and four streets across the
 * spine, the last along the shore. Each later one meets or crosses those
 * before it, so the road tool's price takes in the junctions it makes.
 */
export const STREETS: readonly { name: string; from: readonly [number, number]; to: readonly [number, number] }[] = [
  { name: "main street", from: [X0, MAIN], to: [X1, MAIN] },
  { name: "the spine", from: [XM, MAIN], to: [XM, SHORE] },
  { name: "the shops' street", from: [X0, SHOPS], to: [X1, SHOPS] },
  { name: "the houses' street", from: [X0, HOMES], to: [X1, HOMES] },
  { name: "the upper street", from: [X0, UPPER], to: [X1, UPPER] },
  { name: "the shore street", from: [SHORE_X0, SHORE], to: [X1, SHORE] },
];

/** The strips step 3 zones, by zone: homes on four streets' sides, one strip of shops, offices, and factories on main street's south side. */
export const HOUSE_STRIPS: Strip[] = [
  { z: HOMES, piece: "west", side: "north" },
  { z: HOMES, piece: "east", side: "north" },
  { z: HOMES, piece: "west", side: "south" },
  { z: HOMES, piece: "east", side: "south" },
  { z: UPPER, piece: "west", side: "north" },
  { z: UPPER, piece: "east", side: "north" },
  { z: UPPER, piece: "west", side: "south" },
  { z: UPPER, piece: "east", side: "south" },
];
/** One strip of shops, so the town wants more of them by step 6. */
export const SHOP_STRIP: Strip = { z: SHOPS, piece: "west", side: "south" };
export const OFFICE_STRIP: Strip = { z: SHOPS, piece: "west", side: "north" };
export const FACTORY_STRIPS: Strip[] = [
  { z: MAIN, piece: "west", side: "south" },
  { z: MAIN, piece: "east", side: "south" },
];
/** The fresh shop ground step 6 zones in the page and in its copy, the shops' street east of the spine on both sides. */
export const NEW_SHOP_STRIPS: Strip[] = [
  { z: SHOPS, piece: "east", side: "south" },
  { z: SHOPS, piece: "east", side: "north" },
];
/** The homes step 8 adds so the town grows: the shore street's north side, by the water. */
export const GROWTH_STRIPS: Strip[] = [
  { z: SHORE, piece: "west", side: "north" },
  { z: SHORE, piece: "east", side: "north" },
];

/**
 * Where step 7 spends the treasury down: avenues across the plateau north
 * of the map's middle, flat dry ground far from the town (seed 2026 rises
 * into steep hills east of the town and the sea is south of it). Each runs
 * east from x = `SPEND_X0` along its z, no longer than `SPEND_MAX_LENGTH`.
 */
export const SPEND_X0 = 3800;
export const SPEND_ROWS: readonly number[] = [1300, 1500, 1700, 1900];
export const SPEND_MAX_LENGTH = 2400;
/** The street the broke city is refused: north of the avenues, on the same ground. */
export const REFUSED_STREET = { from: [SPEND_X0, 1100], to: [SPEND_X0 + 600, 1100] } as const;
