// The checks every scale city of M3-20 is held to, in a file of its own per
// size (scale-city-*.test.ts) so that Vitest generates them side by side.
// Timings are in the client's scale-cities.bench.ts, which may read a
// clock.

import { expect } from "vitest";
import {
  POPS_BALANCE,
  deserialize,
  generateScaleCity,
  hashState,
  recountTotals,
  createScaleState,
  replayFrom,
  serialize,
  type GeneratedScaleCity,
  type ScaleCityResidents,
} from "../src/index";
import { loadScaleCity } from "./scale-fixture";

/** M3-20: "a population within 5 percent of its target". */
const WITHIN = 0.05;

/** Generates the scale city of `residents` on a fresh copy of the scale city. */
export const generate = (residents: ScaleCityResidents): GeneratedScaleCity => generateScaleCity(residents, loadScaleCity());

/** Holds a generated city to its target, its mix and a recount, as the issue asks. */
export function checkCity(city: GeneratedScaleCity, residents: ScaleCityResidents): void {
  const { state, totals } = city;
  const population = state.stats.totals["population"] ?? 0;
  expect(Math.abs(population - residents) / residents, `population ${population} against ${residents}`).toBeLessThan(WITHIN);
  expect(totals.population).toBe(population);
  // The running totals equal a count from the rows, on the city as
  // generated and on it loaded from its bytes, as a city file opens.
  expect(state.stats.totals).toEqual(recountTotals(state));
  const loaded = deserialize(serialize(state)).state;
  expect(loaded.stats.totals).toEqual(recountTotals(loaded));
  expect(hashState(loaded)).toBe(hashState(state));
  // About half a job a resident, and most of the people who work in one.
  const jobs = totals.jobs.commercial + totals.jobs.office + totals.jobs.industrial;
  expect(jobs / population).toBeGreaterThan(0.45);
  expect(jobs / population).toBeLessThan(0.55);
  const workers = totals.workersEmployed + totals.workersUnemployed;
  expect(totals.workersEmployed / workers).toBeGreaterThan(0.7);
  // Homes at every density, and no pop over its home's size cap.
  for (const room of totals.roomByDensity) expect(room).toBeGreaterThan(0);
  const p = state.pops;
  for (let id = 0; id < p.flags.length; id++) {
    if (!p.flags[id]) continue;
    const cap = POPS_BALANCE.popSizeCap[(state.buildings.density[p.home[id] ?? 0] ?? 1) - 1] ?? 0;
    if ((p.size[id] ?? 0) > cap) throw new Error(`pop ${id} holds ${p.size[id]}, over its home's cap of ${cap}`);
  }
  // Generated paused and unpaused again, so it runs once opened.
  expect(state.speed).toBe(1);
}

/**
 * The same seed gives the same city. With `withReplay`, the log also
 * replays to its roads and zoning: the buildings and pops are only in the
 * state.
 */
export function checkRepeatable(city: GeneratedScaleCity, residents: ScaleCityResidents, withReplay: boolean): void {
  const again = generate(residents);
  expect(hashState(again.state)).toBe(hashState(city.state));
  expect(again.totals).toEqual(city.totals);
  if (!withReplay) return;
  const replayed = replayFrom(createScaleState(), city.state.log, city.state.tick);
  expect(hashState(replayed.roads)).toBe(hashState(city.state.roads));
  expect(hashState(replayed.cells)).toBe(hashState(city.state.cells));
}
