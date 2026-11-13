// Settings for the drawing tools: how near the cursor must be for each snap
// to catch, and the steps the guides snap to. Feel, not game balance, so it
// lives in the client rather than under packages/sim/balance.
//
// Distances in pixels are CSS pixels on screen, turned into metres at the
// cursor each frame, so a snap feels the same in every zoom band.

/** The route tool in the debug panel (issue M1-15). */
export const ROUTE_TOOL = {
  /** A clicked point joins the nearest road no further than this, in metres. */
  attachRadius: 300,
  /** The highlight's width as a share of the road's, so the road shows at its edges. */
  widthScale: 1.25,
} as const;

/** The block overlay in the debug panel (issue M1-18). */
export const BLOCK_OVERLAY = {
  /** The outline's width as a share of the road's, so it reads as a line down the middle. */
  widthScale: 0.35,
  /** Points each curve is followed through when placing a block's label. */
  labelCurveSteps: 8,
} as const;

export const SNAP = {
  /** An existing node catches the cursor this near. */
  nodePx: 16,
  /** A point on an existing segment catches the cursor this near. */
  segmentPx: 12,
  /** The point where the road would meet a segment at a right angle catches the cursor this near. */
  perpendicularPx: 14,
  /** The strong angle steps: straight on, 45 and 90 degrees. They catch from further away and win when close. */
  strongAngleStep: 45,
  strongAnglePx: 14,
  /** The lighter angle steps. */
  lightAngleStep: 15,
  lightAnglePx: 6,
  /**
   * Length snap step, metres. One M2 zoning cell, so a road's frontage holds
   * a whole number of cells. If M2 changes the cell size, change it here.
   */
  cellSize: 8,
  /**
   * How deep zoning reaches from a road's edge, in cells: the M2 rule that a
   * zonable segment gets cells six deep. The parallel offsets are strips of
   * this depth, so if M2 changes it, they follow.
   */
  zoneDepthCells: 6,
} as const;

/** Guide lines from nearby nodes (issue M1-19). */
export const GUIDE_LINES = {
  /** Nodes this near the cursor, in metres, give guide lines: a little over two blocks of twelve cells. */
  searchMetres: 260,
  /**
   * The search starts at these shares of `searchMetres` and grows until it
   * finds `enoughNodes` nodes, so a dense network costs no more than a sparse one.
   */
  searchSteps: [0.125, 0.25, 0.5, 1],
  enoughNodes: 40,
  /** At most this many lines are tried, nearest the cursor first. */
  maxLines: 4,
  /** A guide line catches the cursor this near. */
  linePx: 10,
  /** Where two guides cross, the crossing catches the cursor this near. */
  crossingPx: 14,
} as const;

/** Parallel offset beside an existing straight road (issue M1-19). */
export const PARALLEL = {
  /**
   * The gaps offered between the two roads' edges, in zoning strips of
   * `SNAP.zoneDepthCells`, main first. Two strips back to back is the main
   * one; one strip is the lighter one.
   */
  strips: [2, 1],
  /** The main offset catches the cursor this near... */
  mainPx: 14,
  /** ...and the lighter ones this near. The main one wins when both reach. */
  lightPx: 8,
  /** The cursor counts as beside a road this far past either end of it, metres. */
  pastEndMetres: 48,
} as const;

/** The edge-to-edge gaps the parallel offset snaps to, in cells, main first. */
export const PARALLEL_GAP_CELLS: readonly number[] = PARALLEL.strips.map((n) => n * SNAP.zoneDepthCells);

/** The guides the road tool offers, in toolbar order. */
export const GUIDES = [
  { id: "angle", label: "Angle", title: "Snap to 90, 45 and 15 degree steps from the road you start on" },
  { id: "length", label: "Length", title: `Snap the length to whole ${SNAP.cellSize} m cells` },
  { id: "grid", label: "Grid", title: "Snap to the 16 m terrain grid" },
  { id: "lines", label: "Lines", title: "Snap to lines running square and in line from nearby road ends and junctions" },
  { id: "offset", label: "Offset", title: `Snap beside a road at ${PARALLEL_GAP_CELLS.join(" or ")} cells, edge to edge` },
] as const;

export type GuideId = (typeof GUIDES)[number]["id"];

/** Which guides are on. */
export type GuideToggles = Record<GuideId, boolean>;

/** Everything on but the terrain grid. */
export const DEFAULT_GUIDES: GuideToggles = { angle: true, length: true, grid: false, lines: true, offset: true };

/** How the key that, held, suspends every guide for a free-hand segment is written. The camera controls track it. */
export const FREE_HAND_KEY_LABEL = "Alt";

/** Picking a segment for the bulldoze and upgrade tools (issue M1-13). */
export const PICK = {
  /** A segment is picked when the pointer is this near its drawn edge, CSS pixels. */
  segmentPx: 10,
  /** A drag is sampled this often along the pointer's path, CSS pixels, so a fast drag skips no segment. */
  dragStepPx: 4,
  /** Points looked at along a segment when measuring its distance on screen: one every this many metres... */
  sampleStep: 4,
  /** ...and never fewer or more than these. */
  minSamples: 8,
  maxSamples: 160,
} as const;
