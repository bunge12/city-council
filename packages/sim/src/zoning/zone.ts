// The ZoneCells command (M2-04, PRD "M2 Zoning and buildings").
//
// A player paints a zone and a density on cells, or clears them. The
// command names ground, not cells: a list of rectangles in world metres.
// Every open cell whose centre lies inside one of them, edges included, is
// painted. So a command sent before another player's road split or removed
// a segment still paints the cells that are on that ground when it applies
// (issue #94).
//
// A rectangle is given as the line down its middle, `from` to `to`, and its
// `width` across that line. The line carries the angle, so the sim needs no
// trigonometry to turn it (CLAUDE.md rule 6): a centre is inside when its
// projection on the line falls between the ends and its distance from the
// line is at most half the width, both compared as squares.
//
// Whether a cell is open is derived from the roads and the terrain
// (cell-index.ts). The command settles any walk still under way before it
// reads that, as every query does, so what it paints follows from the roads
// alone and never from how far a walk had got.

import type { SimState } from "../state";
import { ZONING_BALANCE } from "./balance";
import { noteCellsPainted } from "./cell-changes";
import { forOpenCellsInBox, syncCells } from "./cell-index";
import { DENSITY_NONE, ZONE_NONE } from "./cells";

/** The `zone` of a ZoneCells that clears cells. */
export const ZONE_CLEAR = "none";

/** A point on the ground, metres. */
export interface ZonePoint {
  x: number;
  z: number;
}

/** A rectangle of ground: `width` metres across the line from `from` to `to`, half on each side. */
export interface ZoneRect {
  from: ZonePoint;
  to: ZonePoint;
  width: number;
}

/** What a ZoneCells command carries. */
export interface ZoneCellsPayload {
  /** A zone id from `zoning.json`, or "none" to clear. */
  zone: string;
  /** 1, 2 or 3. Left out, or ignored, when `zone` is "none". */
  density?: number;
  /** At most `maxRectsPerCommand`, each side at most `maxRectSide`. */
  rects: ZoneRect[];
}

/** What a ZoneCells command would do. */
export interface ZonePlan {
  /** The zone every changed cell gets, as `state.cells.zone` holds it: ZONE_NONE or 1 plus the zone's place in `zoning.json`. */
  zone: number;
  /** The density every changed cell gets: DENSITY_NONE or 1 to 3. */
  density: number;
  /** Where each cell that would change sits in `state.cells.zone` and `state.cells.density`, ascending. Never empty. */
  cells: Int32Array;
}

export type ZonePlanResult = { ok: true; plan: ZonePlan } | { ok: false; reason: string };

/** Numbers per rectangle once parsed: from x and z, the line's dx and dz, half the width. */
const RECT_FLOATS = 5;

