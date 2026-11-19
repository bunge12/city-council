// Vitest global setup (issue #230): builds the scale city once per run,
// before any test file loads, and saves it as snapshot bytes for every scale
// test and bench to load (scale-fixture.ts). Building it through its
// commands takes about 13 s, and five test files and three bench files
// each built their own. In bench mode it also grows the scale town, which
// town.bench.ts times.
//
// State serialises at every tick and derived data is rebuilt from it (rules
// 5 and 7), so a city loaded from these bytes runs the same as the one
// built. `scale.test.ts` builds the city from its commands again and checks
// its hash against the saved one, so the shortcut cannot drift.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { buildScaleCity, deserialize, growScaleCity, hashState, serialize } from "../src/index";
import { CITY_FILE, CITY_META, TOWN_FILE, TOWN_META, type ScaleCityMeta, type ScaleTownMeta } from "./scale-files";

declare module "vitest" {
  export interface ProvidedContext {
    /** The directory the scale city's snapshot and its counts are saved in. */
    scaleDir: string;
  }
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "city-council-scale-"));
  const city = buildScaleCity();
  const bytes = serialize(city.state);
  const meta: ScaleCityMeta = { counts: city.counts, grids: city.grids, hash: hashState(city.state) };
  writeFileSync(join(dir, CITY_FILE), bytes);
  writeFileSync(join(dir, CITY_META), JSON.stringify(meta));
  if (project.config.benchmark?.enabled) {
    // Grown on a copy loaded from the bytes, as the scale tests grow it.
    const copy = { ...city, state: deserialize(bytes).state };
    const town = growScaleCity(copy);
    const townMeta: ScaleTownMeta = { town, hash: hashState(copy.state) };
    writeFileSync(join(dir, TOWN_FILE), serialize(copy.state));
    writeFileSync(join(dir, TOWN_META), JSON.stringify(townMeta));
  }
  project.provide("scaleDir", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
