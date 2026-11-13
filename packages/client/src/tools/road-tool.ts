// The straight road tool (issue M1-07). Click to set the start, move to see
// a preview, click again to send `BuildRoad`. Escape or a right-click
// cancels.
//
// The preview is checked with `planRoad`, the same function the sim
// validates `BuildRoad` with, run against the mirror's read-only copy of the
// roads. The sim still has the final say. Tool state lives in the UI store
// (ui/store.ts); nothing here writes sim state.
//
// A sent road stays on screen as an in-flight preview until the sim answers.
// A refusal removes it and shows the reason. An acceptance only means the
// command is queued, so the preview stays until the next delta from a step,
// which carries the real road. A server answers later than a worker does;
// the same states cover both.

import {
  NONE,
  ROAD_TYPES,
  planRoad,
  snapToGrid,
  type BuildPoint,
  type BuildRoadPayload,
  type CommandResult,
  type RoadNetwork,
  type RoadType,
  type Terrain,
} from "@city-council/sim";
import type { RoadNet } from "../render/road-geometry";
import { DEFAULT_GUIDES, type GuideId, type GuideToggles } from "./config";
import { snapPoint, startSource, type Snap } from "./snap";

/** The road types the tool offers, in toolbar order. Highway waits for M5. */
export const TOOL_ROAD_TYPES = ["street", "avenue", "oneWay"] as const;
export type ToolRoadType = (typeof TOOL_ROAD_TYPES)[number];

/** How a road would be built, or why it would be refused. */
export interface RoadPreview {
  /** The ends as the sim would build them: on the build grid, or at the node an end joins. */
  from: BuildPoint;
  to: BuildPoint;
  type: RoadType;
  ok: boolean;
  /** Why the sim would refuse it, or null when it would build it. */
  reason: string | null;
  /** Plan length in metres. */
  length: number;
  /** Build cost in whole dollars: the length times the type's price. Zero when refused. */
  cost: number;
  /** Where the road would meet another road: a split, or an existing node it joins or passes. */
  junctions: BuildPoint[];
}

function typeById(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(`no road type "${id}"`);
  return type;
}

/**
 * What the sim would do with `BuildRoad` from `from` to `to`, checked
 * against the mirror's roads. Changes nothing.
 */
export function previewRoad(net: RoadNet, terrain: Terrain, from: BuildPoint, to: BuildPoint, typeId: string): RoadPreview {
  const type = typeById(typeId);
  const payload: BuildRoadPayload = { from, to, type: typeId };
  // The planner only reads the network. It takes the mutable type because
  // the sim calls it on live state; the copy here is never written.
  const result = planRoad(net as unknown as RoadNetwork, terrain, payload);
  if (!result.ok) {
    const a = { x: snapToGrid(from.x), z: snapToGrid(from.z) };
    const b = { x: snapToGrid(to.x), z: snapToGrid(to.z) };
    return { from: a, to: b, type, ok: false, reason: result.reason, length: Math.hypot(b.x - a.x, b.z - a.z), cost: 0, junctions: [] };
  }
  const { stops, length, cost } = result.plan;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) throw new Error("a road plan has at least two stops");
  const junctions = stops.filter((s) => s.node !== NONE || s.splits.length > 0).map((s) => ({ x: s.x, z: s.z }));
  return { from: { x: first.x, z: first.z }, to: { x: last.x, z: last.z }, type, ok: true, reason: null, length, cost, junctions };
}

/** A road the tool has sent and the sim has not yet built or refused. */
export interface PendingRoad {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: RoadPreview;
  /** "sending" until the sim answers; "accepted" once it has queued the command. */
  status: "sending" | "accepted";
}

/** The tool's part of the UI store. */
export interface RoadToolState {
  /** The active tool, or null for none. */
  tool: "road" | null;
  roadType: ToolRoadType;
  /** Where the road being drawn starts, or null before the first click. */
  roadStart: BuildPoint | null;
  roadPending: readonly PendingRoad[];
  /** The last refusal, from the preview check at the click or from the sim. Null when there is none. */
  roadNote: string | null;
  /** Which snapping guides are on. Kept for the page's life. */
  guides: GuideToggles;
}

export const INITIAL_ROAD_TOOL: RoadToolState = {
  tool: null,
  roadType: "street",
  roadStart: null,
  roadPending: [],
  roadNote: null,
  guides: DEFAULT_GUIDES,
};

/** What the snap needs from the view at the cursor. */
export interface SnapView {
  /** Metres one CSS pixel covers at the cursor. */
  metresPerPixel: number;
  /** The free-hand key is held. */
  free: boolean;
}

