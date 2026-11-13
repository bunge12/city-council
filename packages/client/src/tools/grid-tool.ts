// The grid tool (issue M1-21). A player lays out a street grid with one drag
// and one confirm:
//
//   drag     from one corner to the other. Started on a road, the
//            rectangle takes that road's angle; on open ground it is
//            square to the map, and holding Alt during the drag turns it
//            around the corner the drag started from
//   confirm  the Confirm button or Enter sends one `BuildRoadGrid`
//
// Escape or a right-click drops the rectangle, and Escape with nothing drawn
// leaves the tool. The block size is set in cells in the build bar, twelve
// deep by default, and the road type comes from the road type picker.
//
// The preview runs `planRoadGrid`, the function the sim plans the command
// with, on the mirror's read-only copy of the roads, so it shows the streets
// the sim would lay and where water or steep ground cuts them. Then each
// link is checked with `planRoad`, the function `BuildRoad` is checked with,
// which finds the junctions with existing roads and most refusals. The sim
// checks the links one after another on a network the earlier links have
// changed, which the client cannot do without writing its copy, so the sim
// still has the final say and its reason shows if it refuses.
//
// A sent grid stays on screen until the delta that carries its roads, as a
// sent road does. Tool state lives in the UI store; nothing here writes sim
// state.

import {
  LEVEL_GROUND,
  NONE,
  ROAD_TYPES,
  planRoad,
  planRoadGrid,
  snapToGrid,
  type BuildPoint,
  type BuildRoadGridPayload,
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
import { nodeSource, segmentSource, snapPoint, startSource, type Snap } from "./snap";
import type { RoadToolState } from "./road-tool";

/** A unit direction in plan. */
export interface Dir {
  dx: number;
  dz: number;
}

/** Map-square: the rectangle's first side runs east. */
export const SQUARE_TO_MAP: Dir = { dx: 1, dz: 0 };

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
}

/** A grid the tool has sent and the sim has not yet built or refused. */
export interface PendingGrid {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: GridPreview;
  status: "sending" | "accepted";
}

/** The grid tool's part of the UI store. */
export interface GridToolState {
  /** Block depth, cells between road edges from one street to the next across the first side. */
  gridDepthCells: number;
  /** Block width, cells between road edges from one street to the next along the first side. */
  gridWidthCells: number;
  /** The corner the drag started from, or null when no rectangle is drawn. */
  gridOrigin: BuildPoint | null;
  /** The far corner, where the pointer is or was when the drag ended. */
  gridCorner: BuildPoint | null;
  /** The direction of the rectangle's first side. */
  gridDir: Dir;
  /** The drag started on a road, so the rectangle keeps that road's angle. */
  gridOnRoad: boolean;
  /** The drag is under way. */
  gridDragging: boolean;
  gridPending: readonly PendingGrid[];
  /** The last refusal, from the preview or from the sim. */
  gridNote: string | null;
}

export const INITIAL_GRID_TOOL: GridToolState = {
  gridDepthCells: GRID_TOOL.defaultDepthCells,
  gridWidthCells: GRID_TOOL.defaultWidthCells,
  gridOrigin: null,
  gridCorner: null,
  gridDir: SQUARE_TO_MAP,
  gridOnRoad: false,
  gridDragging: false,
  gridPending: [],
  gridNote: null,
};

const NO_RECTANGLE = { gridOrigin: null, gridCorner: null, gridDir: SQUARE_TO_MAP, gridOnRoad: false, gridDragging: false } as const;

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

/**
 * The direction a rectangle started at `origin` takes: the road there, as
 * the road tool finds what a road starts from, or null on open ground. On a
 * segment it is the segment's direction at that point; at a node, the first
 * road leaving it.
 */
export function roadDirAt(net: RoadNet, origin: BuildPoint): Dir | null {
  const source = startSource(net, origin);
  return source?.dirs[0] ?? null;
}

/**
 * The three corners of the rectangle from `origin` to the pointer at
 * `corner`, with its first side along `dir`. The pointer is projected onto
 * the two sides, so the rectangle's far corner is the pointer. Corners are
 * on the build grid, as the sim takes them.
 */
export function gridCorners(origin: BuildPoint, corner: BuildPoint, dir: Dir): { origin: BuildPoint; along: BuildPoint; across: BuildPoint } {
  const dx = corner.x - origin.x;
  const dz = corner.z - origin.z;
  const a = dx * dir.dx + dz * dir.dz;
  // Square to `dir`, turned a quarter to the left.
  const vx = -dir.dz;
  const vz = dir.dx;
  const b = dx * vx + dz * vz;
  return {
    origin: onGrid(origin),
    along: onGrid({ x: origin.x + dir.dx * a, z: origin.z + dir.dz * a }),
    across: onGrid({ x: origin.x + vx * b, z: origin.z + vz * b }),
  };
}

