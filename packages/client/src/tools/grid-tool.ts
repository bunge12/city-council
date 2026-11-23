// The grid tool (issue M1-21, reworked in issue 88). A player lays out a
// street grid in three moves:
//
//   drag     draws the grid's first side, from the corner pressed to the
//            corner released. Its end snaps as a road's end does: the angle
//            guide lines it up with the road it starts on, or with the map
//            on open ground, and the guide lines, offsets and cell lines
//            line it up with roads and zoning nearby
//   move     sets how far the grid reaches from that side, square to it, on
//            whichever side the pointer is; a click or Enter fixes it
//   confirm  the Confirm button or Enter sends one `BuildRoadGrid`
//
// Escape or a right-click drops the rectangle, and Escape with nothing drawn
// leaves the tool. The block size is set in cells in the build bar, twelve
// deep by default, and the road type comes from the road type picker.
//
// The preview runs `planRoadGrid`, the function the sim plans the command
// with, on the mirror's read-only copy of the roads, so it shows the streets
// the sim would lay and where water or steep ground cuts them. Then each
// link with a road near it is checked with `planRoad`, the function
// `BuildRoad` is checked with, which finds the junctions with existing roads
// and most refusals; a link with none near it cannot have either. The sim
// checks the links one after another on a network the earlier links have
// changed, which the client cannot do without writing its copy, so the sim
// still has the final say and its reason shows if it refuses.
//
// A sent grid stays on screen until the delta that carries its roads, as a
// sent road does. Tool state lives in the UI store; nothing here writes sim
// state.

import {
  LEVEL_GROUND,
  NETWORKS_ROAD,
  NONE,
  ROAD_BUILD,
  ROAD_TYPES,
  planRoad,
  planRoadGrid,
  roadIndexOf,
  segmentsInBox,
  snapToGrid,
  type BuildPoint,
  type BuildRoadGridPayload,
  type BuildingsInTheWay,
  type GridPlan,
  type CommandResult,
  type GridStreet,
  type RoadNetwork,
  type RoadType,
  type Terrain,
} from "@city-council/sim";
import type { RoadNet } from "../render/road-geometry";
import type { PreviewLook, PreviewShape } from "../render/road-preview-geometry";
import type { SnapMark } from "../render/snap-marks-geometry";
import { GRID_TOOL, SNAP } from "./config";
import { cellCornerSource, cellEdgeSource, type CellLookup } from "./cell-snap";
import { SNAP_SOURCES, angleSource, nodeSource, segmentSource, snapPoint, startSource, type Snap, type SnapSource } from "./snap";
import type { RoadToolState } from "./road-tool";

/**
 * Where the grid tool is: drawing the first side, setting how far the grid
 * reaches from it, or holding a rectangle until Confirm.
 */
export type GridStage = "side" | "depth" | "placed";

/** What the grid tool would send, and what the sim would do with it. */
export interface GridPreview {
  payload: BuildRoadGridPayload;
  type: RoadType;
  ok: boolean;
  /** Why the sim would refuse it, or null when it would build it. */
  reason: string | null;
  /** The streets, in the order the sim builds them. Empty when the plan itself is refused. */
  streets: readonly GridStreet[];
  /** Where a street would meet an existing road. */
  junctions: readonly BuildPoint[];
  /** Street ends that water or steep ground cut. */
  cuts: readonly BuildPoint[];
  /** Plan length of every street, metres. */
  length: number;
  /** Whole dollars. Not charged until M4. */
  cost: number;
  /**
   * The buildings the grid would clear and their residents, from the sim's
   * `gridClears` on the mirror (issue M2-15). Null while the rectangle is
   * being dragged, since rehearsing a big grid takes tens of milliseconds,
   * and for a refused grid.
   */
  clears: BuildingsInTheWay | null;
  /**
   * The cells the grid's streets would open, eight corner numbers a cell,
   * from the sim's `gridEffects` on the mirror. Found once the rectangle is
   * placed, as `clears` is; null before then and for a refused grid.
   */
  newCells: Float64Array | null;
}

