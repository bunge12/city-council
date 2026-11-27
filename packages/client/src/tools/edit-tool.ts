// The upgrade tool (issue M1-13), and the road edits the bulldozer uses.
//
//   upgrade   hover a segment to see it as the type picked in the road type
//             picker, click to send `UpgradeRoad`. A right-click on a one-way
//             reverses it
//
// The bulldozer has been a tool of its own since issue 116
// (bulldoze-tool.ts). It still prices a road with `previewEdit` here and
// draws it with `editShapes`.
//
// With the upgrade tool a left drag collects every segment the pointer passes
// over and sends one command for all of them on release, so the activity log
// gets one entry. A segment the tool could not act on alone is left out of
// the drag: a fixed one, or for an upgrade one that is already the type
// picked. Escape drops a drag; with no drag it leaves the tool.
//
// Both tools check what they show with `planBulldoze` and `planUpgrade`, the
// functions the sim validates the commands with, run against the mirror's
// read-only copy of the roads. So the price shown before the click is the
// sim's, and a refusal shows the sim's reason and sends nothing. An upgrade
// is priced with the buildings a wider road takes and checked against the
// treasury with the sim's `roadPrice` (M4-16); one the treasury cannot pay
// is still sent, so the sim refuses it and the "rejected" cue plays. The sim
// still has the final say. Tool state lives in the UI store (ui/store.ts);
// nothing here writes sim state.
//
// Since issue 86 both act on part of a road: the pointer marks a short
// stretch of the segment under it, Shift marks the whole segment, and a
// drag grows each segment's stretch over everything it passes (see
// edit-section.ts). The mark is drawn from `planSection`, the sim's own
// cut, so it shows where the sim will cut. Reversing a one-way with a
// right-click still takes the whole segment: half a road reversed would
// meet the other half head on.
//
// A sent edit stays marked on screen until the sim has applied or refused
// it. A refusal removes the mark and shows the reason, whether the sim
// refused the command when it arrived or dropped it at the step.
//
// A command names segments by id and carries where each one's ends were and
// its type when the player picked it: on hover for a click, and as the
// pointer passed over it for a drag. If the segment has split, changed type
// or the id names another road by the time the command applies, as when
// another player's crossing road lands first, the sim refuses it and
// nothing is removed or changed (issue 94).

import {
  LEVEL_BRIDGE,
  NONE,
  ROAD_TYPES,
  SEG_FIXED,
  levelOffset,
  planBulldoze,
  planSection,
  planUpgrade,
  segmentQuad,
  subQuad,
  segmentEnds,
  segmentTypeId,
  type BuildingsInTheWay,
  type CommandResult,
  type SegmentEnds,
  type UpgradePlan,
  type RoadNetwork,
  type RoadType,
  type Quad,
  type Section,
  type Terrain,
} from "@city-council/sim";
import { WHOLE, isWhole, joinSections, sectionKey } from "./edit-section";
import { isRaised, liveRoadSegment, roadTypeOf, type RoadNet } from "../render/road-geometry";
import type { PreviewLook, PreviewShape } from "../render/road-preview-geometry";
import type { RoadPricer, RoadToolState, ToolRoadType } from "./road-tool";

/** How the upgrade tool prices an upgrade on the mirror (M4-16): the buildings it takes, and the sim's `roadPrice`. */
export interface EditMoney {
  clears: (plan: UpgradePlan) => BuildingsInTheWay;
  price: RoadPricer;
}

/** What an edit does: remove, change type, or reverse a one-way. */
export type EditKind = "bulldoze" | "upgrade" | "reverse";

