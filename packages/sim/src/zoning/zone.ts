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

import { noteFrontCells } from "../buildings/candidates";
import { landmarkSlots } from "../buildings/landmarks";
import { DENSITY_UNLOCKS } from "../progression/balance";
import { lockNote } from "../progression/milestones";
import type { SimState } from "../state";
import { ZONING_BALANCE } from "./balance";
import { noteCellsPainted } from "./cell-changes";
import { forOpenCellsInBoxes, syncCells } from "./cell-index";
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
  /**
   * Optional. The same id on every command of a stroke too big for one, so
   * one undo takes back the whole stroke (M2 review, #147). A whole number,
   * 0 or more; the zone tool gives the seq of the stroke's first command.
   */
  stroke?: number;
}

/** The stroke id a ZoneCells payload carries, or undefined. Only for a payload `parse` accepted. */
export function strokeOf(payload: unknown): number | undefined {
  const stroke = isRecord(payload) ? payload["stroke"] : undefined;
  return typeof stroke === "number" ? stroke : undefined;
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
  const stroke = payload["stroke"];
  if (stroke !== undefined && !(Number.isSafeInteger(stroke) && (stroke as number) >= 0)) return "stroke must be a whole number, 0 or more";
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

// Scratch for the list, kept between commands so a stroke at the cap grows
// no list of its own (issue #155), and for the rectangles' boxes. Not state.
let found = new Int32Array(1 << 12);
let boxes = new Float64Array(4 * 64);

/**
 * Finds every cell the command would change: the open cells with their centre inside a rectangle
 * whose zone or density is not already the one asked for, and that no landmark stands on. The cells under
 * all the rectangles are read in one pass, so a cell under two is looked at
 * once and listed once (issue #204: a pass per rectangle read the buckets
 * where two meet twice).
 *
 * Returns how many cells; where each sits is left in the first that many
 * entries of `found`, in no order, until the next call. Each stroke used to
 * copy that list out twice, at submit and when it applied: about 60 MB an
 * hour of buffers in the soak (issue #209).
 */
function gather(state: SimState, parsed: Parsed): number {
  const index = syncCells(state);
  const cells = state.cells;
  const { zone, density, rects } = parsed;
  const count = rects.length / RECT_FLOATS;
  if (boxes.length < 4 * count) boxes = new Float64Array(4 * count);
  for (let r = 0; r < count; r++) {
    const at = r * RECT_FLOATS;
    const fx = rects[at] ?? 0;
    const fz = rects[at + 1] ?? 0;
    const dx = rects[at + 2] ?? 0;
    const dz = rects[at + 3] ?? 0;
    const half = rects[at + 4] ?? 0;
    // A box around the rectangle, a little generous: it only picks the
    // buckets to look in, and the test below decides.
    const length = Math.sqrt(dx * dx + dz * dz);
    const padX = (half * (dz < 0 ? -dz : dz)) / length + 1;
    const padZ = (half * (dx < 0 ? -dx : dx)) / length + 1;
    boxes[4 * r] = (dx < 0 ? fx + dx : fx) - padX;
    boxes[4 * r + 1] = (dz < 0 ? fz + dz : fz) - padZ;
    boxes[4 * r + 2] = (dx < 0 ? fx : fx + dx) + padX;
    boxes[4 * r + 3] = (dz < 0 ? fz : fz + dz) + padZ;
  }
  let n = 0;
  // A landmark's cells are out of the zoning while it stands (M4-13).
  const landmark = landmarkSlots(state);
  forOpenCellsInBoxes(
    index,
    cells,
    boxes,
    count,
    landmark.size === 0
      ? (slot) => cells.zone[slot] === zone && cells.density[slot] === density
      : (slot) => (cells.zone[slot] === zone && cells.density[slot] === density) || landmark.has(slot),
    (slot, x, z, hits, hitCount) => {
      for (let k = 0; k < hitCount; k++) {
        const at = (hits[k] ?? 0) * RECT_FLOATS;
        const px = x - (rects[at] ?? 0);
        const pz = z - (rects[at + 1] ?? 0);
        const dx = rects[at + 2] ?? 0;
        const dz = rects[at + 3] ?? 0;
        const half = rects[at + 4] ?? 0;
        const length2 = dx * dx + dz * dz;
        const along = px * dx + pz * dz;
        if (along < 0 || along > length2) continue;
        const across = px * dz - pz * dx;
        if (across * across > half * half * length2) continue;
        if (n === found.length) {
          const grown = new Int32Array(found.length * 2);
          grown.set(found);
          found = grown;
        }
        found[n++] = slot;
        return;
      }
    },
  );
  return n;
}

/** The cells `gather` found, ascending, as a view on its scratch: read it before the next `gather`. */
function gathered(count: number): Int32Array {
  return found.subarray(0, count).sort();
}

/**
 * Why `state` refuses to paint `parsed`'s density, or null: a density whose
 * milestone the city has not reached is locked (M4-12). Clearing and
 * density 1 are never locked. A lock stops only new painting: cells zoned
 * at a locked density already keep growing, so a city loaded from before
 * the milestones loses nothing.
 */
function lockReason(state: SimState, parsed: Parsed): string | null {
  if (parsed.zone === ZONE_NONE) return null;
  const unlock = DENSITY_UNLOCKS[parsed.density];
  return unlock === undefined ? null : lockNote(state, unlock);
}

const NOTHING = "no cell would change: nothing open lies under the rectangles, or it is zoned this way already";

/** Why a ZoneCells payload is refused whatever the city holds, or null. Reads no cells. */
export function checkZoneCellsPayload(payload: unknown): string | null {
  const parsed = parse(payload);
  return typeof parsed === "string" ? parsed : null;
}

/**
 * What a ZoneCells command with this payload would do to `state`, or why it
 * would be refused. Changes nothing a player set. For the zone tool's
 * preview on the client's copy of the city.
 */
export function planZoneCells(state: SimState, payload: unknown): ZonePlanResult {
  const parsed = parse(payload);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  const locked = lockReason(state, parsed);
  if (locked !== null) return { ok: false, reason: locked };
  const count = gather(state, parsed);
  if (count === 0) return { ok: false, reason: NOTHING };
  return { ok: true, plan: { zone: parsed.zone, density: parsed.density, cells: gathered(count).slice() } };
}

/**
 * Why a ZoneCells command with this payload would be refused by `state`,
 * or null: what `planZoneCells` says, without the list of cells. For the
 * check at submit, which needs only whether any cell would change.
 */
export function checkZoneCells(state: SimState, payload: unknown): string | null {
  const parsed = parse(payload);
  if (typeof parsed === "string") return parsed;
  const locked = lockReason(state, parsed);
  if (locked !== null) return locked;
  return gather(state, parsed) === 0 ? NOTHING : null;
}

/**
 * Plans and paints in one pass, as the step does: null once painted, or the
 * reason, with the city as it was. Refuses exactly what `planZoneCells`
 * refuses and changes exactly the cells it lists. `before`, when given, is
 * called with the cells it is about to paint, ascending, and the zone and
 * density they get, while they still hold what they had, for the undo
 * record. The cells are a view on scratch that the next stroke writes over,
 * so `before` must not keep it.
 */
export function zoneCellsIfValid(
  state: SimState,
  payload: unknown,
  before?: (slots: Int32Array, zone: number, density: number) => void,
): string | null {
  const parsed = parse(payload);
  if (typeof parsed === "string") return parsed;
  const locked = lockReason(state, parsed);
  if (locked !== null) return locked;
  const count = gather(state, parsed);
  if (count === 0) return NOTHING;
  const slots = gathered(count);
  before?.(slots, parsed.zone, parsed.density);
  const { zone, density } = state.cells;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] ?? 0;
    zone[slot] = parsed.zone;
    density[slot] = parsed.density;
  }
  noteCellsPainted(state.roads, state.cells, slots);
  noteFrontCells(state, slots);
  return null;
}