/** Finds the buildings a planned grid would clear: the sim's `gridClears` on the mirror. */
export type GridClears = (plan: GridPlan) => BuildingsInTheWay;

/** Finds the cells a planned grid would open: the sim's `gridEffects` on the mirror. */
export type GridCells = (plan: GridPlan) => Float64Array;

/** A grid the tool has sent and the sim has not yet built or refused. */
export interface PendingGrid {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: GridPreview;
}

/** The grid tool's part of the UI store. */
export interface GridToolState {
  /** Block depth, cells between road edges from one street to the next across the first side. */
  gridDepthCells: number;
  /** Block width, cells between road edges from one street to the next along the first side. */
  gridWidthCells: number;
  /** Where the grid tool is, or null when no rectangle is being drawn. */
  gridStage: GridStage | null;
  /** The corner the first side starts from, or null when none is drawn. */
  gridOrigin: BuildPoint | null;
  /** The other end of the first side. */
  gridSideEnd: BuildPoint | null;
  /**
   * How far the grid reaches from the first side, metres, signed: positive
   * to the left looking from the origin along the side.
   */
  gridReach: number;
  gridPending: readonly PendingGrid[];
  /** The last refusal, from the preview or from the sim. */
  gridNote: string | null;
}

export const INITIAL_GRID_TOOL: GridToolState = {
  gridDepthCells: GRID_TOOL.defaultDepthCells,
  gridWidthCells: GRID_TOOL.defaultWidthCells,
  gridStage: null,
  gridOrigin: null,
  gridSideEnd: null,
  gridReach: 0,
  gridPending: [],
  gridNote: null,
};

const NO_RECTANGLE = { gridStage: null, gridOrigin: null, gridSideEnd: null, gridReach: 0 } as const;

function typeById(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(`no road type "${id}"`);
  return type;
}

function asNetwork(net: RoadNet): RoadNetwork {
  // The planners only read the network. They take the mutable type because
  // the sim calls them on live state; the copy here is never written.
  return net as unknown as RoadNetwork;
}

function onGrid(p: BuildPoint): BuildPoint {
  return { x: snapToGrid(p.x), z: snapToGrid(p.z) };
}

/** The unit direction from `a` to `b`, or null when they are the same point. */
function unitFrom(a: BuildPoint, b: BuildPoint): { dx: number; dz: number } | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { dx: dx / len, dz: dz / len } : null;
}

/**
 * How far `point` lies from the line through the first side, from `origin`
 * to `sideEnd`, metres: positive to the left looking along the side, which
 * is the side `gridCorners` reaches toward with a positive reach.
 */
export function reachTo(origin: BuildPoint, sideEnd: BuildPoint, point: BuildPoint): number {
  const u = unitFrom(origin, sideEnd);
  if (!u) return 0;
  return (point.z - origin.z) * u.dx - (point.x - origin.x) * u.dz;
}

/**
 * The three corners of the rectangle with its first side from `origin` to
 * `sideEnd`, reaching `reach` metres square to it, to the left for a
 * positive reach. Corners are on the build grid, as the sim takes them.
 */
export function gridCorners(origin: BuildPoint, sideEnd: BuildPoint, reach: number): { origin: BuildPoint; along: BuildPoint; across: BuildPoint } {
  const u = unitFrom(origin, sideEnd) ?? { dx: 1, dz: 0 };
  // Square to the side, turned a quarter to the left.
  return {
    origin: onGrid(origin),
    along: onGrid(sideEnd),
    across: onGrid({ x: origin.x - u.dz * reach, z: origin.z + u.dx * reach }),
  };
}

/**
 * Lines a grid's first side up with the road it starts on, straight along
 * it either way or square to it, or with the map's axes on open ground. The
 * road tool's angle guide leaves out the directions along the road a road
 * starts from, since a road there would lie on top of it, but a grid's side
 * along its road is how the grid lines up with it: the sim leaves out what
 * lies along an existing road and joins the rest. Catches as the angle
 * guide's strong steps do. Off with the angle guide or while the free-hand
 * key is held.
 */
