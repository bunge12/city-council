// M4 review (#456): save and resume against an uninterrupted run on the
// scale city of 50,000, with its economy furnished as the benches have it:
// taxes swept a stride a tick, upkeep a day at a time, City Hall standing, a
// loan open. 1,000 ticks straight; again 500, save, load, 500 more. Along the
// way the player moves a rate and a charge, expropriates an occupied home and
// takes a second loan, so each part of the economy has state in flight at the
// save. Both runs must end on the same hash. This catches state that did not
// make it into the snapshot, which the replay tests alone miss.

import { beforeAll, expect, it } from "vitest";
import {
  buildingPeople,
  creditLeft,
  deserialize,
  furnishEconomy,
  hashState,
  recountTotals,
  seeBuilding,
  serialize,
  step,
  type SimState,
} from "../src/index";
import { generate } from "./scale-cities";
import { submit } from "./seen-ends";

const RESIDENTS = 50_000;
const STEPS = 1_000;

let start: Uint8Array;
beforeAll(() => {
  const city = generate(RESIDENTS);
  furnishEconomy(city.state, RESIDENTS);
  start = serialize(city.state);
}, 180_000);

/** The first occupied home, as BulldozeBuilding names it. */
function occupiedHome(state: SimState): unknown {
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) {
    if (b.flags[id] && b.zone[id] === 1 && buildingPeople(state, id) > 0) return seeBuilding(b, id);
  }
  throw new Error("no occupied home");
}

/** Step `i`: a command picked from `i` and the state as it stands, then a step. */
function drive(state: SimState, i: number): void {
  const send = (type: string, payload: unknown) => {
    const result = submit(state, { seq: 900_000 + i, playerId: i % 2 ? "p1" : "p2", type, payload });
    if (!result.ok) throw new Error(`${type} at ${i} refused: ${JSON.stringify(result)}`);
  };
  if (i === 120) send("SetTaxRate", { zone: "commercial", rate: 0.05 });
  if (i === 340) send("SetDevelopmentCharge", { zone: "residential", rate: 200 });
  if (i === 499) send("BulldozeBuilding", { buildings: [occupiedHome(state)] });
  if (i === 650) send("TakeLoan", { principal: Math.floor(creditLeft(state) / 4), termMonths: 120 });
  step(state);
}

function run(state: SimState, from: number, to: number): SimState {
  for (let i = from; i < to; i++) drive(state, i);
  return state;
}

let straight: SimState;
beforeAll(() => {
  straight = run(deserialize(start).state, 0, STEPS);
}, 180_000);

it("the straight run expropriated one home and balanced its totals", () => {
  expect(straight.expropriations.length).toBe(1);
  expect(straight.stats.totals).toEqual(recountTotals(straight));
});

// Half way, as the review asks, and next to each command.
for (const at of [STEPS / 2, 121, STEPS / 2 - 1, 651]) {
  it(`${at} ticks, save, load, ${STEPS - at} more end on the straight hash`, () => {
    let resumed = run(deserialize(start).state, 0, at);
    resumed = deserialize(serialize(resumed)).state;
    run(resumed, at, STEPS);
    expect(resumed.budget.treasury).toBe(straight.budget.treasury);
    expect(resumed.budget.month).toEqual(straight.budget.month);
    expect(hashState(resumed)).toBe(hashState(straight));
    expect(resumed.stats.totals).toEqual(recountTotals(resumed));
  }, 300_000);
}
