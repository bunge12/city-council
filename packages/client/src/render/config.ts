// Renderer settings. These are presentation, not game balance, so they live
// with the client and not under packages/sim/balance.

/** Side of a terrain chunk in metres. 12,000 m / 500 m gives 24 x 24 chunks. */
export const CHUNK_SIZE = 500;

/**
 * Detail levels for a chunk, nearest first. `segments` is the number of
 * quads along each side; `from` is the camera distance in metres to the
 * chunk centre at which the level takes over. Segment counts are powers of
 * two so that every coarse vertex is also a fine vertex.
 */
export const TERRAIN_LODS: readonly { segments: number; from: number }[] = [
  { segments: 32, from: 0 },
  { segments: 16, from: 1800 },
  { segments: 8, from: 4500 },
];

/** Share of a level's switch distance used as hysteresis, so chunks do not flicker. */
export const LOD_HYSTERESIS = 0.1;

/** How far below the lowest edge vertex a chunk's skirt reaches, in metres. */
export const SKIRT_DEPTH = 20;

/**
 * How far a skirt's bottom edge reaches outward, under the neighbouring
 * chunk, in metres. A flared skirt catches a view ray that slips through a
 * seam from either side; a vertical one only catches it at its very top.
 */
export const SKIRT_FLARE = 8;

/** Skirts on the outer edge of the map drop to this height, so the map has a solid base. */
export const MAP_BASE_HEIGHT = -40;

/** Upper bound on device pixel ratio. Integrated graphics cannot fill a 2x laptop panel at 60 fps. */
export const MAX_PIXEL_RATIO = 1.5;

/** Frames averaged for the frame-time readout. */
export const FRAME_TIME_WINDOW = 60;