export const sideAxisSource: SnapSource = {
  id: "side-axis",
  find(x, z, ctx) {
    const { start } = ctx;
    if (!start || !ctx.guides.angle || ctx.free) return null;
    const vx = x - start.x;
    const vz = z - start.z;
    const reach = SNAP.strongAnglePx * ctx.metresPerPixel;
    const base = ctx.source?.dirs ?? [{ dx: 1, dz: 0 }];
    let best: { d: number; t: number; dx: number; dz: number } | null = null;
    for (const dir of base) {
      for (const [dx, dz] of [
        [dir.dx, dir.dz],
        [-dir.dz, dir.dx],
        [-dir.dx, -dir.dz],
        [dir.dz, -dir.dx],
      ] as const) {
        const t = vx * dx + vz * dz;
        if (t <= 0) continue;
        const d = Math.abs(vx * dz - vz * dx);
        if (d <= reach && (!best || d < best.d)) best = { d, t, dx, dz };
      }
    }
    if (!best) return null;
    return { kind: "angle", x: start.x + best.dx * best.t, z: start.z + best.dz * best.t, ray: { dx: best.dx, dz: best.dz } };
  },
};

/** What the first side's end snaps to: everything a road's end does, with the side's own axes after the angle guide. */
const SIDE_SOURCES: readonly SnapSource[] = SNAP_SOURCES.flatMap((source) => (source === angleSource ? [source, sideAxisSource] : [source]));
/** What the first corner and the reach snap to: road nodes and segments, and zoned cells' corners and edges. */
const CORNER_SOURCES: readonly SnapSource[] = [nodeSource, cellCornerSource, segmentSource, cellEdgeSource];

/** The `BuildRoadGrid` payload for a rectangle and a block size in cells. */
export function gridPayload(
  origin: BuildPoint,
  sideEnd: BuildPoint,
  reach: number,
  depthCells: number,
  widthCells: number,
  typeId: string,
): BuildRoadGridPayload {
  return {
    ...gridCorners(origin, sideEnd, reach),
    depth: depthCells * SNAP.cellSize,
    width: widthCells * SNAP.cellSize,
    type: typeId,
  };
}

const samePoint = (p: BuildPoint, q: BuildPoint): boolean => p.x === q.x && p.z === q.z;

/**
 * Whether no road, at any level, comes within the merge distance of the
 * link from `a` to `b`. `planRoad` looks no further than that for what a
 * road joins, crosses or passes over, so such a link has no junction and no
 * refusal but the ground's, which the plan has already checked, and the
 * preview need not plan it (issue 88). On open ground that is most links.
 */
function clearOfRoads(net: RoadNetwork, a: BuildPoint, b: BuildPoint): boolean {
  const r = ROAD_BUILD.mergeDistance;
  const minX = Math.min(a.x, b.x) - r;
  const minZ = Math.min(a.z, b.z) - r;
  const maxX = Math.max(a.x, b.x) + r;
  const maxZ = Math.max(a.z, b.z) + r;
  return segmentsInBox(roadIndexOf(net), minX, minZ, maxX, maxZ, NETWORKS_ROAD).length === 0;
}

/**
 * What the sim would do with `payload`, checked against the mirror's roads.
 * Changes nothing. A refused plan has no streets; a plan whose link the
 * sim would refuse keeps its streets and names the street, as the sim does.
 */
