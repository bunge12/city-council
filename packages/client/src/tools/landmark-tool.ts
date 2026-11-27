// The landmark tool (M4-17, PRD "Landmarks"). A player places City Hall, and
// later the other landmarks, on a lot along a road.
//
// Hover a road, or a cell beside one: the lot shows on the side the pointer
// is, its middle under the pointer, in green where the sim would take it
// and red where it would not, with the price and, when it is refused or the
// treasury cannot pay, the reason. A click sends `PlaceLandmark`.
//
// What the tool shows is `planPlaceLandmark`, the function the sim checks
// the command with, run on the mirror's copy: the footprint, the price and
// the reason. A lot the treasury cannot pay is still sent, so the sim
// refuses it and the page plays its "rejected" cue, as the road tool's
// roads are; a lot the sim would refuse whatever the treasury holds sends
// nothing. A lot the sim refuses has no footprint of its own, so the
// tool draws the cells of the hovered strip the lot would take, as far as
// that strip has them. The landmark is unique, so once one stands its
// button stays pressed only until the delta that brings it, and the tool
// leaves. Tool state lives in the UI store (ui/store.ts); nothing here
// writes sim state.

import {
  LANDMARKS,
  NONE,
  ZONING_BALANCE,
  cellAt,
  cellCorners,
  lockNote,
  placesAlong,
  type CommandResult,
  type LandmarkPlanResult,
  type PlaceLandmarkPayload,
  type RoadNetwork,
  type SimState,
  type Unlock,
} from "@city-council/sim";
import type { ReadonlyDeep } from "../protocol/mirror";
import type { RoadToolState } from "./road-tool";
import { targetOfSlot } from "./zone-tool";

/** A cell of a landmark's lot as the tool draws it: its corners, x0, z0, ..., x3, z3. */
export interface LotCell {
  corners: readonly number[];
}

/** What a click would do now, from `planPlaceLandmark`. */
export interface LandmarkPreview {
  /** The landmark's id in economy.json and its name. */
  landmark: string;
  name: string;
  payload: PlaceLandmarkPayload;
  /** Whether the sim would take the lot, the treasury apart. */
  ok: boolean;
  /** Whole dollars it costs, from the plan; the landmark's price when refused. */
  price: number;
  /** Why the treasury cannot pay, when the lot is fine. */
  refusal: string | null;
  /** Why the sim refuses the lot, or null. */
  reason: string | null;
  /** The lot's cells, the plan's own when it passed. */
  cells: readonly LotCell[];
}

/** A landmark sent and not yet in the copy. */
export interface PendingLandmark {
  id: number;
  preview: LandmarkPreview;
}

/** The landmark tool's part of the UI store. */
export interface LandmarkToolState {
  /** The landmark picked, an id from economy.json's `landmarks`. */
  landmarkPick: string;
  landmarkPending: readonly PendingLandmark[];
  /** The last refusal from the sim, or why a click sent nothing. */
  landmarkNote: string | null;
}

export const INITIAL_LANDMARK_TOOL: LandmarkToolState = {
  landmarkPick: LANDMARKS[0]?.id ?? "cityHall",
  landmarkPending: [],
  landmarkNote: null,
};

/** What the pointer is over, worked out by the page each frame. */
export interface LandmarkHover {
  ground: { x: number; z: number } | null;
  /** The road segment the pointer is over, as the bulldozer picks it, or NONE. */
  segment: number;
}

type City = ReadonlyDeep<SimState>;

function asState(city: City): SimState {
  return city as unknown as SimState;
}

/** Where a road-edge cell is: its side and place along the segment, and its centre. */
interface EdgeCell {
  side: number;
  place: number;
  x: number;
  z: number;
}

/** The centre of the cell named this way, or null when there is none. */
function centreOf(city: City, segment: number, side: number, place: number, depth: number): { x: number; z: number; corners: number[] } | null {
  const c = cellCorners(asState(city), { segment, side, place, depth });
  if (!c) return null;
  return { x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4, z: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4, corners: Array.from(c) };
}

/** Every road-edge cell of `segment`, both sides. */
export function edgeCells(city: City, segment: number): EdgeCell[] {
  const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
  const out: EdgeCell[] = [];
  for (let place = 0; place < places; place++) {
    for (const side of [0, 1]) {
      const c = centreOf(city, segment, side, place, 0);
      if (c) out.push({ side, place, x: c.x, z: c.z });
    }
  }
  return out;
}

/**
 * Where a lot `width` cells along the road starts with the pointer at
 * (x, z) over segment `segment`: on the side the pointer is, its middle on
 * the place nearest the pointer, kept on the segment where it is long
 * enough. Null when the segment has no cells.
 */
