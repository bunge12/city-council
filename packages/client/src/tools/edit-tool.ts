// The bulldoze and upgrade tools (issue M1-13).
//
//   bulldoze  hover a segment to see it marked and what removing it costs,
//             click to send `BulldozeRoad`
//   upgrade   hover a segment to see it as the type picked in the road type
//             picker, click to send `UpgradeRoad`. A right-click on a one-way
//             reverses it
//
// With either tool a left drag collects every segment the pointer passes
// over and sends one command for all of them on release, so the activity log
// gets one entry. A segment the tool could not act on alone is left out of
// the drag: a fixed one, or for an upgrade one that is already the type
// picked. Escape drops a drag; with no drag it leaves the tool.
//
// Both tools check what they show with `planBulldoze` and `planUpgrade`, the
// functions the sim validates the commands with, run against the mirror's
// read-only copy of the roads. So the price shown before the click is the
// sim's, and a refusal shows the sim's reason and sends nothing. The sim
// still has the final say. Tool state lives in the UI store (ui/store.ts);
// nothing here writes sim state.
//
// A sent edit stays marked on screen until the sim answers. A refusal
// removes the mark and shows the reason. An acceptance keeps it until the
// next delta from a step, which carries the change, as with the road tool.

import {
  LEVEL_BRIDGE,
  NONE,
  ROAD_TYPES,
  SEG_FIXED,
  planBulldoze,
  planUpgrade,
  type CommandResult,
  type RoadNetwork,
  type RoadType,
  type Terrain,
} from "@city-council/sim";
import { liveRoadSegment, roadTypeOf, type RoadNet } from "../render/road-geometry";
import type { PreviewLook, PreviewShape } from "../render/road-preview-geometry";
import type { RoadToolState, ToolRoadType } from "./road-tool";

/** What an edit does: remove, change type, or reverse a one-way. */
export type EditKind = "bulldoze" | "upgrade" | "reverse";

/** What the sim would do with an edit, or why it would refuse it. */
export interface EditPreview {
  kind: EditKind;
  /** The segments, in the order they were picked. */
  segments: readonly number[];
  /** The type an upgrade changes to, or null for a bulldoze. A reversal keeps its one-way type. */
  type: RoadType | null;
  ok: boolean;
  /** Why the sim would refuse it, or null when it would do it. */
  reason: string | null;
  /** Plan length in metres. */
  length: number;
  /** Price in whole dollars, from the balance file. Zero when refused. Not charged until M4. */
  cost: number;
  /** A segment in it is fixed, such as an outside connection's: it cannot be removed or changed. */
  fixed: boolean;
}

/** The command an edit sends. */
export interface EditCommand {
  type: "BulldozeRoad" | "UpgradeRoad";
  payload: { segments: number[]; type?: string };
}

/** The command for an edit of `segments`. */
export function editCommand(kind: EditKind, segments: readonly number[], typeId: string): EditCommand {
  if (kind === "bulldoze") return { type: "BulldozeRoad", payload: { segments: [...segments] } };
  return { type: "UpgradeRoad", payload: { segments: [...segments], type: typeId } };
}

function isFixed(net: RoadNet, seg: number): boolean {
  return ((net.segFlags[seg] ?? 0) & SEG_FIXED) !== 0;
}

function asNetwork(net: RoadNet): RoadNetwork {
  // The planners only read the network. They take the mutable type because
  // the sim calls them on live state; the copy here is never written.
  return net as unknown as RoadNetwork;
}

/**
 * What the sim would do with an edit of `segments`, checked against the
 * mirror's roads with the sim's own planners. Changes nothing. `typeId` is
 * the type an upgrade changes to; a reversal passes the one-way type.
 */
export function previewEdit(
  net: RoadNet,
  terrain: Terrain,
  kind: EditKind,
  segments: readonly number[],
  typeId: string,
): EditPreview {
  const command = editCommand(kind, segments, typeId);
  const type = kind === "bulldoze" ? null : (ROAD_TYPES.find((t) => t.id === typeId) ?? null);
  const fixed = segments.some((seg) => isFixed(net, seg));
  const base = { kind, segments: [...segments], type, fixed };
  if (fixed) {
    // The sim refuses this too, naming the segment by id. A player does not know ids.
    const reason = kind === "bulldoze" ? "This road is fixed and cannot be removed" : "This road is fixed and cannot be changed";
    return { ...base, ok: false, reason, length: 0, cost: 0 };
  }
  const result =
    kind === "bulldoze" ? planBulldoze(asNetwork(net), command.payload) : planUpgrade(asNetwork(net), terrain, command.payload);
  if (!result.ok) return { ...base, ok: false, reason: result.reason, length: 0, cost: 0 };
  return { ...base, ok: true, reason: null, length: result.plan.length, cost: result.plan.cost };
}