export function previewGrid(
  net: RoadNet,
  terrain: Terrain,
  payload: BuildRoadGridPayload,
  clearsOf: GridClears | null = null,
  cellsOf: GridCells | null = null,
): GridPreview {
  const type = typeById(payload.type);
  const result = planRoadGrid(asNetwork(net), terrain, payload);
  if (!result.ok) {
    return { payload, type, ok: false, reason: result.reason, streets: [], junctions: [], cuts: [], length: 0, cost: 0, clears: null, newCells: null };
  }
  const { streets, length, cost } = result.plan;
  const junctions: BuildPoint[] = [];
  const cuts: BuildPoint[] = [];
  let reason: string | null = null;
  streets.forEach((street, s) => {
    const first = street.points[0];
    const last = street.points[street.points.length - 1];
    if (street.cutStart && first) cuts.push(first);
    if (street.cutEnd && last) cuts.push(last);
    for (let k = 1; k < street.points.length; k++) {
      const from = street.points[k - 1] as BuildPoint;
      const to = street.points[k] as BuildPoint;
      if (clearOfRoads(asNetwork(net), from, to)) continue;
      const link = planRoad(asNetwork(net), terrain, { from, to, type: type.id });
      let problem: string | null = null;
      if (!link.ok) problem = link.reason;
      else if (link.plan.levels.some((level) => level !== LEVEL_GROUND)) problem = "The street would need a bridge, and a grid never builds one";
      if (problem !== null) {
        reason ??= `Street ${s + 1} of ${streets.length} in the grid: ${problem}`;
        continue;
      }
      if (!link.ok) continue;
      for (const stop of link.plan.stops) {
        if (stop.node === NONE && stop.splits.length === 0) continue;
        const p = { x: stop.x, z: stop.z };
        if (!junctions.some((j) => samePoint(j, p))) junctions.push(p);
      }
    }
  });
  const ok = reason === null;
  return {
    payload,
    type,
    ok,
    reason,
    streets,
    junctions,
    cuts,
    length,
    cost: ok ? cost : 0,
    clears: ok && clearsOf ? clearsOf(result.plan) : null,
    newCells: ok && cellsOf ? cellsOf(result.plan) : null,
  };
}

/** The road preview strips for a grid: one per link, with junction discs on the links that meet a road. */
export function gridShapes(preview: GridPreview, look: PreviewLook): PreviewShape[] {
  const shapes: PreviewShape[] = [];
  const width = preview.type.width;
  for (const street of preview.streets) {
    for (let k = 1; k < street.points.length; k++) {
      const a = street.points[k - 1] as BuildPoint;
      const b = street.points[k] as BuildPoint;
      const minX = Math.min(a.x, b.x) - 1e-6;
      const maxX = Math.max(a.x, b.x) + 1e-6;
      const minZ = Math.min(a.z, b.z) - 1e-6;
      const maxZ = Math.max(a.z, b.z) + 1e-6;
      const junctions = look === "refused" ? [] : preview.junctions.filter((j) => j.x >= minX && j.x <= maxX && j.z >= minZ && j.z <= maxZ && onLink(a, b, j));
      shapes.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, control: null, width, look, junctions, bridges: [] });
    }
  }
  return shapes;
}

/** Whether `p` lies on the link from `a` to `b`, within a few centimetres. */
function onLink(a: BuildPoint, b: BuildPoint, p: BuildPoint): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return false;
  return Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / len < 0.05;
}

/** The rectangle's outline and a cross at each cut street end, as flat marks. */
export function gridMarks(payload: BuildRoadGridPayload, cuts: readonly BuildPoint[]): SnapMark[] {
  const { origin: o, along: p, across: q } = payload;
  const far = { x: p.x + q.x - o.x, z: p.z + q.z - o.z };
  const corners = [o, p, far, q];
  const marks: SnapMark[] = corners.map((c, i) => {
    const d = corners[(i + 1) % 4] as BuildPoint;
    return { shape: "line", ax: c.x, az: c.z, bx: d.x, bz: d.z, look: "angle" };
  });
  for (const c of cuts) marks.push({ shape: "cross", x: c.x, z: c.z, look: "cut" });
  return marks;
}

/** The first side while it is drawn, before the grid has any reach, as a flat mark. */
export function gridSideMarks(origin: BuildPoint, sideEnd: BuildPoint): SnapMark[] {
  return [{ shape: "line", ax: origin.x, az: origin.z, bx: sideEnd.x, bz: sideEnd.z, look: "angle" }];
}

/** What the controller needs from the page. */
export interface GridToolHost {
  get(): GridToolState & Pick<RoadToolState, "tool" | "roadType" | "guides">;
  set(patch: Partial<GridToolState & Pick<RoadToolState, "tool" | "roadNote" | "roadStart" | "roadControl" | "roadChain">>): void;
  /**
   * The mirror's roads and the map, its zoned cells for the snap, and ways
   * to find the buildings a grid would clear and the cells it would open,
   * or null before the first snapshot.
   */
  world(): { net: RoadNet; terrain: Terrain; cells?: CellLookup; clears?: GridClears; newCells?: GridCells } | null;
  /** Sends `BuildRoadGrid` and resolves once the sim has built it, or with why it did not. */
  send(payload: BuildRoadGridPayload): Promise<CommandResult>;
}

