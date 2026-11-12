// The terrain a command reads. Terrain is not state: it is rebuilt from the
// seed (PRD, "Derived data"). Generation is a pure function of the seed with
// only exact arithmetic, so a worker, a server and a replay that ask for the
// same seed get the same map bit for bit, and a check that reads it gives the
// same answer on all three.
//
// A host usually runs one city, so a couple of maps are kept, most recently
// used last. A map is about 7 MB.

import { generateTerrain, type Terrain } from "./terrain";

const KEEP = 2;
const cache = new Map<number, Terrain>();

/** The terrain for `seed`, generated on first use and then kept. */
export function terrainOf(seed: number): Terrain {
  let terrain = cache.get(seed);
  if (terrain) {
    cache.delete(seed);
  } else {
    terrain = generateTerrain(seed);
    if (cache.size >= KEEP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(seed, terrain);
  return terrain;
}
