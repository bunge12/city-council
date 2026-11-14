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
  /** Commands not yet answered. */
  waiting: number;
  /** "sending" until every command is answered; "accepted" once all were queued. */
  status: "sending" | "accepted";
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

/**
 * The cells of segment `segment` on side `side`, from the road's edge back
 * `depth` cells, place by place. Blocked ones too: the sim leaves them alone.
 */
export function stripCells(city: City, segment: number, side: number, depth: number): ZoneTarget[] {
  const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
  const rows = Math.max(1, Math.min(ZONING_BALANCE.zoneDepthCells, Math.floor(depth)));
  const out: ZoneTarget[] = [];
  for (let place = 0; place < places; place++) {
    for (let d = 0; d < rows; d++) {
      const t = targetOf(city, segment, side, place, d);
      if (t) out.push(t);
    }
  }
  return out;
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

/**
 * What painting `cells` would do, checked with `planZoneCells` on the
 * mirror's copy: the cells that would change, or the sim's reason why none
 * would.
 */
export function previewZone(city: City, zone: string, density: number, cells: readonly ZoneTarget[]): ZonePreview {
  const base = { zone, density };
  if (cells.length === 0) return { ...base, ok: false, reason: null, cells: [], payloads: [] };
  const payloads = zonePayloads(zone, density, cells);
  const changing = new Set<number>();
  let reason: string | null = null;
  const sent: ZoneCellsPayload[] = [];
  for (const payload of payloads) {
    const plan = planZoneCells(asState(city), payload);
    if (!plan.ok) {
      reason = plan.reason;
      continue;
    }
    // A part that would change nothing would be refused on its own, so it is not sent.
    sent.push(payload);
    for (const slot of plan.plan.cells) changing.add(slot);
  }
  if (changing.size === 0) return { ...base, ok: false, reason, cells: [], payloads: [] };
  const seen = new Set<number>();
  const shown = cells.filter((c) => changing.has(c.slot) && !seen.has(c.slot) && seen.add(c.slot));
  return { ...base, ok: true, reason: null, cells: shown, payloads: sent };
}

/** What the controller needs from the page. */
export interface ZoneToolHost {
  get(): RoadToolState & ZoneToolState & { zoningOverlay: boolean };
  set(patch: Partial<RoadToolState & ZoneToolState & { zoningOverlay: boolean }>): void;
  /** The mirror's copy of the city, or null before the first snapshot. */
  city(): City | null;
  /** Sends a `ZoneCells` and resolves with the sim's answer. */
  send(payload: ZoneCellsPayload): Promise<CommandResult>;
}

/** The zone tool's input handling. Holds no state of its own beyond a counter for ids and the overlay to put back. */
export class ZoneToolController {
  private readonly host: ZoneToolHost;
  private nextId = 1;
  /** Whether the overlay was on before the tool turned it on, so leaving puts it back. */
  private overlayBefore: boolean | null = null;

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

  /** Turns the tool on, with the zoning overlay, or off when it is on. A road being drawn is dropped. */
  toggle(): void {
    if (this.active()) {
      this.leave();
      return;
    }
    this.overlayBefore = this.host.get().zoningOverlay;
    this.host.set({ tool: "zone", zoningOverlay: true, zoneNote: null, zoneBrush: null, roadStart: null, roadControl: null, roadChain: 0, roadNote: null });
  }

  leave(): void {
    this.host.set({ tool: null });
    this.left();
  }

  /**
   * Call when the tool in the store changed. Once the zone tool is off,
   * however it was left, drops its stroke and puts the overlay back the
   * way it was before the tool opened.
   */
  toolChanged(now: string | null, before: string | null): void {
    if (before === "zone" && now !== "zone") this.left();
  }

  private left(): void {
    const patch: Partial<ZoneToolState & { zoningOverlay: boolean }> = { zoneBrush: null, zoneNote: null };
    if (this.overlayBefore === false) patch.zoningOverlay = false;
    this.overlayBefore = null;
    this.host.set(patch);
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
  targets(hover: ZoneHover): ZoneTarget[] {
    const city = this.host.city();
    const s = this.host.get();
    if (!this.active() || !city) return [];
    if (s.zoneBrush) return [...s.zoneBrush];
    const ground = hover.ground;
    if (s.zoneMode === "brush") {
      const cell = ground ? cellUnder(city, ground.x, ground.z) : null;
      return cell ? [cell] : [];
    }
    // Fill: the road under the pointer, or the road of the cell under it.
    if (hover.segment !== NONE && ground) {
      const side = nearerSide(city, hover.segment, ground.x, ground.z);
      return side === null ? [] : stripCells(city, hover.segment, side, s.zoneDepth);
    }
    const cell = ground ? cellUnder(city, ground.x, ground.z) : null;
    return cell ? stripCells(city, cell.segment, cell.side, s.zoneDepth) : [];
  }

  /** What the tool shows with the pointer over `hover`, or null when there is nothing to show. */
  preview(hover: ZoneHover): ZonePreview | null {
    const city = this.host.city();
    if (!this.active() || !city) return null;
    const cells = this.targets(hover);
    if (cells.length === 0) return null;
    const { zone, density } = this.paint();
    return previewZone(city, zone, density, cells);
  }

  /** A left click: paints what the preview shows, or sends nothing when nothing would change. */
  click(hover: ZoneHover): void {
    if (!this.active()) return;
    const preview = this.preview(hover);
    if (preview) this.sendIfOk(preview);
  }

  /** A brush drag started. */
  dragStart(): void {
    if (this.brushing()) this.host.set({ zoneBrush: [], zoneNote: null });
  }

  /** The brush passed over ground point (x, z): the open cell there joins the stroke. */
  brushOver(x: number, z: number): void {
    const s = this.host.get();
    const city = this.host.city();
    if (!this.brushing() || !s.zoneBrush || !city) return;
    const cell = cellUnder(city, x, z);
    if (!cell || s.zoneBrush.some((c) => c.slot === cell.slot)) return;
    this.host.set({ zoneBrush: [...s.zoneBrush, cell] });
  }

  /** The drag ended: paints every cell it passed over. */
  dragEnd(): void {
    const s = this.host.get();
    const city = this.host.city();
    const brush = s.zoneBrush;
    this.host.set({ zoneBrush: null });
    if (!this.brushing() || !city || !brush || brush.length === 0) return;
    const { zone, density } = this.paint();
    this.sendIfOk(previewZone(city, zone, density, brush));
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
    const pending: PendingZone = { id: this.nextId++, preview, waiting: preview.payloads.length, status: "sending" };
    this.host.set({ zoneNote: null, zonePending: [...this.host.get().zonePending, pending] });
    for (const payload of preview.payloads) {
      void this.host.send(payload).then((result) => this.answered(pending.id, result));
    }
  }

  private answered(id: number, result: CommandResult): void {
    const all = this.host.get().zonePending;
    const pending = all.find((p) => p.id === id);
    if (!pending) return;
    if (!result.ok) {
      this.host.set({ zonePending: all.filter((p) => p.id !== id), zoneNote: result.reason });
      return;
    }
    const waiting = pending.waiting - 1;
    const next: PendingZone = { ...pending, waiting, status: waiting === 0 ? "accepted" : "sending" };
    this.host.set({ zonePending: all.map((p) => (p.id === id ? next : p)) });
  }

  /**
   * Call on every mirror update. After a step, every command the sim had
   * accepted before it has been applied, so the cells it painted are in the
   * copy; a stroke whose commands were all accepted stops being drawn. A
   * snapshot replaces the copy, so it clears them too.
   */
  mirrorUpdated(update: { kind: "snapshot" } | { kind: "delta"; steps: number }): void {
    if (update.kind === "delta" && update.steps === 0) return;
    const pending = this.host.get().zonePending;
    if (pending.some((p) => p.status === "accepted")) {
      this.host.set({ zonePending: pending.filter((p) => p.status !== "accepted") });
    }
  }
}
