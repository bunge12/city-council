// The map grid. Rendering, spatial lookups, dirty tracking and network deltas
// all work per chunk (PRD, "The map is chunked").

import { TERRAIN_BALANCE, mapSize } from "./terrain/terrain";

/** Side of a chunk in metres. 12,000 m / 500 m gives 24 x 24 chunks. */
export const CHUNK_SIZE = 500;

/** Chunks along each side of the map. */
export const CHUNKS_PER_SIDE = Math.ceil(mapSize(TERRAIN_BALANCE) / CHUNK_SIZE);
