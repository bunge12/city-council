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
    drawDistance: 3500,
  },
  /**
   * The stand-in for trees too far away to draw: the terrain under forest
   * takes the canopy colour, so a forest still reads as green from the city
   * band. It fades in from `fadeFrom` metres from the camera and is full at
   * `fadeTo`, which matches the trees' draw distance so the two hand over.
   * `cover` is how much of the ground colour the canopy hides at full.
   */
  canopy: {
    colour: 0x4a7436,
    fadeFrom: 1500,
    fadeTo: 3500,
    cover: 0.85,
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
   * How finely a curved road is cut into straight pieces. A piece turns
   * through at most `surfaceTurn` radians on the surface and its paint,
   * which the street band sees up close, and `lineTurn` in the city band's
   * lines, seen from kilometres up. `minPiece` is the shortest piece, metres.
   * `tableStep` is the spacing, metres, of the polyline that measures a
   * curve's length, up to `maxTableSteps` points.
   */
  curves: { surfaceTurn: 0.05, lineTurn: 0.25, minPiece: 0.25, tableStep: 0.5, maxTableSteps: 4096 },
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
  /**
   * Lane markings and arrows show while the camera is lower than this many
   * metres over the ground: all of the street band and the low part of the
   * district band. Higher up a line is under a pixel wide and shimmers.
   */
  markingsBelow: 1400,
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
    colours: { avenue: 0x5c5e63, highway: 0xe0563a } as Readonly<Record<string, number>>,
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
  /**
   * Bridges. Sizes are metres: the deck's depth under its surface, the
   * railing along each edge, and the piers, which stand at most
   * `pierSpacing` apart under the level deck, are `pierThickness` along the
   * road and `pierWidthShare` of its width across, and reach `pierFooting`
   * into the ground.
   */
  bridges: {
    deckDepth: 1.2,
    railingHeight: 1.1,
    railingThickness: 0.35,
    pierSpacing: 36,
    pierThickness: 1.6,
    pierWidthShare: 0.7,
    pierFooting: 1,
    railing: 0xc9c5ba,
    underside: 0x8e8a82,
    pier: 0xa7a296,
  },
  /**
   * Rounded kerb corners (issue 87). Where two roads meet at under 180
   * degrees, the kerbs turn through an arc of about `radius` metres, the
   * smaller of the two roads' radii by type id. Each road is cut back
   * further to make room, by at most `maxCut` metres past the sharp corner.
   * The arc is drawn as `steps` straight pieces.
   */
  corners: {
    radius: { street: 6, avenue: 9, oneWay: 6, highway: 12 } as Readonly<Record<string, number>>,
    radiusDefault: 6,
    maxCut: 14,
    steps: 6,
  },
  /**
   * Where a road of one width runs on into a road of another, bent by at
   * most `maxBend` radians, the narrow road widens into the wide one over
   * `ratio` metres for each metre of difference in half-width (issue 87).
   */
  taper: { ratio: 5, maxBend: 0.8 },
  /**
   * Zebra crossings, on each road at a junction of three or more (issue 87).
   * Metres: the crossing starts `gap` past the junction and is `length`
   * long; its bars are `bar` wide with `space` between, and stop `margin`
   * short of each kerb. Lane lines stop `gap` short of it. None on types
   * not in `types`, or on a road too short to have room at both ends.
   */
  crossings: {
    gap: 0.8,
    length: 3,
    bar: 0.5,
    space: 0.55,
    margin: 0.5,
    types: ["street", "avenue", "oneWay"] as readonly string[],
  },
  /**
   * Signals and signs at junctions of three or more roads (issue 87). Drawn
   * in the street band only. A junction with an avenue gets a traffic light
   * on each road that brings traffic in, and one of streets and one-ways
   * gets a yield sign on each. They stand `kerbGap` metres outside the
   * kerb on the right of the incoming traffic, `setback` metres back from
   * the crossing. Decoration only: the sim has no signals.
   */
  props: {
    signalTypes: ["avenue"] as readonly string[],
    yieldTypes: ["street", "oneWay"] as readonly string[],
    kerbGap: 1,
    setback: 1.5,
    signal: { poleHeight: 6.2, mast: 5.5, pole: 0x5d6168, head: 0x2b2d30, housing: 0xd2a72a, red: 0xe03a2c, amber: 0xf2a33a, green: 0x39c46a },
    yield: { poleHeight: 2.1, size: 0.9, pole: 0x8d9198, red: 0xc8262b, white: 0xf2f2ee, back: 0x9da1a6 },
  },
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
    /** The part of a road that would be a bridge. */
    bridge: 0xb48cff,
    /** A road the bulldoze tool would remove (issue M1-13). */
    bulldoze: 0xff8a1f,
    /** A route the debug panel's route tool found (issue M1-15). */
    route: 0x2ee06f,
    /** The outline of a block the debug panel's block overlay shows (issue M1-18). */
    block: 0xff4fd8,
  },
  /** The bridge strip: width as a share of the road's, and extra height over the strip. */
  bridgeScale: 0.6,
  bridgeLift: 0.05,
  opacity: 0.72,
  /** Metres above the ground. */
  lift: 0.6,
  /** Most pieces a curved preview is cut into, so a very tight refused curve stays cheap. */
  maxCurvePieces: 400,
  /** Junction markers: radius as a share of the road width, sides, and extra height. */
  junctionScale: 0.75,
  junctionSides: 20,
  junctionLift: 0.1,
} as const;

