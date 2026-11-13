// The road tool (issues M1-07 and M1-10). It draws in three modes:
//
//   straight    click the start, click the end
//   curved      click the start, click a point that sets the direction (the
//               curve's control point), click the end. A curve started from
//               the end of a road leaves in line with it unless the
//               free-hand key is held
//   continuous  straight segments end to end: each click ends one segment
//               and starts the next, until Escape, a right-click or a
//               double click
//
// Escape or a right-click drops the road being drawn; switching mode or
// leaving the tool does too. Each segment is its own `BuildRoad` command.
// A continuous road also ends at a click back on the end just built, which
// is what the second click of a double click is, and at a segment the
// preview or the sim refuses, keeping the segments built before it.
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
//
// In continuous mode a segment is not sent until the one before it is
// built. The sim validates a command against the city as it is, so the next
// segment has to see the last one to be checked against it, for the angle
// where they meet among other things. Until then it waits as "queued", and
// is checked again before it goes. A segment the sim refuses ends the road
// there: the segments before it stay built and any queued after it are
// dropped.

import {
  LEVEL_BRIDGE,
  NONE,
  ROAD_BUILD,
  ROAD_TYPES,
  curveLength,
  planRoad,
  snapToGrid,
  subControl,
  type BuildPoint,
  type BuildRoadPayload,
  type CommandResult,
  type Quad,
  type RoadNetwork,
  type RoadType,
  type Terrain,
} from "@city-council/sim";
import type { RoadNet } from "../render/road-geometry";
import { DEFAULT_GUIDES, type GuideId, type GuideToggles } from "./config";
import { roadEnd, snapPoint, startSource, type Snap } from "./snap";

/** The road types the tool offers, in toolbar order. Highway waits for M5. */
export const TOOL_ROAD_TYPES = ["street", "avenue", "oneWay"] as const;
export type ToolRoadType = (typeof TOOL_ROAD_TYPES)[number];

/** The drawing modes, in toolbar order. */
export const DRAW_MODES = ["straight", "curved", "continuous"] as const;
export type DrawMode = (typeof DRAW_MODES)[number];

/** How a road would be built, or why it would be refused. */
export interface RoadPreview {
  /** The ends as the sim would build them: on the build grid, or at the node an end joins. */
  from: BuildPoint;
  to: BuildPoint;
  /** The control point of a curved road, on the build grid, or null for a straight one. */
  control: BuildPoint | null;
  type: RoadType;
  ok: boolean;
  /** Why the sim would refuse it, or null when it would build it. */
  reason: string | null;
  /** Plan length in metres, along the curve for a curved road. */
  length: number;
  /** Build cost in whole dollars: the length times the type's price. Zero when refused. */
  cost: number;
  /** Where the road would meet another road: a split, or an existing node it joins or passes. */
  junctions: BuildPoint[];
  /** The parts that would be bridges, bank to bank, each with its control point or null. */
  bridges: PreviewSpan[];
  /** Metres of `length` that would be bridge. */
  bridgeLength: number;
}

/** A part of a previewed road between two of its stops. */
export interface PreviewSpan {
  from: BuildPoint;
  to: BuildPoint;
  control: BuildPoint | null;
}

function typeById(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(`no road type "${id}"`);
  return type;
}

function onGrid(p: BuildPoint): BuildPoint {
  return { x: snapToGrid(p.x), z: snapToGrid(p.z) };
}

/**
 * What the sim would do with `BuildRoad` from `from` to `to`, through
 * `control` for a curve, checked against the mirror's roads. Changes nothing.
 */
