// M3-20: the scale city of 200,000 residents (scale-cities.ts).

import { beforeAll, expect, it } from "vitest";
import type { GeneratedScaleCity } from "../src/index";
import { checkCity, checkRepeatable, generate } from "./scale-cities";

const RESIDENTS = 200_000;
let city: GeneratedScaleCity;
beforeAll(() => {
  city = generate(RESIDENTS);
}, 120_000);

it("has about 200,000 residents in homes and jobs, with totals that equal a recount", () => {
  checkCity(city, RESIDENTS);
  expect(city.totals.target).toBe(RESIDENTS);
});

it("is the same city for the same seed every run", () => {
  checkRepeatable(city, RESIDENTS, false);
}, 120_000);
