// The files scale-setup.ts writes and scale-fixture.ts reads.

import type { ScaleCounts, ScaleTown } from "../src/index";

export const CITY_FILE = "city.bin";
export const CITY_META = "city.json";
export const TOWN_FILE = "town.bin";
export const TOWN_META = "town.json";

export interface ScaleCityMeta {
  counts: ScaleCounts;
  grids: { x: number; z: number }[];
  /** `hashState` of the city as built. */
  hash: string;
}

export interface ScaleTownMeta {
  town: ScaleTown;
}
