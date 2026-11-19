// The scale city and the scale town, loaded from the snapshots scale-setup.ts
// saved at the start of the run (issue #230). Each call gives a new state of
// its own, with no derived data: it is rebuilt on the first step, or by
// `prepareDerived`, as on a load.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";
import { deserialize, type ScaleCity, type ScaleTown } from "../src/index";
import { CITY_FILE, CITY_META, TOWN_FILE, TOWN_META, type ScaleCityMeta, type ScaleTownMeta } from "./scale-files";

/** A file the setup saved, as a plain Uint8Array: the snapshot reader takes no Node Buffer. */
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(inject("scaleDir"), name)));
const readJson = <T>(name: string): T => JSON.parse(new TextDecoder().decode(read(name))) as T;

let cityBytes: Uint8Array | undefined;
let cityMeta: ScaleCityMeta | undefined;

/** The scale city's counts, grids and hash, as `buildScaleCity` gave them. */
export function scaleCityMeta(): ScaleCityMeta {
  cityMeta ??= readJson<ScaleCityMeta>(CITY_META);
  return cityMeta;
}

/** A fresh copy of the scale city, as `buildScaleCity()` builds it. */
export function loadScaleCity(): ScaleCity {
  cityBytes ??= read(CITY_FILE);
  const meta = scaleCityMeta();
  return { state: deserialize(cityBytes).state, counts: { ...meta.counts }, grids: meta.grids.map((g) => ({ ...g })) };
}

/** A fresh copy of the scale town, as `growScaleCity` grows the scale city. Bench runs only. */
export function loadScaleTown(): { city: ScaleCity; town: ScaleTown; hash: string } {
  const meta = readJson<ScaleTownMeta>(TOWN_META);
  const city = scaleCityMeta();
  return {
    city: { state: deserialize(read(TOWN_FILE)).state, counts: { ...city.counts }, grids: city.grids.map((g) => ({ ...g })) },
    town: meta.town,
    hash: meta.hash,
  };
}