/** What the snap needs from the view at the pointer. */
export interface GridSnapView {
  /** Metres one CSS pixel covers at the pointer. */
  metresPerPixel: number;
  /** The free-hand key, Alt, is held: no snaps. */
  free: boolean;
}

/** The grid tool's input handling. Holds no state of its own beyond a counter for ids and the preview cache. */
export class GridToolController {
  private readonly host: GridToolHost;
  private nextId = 1;
  /** The last preview worked out, and what it was worked out for. */
  private cacheKey = "";
  private cached: GridPreview | null = null;
  private version = 0;
  /** Counts mirror updates that carried buildings, so the buildings in the way are found again. */
  private buildingsVersion = 0;
  /**
   * The rectangle a drag replaced, while the drag is under way. A drag too
   * short to be a side puts it back, so a click that moved a few pixels
   * does not lose it.
   */
  private replaced: Pick<GridToolState, "gridStage" | "gridOrigin" | "gridSideEnd" | "gridReach"> | null = null;

  constructor(host: GridToolHost) {
    this.host = host;
  }

  active(): boolean {
    return this.host.get().tool === "grid";
  }

  /** Turns the grid tool on, or off when it is on. Off drops the rectangle. */
  toggle(): void {
    if (this.active()) this.leave();
    else this.host.set({ tool: "grid", gridNote: null, roadNote: null, roadStart: null, roadControl: null, roadChain: 0, ...NO_RECTANGLE });
  }

  leave(): void {
    this.host.set({ tool: null, gridNote: null, ...NO_RECTANGLE });
  }

  /** Sets the block depth or width, in whole cells, within the tool's limits. */
  setBlock(side: "depth" | "width", cells: number): void {
    if (!Number.isFinite(cells)) return;
    const value = Math.min(GRID_TOOL.maxBlockCells, Math.max(GRID_TOOL.minBlockCells, Math.round(cells)));
    this.host.set(side === "depth" ? { gridDepthCells: value, gridNote: null } : { gridWidthCells: value, gridNote: null });
  }

  /** Escape: drops the rectangle, or leaves the tool when there is none. Returns whether it did anything. */
  escape(): boolean {
    if (!this.active()) return false;
    if (this.host.get().gridStage) this.drop();
    else this.leave();
    return true;
  }

  /** A right-click: drops the rectangle. */
  cancel(): void {
    if (this.active() && this.host.get().gridStage) this.drop();
  }

  private drop(): void {
    this.replaced = null;
    this.host.set({ gridNote: null, ...NO_RECTANGLE });
  }

  /** The start of the snap marks' angle and length guides: the first corner while the first side is drawn. */
  anchor(): BuildPoint | null {
    const s = this.host.get();
    return s.gridStage === "side" ? s.gridOrigin : null;
  }

  /**
   * Where the pointer at `ground` lands, for the move it would be. The
   * first side's end snaps as a road's end does, measured from the first
   * corner (issue 88). The first corner and the reach catch road nodes and
   * segments, and the corners and edges of zoned cells when the road tool's
   * cell guide is on (issue M2-08).
   */
  snap(ground: BuildPoint, view: GridSnapView): Snap | null {
    const world = this.host.world();
    if (!world) return null;
    const s = this.host.get();
    const type = typeById(s.roadType);
    const drawingSide = s.gridStage === "side" && s.gridOrigin !== null;
    const start = drawingSide ? s.gridOrigin : null;
    return snapPoint(
      ground.x,
      ground.z,
      {
        net: world.net,
        start,
        source: start ? startSource(world.net, start) : null,
        metresPerPixel: view.metresPerPixel,
        guides: drawingSide ? s.guides : { angle: false, length: false, grid: false, lines: false, offset: false, cells: s.guides.cells },
        free: view.free,
        gridStep: world.terrain.spacing,
        roadWidth: type.width,
        cells: world.cells ?? null,
      },
      drawingSide ? SIDE_SOURCES : CORNER_SOURCES,
    );
  }