/** What the sim would do with an edit, or why it would refuse it. */
export interface EditPreview {
  kind: EditKind;
  /** The segments, in the order they were picked. */
  segments: readonly number[];
  /** The stretch of each, in the same order. `[0, 1]` for the whole. */
  sections: readonly Section[];
  /** The type an upgrade changes to, or null for a bulldoze. A reversal keeps its one-way type. */
  type: RoadType | null;
  ok: boolean;
  /** Why the sim would refuse it, or null when it would do it. */
  reason: string | null;
  /** Plan length in metres. */
  length: number;
  /** The plan's cost in whole dollars, from the balance file: for a bulldoze its demolition less its refund. Zero when refused. */
  cost: number;
  /** A bulldoze's demolition and the refund it pays back, from its plan (M4-03), whose difference is `cost`. Zero for an upgrade or when refused. */
  demolition: number;
  refund: number;
  /**
   * What the command charges: `cost` plus the compensation for the buildings
   * a wider road takes, from the sim's `roadPrice` on the mirror (M4-16).
   * `cost` when nothing gave a way to price it, and zero when refused.
   */
  price: number;
  /** Why the treasury cannot pay `price`, or null. */
  refusal: string | null;
  /** The buildings an upgrade would take, or null when not looked for. */
  clears: BuildingsInTheWay | null;
  /** A segment in it is fixed, such as an outside connection's: it cannot be removed or changed. */
  fixed: boolean;
  /** The command that does it, with the segments' ends as the preview saw them. */
  command: EditCommand;
}

/** The command an edit sends. */
export interface EditCommand {
  type: "BulldozeRoad" | "UpgradeRoad";
  payload: { segments: number[]; ends: SegmentEnds[]; types: string[]; type?: string; sections?: Section[] };
}

/**
 * How the player saw a segment when they picked it: where its ends were,
 * its type, and the stretch of it they picked, the whole when left out.
 */
export interface SeenSegment {
  ends: SegmentEnds;
  type: string;
  section?: Section;
}

/** Segment `seg` as it is in `net` now, with stretch `section` of it picked. */
export function seeSegment(net: RoadNet, seg: number, section?: Section): SeenSegment {
  const seen: SeenSegment = { ends: segmentEnds(net, seg), type: segmentTypeId(net, seg) };
  if (section && !isWhole(section)) seen.section = section;
  return seen;
}

/** `seen` with its stretch grown to cover `section` too. */
export function seeMore(seen: SeenSegment, section: Section | undefined): SeenSegment {
  const joined = joinSections(seen.section ?? WHOLE, section ?? WHOLE);
  const out: SeenSegment = { ends: seen.ends, type: seen.type };
  if (!isWhole(joined)) out.section = joined;
  return out;
}

/**
 * The command for an edit of `segments`. Each carries how the player saw
 * it: from `seen` when given, one per segment, or as it is in `net` now.
 */
export function editCommand(
  net: RoadNet,
  kind: EditKind,
  segments: readonly number[],
  typeId: string,
  seen?: readonly SeenSegment[],
): EditCommand {
  const saw = segments.map((seg, i) => seen?.[i] ?? seeSegment(net, seg));
  const ends = saw.map((s) => s.ends);
  const types = saw.map((s) => s.type);
  // Left out when every segment goes whole, so such a command is what it always was.
  const parts = saw.some((s) => s.section) ? { sections: saw.map((s) => s.section ?? WHOLE) } : {};
  if (kind === "bulldoze") return { type: "BulldozeRoad", payload: { segments: [...segments], ends, types, ...parts } };
  return { type: "UpgradeRoad", payload: { segments: [...segments], ends, types, type: typeId, ...parts } };
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
  seen?: readonly SeenSegment[],
  money?: EditMoney,
): EditPreview {
  const command = editCommand(net, kind, segments, typeId, seen);
  const type = kind === "bulldoze" ? null : (ROAD_TYPES.find((t) => t.id === typeId) ?? null);
  const fixed = segments.some((seg) => isFixed(net, seg));
  // As the sim will cut them: a stretch whose ends would leave stubs is the whole segment.
  const sections = (command.payload.sections ?? segments.map(() => WHOLE)).map((section, i): Section => {
    if (isWhole(section)) return section;
    const plan = planSection(asNetwork(net), segments[i] ?? NONE, section);
    return typeof plan === "string" ? section : [plan.from, plan.to];
  });
  const base = { kind, segments: [...segments], sections, type, fixed, command };
  const none = { length: 0, cost: 0, demolition: 0, refund: 0, price: 0, refusal: null, clears: null };
  if (fixed) {
    // The sim refuses this too, naming the segment by id. A player does not know ids.
    const reason = kind === "bulldoze" ? "This road is fixed and cannot be removed" : "This road is fixed and cannot be changed";
    return { ...base, ...none, ok: false, reason };
  }
  if (kind === "bulldoze") {
    const result = planBulldoze(asNetwork(net), command.payload);
    if (!result.ok) return { ...base, ...none, ok: false, reason: result.reason };
    const { length, cost, demolition, refund } = result.plan;
    // The bulldozer prices the buildings on the road itself, with the sim's `previewBulldozeRoad` (bulldoze-tool.ts).
    return { ...base, ok: true, reason: null, length, cost, demolition, refund, price: cost, refusal: null, clears: null };
  }
  const result = planUpgrade(asNetwork(net), terrain, command.payload);
  if (!result.ok) return { ...base, ...none, ok: false, reason: result.reason };
  const { length, cost } = result.plan;
  const clears = money ? money.clears(result.plan) : null;
  const { price, refusal } = money ? money.price(cost, clears) : { price: cost, refusal: null };
  return { ...base, ok: true, reason: null, length, cost, demolition: 0, refund: 0, price, refusal, clears };
}

