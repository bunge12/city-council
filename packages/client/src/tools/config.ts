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
} as const;

/** The guides the road tool offers, in toolbar order. Issue M1-19 appends guide lines and parallel offset. */
export const GUIDES = [
  { id: "angle", label: "Angle", title: "Snap to 90, 45 and 15 degree steps from the road you start on" },
  { id: "length", label: "Length", title: `Snap the length to whole ${SNAP.cellSize} m cells` },
  { id: "grid", label: "Grid", title: "Snap to the 16 m terrain grid" },
] as const;

export type GuideId = (typeof GUIDES)[number]["id"];

/** Which guides are on. */
export type GuideToggles = Record<GuideId, boolean>;

/** Angle and length on, the terrain grid off. */
export const DEFAULT_GUIDES: GuideToggles = { angle: true, length: true, grid: false };

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
