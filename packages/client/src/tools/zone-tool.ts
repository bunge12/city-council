// The zone tool (issue M2-07). A player paints zones on the cells along the
// streets.
//
//   fill   hover a road, or a cell beside one, and the strip on that side of
//          that segment lights up, `zoneDepth` cells back from the road's
//          edge. A click paints it.
//   brush  drag over cells to paint the ones the pointer passes over. A
//          click paints the one cell under it.
//
// The zone and density come from the picker, or erase clears instead.
//
// The tool names ground, as `ZoneCells` does: each run of cells it means to
// paint becomes a thin rectangle through their centres, so the sim paints
// exactly those. What it shows before the click is `planZoneCells`, the
// function the sim checks the command with, run on the mirror's copy of the
// city: the cells that would change and how many. A click where nothing
// would change sends nothing. Each click or drag sends one `ZoneCells`; one
// with more rectangles than a command takes is cut into several.
//
// A sent stroke stays on screen until the delta that paints it arrives, as
// the road tool's roads do. Tool state lives in the UI store (ui/store.ts);
// nothing here writes sim state.

import {
  CELL_OPEN,
  NONE,
  ZONE_CLEAR,
  ZONING_BALANCE,
  cellAt,
  cellCorners,
  placesAlong,
  planZoneCells,
  type CommandResult,
  type RoadNetwork,
  type SimState,
  type ZoneCellsPayload,
  type ZoneRect,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import type { RoadToolState } from "./road-tool";

/** How the tool paints: a whole strip beside a road, or the cells under the pointer. */
export type ZoneMode = "fill" | "brush";

export const ZONE_MODES: readonly ZoneMode[] = ["fill", "brush"];

/** Fill depths offered, in cells back from the road's edge: one to the full zoning depth. */
export const ZONE_DEPTHS: readonly number[] = Array.from({ length: ZONING_BALANCE.zoneDepthCells }, (_, i) => i + 1);

/** A cell the tool means to paint: where it sits in `state.cells`, its centre, and its corners for drawing. */
export interface ZoneTarget {
  slot: number;
  segment: number;
  side: number;
  place: number;
  depth: number;
  x: number;
  z: number;
  /** x0, z0, ..., x3, z3, as `cellCorners` gives them. */
  corners: readonly number[];
}

/** What the tool would do now, checked with `planZoneCells`. */
export interface ZonePreview {
  /** The zone id, or "none" for erase. */
  zone: string;
  density: number;
  ok: boolean;
  /** Why nothing would be sent, or null. */
  reason: string | null;
  /** The cells that would change. Empty when refused. */
  cells: readonly ZoneTarget[];
  /** The commands a click would send, each within the sim's cap on rectangles. Empty when refused. */
  payloads: readonly ZoneCellsPayload[];
}

/** A stroke the tool has sent and the sim has not yet painted. */
export interface PendingZone {
  /** Local to this page, for keys. Not a sim id. */
  id: number;
  preview: ZonePreview;
  /** Commands the sim has not yet applied or refused. */
  waiting: number;
}

/** The zone tool's part of the UI store. */
export interface ZoneToolState {
  /** The zone picked, a zone id from `zoning.json`. */
  zonePick: string;
  zoneDensity: number;
  /** Erase clears cells instead of painting the zone picked. */
  zoneErase: boolean;
  zoneMode: ZoneMode;
  /** How far back a fill reaches from the road's edge, in cells. */
  zoneDepth: number;
  /** The cells a brush drag has passed over, in order, or null when no drag is on. */
  zoneBrush: readonly ZoneTarget[] | null;
  zonePending: readonly PendingZone[];
  /** The last refusal from the sim, or the reason a click sent nothing. Null when there is none. */
  zoneNote: string | null;
}

export const INITIAL_ZONE_TOOL: ZoneToolState = {
  zonePick: ZONING_BALANCE.zones[0]?.id ?? "residential",
  zoneDensity: 1,
  zoneErase: false,
  zoneMode: "fill",
  zoneDepth: ZONING_BALANCE.zoneDepthCells,
  zoneBrush: null,
  zonePending: [],
  zoneNote: null,
};

/** What the pointer is over, worked out by the page each frame. */
export interface ZoneHover {
  /** The ground under the pointer, or null. */
  ground: { x: number; z: number } | null;
  /** The road segment the pointer is over, as the bulldoze tool picks it, or NONE. */
  segment: number;
}

type City = ReadonlyDeep<SimState>;

const NO_TARGETS: readonly ZoneTarget[] = [];

/** The sim's queries only read the city, apart from the derived cell index, which is not state a player set. */
function asState(city: City): SimState {
  return city as unknown as SimState;
}

/** Where a cell named this way sits in `state.cells`. */
function slotOf(city: City, segment: number, side: number, place: number, depth: number): number {
  const d = ZONING_BALANCE.zoneDepthCells;
  return (city.cells.offset[segment] ?? 0) + (place * 2 + side) * d + depth;
}

/** The cell named this way as a target, or null when there is no such cell. */
function targetOf(city: City, segment: number, side: number, place: number, depth: number): ZoneTarget | null {
  const corners = cellCorners(asState(city), { segment, side, place, depth });
  if (!corners) return null;
  const x = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
  const z = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
  return { slot: slotOf(city, segment, side, place, depth), segment, side, place, depth, x, z, corners };
}

/** Whether target `t` is open: the cell the sim finds at its centre is this one, and open. */
function isOpen(city: City, t: ZoneTarget): boolean {
  const info = cellAt(asState(city), t.x, t.z);
  return info !== null && info.index === t.slot && info.status === CELL_OPEN;
}

/**
 * The open cells of segment `segment` on side `side`, from the road's edge
 * back `depth` cells, place by place. A blocked cell is left out: where
 * another segment's open cell lies on the same ground, a rectangle through
 * its centre would paint that one, which is not this strip's.
 */
export function stripCells(city: City, segment: number, side: number, depth: number): ZoneTarget[] {
  const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
  const rows = Math.max(1, Math.min(ZONING_BALANCE.zoneDepthCells, Math.floor(depth)));
  const out: ZoneTarget[] = [];
  for (let place = 0; place < places; place++) {
    for (let d = 0; d < rows; d++) {
      const t = targetOf(city, segment, side, place, d);
      if (t && isOpen(city, t)) out.push(t);
    }
  }
  return out;
}

/** The cell at `slot` in `state.cells`, as a target, or null when there is none. */
export function targetOfSlot(city: City, slot: number): ZoneTarget | null {
  const offset = city.cells.offset;
  // The last segment whose run starts at or before the slot; runs of length zero share a start.
  let lo = 0;
  let hi = offset.length - 2;
  if (hi < 0 || slot < 0 || slot >= (offset[hi + 1] ?? 0)) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offset[mid] ?? 0) <= slot) lo = mid;
    else hi = mid - 1;
  }
  const d = ZONING_BALANCE.zoneDepthCells;
  const local = slot - (offset[lo] ?? 0);
  const depth = local % d;
  const rest = (local - depth) / d;
  const side = rest % 2;
  return targetOf(city, lo, side, (rest - side) / 2, depth);
}