export function previewRoad(
  net: RoadNet,
  terrain: Terrain,
  from: BuildPoint,
  to: BuildPoint,
  typeId: string,
  control: BuildPoint | null = null,
): RoadPreview {
  const type = typeById(typeId);
  const payload: BuildRoadPayload = control ? { from, to, type: typeId, control } : { from, to, type: typeId };
  // The planner only reads the network. It takes the mutable type because
  // the sim calls it on live state; the copy here is never written.
  const result = planRoad(net as unknown as RoadNetwork, terrain, payload);
  if (!result.ok) {
    const a = onGrid(from);
    const b = onGrid(to);
    const c = control ? onGrid(control) : null;
    const length = c ? curveLength(a.x, a.z, c.x, c.z, b.x, b.z) : Math.hypot(b.x - a.x, b.z - a.z);
    return { from: a, to: b, control: c, type, ok: false, reason: result.reason, length, cost: 0, junctions: [], bridges: [], bridgeLength: 0 };
  }
  const { stops, length, cost, levels, bridgeLength } = result.plan;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) throw new Error("a road plan has at least two stops");
  const junctions = stops.filter((s) => s.node !== NONE || s.splits.length > 0).map((s) => ({ x: s.x, z: s.z }));
  const bridges: PreviewSpan[] = [];
  const planned = result.plan.control;
  levels.forEach((level, i) => {
    const a = stops[i];
    const b = stops[i + 1];
    if (level !== LEVEL_BRIDGE || !a || !b) return;
    // A piece of a curve takes the control point of its part of the curve, as the sim builds it.
    const c = planned ? subControl(roadQuad(first, last, planned), a.t, b.t) : null;
    bridges.push({ from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z }, control: c });
  });
  return {
    from: { x: first.x, z: first.z },
    to: { x: last.x, z: last.z },
    control: planned,
    type,
    ok: true,
    reason: null,
    length,
    cost,
    junctions,
    bridges,
    bridgeLength,
  };
}

function roadQuad(a: BuildPoint, b: BuildPoint, c: BuildPoint): Quad {
  return { ax: a.x, az: a.z, cx: c.x, cz: c.z, bx: b.x, bz: b.z };
}

/** A road the tool has sent, or will send, and the sim has not yet built or refused. */
export interface PendingRoad {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: RoadPreview;
  payload: BuildRoadPayload;
  /** The continuous road it is part of, or 0. */
  chain: number;
  /**
   * "queued" while it waits for the segment before it in a continuous road
   * to be built; "sending" until the sim answers; "accepted" once the sim
   * has queued the command.
   */
  status: "queued" | "sending" | "accepted";
}

/** The tool's part of the UI store. */
export interface RoadToolState {
  /** The active tool, or null for none. */
  tool: "road" | null;
  roadType: ToolRoadType;
  roadMode: DrawMode;
  /** Where the road being drawn starts, or null before the first click. */
  roadStart: BuildPoint | null;
  /** Curved mode: the control point, once the second click has set it. */
  roadControl: BuildPoint | null;
  /** Continuous mode: the road being drawn, or 0. */
  roadChain: number;
  roadPending: readonly PendingRoad[];
  /** The last refusal, from the preview check at the click or from the sim. Null when there is none. */
  roadNote: string | null;
  /** Which snapping guides are on. Kept for the page's life. */
  guides: GuideToggles;
}

export const INITIAL_ROAD_TOOL: RoadToolState = {
  tool: null,
  roadType: "street",
  roadMode: "straight",
  roadStart: null,
  roadControl: null,
  roadChain: 0,
  roadPending: [],
  roadNote: null,
  guides: DEFAULT_GUIDES,
};

/** Nothing being drawn. */
const IDLE = { roadStart: null, roadControl: null, roadChain: 0 } as const;

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

/** The nearest a curve's control point may sit to its start, metres. */
const MIN_CONTROL_DISTANCE = ROAD_BUILD.minLength;

/** The tool's input handling. Holds no state of its own beyond counters for ids. */
export class RoadToolController {
  private readonly host: RoadToolHost;
  private nextId = 1;
  private nextChain = 1;

  constructor(host: RoadToolHost) {
    this.host = host;
  }

  /** Turns the road tool on, or off when it is on. Off drops a road being drawn. */
  toggle(): void {
    if (this.host.get().tool === "road") this.leave();
    else this.host.set({ tool: "road", roadNote: null });
  }

  /** Picks a road type and turns the tool on. A road being drawn keeps going in the new type. */
  pickType(type: ToolRoadType): void {
    this.host.set({ tool: "road", roadType: type, roadNote: null });
  }

  /** Picks a drawing mode and turns the tool on. A road being drawn is dropped. */
  pickMode(mode: DrawMode): void {
    this.host.set({ tool: "road", roadMode: mode, roadNote: null, ...IDLE });
  }

  leave(): void {
    this.host.set({ tool: null, roadNote: null, ...IDLE });
  }

  /**
   * Escape: drops the road being drawn, or leaves the tool when nothing is
   * being drawn. Returns whether it did anything. In continuous mode the
   * segments already clicked stay; only the one at the cursor goes.
   */
  escape(): boolean {
    const s = this.host.get();
    if (s.tool !== "road") return false;
    if (s.roadStart) this.host.set({ roadNote: null, ...IDLE });
    else this.leave();
    return true;
  }