/** What the controller needs from the page. */
export interface RoadToolHost {
  get(): RoadToolState;
  set(patch: Partial<RoadToolState>): void;
  /** The mirror's roads and the map, or null before the first snapshot. */
  world(): { net: RoadNet; terrain: Terrain } | null;
  /** Sends `BuildRoad` and resolves with the sim's answer. */
  send(payload: BuildRoadPayload): Promise<CommandResult>;
}

/** The tool's input handling. Holds no state of its own beyond a counter for pending ids. */
export class RoadToolController {
  private readonly host: RoadToolHost;
  private nextId = 1;

  constructor(host: RoadToolHost) {
    this.host = host;
  }

  /** Turns the road tool on, or off when it is on. Off drops a road being drawn. */
  toggle(): void {
    if (this.host.get().tool === "road") this.leave();
    else this.host.set({ tool: "road", roadNote: null });
  }

  /** Picks a road type and turns the tool on. */
  pickType(type: ToolRoadType): void {
    this.host.set({ tool: "road", roadType: type, roadNote: null });
  }

  leave(): void {
    this.host.set({ tool: null, roadStart: null, roadNote: null });
  }

  /**
   * Escape: drops the road being drawn, or leaves the tool when nothing is
   * being drawn. Returns whether it did anything.
   */
  escape(): boolean {
    const s = this.host.get();
    if (s.tool !== "road") return false;
    if (s.roadStart) this.host.set({ roadStart: null, roadNote: null });
    else this.leave();
    return true;
  }

  /** A right-click without a drag: drops the road being drawn. */
  cancel(): void {
    if (this.host.get().roadStart) this.host.set({ roadStart: null, roadNote: null });
  }

  /** Turns a snapping guide on or off. */
  toggleGuide(id: GuideId): void {
    const guides = this.host.get().guides;
    this.host.set({ guides: { ...guides, [id]: !guides[id] } });
  }

  /**
   * Where the cursor at (x, z) lands with the guides that are on: the start
   * of a road before the first click, its end after. Null with the tool off
   * or before the first snapshot.
   */
  snap(cursor: BuildPoint | null, view: SnapView): Snap | null {
    const s = this.host.get();
    const world = this.host.world();
    if (s.tool !== "road" || !cursor || !world) return null;
    const start = s.roadStart;
    return snapPoint(cursor.x, cursor.z, {
      net: world.net,
      start,
      source: start ? startSource(world.net, start) : null,
      metresPerPixel: view.metresPerPixel,
      guides: s.guides,
      free: view.free,
      gridStep: world.terrain.spacing,
    });
  }

  /** The preview from the start to `cursor`, or null when nothing is being drawn. */
  preview(cursor: BuildPoint | null): RoadPreview | null {
    const s = this.host.get();
    const world = this.host.world();
    if (s.tool !== "road" || !s.roadStart || !cursor || !world) return null;
    return previewRoad(world.net, world.terrain, s.roadStart, cursor, s.roadType);
  }

  /**
   * A left click on the ground, or on the sky (null), already snapped. The first click sets
   * the start, the second sends the road if the preview passes. A click the
   * preview refuses keeps the start and shows the reason.
   */
  click(hit: BuildPoint | null): void {
    const s = this.host.get();
    if (s.tool !== "road" || !hit) return;
    // On the build grid, as the sim would round it, so the command and the
    // log carry the point the preview showed.
    const point = { x: snapToGrid(hit.x), z: snapToGrid(hit.z) };
    if (!s.roadStart) {
      this.host.set({ roadStart: point, roadNote: null });
      return;
    }
    const preview = this.preview(point);
    if (!preview) return;
    if (!preview.ok) {
      this.host.set({ roadNote: preview.reason });
      return;
    }
    const pending: PendingRoad = { id: this.nextId++, preview, status: "sending" };
    this.host.set({ roadStart: null, roadNote: null, roadPending: [...s.roadPending, pending] });
    const payload: BuildRoadPayload = { from: s.roadStart, to: point, type: s.roadType };
    void this.host.send(payload).then((result) => this.answered(pending.id, result));
  }

  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().roadPending;
    if (result.ok) {
      this.host.set({ roadPending: pending.map((p) => (p.id === id ? { ...p, status: "accepted" } : p)) });
    } else {
      this.host.set({ roadPending: pending.filter((p) => p.id !== id), roadNote: result.reason });
    }
  }

  /**
   * Call on every mirror update. After a step, every command the sim had
   * accepted before it has been built, or dropped because an earlier
   * command in the same tick made it invalid; either way its preview goes.
   * A snapshot replaces the whole copy, so it clears them too.
   */
  mirrorUpdated(update: { kind: "snapshot" } | { kind: "delta"; steps: number }): void {
    if (update.kind === "delta" && update.steps === 0) return;
    const pending = this.host.get().roadPending;
    if (!pending.some((p) => p.status === "accepted")) return;
    this.host.set({ roadPending: pending.filter((p) => p.status !== "accepted") });
  }
}