/** The open cell whose ground holds (x, z), or null. */
export function cellUnder(city: City, x: number, z: number): ZoneTarget | null {
  const info = cellAt(asState(city), x, z);
  if (!info || info.status !== CELL_OPEN) return null;
  return targetOf(city, info.segment, info.side, info.place, info.depth);
}

/**
 * The side of segment `segment` nearer to (x, z): the side of the road-edge
 * cell whose centre is nearest. Null when the segment has no cells.
 */
export function nearerSide(city: City, segment: number, x: number, z: number): number | null {
  const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
  let best: number | null = null;
  let bestD = Infinity;
  for (let place = 0; place < places; place++) {
    for (const side of [0, 1]) {
      const t = targetOf(city, segment, side, place, 0);
      if (!t) continue;
      const d = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = side;
      }
    }
  }
  return best;
}

/**
 * Half the width of the rectangles the tool sends, metres. Two cell centres
 * are never this near each other, so each rectangle holds only the centres
 * it was drawn through.
 */
const REACH = 1;

/**
 * Rectangles of ground whose cell centres are exactly `cells`, none of them
 * longer than the sim takes. A run of cells one behind the other in a
 * column, from the road's edge back, shares one rectangle through their
 * centres, which lie on one line. Any other cell gets a short one of its own.
 */
export function rectsFor(cells: readonly ZoneTarget[]): ZoneRect[] {
  // Group by column, then cut each column into runs of neighbouring depths.
  const columns = new Map<string, ZoneTarget[]>();
  for (const c of cells) {
    const key = `${c.segment},${c.side},${c.place}`;
    const list = columns.get(key);
    if (list) list.push(c);
    else columns.set(key, [c]);
  }
  const out: ZoneRect[] = [];
  for (const column of columns.values()) {
    column.sort((a, b) => a.depth - b.depth);
    let run: ZoneTarget[] = [];
    const flush = () => {
      if (run.length > 0) out.push(...runRects(run));
      run = [];
    };
    for (const c of column) {
      const last = run[run.length - 1];
      if (last && (c.depth === last.depth || c.depth !== last.depth + 1)) flush();
      run.push(c);
    }
    flush();
  }
  return out;
}