  /** A right-click without a drag: drops the road being drawn. */
  cancel(): void {
    if (this.host.get().roadStart) this.host.set({ roadNote: null, ...IDLE });
  }

  /**
   * A double click: ends a continuous road where the last segment ended.
   * Its second click has already gone to `click`, which ends the road when
   * it lands on the end just built, so this only catches a second click the
   * cursor moved away between.
   */
  finish(): void {
    const s = this.host.get();
    if (s.tool === "road" && s.roadMode === "continuous" && s.roadStart) this.host.set({ roadNote: null, ...IDLE });
  }

  /** Turns a snapping guide on or off. */
  toggleGuide(id: GuideId): void {
    const guides = this.host.get().guides;
    this.host.set({ guides: { ...guides, [id]: !guides[id] } });
  }

  /**
   * The point the next click's guides measure from: the start, or a curve's
   * control point once it is set. Null before the first click.
   */
  anchor(): BuildPoint | null {
    const s = this.host.get();
    return s.roadControl ?? s.roadStart;
  }

  /**
   * Where the cursor at (x, z) lands with the guides that are on, for the
   * click it would be: a road's start, a curve's control point, or an end.
   * Null with the tool off or before the first snapshot.
   */
  snap(cursor: BuildPoint | null, view: SnapView): Snap | null {
    const s = this.host.get();
    const world = this.host.world();
    if (s.tool !== "road" || !cursor || !world) return null;
    const base = {
      net: world.net,
      metresPerPixel: view.metresPerPixel,
      free: view.free,
      gridStep: world.terrain.spacing,
    };
    if (s.roadControl) {
      // A curve's end. The angle and length guides measure a straight road
      // from its start, which a curve's end is not, so only the points that
      // fix an end catch it: nodes, segments and the grid.
      return snapPoint(cursor.x, cursor.z, {
        ...base,
        start: s.roadControl,
        source: null,
        guides: { ...s.guides, angle: false, length: false },
      });
    }
    const start = s.roadStart;
    const source = start ? startSource(world.net, start) : null;
    if (start && s.roadMode === "curved" && !view.free) {
      const end = roadEnd(world.net, source);
      if (end) return tangentSnap(cursor, end, source);
    }
    return snapPoint(cursor.x, cursor.z, { ...base, start, source, guides: s.guides });
  }

  /**
   * The preview from the start to `cursor`, or null when no road is being
   * drawn yet. A curve has none until its control point is set.
   */
  preview(cursor: BuildPoint | null): RoadPreview | null {
    const s = this.host.get();
    const world = this.host.world();
    if (s.tool !== "road" || !s.roadStart || !cursor || !world) return null;
    if (s.roadMode === "curved" && !s.roadControl) return null;
    return previewRoad(world.net, world.terrain, s.roadStart, cursor, s.roadType, s.roadControl);
  }

  /**
   * A left click on the ground, or on the sky (null), already snapped. It
   * sets the start, then a curve's control point, then sends the road if
   * the preview passes. A click the preview refuses keeps the road going and
   * shows the reason.
   */
  click(hit: BuildPoint | null): void {
    const s = this.host.get();
    if (s.tool !== "road" || !hit) return;
    // On the build grid, as the sim would round it, so the command and the
    // log carry the point the preview showed.
    const point = onGrid(hit);
    if (!s.roadStart) {
      const roadChain = s.roadMode === "continuous" ? this.nextChain++ : 0;
      this.host.set({ roadStart: point, roadControl: null, roadChain, roadNote: null });
      return;
    }
    if (s.roadMode === "curved" && !s.roadControl) {
      if (Math.hypot(point.x - s.roadStart.x, point.z - s.roadStart.z) < MIN_CONTROL_DISTANCE) return;
      this.host.set({ roadControl: point, roadNote: null });
      return;
    }
    const continuous = s.roadMode === "continuous";
    // A click back on the end just built, as the second click of a double
    // click is, ends a continuous road. It would be too short to build.
    if (continuous && Math.hypot(point.x - s.roadStart.x, point.z - s.roadStart.z) < ROAD_BUILD.minLength) {
      this.host.set({ roadNote: null, ...IDLE });
      return;
    }
    const preview = this.preview(point);
    if (!preview) return;
    if (!preview.ok) {
      // A continuous road stops at a segment that cannot be built; a single road waits for another try.
      this.host.set(continuous ? { roadNote: preview.reason, ...IDLE } : { roadNote: preview.reason });
      return;
    }
    const payload: BuildRoadPayload = s.roadControl
      ? { from: s.roadStart, to: point, type: s.roadType, control: s.roadControl }
      : { from: s.roadStart, to: point, type: s.roadType };
    const chain = continuous ? s.roadChain : 0;
    // A continuous road's segment waits for the one before it.
    const waits = chain !== 0 && s.roadPending.some((p) => p.chain === chain);
    const pending: PendingRoad = { id: this.nextId++, preview, payload, chain, status: waits ? "queued" : "sending" };
    // A continuous road carries on from where this segment ends, at the node it joins if it joins one.
    const next = chain !== 0 ? { roadStart: preview.to, roadControl: null } : IDLE;
    this.host.set({ ...next, roadNote: null, roadPending: [...s.roadPending, pending] });
    if (!waits) this.sendPending(pending);
  }