export function lotStartAt(city: City, segment: number, x: number, z: number, width: number, edge = edgeCells(city, segment)): { side: number; place: number } | null {
  let best: EdgeCell | null = null;
  let bestD = Infinity;
  for (const c of edge) {
    const d = (c.x - x) ** 2 + (c.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (!best) return null;
  const places = placesAlong(city.roads as unknown as RoadNetwork, segment);
  const start = best.place - Math.floor((width - 1) / 2);
  return { side: best.side, place: Math.max(0, Math.min(Math.max(0, places - width), start)) };
}

/** The cells of a lot on its own segment's strip, as far as the strip has them: what a refused lot is drawn as. */
function stripLot(city: City, p: PlaceLandmarkPayload, width: number, depth: number): LotCell[] {
  const out: LotCell[] = [];
  const places = placesAlong(city.roads as unknown as RoadNetwork, p.segment);
  for (let k = 0; k < width; k++) {
    const place = p.dir === 1 ? p.place - k : p.place + k;
    if (place < 0 || place >= places) continue;
    for (let d = 0; d < Math.min(depth, ZONING_BALANCE.zoneDepthCells); d++) {
      const c = centreOf(city, p.segment, p.side, place, d);
      if (c) out.push({ corners: c.corners });
    }
  }
  return out;
}

/** What placing landmark `id` with `payload` would do, from the plan the sim gives (`plan`). */
export function previewLandmark(city: City, id: string, payload: PlaceLandmarkPayload, plan: LandmarkPlanResult): LandmarkPreview {
  const kind = LANDMARKS.find((l) => l.id === id);
  const name = kind?.name ?? id;
  if (!plan.ok) return { landmark: id, name, payload, ok: false, price: kind?.price ?? 0, refusal: null, reason: plan.reason, cells: kind ? stripLot(city, payload, kind.width, kind.depth) : [] };
  const cells = plan.plan.slots.flatMap((slot) => {
    const t = targetOfSlot(city, slot);
    return t ? [{ corners: t.corners }] : [];
  });
  return { landmark: id, name, payload, ok: true, price: plan.plan.price, refusal: plan.plan.refusal, reason: null, cells };
}

/** What the controller needs from the page. */
export interface LandmarkToolHost {
  get(): RoadToolState & LandmarkToolState;
  set(patch: Partial<RoadToolState & LandmarkToolState>): void;
  city(): City | null;
  /** A number that changes whenever the copy's roads, cells or buildings do. */
  version(): number;
  /** The sim's plan for `payload` on the copy. */
  plan(payload: PlaceLandmarkPayload): LandmarkPlanResult;
  send(payload: PlaceLandmarkPayload): Promise<CommandResult>;
}

/** The landmark tool's input handling. Holds nothing but caches of what it worked out from the copy. */
export class LandmarkToolController {
  private readonly host: LandmarkToolHost;
  private nextId = 1;
  private edge: { key: string; cells: EdgeCell[] } = { key: "", cells: [] };
  private memo: { key: string; preview: LandmarkPreview | null } = { key: "", preview: null };

  constructor(host: LandmarkToolHost) {
    this.host = host;
  }

  active(): boolean {
    return this.host.get().tool === "landmark";
  }

  /** Why the landmark picked cannot be placed yet, or null: the milestone that opens it. Null before the first snapshot. */
  lock(): string | null {
    const kind = LANDMARKS.find((l) => l.id === this.host.get().landmarkPick);
    const city = this.host.city();
    return !kind || city === null ? null : lockNote(city, kind.unlock as Unlock);
  }

  /** Turns the tool on, unless the landmark is locked, or off when it is on. A road being drawn is dropped. */
  toggle(): void {
    if (this.active()) {
      this.leave();
      return;
    }
    if (this.lock() !== null) return;
    this.host.set({ tool: "landmark", landmarkNote: null, roadStart: null, roadControl: null, roadChain: 0, roadNote: null });
  }

  leave(): void {
    this.host.set({ tool: null, landmarkNote: null });
  }

  /** Escape: leaves the tool. Returns whether it was on. */
  escape(): boolean {
    if (!this.active()) return false;
    this.leave();
    return true;
  }

  /** The payload a click would send with the pointer over `hover`, or null when it is over no road or cell. */
  payloadAt(hover: LandmarkHover): PlaceLandmarkPayload | null {
    const city = this.host.city();
    const kind = LANDMARKS.find((l) => l.id === this.host.get().landmarkPick);
    if (!this.active() || !city || !kind || !hover.ground) return null;
    let segment = hover.segment;
    if (segment === NONE) {
      // Over a cell: its road, as the zone tool's fill takes it.
      const cell = cellAt(asState(city), hover.ground.x, hover.ground.z);
      if (!cell) return null;
      segment = cell.segment;
    }
    const key = `${this.host.version()},${segment}`;
    if (key !== this.edge.key) this.edge = { key, cells: edgeCells(city, segment) };
    const start = lotStartAt(city, segment, hover.ground.x, hover.ground.z, kind.width, this.edge.cells);
    return start ? { landmark: kind.id, segment, side: start.side, place: start.place } : null;
  }

  /** What the tool shows with the pointer over `hover`, or null. The treasury moves every tick, so `money` is part of the key. */
  preview(hover: LandmarkHover, money = 0): LandmarkPreview | null {
    const city = this.host.city();
    const payload = this.payloadAt(hover);
    if (!city || !payload) return null;
    const key = `${this.host.version()},${money},${payload.landmark},${payload.segment},${payload.side},${payload.place},${this.host.get().landmarkPending.length}`;
    if (key !== this.memo.key) {
      const preview = previewLandmark(city, payload.landmark, payload, this.host.plan(payload));
      this.memo = { key, preview: this.host.get().landmarkPending.length > 0 && preview.ok ? { ...preview, ok: false, reason: `${preview.name} is being built already` } : preview };
    }
    return this.memo.preview;
  }

  /** A left click: places the landmark the preview shows, or says why not. */
  click(hover: LandmarkHover, money = 0): void {
    if (!this.active()) return;
    const preview = this.preview(hover, money);
    if (!preview) return;
    if (preview.reason !== null) {
      this.host.set({ landmarkNote: preview.reason });
      return;
    }
    const pending: PendingLandmark = { id: this.nextId++, preview };
    this.host.set({ landmarkNote: null, landmarkPending: [...this.host.get().landmarkPending, pending] });
    void this.host.send(preview.payload).then((result) => {
      const left = this.host.get().landmarkPending.filter((p) => p.id !== pending.id);
      // One of a kind: once it stands, the tool has nothing left to place.
      if (result.ok) this.host.set({ landmarkPending: left, ...(this.active() ? { tool: null } : {}), landmarkNote: null });
      else this.host.set({ landmarkPending: left, landmarkNote: result.reason });
    });
  }
}