/**
 * The direction that turns the rectangle `size`, measured along and across
 * `dir`, around its origin so its far corner points at `toward`. Whole
 * degrees, so a turned grid reads cleanly. Holding Alt during a drag on
 * open ground calls this.
 */
export function turnedDir(origin: BuildPoint, toward: BuildPoint, size: { a: number; b: number }): Dir {
  const pointer = Math.atan2(toward.z - origin.z, toward.x - origin.x);
  const diagonal = Math.atan2(size.b, size.a);
  const step = GRID_TOOL.turnStepDegrees * (Math.PI / 180);
  const angle = Math.round((pointer - diagonal) / step) * step;
  return { dx: Math.cos(angle), dz: Math.sin(angle) };
}

/** The rectangle's size along and across `dir`, metres, signed. */
export function rectangleSize(origin: BuildPoint, corner: BuildPoint, dir: Dir): { a: number; b: number } {
  const dx = corner.x - origin.x;
  const dz = corner.z - origin.z;
  return { a: dx * dir.dx + dz * dir.dz, b: -dx * dir.dz + dz * dir.dx };
}

/** The `BuildRoadGrid` payload for a rectangle and a block size in cells. */
export function gridPayload(
  origin: BuildPoint,
  corner: BuildPoint,
  dir: Dir,
  depthCells: number,
  widthCells: number,
  typeId: string,
): BuildRoadGridPayload {
  return {
    ...gridCorners(origin, corner, dir),
    depth: depthCells * SNAP.cellSize,
    width: widthCells * SNAP.cellSize,
    type: typeId,
  };
}

const samePoint = (p: BuildPoint, q: BuildPoint): boolean => p.x === q.x && p.z === q.z;

/**
 * What the sim would do with `payload`, checked against the mirror's roads.
 * Changes nothing. A refused plan has no streets; a plan whose link the
 * sim would refuse keeps its streets and names the street, as the sim does.
 */