  private sendPending(pending: PendingRoad): void {
    void this.host.send(pending.payload).then((result) => this.answered(pending.id, result));
  }

  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().roadPending;
    if (result.ok) {
      this.host.set({ roadPending: pending.map((p) => (p.id === id ? { ...p, status: "accepted" } : p)) });
      return;
    }
    const refused = pending.find((p) => p.id === id);
    this.stopChain(
      pending.filter((p) => p.id !== id),
      refused?.chain ?? 0,
      result.reason,
    );
  }

  /**
   * Shows `reason` and, for a continuous road, ends it: segments queued
   * after the refused one are dropped, and the road at the cursor goes too.
   */
  private stopChain(pending: readonly PendingRoad[], chain: number, reason: string): void {
    if (chain === 0) {
      this.host.set({ roadPending: pending, roadNote: reason });
      return;
    }
    const kept = pending.filter((p) => p.chain !== chain || p.status !== "queued");
    const drawing = this.host.get().roadChain === chain ? IDLE : {};
    this.host.set({ ...drawing, roadPending: kept, roadNote: reason });
  }

  /**
   * Call on every mirror update. After a step, every command the sim had
   * accepted before it has been built, or dropped because an earlier
   * command in the same tick made it invalid; either way its preview goes.
   * A snapshot replaces the whole copy, so it clears them too. Then each
   * continuous road's next queued segment, if nothing of its road is still
   * in flight, is checked against the roads as they now are and sent.
   */
  mirrorUpdated(update: { kind: "snapshot" } | { kind: "delta"; steps: number }): void {
    if (update.kind === "delta" && update.steps === 0) return;
    let pending = this.host.get().roadPending;
    if (pending.some((p) => p.status === "accepted")) {
      pending = pending.filter((p) => p.status !== "accepted");
      this.host.set({ roadPending: pending });
    }
    const world = this.host.world();
    if (!world) return;
    for (const chain of new Set(pending.map((p) => p.chain))) {
      if (chain === 0) continue;
      const mine = pending.filter((p) => p.chain === chain);
      const next = mine[0];
      if (!next || next.status !== "queued") continue;
      const { from, to, type, control } = next.payload;
      const preview = previewRoad(world.net, world.terrain, from, to, type, control ?? null);
      pending = this.host.get().roadPending;
      if (!preview.ok) {
        this.stopChain(
          pending.filter((p) => p.id !== next.id),
          chain,
          preview.reason ?? "",
        );
        pending = this.host.get().roadPending;
        continue;
      }
      const sending: PendingRoad = { ...next, preview, status: "sending" };
      pending = pending.map((p) => (p.id === next.id ? sending : p));
      this.host.set({ roadPending: pending });
      this.sendPending(sending);
    }
  }
}

/**
 * The control point of a curve leaving the end of a road: on the line the
 * road carries straight on along, at the cursor's distance along it, and no
 * nearer the start than `MIN_CONTROL_DISTANCE`. A curve's direction at its
 * start points at its control point, so this curve leaves without a kink.
 */
function tangentSnap(cursor: BuildPoint, end: { x: number; z: number; dx: number; dz: number }, source: Snap["source"]): Snap {
  const along = (cursor.x - end.x) * end.dx + (cursor.z - end.z) * end.dz;
  const t = Math.max(MIN_CONTROL_DISTANCE, along);
  return {
    kind: "tangent",
    x: end.x + end.dx * t,
    z: end.z + end.dz * t,
    ray: { dx: end.dx, dz: end.dz },
    lengthSnapped: false,
    source,
    angle: null,
    square: false,
    squareTo: null,
  };
}