  /** A drag began at `ground`, already snapped: the first side starts there. Any rectangle drawn before goes. */
  dragStart(ground: BuildPoint | null): void {
    if (!this.active() || !ground || !this.host.world()) return;
    const s = this.host.get();
    this.replaced = s.gridStage === "depth" || s.gridStage === "placed" ? { gridStage: s.gridStage, gridOrigin: s.gridOrigin, gridSideEnd: s.gridSideEnd, gridReach: s.gridReach } : null;
    const origin = onGrid(ground);
    this.host.set({ gridStage: "side", gridOrigin: origin, gridSideEnd: origin, gridReach: 0, gridNote: null });
  }

  /** The pointer moved to `ground`, already snapped, during the drag: the first side ends there. */
  dragMove(ground: BuildPoint | null): void {
    const s = this.host.get();
    if (!this.active() || s.gridStage !== "side" || !ground) return;
    this.host.set({ gridSideEnd: onGrid(ground) });
  }

  /**
   * The button came up: the first side is set, and the pointer now sets the
   * reach. A side shorter than the shortest road the sim builds is no side:
   * it was a click that moved a little, so a rectangle it replaced comes
   * back, and is placed as a click would place it.
   */
  dragEnd(): void {
    const s = this.host.get();
    if (s.gridStage !== "side") return;
    const o = s.gridOrigin;
    const e = s.gridSideEnd;
    const replaced = this.replaced;
    this.replaced = null;
    if (!o || !e || Math.hypot(e.x - o.x, e.z - o.z) < ROAD_BUILD.minLength) {
      if (replaced) {
        this.host.set(replaced);
        this.click();
      } else this.drop();
      return;
    }
    this.host.set({ gridStage: "depth" });
  }

  /** The drag was cut off: the rectangle goes. */
  dragCancel(): void {
    if (this.host.get().gridStage === "side") this.drop();
  }

  /**
   * The pointer is at `ground`, already snapped, with no button held. While
   * the reach is being set, the grid reaches square from the first side to
   * the pointer. When the length guide is on, nothing caught the pointer
   * and the free-hand key is not held, the reach is whole cells, as a
   * road's length is.
   */
  hover(ground: Snap | BuildPoint | null, free = false): void {
    const s = this.host.get();
    if (!this.active() || s.gridStage !== "depth" || !ground || !s.gridOrigin || !s.gridSideEnd) return;
    let reach = reachTo(s.gridOrigin, s.gridSideEnd, ground);
    const caught = "kind" in ground && ground.kind !== "none";
    if (!caught && !free && s.guides.length) reach = Math.sign(reach) * Math.max(1, Math.round(Math.abs(reach) / SNAP.cellSize)) * SNAP.cellSize;
    if (reach !== s.gridReach) this.host.set({ gridReach: reach });
  }

  /** A click on the map: while the reach is being set, it fixes the rectangle, which waits for Confirm. */
  click(): void {
    const s = this.host.get();
    if (!this.active() || s.gridStage !== "depth" || !this.payload()) return;
    this.host.set({ gridStage: "placed" });
  }