/** An edit the tool has sent and the sim has not yet applied or refused. */
export interface PendingEdit {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: EditPreview;
  /** "sending" until the sim answers; "accepted" once it has queued the command. */
  status: "sending" | "accepted";
}

/** The edit tools' part of the UI store. */
export interface EditToolState {
  /** The segments a drag has collected so far, in order, or null when no drag is on. */
  editDrag: readonly number[] | null;
  editPending: readonly PendingEdit[];
  /** The last refusal, from the preview check at the click or from the sim. Null when there is none. */
  editNote: string | null;
}

export const INITIAL_EDIT_TOOL: EditToolState = {
  editDrag: null,
  editPending: [],
  editNote: null,
};

/** The edit tools' ids. */
export type EditToolId = "bulldoze" | "upgrade";

/** What the controller needs from the page. */
export interface EditToolHost {
  get(): RoadToolState & EditToolState;
  set(patch: Partial<RoadToolState & EditToolState>): void;
  /** The mirror's roads and the map, or null before the first snapshot. */
  world(): { net: RoadNet; terrain: Terrain } | null;
  /** Sends a command and resolves with the sim's answer. */
  send(type: EditCommand["type"], payload: EditCommand["payload"]): Promise<CommandResult>;
}

/** Nothing being drawn with the road tool. */
const ROAD_IDLE = { roadStart: null, roadControl: null, roadChain: 0 } as const;

/** The bulldoze and upgrade tools' input handling. Holds no state of its own beyond a counter for ids. */
export class EditToolController {
  private readonly host: EditToolHost;
  private nextId = 1;

  constructor(host: EditToolHost) {
    this.host = host;
  }

  /** The edit tool that is on, or null. */
  active(): EditToolId | null {
    const tool = this.host.get().tool;
    return tool === "bulldoze" || tool === "upgrade" ? tool : null;
  }

  /** Turns tool `id` on, or off when it is on. Either way a road being drawn and a drag are dropped. */
  toggle(id: EditToolId): void {
    const on = this.host.get().tool === id;
    this.host.set({ tool: on ? null : id, editDrag: null, editNote: null, roadNote: null, ...ROAD_IDLE });
  }

  leave(): void {
    this.host.set({ tool: null, editDrag: null, editNote: null });
  }

  /** Escape: drops a drag, or leaves the tool. Returns whether it did anything. */
  escape(): boolean {
    if (!this.active()) return false;
    if (this.host.get().editDrag) this.host.set({ editDrag: null, editNote: null });
    else this.leave();
    return true;
  }

  /** The type an upgrade changes to: the one in the road type picker. */
  private upgradeType(): ToolRoadType {
    return this.host.get().roadType;
  }

  /**
   * What the tool shows with the pointer over segment `seg` (NONE for none):
   * the drag so far while one is on, otherwise that segment alone. Null when
   * there is nothing to show.
   */
  preview(seg: number): EditPreview | null {
    const tool = this.active();
    const world = this.host.world();
    if (!tool || !world) return null;
    const drag = this.host.get().editDrag;
    const segments = drag ?? (seg !== NONE && liveRoadSegment(world.net, seg) ? [seg] : []);
    if (segments.length === 0) return null;
    // A click with the upgrade tool on a one-way, with one-way picked, reverses it, as the sim does.
    if (!drag && tool === "upgrade" && roadTypeOf(world.net, seg).id === this.upgradeType()) {
      const reverse = this.reversePreview(seg);
      if (reverse) return reverse;
    }
    return previewEdit(world.net, world.terrain, tool, segments, this.upgradeType());
  }

  /**
   * What a right-click on `seg` would do with the upgrade tool: reverse a
   * one-way. Null for anything else.
   */
  reversePreview(seg: number): EditPreview | null {
    const world = this.host.world();
    if (this.active() !== "upgrade" || !world || seg === NONE || !liveRoadSegment(world.net, seg)) return null;
    const type = roadTypeOf(world.net, seg);
    if (!type.oneWay) return null;
    return previewEdit(world.net, world.terrain, "reverse", [seg], type.id);
  }

  /** A left click with segment `seg` under the pointer, or NONE. */
  click(seg: number): void {
    if (!this.active()) return;
    const preview = this.preview(seg);
    if (!preview) return;
    this.sendIfOk(preview);
  }