/** A rectangle through a lone cell's centre. */
function cellRect(c: ZoneTarget): ZoneRect {
  return { from: { x: c.x - REACH, z: c.z }, to: { x: c.x + REACH, z: c.z }, width: 2 * REACH };
}

/** One rectangle through the centres of a run of cells, or one each when they do not lie on a line. */
function runRects(run: readonly ZoneTarget[]): ZoneRect[] {
  const first = run[0];
  const last = run[run.length - 1];
  if (!first || !last) return [];
  if (run.length === 1) return [cellRect(first)];
  const dx = last.x - first.x;
  const dz = last.z - first.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 0)) return run.map(cellRect);
  const ux = dx / length;
  const uz = dz / length;
  // Each centre must lie well inside the rectangle, and the run must fit the sim's longest side.
  const inLine = run.every((c) => Math.abs((c.x - first.x) * uz - (c.z - first.z) * ux) <= REACH / 2);
  if (!inLine || length + 2 * REACH > ZONING_BALANCE.maxRectSide) return run.map(cellRect);
  return [
    {
      from: { x: first.x - ux * REACH, z: first.z - uz * REACH },
      to: { x: last.x + ux * REACH, z: last.z + uz * REACH },
      width: 2 * REACH,
    },
  ];
}

/** The commands for painting `cells` with zone `zone` at `density`: as few as the cap on rectangles allows. */
export function zonePayloads(zone: string, density: number, cells: readonly ZoneTarget[]): ZoneCellsPayload[] {
  const rects = rectsFor(cells);
  const most = ZONING_BALANCE.maxRectsPerCommand;
  const out: ZoneCellsPayload[] = [];
  for (let i = 0; i < rects.length; i += most) {
    const part = rects.slice(i, i + most);
    out.push(zone === ZONE_CLEAR ? { zone, rects: part } : { zone, density, rects: part });
  }
  return out;
}

/** Why a click sends nothing when every cell it would change is in a stroke already sent. */
const ALREADY_SENT = "these cells are being zoned already";

/**
 * What painting `cells` would do, checked with `planZoneCells` on the
 * mirror's copy: the cells that would change, or the sim's reason why none
 * would. The cells shown are the plan's own, so they are what the sim
 * paints. Cells in `sent`, slots of strokes sent and not yet in the copy,
 * count as painted already.
 */
export function previewZone(
  city: City,
  zone: string,
  density: number,
  cells: readonly ZoneTarget[],
  sent: ReadonlySet<number> = new Set(),
): ZonePreview {
  const base = { zone, density };
  if (cells.length === 0) return { ...base, ok: false, reason: null, cells: [], payloads: [] };
  const payloads = zonePayloads(zone, density, cells);
  const changing = new Set<number>();
  let reason: string | null = null;
  const going: ZoneCellsPayload[] = [];
  for (const payload of payloads) {
    const plan = planZoneCells(asState(city), payload);
    if (!plan.ok) {
      reason = plan.reason;
      continue;
    }
    const fresh = Array.from(plan.plan.cells).filter((slot) => !sent.has(slot));
    // A part that would change nothing, or only cells already on their way, is not sent.
    if (fresh.length === 0) {
      reason = ALREADY_SENT;
      continue;
    }
    going.push(payload);
    for (const slot of fresh) changing.add(slot);
  }
  if (changing.size === 0) return { ...base, ok: false, reason, cells: [], payloads: [] };
  const shown = [...changing].sort((a, b) => a - b).flatMap((slot) => targetOfSlot(city, slot) ?? []);
  return { ...base, ok: true, reason: null, cells: shown, payloads: going };
}

/** What the controller needs from the page. */
export interface ZoneToolHost {
  get(): RoadToolState & ZoneToolState;
  set(patch: Partial<RoadToolState & ZoneToolState>): void;
  /** The mirror's copy of the city, or null before the first snapshot. */
  city(): City | null;
  /** A number that changes whenever the copy does, so the tool can keep what it worked out from it. */
  version(): number;
  /** Sends a `ZoneCells` and resolves once the sim has applied it, or with why it did not. */
  send(payload: ZoneCellsPayload): Promise<CommandResult>;
}

/** The zone tool's input handling. Holds no state of its own beyond a counter for ids and caches of what it worked out from the copy. */
export class ZoneToolController {
  private readonly host: ZoneToolHost;
  private nextId = 1;
  /** The last targets worked out, and what they were worked out from. */
  private memo: { key: string; cells: ZoneTarget[] } = { key: "", cells: [] };
  /** The road-edge cells of the last segment the fill hovered, for picking a side. */
  private edge: { key: string; cells: ZoneTarget[] } = { key: "", cells: [] };
  /** Centres of the cells in the brush stroke, so each joins once. */
  private brushed = new Set<string>();

