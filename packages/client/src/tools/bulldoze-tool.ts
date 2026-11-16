// The bulldozer (issue 116, PRD "Removing things"): one tool for everything
// the player can remove. With it on, the thing under the pointer is marked
// in the bulldoze orange, a price tag says what a click removes and what it
// costs, and the click removes it.
//
// Each kind of thing it removes is a target kind in `BULLDOZE_TARGETS`, in
// pick order: where two kinds are under the pointer at once, the earlier
// one wins. M2 has two, buildings before roads. A kind supplies how the
// player saw a target when they picked it, so the command can name what
// they saw (`see`), and the plan for a list of targets: what the price tag
// shows and the command a click sends (`plan`). The plan runs the sim's own
// planner on the mirror's read-only copy, so the tag and the charge agree.
// How a kind is found under the pointer is the page's work (main.ts), since
// it needs the camera; the tool asks for it through `pick` on its host. The
// marks follow from the plan: the road segments and the buildings it
// removes. Later milestones add kinds here; nobody builds a second
// bulldozer.
//
// A left drag collects every target of the kind it touched first and sends
// one command on release, so one log entry. A drag that starts on a
// building passes over roads, and one that starts on a road removes the
// buildings on it, as a road bulldoze does. Each kind has a filter in the
// tool's menu; with one off the pointer ignores that kind.
//
// Removing a road can be undone. Removing a building cannot, and asks for no
// confirmation: the price tag is the warning. Tool state lives in the UI
// store; nothing here writes sim state.

