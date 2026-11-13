// The route tool in the debug panel (issue M1-15). Click a start and an end
// on the map; the quickest road route between them is highlighted, with its
// length and time, or the panel says there is no route.
//
// The route comes from `findRouteBetween`, the sim's own pathfinder, run on
// the mirror's read-only copy of the roads and its routing graph, which
// `applyRoadDelta` keeps current. It is worked out again whenever the mirror
// changes, so bulldozing the only link turns the route into "no route". The
// two points stay set after the tool is left, so the player can switch to
// the bulldozer and watch. Nothing here writes sim state.

import {
  LEVEL_BRIDGE,
  findRouteBetween,
  levelOffset,
  quadPoint,
  routingGraphOf,
  segmentQuad,
  subControl,
  type BuildPoint,
  type PointRoute,
  type RoadNetwork,
  type RouteResult,
} from "@city-council/sim";
import { isRaised, roadTypeOf, type RoadNet } from "../render/road-geometry";
import type { PreviewShape } from "../render/road-preview-geometry";
import type { RoadToolState } from "./road-tool";
import { ROUTE_TOOL } from "./config";

/** The route tool's part of the UI store. */
export interface RouteToolState {
  /** The start clicked, or null. */
  routeFrom: BuildPoint | null;
  /** The end clicked, or null until the second click. */
  routeTo: BuildPoint | null;
  /** The route between them on the mirror's roads as they are now, or null without both points. */
  routeResult: RouteResult<PointRoute> | null;
}

export const INITIAL_ROUTE_TOOL: RouteToolState = { routeFrom: null, routeTo: null, routeResult: null };

/** What the controller needs from the page. */
export interface RouteToolHost {
  get(): RoadToolState & RouteToolState;
  set(patch: Partial<RoadToolState & RouteToolState>): void;
  /** The mirror's roads, or null before the first snapshot. */
  net(): RoadNet | null;
}

function asNetwork(net: RoadNet): RoadNetwork {
  // The pathfinder only reads the network. The routing graph it keeps is
  // derived data, outside the mirror's copy of state.
  return net as unknown as RoadNetwork;
}

/** The route between `from` and `to` on `net`. */
export function routeBetween(net: RoadNet, from: BuildPoint, to: BuildPoint): RouteResult<PointRoute> {
  return findRouteBetween(routingGraphOf(asNetwork(net)), from.x, from.z, to.x, to.z, { radius: ROUTE_TOOL.attachRadius });
}

/** The route tool's input handling. Holds no state of its own. */
export class RouteToolController {
  private readonly host: RouteToolHost;

  constructor(host: RouteToolHost) {
    this.host = host;
  }

  active(): boolean {
    return this.host.get().tool === "route";
  }

  /** Turns the tool on, or off when it is on. Turning it on starts a new pick. */
  toggle(): void {
    if (this.active()) {
      this.host.set({ tool: null });
      return;
    }
    this.host.set({ tool: "route", roadStart: null, roadControl: null, roadChain: 0, ...INITIAL_ROUTE_TOOL });
  }

  /** Escape: clears the points, or leaves the tool when there are none. Returns whether it did anything. */
  escape(): boolean {
    if (!this.active()) return false;
    if (this.host.get().routeFrom) this.host.set({ ...INITIAL_ROUTE_TOOL });
    else this.host.set({ tool: null });
    return true;
  }

  /** A click on the ground at `hit`, or off the map. The first sets the start, the second the end, a third starts again. */
  click(hit: { x: number; z: number } | null): void {
    if (!this.active() || !hit) return;
    const s = this.host.get();
    const point = { x: hit.x, z: hit.z };
    if (!s.routeFrom || s.routeTo) this.host.set({ routeFrom: point, routeTo: null, routeResult: null });
    else this.host.set({ routeTo: point });
    this.refresh();
  }

  /** Works the route out again from the mirror's roads. Call on every mirror update. */
  refresh(): void {
    const s = this.host.get();
    const net = this.host.net();
    const result = net && s.routeFrom && s.routeTo ? routeBetween(net, s.routeFrom, s.routeTo) : null;
    if (result !== null || s.routeResult !== null) this.host.set({ routeResult: result });
  }
}

/** The piece of segment `seg` from parameter `t0` to `t1`, as a highlight strip. */
function piece(net: RoadNet, seg: number, t0: number, t1: number): PreviewShape {
  const q = segmentQuad(asNetwork(net), seg);
  const a = quadPoint(q, t0);
  const b = quadPoint(q, t1);
  const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
  const shape: PreviewShape = {
    ax: a.x,
    az: a.z,
    bx: b.x,
    bz: b.z,
    control: straight ? null : subControl(q, t0, t1),
    width: roadTypeOf(net, seg).width * ROUTE_TOOL.widthScale,
    look: "route",
    junctions: [],
    bridges: [],
  };
  // A whole bridge is drawn on its deck. A part of one is rare enough in a debug tool to lie on the ground.
  if (net.segLevelA[seg] === LEVEL_BRIDGE && t0 === 0 && t1 === 1) {
    const na = net.segA[seg] ?? 0;
    const nb = net.segB[seg] ?? 0;
    shape.deck = { hA: net.nodeHeight[na] ?? 0, hB: net.nodeHeight[nb] ?? 0, grade: roadTypeOf(net, seg).maxSlope };
  } else if (isRaised(net, seg)) {
    const a = levelOffset(net.segLevelA[seg] ?? 0);
    const b = levelOffset(net.segLevelB[seg] ?? 0);
    shape.raise = { a: a + (b - a) * t0, b: a + (b - a) * t1 };
  }
  return shape;
}

/**
 * The strips that highlight a route: each segment it uses, with the first
 * and last cut where the route joins and leaves them.
 */
export function routeShapes(net: RoadNet, route: PointRoute): PreviewShape[] {
  const out: PreviewShape[] = [];
  const last = route.segments.length - 1;
  route.segments.forEach((seg, i) => {
    const forward = route.forward[i] ?? true;
    // The part travelled, as curve parameters from node A.
    let t0 = 0;
    let t1 = 1;
    if (i === 0) {
      if (forward) t0 = route.start.t;
      else t1 = route.start.t;
    }
    if (i === last) {
      if (forward) t1 = route.end.t;
      else t0 = route.end.t;
    }
    if (t1 > t0) out.push(piece(net, seg, t0, t1));
  });
  return out;
}

/** Plan length in metres as the readout shows it, such as "850 m" or "2.35 km". */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/** Seconds as the readout shows them, such as "45 s" or "3 min 05 s". */
export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  return `${minutes} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** What the debug panel says about the route tool. */
export function routeReadout(s: RouteToolState & { tool: RoadToolState["tool"] }): string {
  if (s.routeResult) {
    if (!s.routeResult.ok) return s.routeResult.reason;
    const r = s.routeResult.route;
    const segments = r.segments.length === 1 ? "1 segment" : `${r.segments.length} segments`;
    return `${formatDistance(r.distance)}, ${formatDuration(r.time)}, ${segments}`;
  }
  if (s.tool !== "route") return "off";
  return s.routeFrom ? "click the end" : "click the start";
}
