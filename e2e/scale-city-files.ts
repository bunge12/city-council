// The scale cities of M3-20 as city files a Playwright test can open:
// 50,000, 200,000 and 500,000 residents, generated in Node by the sim's
// `generateScaleCity` on the M1 scale city's roads, which is built once
// per worker and copied for each.
//
// Each file is the city's snapshot, as a downloaded city file carries it,
// past the construction animation (issue 136), since every building was
// placed on one tick. It is left running, unlike the scale town's fixture:
// a test that opens it waits for the sim to step.

import { SCALE_CITY_RESIDENTS, buildScaleCity, deserialize, generateScaleCity, serialize, type GeneratedScaleCity, type ScaleCity, type ScaleCityResidents } from "../packages/sim/src/index";
import { finishConstruction } from "./building-fixtures";

export { SCALE_CITY_RESIDENTS };

let base: { bytes: Uint8Array; shape: Omit<ScaleCity, "state"> } | null = null;
const files = new Map<ScaleCityResidents, { bytes: Uint8Array; totals: GeneratedScaleCity["totals"] }>();

/** The city file of the scale city of `residents`, generated on first use in this worker. */
export function scaleCityFile(residents: ScaleCityResidents): { bytes: Uint8Array; totals: GeneratedScaleCity["totals"] } {
  const kept = files.get(residents);
  if (kept) return kept;
  if (!base) {
    const { state, ...shape } = buildScaleCity();
    base = { bytes: serialize(state), shape };
  }
  const city = generateScaleCity(residents, { ...base.shape, state: deserialize(base.bytes).state });
  finishConstruction(city.state);
  const file = { bytes: serialize(city.state), totals: city.totals };
  files.set(residents, file);
  return file;
}
