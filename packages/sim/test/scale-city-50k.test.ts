// M3-20: the scale city of 50,000 residents (scale-cities.ts). The only
// size whose log is also replayed, since a replay builds the scale city
// again from its 30,000 segments' commands.

import { beforeAll, expect, it } from "vitest";
import type { GeneratedScaleCity } from "../src/index";
import { checkCity, checkRepeatable, generate } from "./scale-cities";

const RESIDENTS = 50_000;
let city: GeneratedScaleCity;
beforeAll(() => {
  city = generate(RESIDENTS);
}, 120_000);

it("has about 50,000 residents in homes and jobs, with totals that equal a recount", () => {
  checkCity(city, RESIDENTS);
  expect(city.totals.target).toBe(RESIDENTS);
});

it("is the same city for the same seed every run, and its log replays to its roads and zoning", () => {
  checkRepeatable(city, RESIDENTS, true);
}, 180_000);