  /**
   * Call on every mirror update, so the preview is checked again against the
   * new roads. `lotOf` gives a standing building's lot corners. The
   * buildings in the way are found again only when a building that came or
   * went was among them or stands within reach of the rectangle, since
   * rehearsing a big grid takes tens of milliseconds and a growing city
   * changes buildings nearly every tick.
   */
  mirrorUpdated(
    update: { kind: "snapshot" } | { kind: "delta"; steps: number; roadNodes: readonly number[]; roadSegs: readonly number[]; buildingIds?: readonly number[] },
    lotOf: (id: number) => readonly number[] | null = () => null,
  ): void {
    if (update.kind === "snapshot" || update.roadNodes.length > 0 || update.roadSegs.length > 0) this.version++;
    if (update.kind === "snapshot") {
      this.buildingsVersion++;
      return;
    }
    const ids = update.buildingIds ?? [];
    if (ids.length === 0) return;
    const counted = this.cached?.clears?.ids ?? [];
    const box = this.reach();
    const near = (id: number): boolean => {
      if (counted.includes(id)) return true;
      const c = lotOf(id);
      if (!c || !box) return false;
      for (let i = 0; i + 1 < c.length; i += 2) {
        const x = c[i] ?? 0;
        const z = c[i + 1] ?? 0;
        if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) return true;
      }
      return false;
    };
    if (ids.some(near)) this.buildingsVersion++;
  }

  /** The rectangle's bounding box, widened by a street's reach, or null when none is drawn. */
  private reach(): { x0: number; z0: number; x1: number; z1: number } | null {
    const p = this.payload();
    if (!p) return null;
    const far = { x: p.along.x + p.across.x - p.origin.x, z: p.along.z + p.across.z - p.origin.z };
    const xs = [p.origin.x, p.along.x, p.across.x, far.x];
    const zs = [p.origin.z, p.along.z, p.across.z, far.z];
    // A street's surface reaches half its width past its line; a lot's corner can sit outside the box while the lot crosses it.
    const pad = GRID_TOOL.clearsReachMetres;
    return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad };
  }

  /** The payload for the rectangle drawn now, or null while there is none or it has no reach yet. */
  payload(): BuildRoadGridPayload | null {
    const s = this.host.get();
    if (!this.active() || s.gridStage === null || s.gridStage === "side" || !s.gridOrigin || !s.gridSideEnd) return null;
    if (samePoint(s.gridOrigin, s.gridSideEnd)) return null;
    const payload = gridPayload(s.gridOrigin, s.gridSideEnd, s.gridReach, s.gridDepthCells, s.gridWidthCells, s.roadType);
    return samePoint(payload.origin, payload.across) ? null : payload;
  }

  /** The first side while it is being drawn, for its mark, or null. */
  side(): { origin: BuildPoint; end: BuildPoint } | null {
    const s = this.host.get();
    if (!this.active() || s.gridStage !== "side" || !s.gridOrigin || !s.gridSideEnd) return null;
    return { origin: s.gridOrigin, end: s.gridSideEnd };
  }

  /**
   * The preview of the rectangle drawn now, worked out again only when it or
   * the roads change. The buildings in its way are found once the
   * rectangle is placed, and again when buildings come or go.
   */
  preview(): GridPreview | null {
    const payload = this.payload();
    const world = this.host.world();
    if (!payload || !world) return null;
    const settled = this.host.get().gridStage === "placed" && world.clears !== undefined;
    const key = `${JSON.stringify(payload)}|${this.version}|${settled ? this.buildingsVersion : "-"}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cached = previewGrid(world.net, world.terrain, payload, settled ? (world.clears ?? null) : null, settled ? (world.newCells ?? null) : null);
    }
    return this.cached;
  }

  /**
   * Confirm or Enter: sends the grid if the preview passes. A grid the
   * preview refuses sends nothing and keeps its reason on screen. While the
   * reach still follows the pointer, Enter places the rectangle instead, so
   * the buildings it would clear show before a second Enter sends it.
   */
  confirm(): void {
    const s = this.host.get();
    if (!this.active() || s.gridStage === "side") return;
    if (s.gridStage === "depth") {
      this.click();
      return;
    }
    const preview = this.preview();
    if (!preview) return;
    if (!preview.ok) {
      this.host.set({ gridNote: preview.reason });
      return;
    }
    const pending: PendingGrid = { id: this.nextId++, preview };
    this.host.set({ ...NO_RECTANGLE, gridNote: null, gridPending: [...s.gridPending, pending] });
    void this.host.send(preview.payload).then((result) => this.answered(pending.id, result));
  }

  /** The sim built the grid, and the copy shows it, or refused it: either way its preview goes. */
  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().gridPending.filter((p) => p.id !== id);
    this.host.set(result.ok ? { gridPending: pending } : { gridPending: pending, gridNote: result.reason });
  }
}
