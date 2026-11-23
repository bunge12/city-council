// M3-20: the scale city of 500,000 residents (scale-cities.ts). Generating
// it takes about 8 s on the development container, on top of the scale
// city scale-setup.ts builds once for the run, so it is generated on every
// run rather than cached.

import { beforeAll, expect, it } from "vitest";
import type { GeneratedScaleCity } from "../src/index";
import { checkCity, checkRepeatable, generate } from "./scale-cities";

const RESIDENTS = 500_000;
let city: GeneratedScaleCity;
beforeAll(() => {
  city = generate(RESIDENTS);
}, 120_000);

it("has about 500,000 residents in homes and jobs, with totals that equal a recount", () => {
  checkCity(city, RESIDENTS);
  expect(city.totals.target).toBe(RESIDENTS);
  // About a third of the room in towers (M3-20).
  const [, , towers] = city.totals.roomByDensity;
  expect(towers / city.totals.room).toBeGreaterThan(0.3);
});

it("is the same city for the same seed every run", () => {
  checkRepeatable(city, RESIDENTS, false);
}, 120_000);