  constructor(host: ZoneToolHost) {
    this.host = host;
  }

  active(): boolean {
    return this.host.get().tool === "zone";
  }

  /** Whether a left drag paints now: the brush is on. */
  brushing(): boolean {
    return this.active() && this.host.get().zoneMode === "brush";
  }

  /** Turns the tool on, or off when it is on. The zoning overlay shows while it is on. A road being drawn is dropped. */
  toggle(): void {
    if (this.active()) {
      this.leave();
      return;
    }
    this.host.set({ tool: "zone", zoneNote: null, zoneBrush: null, roadStart: null, roadControl: null, roadChain: 0, roadNote: null });
  }

  leave(): void {
    this.host.set({ tool: null });
    this.left();
  }

  /**
   * Call when the tool in the store changed. Once the zone tool is off,
   * however it was left, drops its stroke.
   */
  toolChanged(now: string | null, before: string | null): void {
    if (before === "zone" && now !== "zone") this.left();
  }

  private left(): void {
    this.host.set({ zoneBrush: null, zoneNote: null });
  }

  /** Escape: drops a brush stroke, or leaves the tool. Returns whether it did anything. */
  escape(): boolean {
    if (!this.active()) return false;
    if (this.host.get().zoneBrush) this.host.set({ zoneBrush: null, zoneNote: null });
    else this.leave();
    return true;
  }

  /** A right-click: drops the brush stroke. Returns whether the tool is on. */
  cancel(): boolean {
    if (!this.active()) return false;
    if (this.host.get().zoneBrush) this.host.set({ zoneBrush: null });
    return true;
  }

  pickZone(id: string): void {
    if (ZONING_BALANCE.zones.some((z) => z.id === id)) this.host.set({ zonePick: id, zoneErase: false, zoneNote: null });
  }

  pickDensity(level: number): void {
    if (ZONING_BALANCE.densities.some((d) => d.level === level)) this.host.set({ zoneDensity: level, zoneErase: false, zoneNote: null });
  }

  /** Erase on or off. */
  toggleErase(): void {
    this.host.set({ zoneErase: !this.host.get().zoneErase, zoneNote: null });
  }

  pickMode(mode: ZoneMode): void {
    this.host.set({ zoneMode: mode, zoneBrush: null, zoneNote: null });
  }

  /** Sets the fill depth, clamped to one to the full zoning depth. */
  setDepth(depth: number): void {
    const d = Math.max(1, Math.min(ZONING_BALANCE.zoneDepthCells, Math.round(depth)));
    this.host.set({ zoneDepth: d });
  }

  /** Steps the fill depth by `by` cells. */
  stepDepth(by: number): void {
    this.setDepth(this.host.get().zoneDepth + by);
  }

  /** The zone a stroke paints, "none" when erasing, and the density. */
  private paint(): { zone: string; density: number } {
    const s = this.host.get();
    return s.zoneErase ? { zone: ZONE_CLEAR, density: s.zoneDensity } : { zone: s.zonePick, density: s.zoneDensity };
  }

  /**
   * The cells a click would paint with the pointer over `hover`: the strip
   * beside the road for a fill, the cell under the pointer for the brush.
   * During a brush drag, the cells it has passed over.
   */
  targets(hover: ZoneHover): readonly ZoneTarget[] {
    const city = this.host.city();
    const s = this.host.get();
    if (!this.active() || !city) return NO_TARGETS;
    if (s.zoneBrush) return s.zoneBrush;
    const v = this.host.version();
    const ground = hover.ground;
    let key: string;
    let make: () => ZoneTarget[];
    if (s.zoneMode === "brush") {
      const cell = ground ? cellUnder(city, ground.x, ground.z) : null;
      key = `${v},brush,${cell?.slot ?? "-"}`;
      make = () => (cell ? [cell] : []);
    } else if (hover.segment !== NONE && ground) {
      // Fill: the road under the pointer, on the side the pointer is.
      const side = this.sideOf(city, v, hover.segment, ground.x, ground.z);
      key = `${v},fill,${hover.segment},${side ?? "-"},${s.zoneDepth}`;
      make = () => (side === null ? [] : stripCells(city, hover.segment, side, s.zoneDepth));
    } else {
      // Or the road of the cell under it.
      const cell = ground ? cellUnder(city, ground.x, ground.z) : null;
      key = cell ? `${v},fill,${cell.segment},${cell.side},${s.zoneDepth}` : `${v},none`;
      make = () => (cell ? stripCells(city, cell.segment, cell.side, s.zoneDepth) : []);
    }
    if (key !== this.memo.key) this.memo = { key, cells: make() };
    return this.memo.cells;
  }

