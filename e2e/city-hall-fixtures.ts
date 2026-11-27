// The cities the City Hall spec opens (M4-17): the money spec's town
// (money-fixtures.ts), with a street on open ground east of its houses for
// City Hall's lot. Built in Node with the sim and handed to the page as city
// files, saved paused.
//
// `villageEveCity` is the town a day short of its first milestone, which
// opens City Hall, funded so the treasury can pay City Hall's price once it
// is open: at honest prices it costs more than the starting grant and the
// Village grant together (M4.md, "City Hall's lot"). `townEveCity` is the
// same town with City Hall standing at stage 1 and the town zoned up to
// density 2, a day short of Town, the milestone it grows at first.
//
// Stepping is the same on every host (CLAUDE.md rule 3), so the page reaches
// each milestone at the tick Node did.

import { LANDMARKS, MILESTONES, TIME_BALANCE, creditMilestones, deserialize, findLandmark, fundCity, landmarkStage, placeCityHallNear, planPlaceLandmark, serialize, step, type SimState } from "../packages/sim/src/index";
import { isSegment } from "../packages/sim/src/roads/network";
import { finishConstruction, zoneSides } from "./building-fixtures";
import { send, zonedTown } from "./money-fixtures";

const DAY = TIME_BALANCE.ticksPerDay;
/** Days a town is given to reach a milestone before the fixture gives up. */
const MAX_DAYS = 365;
/** What the treasury is funded to: City Hall's price and plenty for the town's upkeep while it grows. */
const FUNDS = 200_000_000;

/** City Hall's street: east from the end of the houses' street, on open ground, 140 m of it, 17 cells. */
export const HALL_STREET = { from: { x: 680, z: 4000 }, to: { x: 820, z: 4000 }, type: "street" } as const;
/** Where the spec points to place City Hall: south of the street's middle, on the strip of the side the page shows facing it. */
export const HALL_POINT = { x: 750, z: 4040 } as const;

export const CITY_HALL = (() => {
  const kind = LANDMARKS.find((l) => l.id === "cityHall");
  if (!kind) throw new Error("no cityHall in economy.json");
  return kind;
})();

/** The id of the newest road segment in `state`: the street just built. */
function newestSegment(state: SimState): number {
  let seg = -1;
  for (let i = 0; i < state.roads.segFlags.length; i++) if (isSegment(state.roads, i)) seg = i;
  return seg;
}

/** The town with City Hall's street, funded. */
function hallTown(): { state: SimState; segment: number } {
  const state = zonedTown();
  send(state, "BuildRoad", HALL_STREET);
  fundCity(state, FUNDS);
  return { state, segment: newestSegment(state) };
}

/** Steps `state` a day at a time until it has reached `count` milestones, and returns the city as it stood the day before. */
function dayBefore(state: SimState, count: number): Uint8Array {
  const target = MILESTONES[count - 1];
  if (!target) throw new Error(`no milestone ${count}`);
  let eve = serialize(state);
  for (let day = 0; state.milestones.length < count; day++) {
    if (day >= MAX_DAYS) throw new Error(`the town has ${state.stats.highestPopulation} residents after ${MAX_DAYS} days, short of ${target.name} at ${target.population}`);
    eve = serialize(state);
    for (let i = 0; i < DAY; i++) step(state);
  }
  return eve;
}

/** A city file's state, paused, as the page will open it. */
function paused(bytes: Uint8Array): { bytes: Uint8Array; state: SimState } {
  const state = deserialize(bytes).state;
  state.speed = 0;
  return { bytes: serialize(state), state };
}

export interface HallCity {
  bytes: Uint8Array;
  state: SimState;
  /** City Hall's street. */
  segment: number;
}

/** The funded town a day short of Village, with City Hall's street and City Hall still locked. */
export function villageEveCity(): HallCity {
  const { state, segment } = hallTown();
  return { ...paused(dayBefore(state, 1)), segment };
}

/** The town with City Hall at stage 1 and density 2 zoned, a day short of Town. */
export function townEveCity(): HallCity & { hall: number } {
  const { state, segment } = hallTown();
  dayBefore(state, 1);
  const payload = { landmark: CITY_HALL.id, segment, side: 1, place: 0 };
  const plan = planPlaceLandmark(state, payload);
  if (!plan.ok || plan.plan.refusal) throw new Error(`the fixture's City Hall is refused: ${plan.ok ? plan.plan.refusal : plan.reason}`);
  send(state, "PlaceLandmark", payload);
  // Zoned up to density 2, which Village opened, so the town grows on to Town.
  zoneSides(state, 0, [1, 1, 4, 1, 7, 1, 1, 10]);
  const city = paused(dayBefore(state, 2));
  const hall = findLandmark(city.state.buildings, CITY_HALL.index);
  if (hall < 0 || landmarkStage(city.state, CITY_HALL.index) !== 1) throw new Error("the fixture's City Hall is not standing at stage 1");
  return { ...city, segment, hall };
}

/**
 * `bytes`, a city file such as a scale city's, with City Hall placed on the
 * first free lot along a road nearest the middle of the map, credited the
 * milestones that open it and funded to pay for it, and past its
 * construction. For measuring the frame with City Hall in it (M4-17).
 */
export function withCityHall(bytes: Uint8Array): { bytes: Uint8Array; hall: number; middle: { x: number; z: number } } {
  const state = deserialize(bytes).state;
  creditMilestones(state, 1);
  fundCity(state, Math.max(state.budget.treasury, FUNDS));
  const { hall, at } = placeCityHallNear(state);
  finishConstruction(state);
  return { bytes: serialize(state), hall, middle: at };
}
