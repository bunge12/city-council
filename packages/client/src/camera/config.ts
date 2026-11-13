// Camera settings. Presentation, not game balance, so they live with the
// client and not under packages/sim/balance. Angles are radians, lengths
// metres, times seconds.

/**
 * Zoom band thresholds, by camera height above the ground directly below
 * it. Starting values from the PRD ("Zoom bands"), to tune.
 */
export const ZOOM_BANDS = {
  /** Below this height the camera is in the street band. */
  streetBelow: 500,
  /** Below this height, and not in the street band, it is in the district band. */
  districtBelow: 3000,
} as const;

const DEG = Math.PI / 180;

/** Limits that keep the camera above the terrain and the map in view. */
export const CAMERA_LIMITS = {
  /** Closest the camera gets to the point it orbits. */
  minDistance: 60,
  /** Furthest the camera gets from the point it orbits. The whole 12 km map fits at about 13 km. */
  maxDistance: 20_000,
  /** Lowest angle above the horizon the camera looks down at. Shallower views show mostly sky. */
  minPitch: 8 * DEG,
  /** Steepest angle. Short of straight down, so the view keeps a heading. */
  maxPitch: 88 * DEG,
  /** Least height of the camera above the ground directly below it. */
  clearance: 20,
} as const;

/** How fast input moves the camera. */
export const CAMERA_SPEEDS = {
  /** Keyboard pan, as a share of the orbit distance per second. */
  keyPan: 0.9,
  /** Keyboard orbit, radians per second. */
  keyYaw: 1.4,
  keyPitch: 0.9,
  /** Keyboard zoom: the distance is multiplied by e^(rate * seconds), towards the screen centre. */
  keyZoom: 1.6,
  /** Mouse orbit, radians per pixel dragged. */
  dragYaw: 0.006,
  dragPitch: 0.004,
  /** Wheel zoom: the distance is multiplied by e^(rate * deltaY in pixels). */
  wheelZoom: 0.0015,
} as const;

/** A press that moves less than this many pixels before release is a click, not a drag. */
export const CLICK_SLOP = 4;

/** Radius of the cursor marker, as a share of its distance from the camera. */
export const CURSOR_MARKER_SCALE = 0.012;

/**
 * Where the camera starts on a new or loaded city (issue M1-16): over the
 * first outside connection, from beyond the map edge, looking into the map
 * along its stub at an angle. High enough for the city band, where no trees
 * or grass are drawn, so opening a city costs no more to draw than the whole
 * map did; the connection's mark is sized in pixels and shows from there.
 * `lead` is how far past the stub's end the camera looks.
 */
export const START_VIEW = {
  lead: 1200,
  distance: 4800,
  pitch: 55 * DEG,
  /**
   * How far the camera swings off the line of the stub. Straight behind
   * it, a band of empty space beyond the edge fills the bottom of the
   * screen; at an angle it is only a corner.
   */
  swing: 35 * DEG,
} as const;