  /** The side of `segment` nearer (x, z), from its road-edge cells, worked out once per segment and copy. */
  private sideOf(city: City, version: number, segment: number, x: number, z: number): number | null {
    const key = `${version},${segment}`;
    if (key !== this.edge.key) {
      const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
      const cells: ZoneTarget[] = [];
      for (let place = 0; place < places; place++) {
        for (const side of [0, 1]) {
          const t = targetOf(city, segment, side, place, 0);
          if (t) cells.push(t);
        }
      }
      this.edge = { key, cells };
    }
    let best: number | null = null;
    let bestD = Infinity;
    for (const t of this.edge.cells) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t.side;
      }
    }
    return best;
  }

  /** Slots of the cells in strokes sent and not yet in the copy. */
  private sentSlots(): Set<number> {
    const out = new Set<number>();
    for (const p of this.host.get().zonePending) for (const c of p.preview.cells) out.add(c.slot);
    return out;
  }

  /** What painting `cells` would do now, with the paint picked. */
  previewOf(cells: readonly ZoneTarget[]): ZonePreview | null {
    const city = this.host.city();
    if (!this.active() || !city || cells.length === 0) return null;
    const { zone, density } = this.paint();
    return previewZone(city, zone, density, cells, this.sentSlots());
  }

  /** What the tool shows with the pointer over `hover`, or null when there is nothing to show. */
  preview(hover: ZoneHover): ZonePreview | null {
    return this.previewOf(this.targets(hover));
  }

  /** A left click: paints what the preview shows, or sends nothing when nothing would change. */
  click(hover: ZoneHover): void {
    if (!this.active()) return;
    // A click is a new press: a stroke a lost drag left behind is dropped, not painted.
    if (this.host.get().zoneBrush) this.host.set({ zoneBrush: null });
    const preview = this.preview(hover);
    if (preview) this.sendIfOk(preview);
  }

  /** A brush drag started. */
  dragStart(): void {
    if (!this.brushing()) return;
    this.brushed = new Set();
    this.host.set({ zoneBrush: [], zoneNote: null });
  }

  /** The brush passed over ground point (x, z): the open cell there joins the stroke. */
  brushOver(x: number, z: number): void {
    const s = this.host.get();
    const city = this.host.city();
    if (!this.brushing() || !s.zoneBrush || !city) return;
    const cell = cellUnder(city, x, z);
    // Known by its centre, which names ground and outlasts a change of roads mid-stroke.
    const key = cell ? `${cell.x},${cell.z}` : "";
    if (!cell || this.brushed.has(key)) return;
    this.brushed.add(key);
    this.host.set({ zoneBrush: [...s.zoneBrush, cell] });
  }

  /** The drag ended: paints every cell it passed over. */
  dragEnd(): void {
    const s = this.host.get();
    const city = this.host.city();
    const brush = s.zoneBrush;
    this.host.set({ zoneBrush: null });
    if (!this.brushing() || !city || !brush || brush.length === 0) return;
    const preview = this.previewOf(brush);
    if (preview) this.sendIfOk(preview);
  }

  /** The drag was cut off: drops it. */
  dragCancel(): void {
    if (this.host.get().zoneBrush) this.host.set({ zoneBrush: null });
  }

  private sendIfOk(preview: ZonePreview): void {
    if (!preview.ok) {
      this.host.set({ zoneNote: preview.reason });
      return;
    }
    const pending: PendingZone = { id: this.nextId++, preview, waiting: preview.payloads.length };
    this.host.set({ zoneNote: null, zonePending: [...this.host.get().zonePending, pending] });
    for (const payload of preview.payloads) {
      void this.host.send(payload).then((result) => this.answered(pending.id, result));
    }
  }

  /**
   * One of a stroke's commands was applied or refused. The stroke stays
   * drawn until every one of them has been, by which time the cells the
   * applied ones painted are in the copy. A refusal's reason is shown.
   */
  private answered(id: number, result: CommandResult): void {
    const all = this.host.get().zonePending;
    const pending = all.find((p) => p.id === id);
    if (!pending) return;
    const waiting = pending.waiting - 1;
    const note = result.ok ? {} : { zoneNote: result.reason };
    const zonePending = waiting === 0 ? all.filter((p) => p.id !== id) : all.map((p) => (p.id === id ? { ...p, waiting } : p));
    this.host.set({ zonePending, ...note });
  }
}
