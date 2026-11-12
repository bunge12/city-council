// Renderer settings. These are presentation, not game balance, so they live
// with the client and not under packages/sim/balance.

/** Side of a chunk in metres. The sim owns it: its spatial index uses the same grid. */
export { CHUNK_SIZE } from "@city-council/sim";

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

/**
 * Decoration: trees and grass tufts. Presentation only, never in sim state.
 * Placement is a pure function of the seed, so the same tree stands in the
 * same place on every load and for every player.
 */
export const DECOR = {
  trees: {
    /** Side of the jitter cell in metres. One tree at most per cell. */
    cell: 14,
    /** Chance of a tree in a cell on forest land. */
    forestChance: 0.7,
    /** Chance of a tree in a cell on other open land, for scattered single trees. */
    scatterChance: 0.012,
    /** Tallest and shortest tree, in metres. */
    minHeight: 7,
    maxHeight: 16,
    /** Above this height over the water, trees are conifers only. */
    coniferAbove: 120,
    /** Steepest ground a tree stands on, as rise over run. */
    maxSlope: 0.6,
    /** Lowest and highest ground a tree stands on, in metres above the water. */
    minAbove: 3,
    maxAbove: 330,
    /** Camera distance in metres to a chunk's centre beyond which its trees are not drawn. */
    drawDistance: 2500,
  },
  grass: {
    /** Side of the jitter cell in metres. */
    cell: 5,
    /** Chance of a tuft in a cell on grassland. */
    chance: 0.45,
    /** Tallest and shortest tuft, in metres. */
    minHeight: 0.5,
    maxHeight: 1.1,
    maxSlope: 0.35,
    minAbove: 3,
    maxAbove: 140,
    /** Camera distance in metres to a chunk's centre beyond which its grass is not drawn. */
    drawDistance: 650,
  },
} as const;

/**
 * Roads on screen. Presentation only: widths and lane counts come from the
 * sim's road types in `packages/sim/balance/roads.json`; this sets how they
 * look. Colours are sRGB hex.
 */
export const ROADS = {
  /** Most metres between two cross-sections along a road, so it follows the ground. */
  sampleStep: 8,
  /**
   * Longest a junction may cut back a road, in metres. A corner that would
   * need more, which only very sharp angles do, is bevelled instead. The
   * renderer also uses it to find the chunks a changed junction reaches.
   */
  maxTrim: 80,
  /** A reflex corner is mitred when the miter point is within this many half-widths of the node, and bevelled otherwise. */
  miterLimit: 2.5,
  /**
   * How far road surfaces sit above the terrain mesh, in metres: `base`
   * plus `perMetre` for each metre from the camera. The terrain's coarser
   * levels of detail cut corners the road does not, and depth precision
   * falls with distance, so the gap grows with distance. Applied in the
   * vertex shader, so it costs no rebuild when the camera moves.
   */
  lift: { base: 0.25, perMetre: 0.0012 },
  /** Extra height of lane markings over the surface, in metres. */
  markingLift: 0.06,
  /** Surface colour by road type id. */
  surface: {
    street: 0x6d6f73,
    avenue: 0x4f5156,
    oneWay: 0x657284,
    highway: 0x45474b,
  } as Readonly<Record<string, number>>,
  /** Surface colour of a type not listed above. */
  surfaceDefault: 0x6d6f73,
  markings: {
    white: 0xe4e4dc,
    yellow: 0xe0b83c,
    /** Width of a painted line, metres. */
    width: 0.18,
    /** Gap between the two lines of a double centre line, metres. */
    doubleGap: 0.25,
    /** Dashed lines: paint and gap lengths, metres. */
    dash: 3,
    gap: 6,
    /** How far a solid edge line sits in from the kerb, metres. */
    edgeInset: 0.4,
    /** One-way arrows: metres between arrows, and the arrow's shaft and head. */
    arrowSpacing: 36,
    arrowShaft: { length: 3, width: 0.35 },
    arrowHead: { length: 2.2, width: 1.5 },
  },
  /**
   * The city band draws only these types, as lines of a fixed screen
   * width. `perMetre` is the line's half-width for each metre from the
   * camera; a line is never thinner than the road.
   */
  cityLines: {
    colours: { avenue: 0xf2a43a, highway: 0xe0563a } as Readonly<Record<string, number>>,
    perMetre: 0.0013,
    /**
     * Most metres between two points along a line. Coarser than the surface:
     * the city band starts 3 km up, where the lift is several metres.
     */
    sampleStep: 40,
    /** Sides of the cap that rounds a line's joint at a node. */
    capSides: 8,
  },
  /**
   * Trees and grass are not placed within this many metres of a road's
   * edge. Trees get more room, since their crowns spread.
   */
  decorClearance: { trees: 3, grass: 0.5 },
  /** Side of a cell in the road mask that decoration checks, metres. */
  maskCell: 2,
} as const;

/**
 * How the road tool draws its previews. Colours are sRGB hex. The preview
 * is drawn over the terrain, not into it, so a hill cannot hide it.
 */
export const ROAD_PREVIEW = {
  colours: {
    /** A road the sim would build. */
    ok: 0x4da3ff,
    /** A road the sim would refuse. */
    refused: 0xe0453a,
    /** Sent, waiting for the sim. */
    pending: 0xb9c6d3,
    /** Where the road would meet another. */
    junction: 0xffd23a,
  },
  opacity: 0.72,
  /** Metres above the ground. */
  lift: 0.6,
  /** Junction markers: radius as a share of the road width, sides, and extra height. */
  junctionScale: 0.75,
  junctionSides: 20,
  junctionLift: 0.1,
} as const;