import {
  NONE,
  buildingInfo,
  isBuilding,
  planBulldozeBuildings,
  previewBulldozeRoad,
  type BuildingInfo,
  type BuildingSeen,
  type CommandResult,
  type SimState,
  type Terrain,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import { liveRoadSegment } from "../render/road-geometry";
import { previewEdit, seeSegment, type EditPreview, type SeenSegment } from "./edit-tool";
import type { RoadToolState } from "./road-tool";

/** The kinds of thing the bulldozer removes in M2. Later milestones add theirs. */
export type BulldozeKind = "building" | "road";

/** The world a plan reads: the mirror's copy of state and the map. Read only. */
export interface BulldozeWorld {
  state: ReadonlyDeep<SimState>;
  terrain: Terrain;
}

/**
 * The sim's planners take the mutable state because the sim calls them on
 * live state; on the copy they only read it, apart from the derived cell
 * index, which is not state a player set.
 */
function asState(world: BulldozeWorld): SimState {
  return world.state as unknown as SimState;
}

/** What removing some targets would do, or why the sim would refuse it. */
export interface BulldozePreview {
  kind: BulldozeKind;
  /** The targets, in the order they were picked: segment ids or building ids. */
  ids: readonly number[];
  ok: boolean;
  /** Why the sim would refuse it, or null. */
  reason: string | null;
  /** A target in it can never be removed, such as an outside connection's road. */
  fixed: boolean;
  /** Whole dollars, from the target's plan. Zero when refused. Buildings are free until M4's eminent domain price. */
  cost: number;
  /** Metres of road removed; 0 for buildings. */
  length: number;
  /** The road segments it removes, for the marks. Empty for buildings. */
  segments: readonly number[];
  /** Every building that goes: the targets themselves, or those standing on the roads' cells. Ascending ids. */
  buildings: readonly number[];
  /** The residents those buildings hold. */
  residents: number;
  /** One building picked alone, for the readout in the tag. Null otherwise. */
  building: BuildingInfo | null;
  /** Whether Undo can take it back. */
  undoable: boolean;
  /** The command a click sends. */
  command: { type: "BulldozeRoad" | "BulldozeBuilding"; payload: unknown };
  /** For roads, the edit preview the strips are drawn from. */
  road: EditPreview | null;
}

/** What a target kind supplies to the bulldozer. */
export interface BulldozeTargetKind {
  id: BulldozeKind;
  /** The filter toggle's label. */
  label: string;
  /** How target `id` is now, as a command names it, or null when it is not there. */
  see(world: BulldozeWorld, id: number): unknown;
  /** Whether a drag may take target `id` alone: something a click on it would not refuse. */
  takes(world: BulldozeWorld, id: number): boolean;
  /** What removing `ids` would do, each as `seen` says the player saw it. */
  plan(world: BulldozeWorld, ids: readonly number[], seen: readonly unknown[]): BulldozePreview;
}

const NOTHING = { ids: [] as number[], residents: 0 };

function roadPlan(world: BulldozeWorld, ids: readonly number[], seen: readonly unknown[]): BulldozePreview {
  const net = world.state.roads;
  const state = asState(world);
  const edit = previewEdit(net, world.terrain, "bulldoze", ids, "street", seen as readonly SeenSegment[]);
  // The buildings on the roads' cells go with them (M2-11), counted by the sim's own planner.
  const planned = edit.ok ? previewBulldozeRoad(state, edit.command.payload) : null;
  const clears = planned?.ok ? planned.clears : NOTHING;
  return {
    kind: "road",
    ids: [...ids],
    ok: edit.ok,
    reason: edit.reason,
    fixed: edit.fixed,
    cost: edit.cost,
    length: edit.length,
    segments: [...ids],
    buildings: clears.ids,
    residents: clears.residents,
    building: null,
    undoable: true,
    command: { type: "BulldozeRoad", payload: edit.command.payload },
    road: edit,
  };
}

function buildingPlan(world: BulldozeWorld, ids: readonly number[], seen: readonly unknown[]): BulldozePreview {
  const buildings = seen as readonly BuildingSeen[];
  const payload = { buildings: buildings.map((b) => ({ id: b.id, segment: b.segment, side: b.side, place: b.place })) };
  const state = asState(world);
  const result = planBulldozeBuildings(state, payload);
  let residents = 0;
  if (result.ok) for (const id of result.ids) residents += world.state.buildings.residents[id] ?? 0;
  return {
    kind: "building",
    ids: [...ids],
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    fixed: false,
    // The plan has no price: M2 has no money. M4 puts the eminent domain price here, from the plan.
    cost: 0,
    length: 0,
    segments: [],
    buildings: result.ok ? result.ids : [],
    residents,
    building: ids.length === 1 && result.ok ? buildingInfo(state, ids[0] ?? NONE) : null,
    undoable: false,
    command: { type: "BulldozeBuilding", payload },
    road: null,
  };
}

function seeBuilding(world: BulldozeWorld, id: number): BuildingSeen | null {
  const b = world.state.buildings;
  if (!isBuilding(b, id)) return null;
  return { id, segment: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0 };
}

/** Every target kind, in pick order: where two are under the pointer, the earlier wins. */
export const BULLDOZE_TARGETS: readonly BulldozeTargetKind[] = [
  {
    id: "building",
    label: "Buildings",
    see: seeBuilding,
    takes: (world, id) => seeBuilding(world, id) !== null,
    plan: buildingPlan,
  },
  {
    id: "road",
    label: "Roads",
    see: (world, id) => (liveRoadSegment(world.state.roads, id) ? seeSegment(world.state.roads, id) : null),
    // A fixed segment would refuse the whole drag, so a drag leaves it out.
    takes: (world, id) => liveRoadSegment(world.state.roads, id) && roadPlan(world, [id], [seeSegment(world.state.roads, id)]).ok,
    plan: roadPlan,
  },
];

function targetKind(kind: BulldozeKind): BulldozeTargetKind {
  const t = BULLDOZE_TARGETS.find((k) => k.id === kind);
  if (!t) throw new Error(`no bulldoze target kind ${kind}`);
  return t;
}

/** One thing under the pointer. */
export interface BulldozeTarget {
  kind: BulldozeKind;
  id: number;
}

/** A bulldoze the tool has sent and the sim has not yet applied or refused. */
export interface PendingBulldoze {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: BulldozePreview;
}

/** The bulldozer's part of the UI store. */
export interface BulldozeToolState {
  /** Which kinds the pointer picks. Every kind starts on. */
  bulldozeFilters: Readonly<Record<BulldozeKind, boolean>>;
  /** The kind a drag took first and what it has collected, in order, or null when no drag is on. */
  bulldozeDrag: { kind: BulldozeKind | null; ids: readonly number[] } | null;
  bulldozePending: readonly PendingBulldoze[];
  /** The last refusal, from the plan at the click or from the sim. Null when there is none. */
  bulldozeNote: string | null;
}

export const INITIAL_BULLDOZE_TOOL: BulldozeToolState = {
  bulldozeFilters: { building: true, road: true },
  bulldozeDrag: null,
  bulldozePending: [],
  bulldozeNote: null,
};

/** What the controller needs from the page. */
export interface BulldozeToolHost {
  get(): RoadToolState & BulldozeToolState;
  set(patch: Partial<RoadToolState & BulldozeToolState>): void;
  /** The mirror's copy of state and the map, or null before the first snapshot. */
  world(): BulldozeWorld | null;
  /** Sends a command and resolves once the sim has applied it, or with why it did not. */
  send(type: string, payload: unknown): Promise<CommandResult>;
}

/**
 * Finds the target of kind `kind` under the pointer, or NONE. `prefer` is the
 * one a drag took last, which wins while the pointer is still on it.
 */
export type BulldozePicker = (kind: BulldozeKind, prefer: number) => number;

/** Nothing being drawn with the road tool. */
const ROAD_IDLE = { roadStart: null, roadControl: null, roadChain: 0 } as const;

/** The bulldozer's input handling. Holds no state of its own beyond a counter for ids and what a drag saw. */
export class BulldozeToolController {
  private readonly host: BulldozeToolHost;
  private nextId = 1;
  /** How each target of the drag on looked when the pointer passed over it, in drag order. */
  private dragSeen: unknown[] = [];

  constructor(host: BulldozeToolHost) {
    this.host = host;
  }

  active(): boolean {
    return this.host.get().tool === "bulldoze";
  }

  /** Turns the bulldozer on, or off when it is on. Either way a road being drawn and a drag are dropped. */
  toggle(): void {
    const on = this.active();
    this.host.set({ tool: on ? null : "bulldoze", bulldozeDrag: null, bulldozeNote: null, roadNote: null, ...ROAD_IDLE });
  }

  leave(): void {
    this.host.set({ tool: null, bulldozeDrag: null, bulldozeNote: null });
  }

  /** Escape: drops a drag, or leaves the tool. Returns whether it did anything. */
  escape(): boolean {
    if (!this.active()) return false;
    if (this.host.get().bulldozeDrag) this.host.set({ bulldozeDrag: null, bulldozeNote: null });
    else this.leave();
    return true;
  }

  /** Turns the filter for `kind` on or off. A drag of that kind is dropped. */
  toggleFilter(kind: BulldozeKind): void {
    const s = this.host.get();
    const filters = { ...s.bulldozeFilters, [kind]: !s.bulldozeFilters[kind] };
    this.host.set({ bulldozeFilters: filters, ...(s.bulldozeDrag?.kind === kind ? { bulldozeDrag: null } : {}) });
  }

  /**
   * The target under the pointer: the first kind in pick order whose filter
   * is on and that `pick` finds there. While a drag is on, only the drag's
   * kind, with the one it took last preferred.
   */
  pick(pick: BulldozePicker): BulldozeTarget | null {
    if (!this.active()) return null;
    const s = this.host.get();
    const drag = s.bulldozeDrag;
    for (const t of BULLDOZE_TARGETS) {
      if (!s.bulldozeFilters[t.id]) continue;
      if (drag?.kind && drag.kind !== t.id) continue;
      const prefer = drag?.kind === t.id ? (drag.ids[drag.ids.length - 1] ?? NONE) : NONE;
      const id = pick(t.id, prefer);
      if (id !== NONE) return { kind: t.id, id };
    }
    return null;
  }

  /**
   * What the price tag shows with `target` under the pointer: the drag so
   * far while one is on, otherwise that target alone. Null when there is
   * nothing to show.
   */
  preview(target: BulldozeTarget | null): BulldozePreview | null {
    const world = this.host.world();
    if (!this.active() || !world) return null;
    const drag = this.host.get().bulldozeDrag;
    if (drag) return drag.kind && drag.ids.length > 0 ? targetKind(drag.kind).plan(world, drag.ids, this.dragSeen) : null;
    if (!target) return null;
    const kind = targetKind(target.kind);
    const seen = kind.see(world, target.id);
    return seen === null ? null : kind.plan(world, [target.id], [seen]);
  }

  /** A left click with `target` under the pointer, or null. */
  click(target: BulldozeTarget | null): void {
    const preview = this.preview(target);
    if (preview) this.sendIfOk(preview);
  }

  /** A drag started. Its kind is the first target it passes over. */
  dragStart(): void {
    if (!this.active()) return;
    this.dragSeen = [];
    this.host.set({ bulldozeDrag: { kind: null, ids: [] }, bulldozeNote: null });
  }

  /** The drag passed over `target`. It joins unless it is another kind, there already, or a click on it alone would be refused. */
  dragOver(target: BulldozeTarget | null): void {
    const s = this.host.get();
    const drag = s.bulldozeDrag;
    const world = this.host.world();
    if (!this.active() || !drag || !world || !target || target.id === NONE) return;
    if (!s.bulldozeFilters[target.kind]) return;
    if (drag.kind && drag.kind !== target.kind) return;
    if (drag.ids.includes(target.id)) return;
    const kind = targetKind(target.kind);
    if (!kind.takes(world, target.id)) return;
    this.dragSeen = [...this.dragSeen.slice(0, drag.ids.length), kind.see(world, target.id)];
    this.host.set({ bulldozeDrag: { kind: target.kind, ids: [...drag.ids, target.id] } });
  }

  /** The drag ended: sends one command for everything it collected. */
  dragEnd(): void {
    const drag = this.host.get().bulldozeDrag;
    const world = this.host.world();
    this.host.set({ bulldozeDrag: null });
    if (!this.active() || !world || !drag?.kind || drag.ids.length === 0) return;
    // As each target was when the pointer passed over it: one changed since refuses the drag.
    this.sendIfOk(targetKind(drag.kind).plan(world, drag.ids, this.dragSeen));
  }

  /** The drag was cut off: drops it. */
  dragCancel(): void {
    if (this.host.get().bulldozeDrag) this.host.set({ bulldozeDrag: null });
  }

  private sendIfOk(preview: BulldozePreview): void {
    if (!preview.ok) {
      this.host.set({ bulldozeNote: preview.reason });
      return;
    }
    const pending: PendingBulldoze = { id: this.nextId++, preview };
    this.host.set({ bulldozeNote: null, bulldozePending: [...this.host.get().bulldozePending, pending] });
    const { type, payload } = preview.command;
    void this.host.send(type, payload).then((result) => this.answered(pending.id, result));
  }

  /** The sim applied the bulldoze, and the copy shows it, or refused it: either way its mark goes. */
  private answered(id: number, result: CommandResult): void {
    const pending = this.host.get().bulldozePending.filter((p) => p.id !== id);
    this.host.set(result.ok ? { bulldozePending: pending } : { bulldozePending: pending, bulldozeNote: result.reason });
  }
}