/** An edit the tool has sent and the sim has not yet applied or refused. */
export interface PendingEdit {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: EditPreview;
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

/** The edit tools' ids. The bulldozer left them in issue 116. */
export type EditToolId = "upgrade";

/** What the controller needs from the page. */
export interface EditToolHost {
  get(): RoadToolState & EditToolState;
  set(patch: Partial<RoadToolState & EditToolState>): void;
  /** The mirror's roads and the map, and how to price an upgrade on it, or null before the first snapshot. */
  world(): { net: RoadNet; terrain: Terrain; money?: EditMoney } | null;
  /** Sends a command and resolves once the sim has applied it, or with why it did not. */
  send(type: EditCommand["type"], payload: EditCommand["payload"]): Promise<CommandResult>;
}

/** Nothing being drawn with the road tool. */
const ROAD_IDLE = { roadStart: null, roadControl: null, roadChain: 0 } as const;

/** The upgrade tool's input handling. Holds no state of its own beyond a counter for ids. */
export class EditToolController {
  private readonly host: EditToolHost;
  private nextId = 1;
  /**
   * How each segment of the drag on looked when the pointer passed over it,
   * in drag order, so the command says what the player saw then and the
   * sim refuses it if a segment changed before the button came up.
   */
  private dragSeen: SeenSegment[] = [];

  constructor(host: EditToolHost) {
    this.host = host;
  }