export function previewGrid(net: RoadNet, terrain: Terrain, payload: BuildRoadGridPayload): GridPreview {
  const type = typeById(payload.type);
  const result = planRoadGrid(asNetwork(net), terrain, payload);
  if (!result.ok) {
    return { payload, type, ok: false, reason: result.reason, streets: [], junctions: [], cuts: [], length: 0, cost: 0 };
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
  return { payload, type, ok: reason === null, reason, streets, junctions, cuts, length, cost: reason === null ? cost : 0 };
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

/** What the controller needs from the page. */
export interface GridToolHost {
  get(): GridToolState & Pick<RoadToolState, "tool" | "roadType">;
  set(patch: Partial<GridToolState & Pick<RoadToolState, "tool" | "roadNote" | "roadStart" | "roadControl" | "roadChain">>): void;
  /** The mirror's roads and the map, or null before the first snapshot. */
  world(): { net: RoadNet; terrain: Terrain } | null;
  /** Sends `BuildRoadGrid` and resolves with the sim's answer. */
  send(payload: BuildRoadGridPayload): Promise<CommandResult>;
}

/** What the corner snap needs from the view at the pointer. */
export interface GridSnapView {
  /** Metres one CSS pixel covers at the pointer. */
  metresPerPixel: number;
  /** The free-hand key, Alt, is held: no snaps, and on open ground the rectangle turns. */
  free: boolean;
}

/** The grid tool's input handling. Holds no state of its own beyond a counter for ids. */
export class GridToolController {
  private readonly host: GridToolHost;
  private nextId = 1;
  /** The rectangle's size when Alt was pressed during the drag, kept while it turns. */
  private turning: { a: number; b: number } | null = null;
  /** The last preview worked out, and what it was worked out for. */
  private cacheKey = "";
  private cached: GridPreview | null = null;
  private version = 0;

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
    this.turning = null;
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
    if (this.host.get().gridOrigin) this.drop();
    else this.leave();
    return true;
  }

  /** A right-click: drops the rectangle. */
  cancel(): void {
    if (this.active() && this.host.get().gridOrigin) this.drop();
  }

  private drop(): void {
    this.turning = null;
    this.host.set({ gridNote: null, ...NO_RECTANGLE });
  }

  /** Where the pointer at `ground` lands: on a road node or segment, as the road tool snaps, or where it is. */
  snap(ground: BuildPoint, view: GridSnapView): Snap | null {
    const world = this.host.world();
    if (!world) return null;
    const type = typeById(this.host.get().roadType);
    return snapPoint(
      ground.x,
      ground.z,
      {
        net: world.net,
        start: null,
        source: null,
        metresPerPixel: view.metresPerPixel,
        guides: { angle: false, length: false, grid: false, lines: false, offset: false },
        free: view.free,
        gridStep: world.terrain.spacing,
        roadWidth: type.width,
      },
      [nodeSource, segmentSource],
    );
  }

  /** A drag began at `ground`, already snapped: the rectangle's first corner. */
  dragStart(ground: BuildPoint | null): void {
    const world = this.host.world();
    if (!this.active() || !ground || !world) return;
    const origin = onGrid(ground);
    const road = roadDirAt(world.net, origin);
    this.turning = null;
    this.host.set({
      gridOrigin: origin,
      gridCorner: origin,
      gridDir: road ?? SQUARE_TO_MAP,
      gridOnRoad: road !== null,
      gridDragging: true,
      gridNote: null,
    });
  }

  /**
   * The pointer moved to `ground`, already snapped, during the drag. With
   * `turn`, a rectangle on open ground turns around its origin so its far
   * corner follows the pointer, keeping its size; let go, and the drag
   * sizes it at the new angle.
   */
  dragMove(ground: BuildPoint | null, turn: boolean): void {
    const s = this.host.get();
    if (!this.active() || !s.gridDragging || !s.gridOrigin || !ground) return;
    const point = onGrid(ground);
    if (turn && !s.gridOnRoad) {
      this.turning ??= rectangleSize(s.gridOrigin, s.gridCorner ?? point, s.gridDir);
      const size = this.turning;
      if (Math.hypot(size.a, size.b) < 1e-6) return;
      const dir = turnedDir(s.gridOrigin, point, size);
      const corner = { x: s.gridOrigin.x + dir.dx * size.a - dir.dz * size.b, z: s.gridOrigin.z + dir.dz * size.a + dir.dx * size.b };
      this.host.set({ gridDir: dir, gridCorner: corner });
      return;
    }
    this.turning = null;
    this.host.set({ gridCorner: point });
  }

  /** The button came up: the rectangle stays, waiting for Confirm. */
  dragEnd(): void {
    this.turning = null;
    if (this.host.get().gridDragging) this.host.set({ gridDragging: false });
  }

  /** The drag was cut off: the rectangle goes. */
  dragCancel(): void {
    if (this.host.get().gridDragging) this.drop();
  }

  /** Call on every mirror update, so the preview is checked again against the new roads. */
  mirrorUpdated(update: { kind: "snapshot" } | { kind: "delta"; steps: number; roadNodes: readonly number[]; roadSegs: readonly number[] }): void {
    if (update.kind === "snapshot" || update.roadNodes.length > 0 || update.roadSegs.length > 0) this.version++;
    if (update.kind === "delta" && update.steps === 0) return;
    // After a step every grid the sim accepted has been built or dropped, so its preview goes.
    const pending = this.host.get().gridPending;
    if (pending.some((p) => p.status === "accepted")) this.host.set({ gridPending: pending.filter((p) => p.status !== "accepted") });
  }

  /** The payload for the rectangle drawn now, or null when there is none or it has no size. */
  payload(): BuildRoadGridPayload | null {
    const s = this.host.get();
    if (!this.active() || !s.gridOrigin || !s.gridCorner) return null;
    if (samePoint(s.gridOrigin, onGrid(s.gridCorner))) return null;
    return gridPayload(s.gridOrigin, s.gridCorner, s.gridDir, s.gridDepthCells, s.gridWidthCells, s.roadType);
  }

  /** The preview of the rectangle drawn now, worked out again only when it or the roads change. */
  preview(): GridPreview | null {
    const payload = this.payload();
    const world = this.host.world();
    if (!payload || !world) return null;
    const key = `${JSON.stringify(payload)}|${this.version}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cached = previewGrid(world.net, world.terrain, payload);
    }
    return this.cached;
  }

  /**
   * Confirm or Enter: sends the grid if the preview passes. A grid the
   * preview refuses sends nothing and keeps its reason on screen.
   */
  confirm(): void {
    const s = this.host.get();
    if (!this.active() || s.gridDragging) return;
    const preview = this.preview();
    if (!preview) return;
    if (!preview.ok) {
      this.host.set({ gridNote: preview.reason });
      return;
    }
    const pending: PendingGrid = { id: this.nextId++, preview, status: "sending" };
    this.turning = null;
    this.host.set({ ...NO_RECTANGLE, gridNote: null, gridPending: [...s.gridPending, pending] });
    void this.host.send(preview.payload).then((result) => this.answered(pending.id, result));
  }

  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().gridPending;
    if (result.ok) {
      this.host.set({ gridPending: pending.map((p) => (p.id === id ? { ...p, status: "accepted" } : p)) });
      return;
    }
    this.host.set({ gridPending: pending.filter((p) => p.id !== id), gridNote: result.reason });
  }
}