interface Parsed {
  zone: number;
  density: number;
  rects: Float64Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointOf(value: unknown): ZonePoint | null {
  if (!isRecord(value)) return null;
  const { x, z } = value;
  return typeof x === "number" && typeof z === "number" && Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

/** The payload as numbers, or why it is refused whatever the city holds. */
function parse(payload: unknown): Parsed | string {
  if (!isRecord(payload)) return "ZoneCells payload must be an object";
  const zoneId = payload["zone"];
  const zoneAt = ZONING_BALANCE.zones.findIndex((z) => z.id === zoneId);
  if (zoneId !== ZONE_CLEAR && zoneAt < 0) {
    return `unknown zone ${JSON.stringify(zoneId)}: it must be one of ${ZONING_BALANCE.zones.map((z) => z.id).join(", ")} or ${ZONE_CLEAR}`;
  }
  const level = payload["density"];
  const known = ZONING_BALANCE.densities.some((d) => d.level === level);
  // Clearing needs no density, but one that is given must still be real.
  if (!known && !(zoneId === ZONE_CLEAR && level === undefined)) {
    return `unknown density ${JSON.stringify(level)}: it must be one of ${ZONING_BALANCE.densities.map((d) => d.level).join(", ")}`;
  }
  const list = payload["rects"];
  if (!Array.isArray(list) || list.length === 0) return "rects must be a list of at least one rectangle";
  const most = ZONING_BALANCE.maxRectsPerCommand;
  if (list.length > most) return `too many rectangles: ${list.length}, and one command takes at most ${most}`;
  const side = ZONING_BALANCE.maxRectSide;
  const rects = new Float64Array(list.length * RECT_FLOATS);
  for (let i = 0; i < list.length; i++) {
    const rect: unknown = list[i];
    const from = isRecord(rect) ? pointOf(rect["from"]) : null;
    const to = isRecord(rect) ? pointOf(rect["to"]) : null;
    const width = isRecord(rect) ? rect["width"] : undefined;
    if (!from || !to) return `rects[${i}] needs a from and a to, each with a finite x and z`;
    if (typeof width !== "number" || !(width > 0)) return `rects[${i}].width must be a positive number of metres`;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length2 = dx * dx + dz * dz;
    if (!(length2 > 0)) return `rects[${i}] has no length: its from and to are the same point`;
    if (!(length2 <= side * side) || !(width <= side)) return `rects[${i}] is too big: each side may be at most ${side} m`;
    rects.set([from.x, from.z, dx, dz, width / 2], i * RECT_FLOATS);
  }
  return zoneId === ZONE_CLEAR ? { zone: ZONE_NONE, density: DENSITY_NONE, rects } : { zone: zoneAt + 1, density: level as number, rects };
}

// Scratch, one byte per cell: set while a cell is on the list being
// gathered, so a cell under two rectangles is listed once. Cleared again
// before `gather` returns. Not state.
let listed = new Uint8Array(0);

/**
 * Where every cell the command would change sits in the zone and density
 * arrays, in no order a caller may rely on: the open cells with their
 * centre inside a rectangle whose zone or density is not already the one
 * asked for.
 */
function gather(state: SimState, parsed: Parsed): number[] {
  const index = syncCells(state);
  const cells = state.cells;
  const { zone, density, rects } = parsed;
  if (listed.length < cells.zone.length) listed = new Uint8Array(cells.zone.length);
  const marks = listed;
  const out: number[] = [];
  for (let at = 0; at < rects.length; at += RECT_FLOATS) {
    const fx = rects[at] ?? 0;
    const fz = rects[at + 1] ?? 0;
    const dx = rects[at + 2] ?? 0;
    const dz = rects[at + 3] ?? 0;
    const half = rects[at + 4] ?? 0;
    const length2 = dx * dx + dz * dz;
    const reach2 = half * half * length2;
    // A box around the rectangle, a little generous: it only picks the
    // buckets to look in, and the test below decides.
    const length = Math.sqrt(length2);
    const padX = (half * (dz < 0 ? -dz : dz)) / length + 1;
    const padZ = (half * (dx < 0 ? -dx : dx)) / length + 1;
    const minX = (dx < 0 ? fx + dx : fx) - padX;
    const maxX = (dx < 0 ? fx : fx + dx) + padX;
    const minZ = (dz < 0 ? fz + dz : fz) - padZ;
    const maxZ = (dz < 0 ? fz : fz + dz) + padZ;
    forOpenCellsInBox(index, cells, minX, minZ, maxX, maxZ, (slot, x, z) => {
      if (cells.zone[slot] === zone && cells.density[slot] === density) return;
      if (marks[slot] === 1) return;
      const px = x - fx;
      const pz = z - fz;
      const along = px * dx + pz * dz;
      if (along < 0 || along > length2) return;
      const across = px * dz - pz * dx;
      if (across * across > reach2) return;
      marks[slot] = 1;
      out.push(slot);
    });
  }
  for (const slot of out) marks[slot] = 0;
  return out;
}

const NOTHING = "no cell would change: nothing open lies under the rectangles, or it is zoned this way already";

/**
 * What a ZoneCells command with this payload would do to `state`, or why it
 * would be refused. Changes nothing a player set. For the command itself
 * and for the zone tool's preview on the client's copy of the city.
 */
export function planZoneCells(state: SimState, payload: unknown): ZonePlanResult {
  const parsed = parse(payload);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  const slots = gather(state, parsed);
  if (slots.length === 0) return { ok: false, reason: NOTHING };
  return { ok: true, plan: { zone: parsed.zone, density: parsed.density, cells: Int32Array.from(slots).sort() } };
}

/**
 * Plans and paints in one pass, as the step does: null once painted, or the
 * reason, with the city as it was. Refuses exactly what `planZoneCells`
 * refuses and changes exactly the cells it lists.
 */
export function zoneCellsIfValid(state: SimState, payload: unknown): string | null {
  const parsed = parse(payload);
  if (typeof parsed === "string") return parsed;
  const slots = gather(state, parsed);
  if (slots.length === 0) return NOTHING;
  const { zone, density } = state.cells;
  for (const slot of slots) {
    zone[slot] = parsed.zone;
    density[slot] = parsed.density;
  }
  noteCellsPainted(state.roads, state.cells, slots);
  return null;
}