  /**
   * A right-click with segment `seg` under the pointer: with the upgrade
   * tool, reverses a one-way. Returns whether it did anything.
   */
  rightClick(seg: number): boolean {
    if (this.active() !== "upgrade" || seg === NONE) return false;
    const preview = this.reversePreview(seg);
    if (!preview) {
      this.host.set({ editNote: "A right-click reverses a one-way road" });
      return true;
    }
    this.sendIfOk(preview);
    return true;
  }

  /** A drag started. */
  dragStart(): void {
    if (this.active()) this.host.set({ editDrag: [], editNote: null });
  }

  /**
   * The drag passed over segment `seg`. It joins the drag unless it is
   * there already or the tool could not act on it alone.
   */
  dragOver(seg: number): void {
    const tool = this.active();
    const s = this.host.get();
    const world = this.host.world();
    if (!tool || !s.editDrag || !world || seg === NONE || s.editDrag.includes(seg)) return;
    if (!liveRoadSegment(world.net, seg)) return;
    // Upgrading a road to the type it is already would refuse the whole drag, or reverse a one-way.
    if (tool === "upgrade" && roadTypeOf(world.net, seg).id === this.upgradeType()) return;
    if (!previewEdit(world.net, world.terrain, tool, [seg], this.upgradeType()).ok) return;
    this.host.set({ editDrag: [...s.editDrag, seg] });
  }

  /** The drag ended: sends one command for every segment it collected. */
  dragEnd(): void {
    const s = this.host.get();
    const tool = this.active();
    const world = this.host.world();
    const drag = s.editDrag;
    this.host.set({ editDrag: null });
    if (!tool || !world || !drag || drag.length === 0) return;
    this.sendIfOk(previewEdit(world.net, world.terrain, tool, drag, this.upgradeType()));
  }

  /** The drag was cut off: drops it. */
  dragCancel(): void {
    if (this.host.get().editDrag) this.host.set({ editDrag: null });
  }

  private sendIfOk(preview: EditPreview): void {
    if (!preview.ok) {
      this.host.set({ editNote: preview.reason });
      return;
    }
    const pending: PendingEdit = { id: this.nextId++, preview, status: "sending" };
    this.host.set({ editNote: null, editPending: [...this.host.get().editPending, pending] });
    const typeId = preview.type?.id ?? "";
    const command = editCommand(preview.kind, preview.segments, typeId);
    void this.host.send(command.type, command.payload).then((result) => this.answered(pending.id, result));
  }

  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().editPending;
    if (result.ok) {
      this.host.set({ editPending: pending.map((p) => (p.id === id ? { ...p, status: "accepted" } : p)) });
      return;
    }
    this.host.set({ editPending: pending.filter((p) => p.id !== id), editNote: result.reason });
  }

  /**
   * Call on every mirror update. After a step, every command the sim had
   * accepted before it has been applied, or dropped because an earlier
   * command in the same tick made it invalid; either way its mark goes. A
   * snapshot replaces the whole copy, so it clears them too.
   */
  mirrorUpdated(update: { kind: "snapshot" } | { kind: "delta"; steps: number }): void {
    if (update.kind === "delta" && update.steps === 0) return;
    const pending = this.host.get().editPending;
    if (pending.some((p) => p.status === "accepted")) {
      this.host.set({ editPending: pending.filter((p) => p.status !== "accepted") });
    }
  }
}

/**
 * The marks to draw for an edit: each segment as a strip, at the width of
 * the type an upgrade would give it, or of its own type otherwise, on its
 * bridge deck when it is a bridge.
 */
export function editShapes(net: RoadNet, preview: EditPreview, look: PreviewLook): PreviewShape[] {
  const out: PreviewShape[] = [];
  for (const seg of preview.segments) {
    if (!liveRoadSegment(net, seg)) continue;
    const own = roadTypeOf(net, seg);
    const type = preview.ok && preview.kind === "upgrade" && preview.type ? preview.type : own;
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const ax = net.nodeX[a] ?? 0;
    const az = net.nodeZ[a] ?? 0;
    const bx = net.nodeX[b] ?? 0;
    const bz = net.nodeZ[b] ?? 0;
    const cx = net.segCX[seg] ?? (ax + bx) / 2;
    const cz = net.segCZ[seg] ?? (az + bz) / 2;
    const straight = cx === (ax + bx) / 2 && cz === (az + bz) / 2;
    const shape: PreviewShape = {
      ax,
      az,
      bx,
      bz,
      control: straight ? null : { x: cx, z: cz },
      width: type.width,
      look,
      junctions: [],
      bridges: [],
    };
    if (net.segLevel[seg] === LEVEL_BRIDGE) {
      shape.deck = { hA: net.nodeHeight[a] ?? 0, hB: net.nodeHeight[b] ?? 0, grade: type.maxSlope };
    }
    out.push(shape);
  }
  return out;
}