/** The road tool's snap markers. Sizes are CSS pixels on screen, turned into metres at the cursor. */
export const SNAP_MARKS = {
  colours: {
    /** Caught an existing node. */
    node: 0xffd23a,
    /** Caught a point on an existing segment. */
    segment: 0x3fe0c5,
    /** An angle guide line from the start. */
    angle: 0xffffff,
    /** The right-angle marker. */
    square: 0xffffff,
    /** Caught the terrain grid. */
    grid: 0xd5dde6,
    /** A guide line from a nearby node, faint blue. */
    line: 0x8fc7ff,
    /** A parallel offset beside a road, and the gap it measures. */
    offset: 0xffa64d,
    /** Where water or steep ground cuts a street of the grid tool's preview (issue M1-21). */
    cut: 0xff5a4a,
  },
  opacity: 0.95,
  /** Metres above the ground, over the road preview. */
  lift: 0.9,
  nodeRingPx: { inner: 10, outer: 15 },
  segmentDiamondPx: 13,
  /** The guide line runs from the start this far past the cursor. */
  guideOvershootPx: 120,
  guideWidthPx: 1.5,
  squarePx: 26,
  squareWidthPx: 3,
  gridCrossPx: 7,
  gridWidthPx: 2,
  /** Ground samples along a guide line at most this far apart, metres. */
  sampleStep: 8,
} as const;

/**
 * The marks on each outside connection (issue M1-16): a disc with an arrow
 * pointing into the map, on the edge node. Sizes are CSS pixels on screen,
 * turned into metres where each mark stands, so a connection is as easy to
 * find from the city band as from the street.
 */
export const CONNECTION_MARKS = {
  /** The disc, a road-sign blue, and the arrow on it. */
  disc: 0x1f6fd1,
  arrow: 0xffffff,
  opacity: 0.95,
  /** Metres above the ground, over the roads. */
  lift: 1.2,
  discPx: 15,
  discSides: 28,
  /** The arrow's length and width, and its stroke. */
  arrowPx: 16,
  arrowWidthPx: 14,
  arrowStrokePx: 3.5,
} as const;

/** The graphics presets, cheapest first. Presentation only: no preset changes the sim. */
export const PRESETS = ["low", "balanced", "high"] as const;
export type Preset = (typeof PRESETS)[number];

/** The preset a player gets when nothing else decides. */
export const DEFAULT_PRESET: Preset = "balanced";

/**
 * Every visual feature and the cheapest preset that turns it on. A preset
 * draws a feature when it is this one or a later one in `PRESETS`. A new
 * feature goes in this list, so nothing costly lands in Low by accident.
 */
export const VISUAL_FEATURES = {
  /** Terrain chunks with their levels of detail, and the water plane. */
  terrain: "low",
  /** Road surfaces, bridges, and the city band's lines. */
  roads: "low",
  /** Lane markings and one-way arrows, in the street and low district bands. */
  roadMarkings: "low",
  /** Decorative trees near the camera, and the canopy colour further out. */
  trees: "low",
  /** Grass tufts near the camera. */
  grass: "low",
  /** One fixed sun, lighting terrain, roads and trees from one side. */
  sunLight: "low",
  /** Sky light from above and earth light from below, in place of one flat fill. */
  softAmbient: "balanced",
  /** The sun casts shadows within `SHADOWS.near` of the point the camera looks at. */
  sunShadows: "balanced",
  /** The same shadows out to `SHADOWS.far`, with a larger shadow map to keep them sharp. */
  longShadows: "high",
} as const satisfies Record<string, Preset>;
export type VisualFeature = keyof typeof VISUAL_FEATURES;

/** True when `preset` draws `feature`. */
export function featureOn(feature: VisualFeature, preset: Preset): boolean {
  return PRESETS.indexOf(preset) >= PRESETS.indexOf(VISUAL_FEATURES[feature]);
}

/**
 * The fixed daylight: one sun and one ambient light. No day and night cycle.
 * Colours are sRGB hex. `sun.direction` points from the scene towards the sun.
 * Without soft ambient the fill is one flat colour, `flat`, as bright overall
 * as the sky and ground pair.
 */
export const LIGHTING = {
  sky: 0xb7cfe0,
  sun: { colour: 0xfff4e0, intensity: 2.2, direction: [0.55, 0.55, 0.3] as const },
  ambient: { sky: 0xdfeaf5, ground: 0x5a5040, flat: 0xbec3c8, intensity: 1.1 },
} as const;

/**
 * Sun shadows. One shadow map follows the point the camera looks at. `range`
 * is the half-width of the square it covers, in metres, and `mapSize` its
 * side in texels, so a texel is 2 * range / mapSize metres. `depth` is how
 * far the shadow camera stands back along the sun's direction, metres: past
 * the highest ground over the focus. The biases keep trees from shadowing
 * themselves in stripes.
 */
export const SHADOWS = {
  near: { range: 320, mapSize: 2048 },
  far: { range: 1000, mapSize: 4096 },
  depth: 1500,
  bias: -0.0004,
  normalBias: 0.35,
} as const;

/**
 * The first-run benchmark. After the first frame with terrain, the game
 * switches to Balanced, draws the start view `renders` times into an
 * offscreen target and waits for the GPU to finish, after `warmup` untimed
 * draws. The mean milliseconds per draw picks the preset: over `lowAbove`
 * gives Low, under `highBelow` gives High, and anything between gives
 * Balanced. It runs once per browser; the choice is kept with the setting.
 *
 * The thresholds are a first guess until the PRD names the reference
 * machines for Low and Balanced. A software adapter, as on a CI runner, takes
 * hundreds of milliseconds per draw. A recent laptop GPU takes a few.
 */
export const PRESET_BENCHMARK = {
  warmup: 2,
  renders: 8,
  lowAbove: 12,
  highBelow: 4,
} as const;