  /** The edit tool that is on, or null. */
  active(): EditToolId | null {
    return this.host.get().tool === "upgrade" ? "upgrade" : null;
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
   * the drag so far while one is on, otherwise stretch `section` of that
   * segment, the whole when left out. Null when there is nothing to show.
   */
  preview(seg: number, section?: Section): EditPreview | null {
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
    const seen = drag ? this.dragSeen : [seeSegment(world.net, seg, section)];
    return previewEdit(world.net, world.terrain, tool, segments, this.upgradeType(), seen, world.money);
  }

  /** A key that changes whenever the drag's stretches do, for telling when its preview needs working out again. */
  dragKey(): string {
    return this.dragSeen.map((s) => sectionKey(s.section)).join(";");
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
    return previewEdit(world.net, world.terrain, "reverse", [seg], type.id, undefined, world.money);
  }

  /** A left click with segment `seg` under the pointer, or NONE, and stretch `section` of it marked. */
  click(seg: number, section?: Section): void {
    if (!this.active()) return;
    const preview = this.preview(seg, section);
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
    if (!this.active()) return;
    this.dragSeen = [];
    this.host.set({ editDrag: [], editNote: null });
  }

  /**
   * The drag passed over stretch `section` of segment `seg`, the whole when
   * left out. It joins the drag unless the tool could not act on it alone.
   * A segment in the drag already has its stretch grown to cover this one.
   */
  dragOver(seg: number, section?: Section): void {
    const tool = this.active();
    const s = this.host.get();
    const world = this.host.world();
    if (!tool || !s.editDrag || !world || seg === NONE) return;
    const at = s.editDrag.indexOf(seg);
    if (at >= 0) {
      const seen = this.dragSeen[at];
      if (!seen) return;
      const more = seeMore(seen, section);
      if (sectionKey(more.section) === sectionKey(seen.section)) return;
      this.dragSeen = this.dragSeen.map((x, i) => (i === at ? more : x));
      // A new list, so the page works the preview out again.
      this.host.set({ editDrag: [...s.editDrag] });
      return;
    }
    if (!liveRoadSegment(world.net, seg)) return;
    // Upgrading a road to the type it is already would refuse the whole drag, or reverse a one-way.
    if (tool === "upgrade" && roadTypeOf(world.net, seg).id === this.upgradeType()) return;
    if (!previewEdit(world.net, world.terrain, tool, [seg], this.upgradeType()).ok) return;
    this.dragSeen = [...this.dragSeen.slice(0, s.editDrag.length), seeSegment(world.net, seg, section)];
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
    // As each segment was when the pointer passed over it: a segment split or replaced since refuses the drag.
    this.sendIfOk(previewEdit(world.net, world.terrain, tool, drag, this.upgradeType(), this.dragSeen));
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
    const pending: PendingEdit = { id: this.nextId++, preview };
    this.host.set({ editNote: null, editPending: [...this.host.get().editPending, pending] });
    const { type, payload } = preview.command;
    void this.host.send(type, payload).then((result) => this.answered(pending.id, result));
  }

  /** The sim applied the edit, and the copy shows it, or refused it: either way its mark goes. */
  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().editPending.filter((p) => p.id !== id);
    this.host.set(result.ok ? { editPending: pending } : { editPending: pending, editNote: result.reason });
  }
}

/**
 * The marks to draw for an edit: each segment as a strip, at the width of
 * the type an upgrade would give it, or of its own type otherwise, on its
 * bridge deck when it is a bridge. Part of a segment is drawn where the
 * sim would cut it (`planSection`), or as picked when the sim would refuse.
 */
export function editShapes(net: RoadNet, preview: EditPreview, look: PreviewLook): PreviewShape[] {
  const out: PreviewShape[] = [];
  preview.segments.forEach((seg, i) => {
    if (!liveRoadSegment(net, seg)) return;
    const own = roadTypeOf(net, seg);
    const type = preview.ok && preview.kind === "upgrade" && preview.type ? preview.type : own;
    const section = preview.sections[i] ?? WHOLE;
    if (!isWhole(section)) {
      const plan = planSection(asNetwork(net), seg, section);
      const q: Quad =
        typeof plan === "string" ? subQuad(segmentQuad(asNetwork(net), seg), section[0], section[1]) : plan.shape;
      const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
      const shape: PreviewShape = {
        ax: q.ax,
        az: q.az,
        bx: q.bx,
        bz: q.bz,
        control: straight ? null : { x: q.cx, z: q.cz },
        width: type.width,
        look,
        junctions: [],
        bridges: [],
      };
      // Only a segment at one level is cut, so a raised one is raised the same at both ends.
      if (isRaised(net, seg)) shape.raise = { a: levelOffset(net.segLevelA[seg] ?? 0), b: levelOffset(net.segLevelB[seg] ?? 0) };
      out.push(shape);
      return;
    }
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
    if (net.segLevelA[seg] === LEVEL_BRIDGE) {
      shape.deck = { hA: net.nodeHeight[a] ?? 0, hB: net.nodeHeight[b] ?? 0, grade: type.maxSlope };
    } else if (isRaised(net, seg)) {
      shape.raise = { a: levelOffset(net.segLevelA[seg] ?? 0), b: levelOffset(net.segLevelB[seg] ?? 0) };
    }
    out.push(shape);
  });
  return out;
}
