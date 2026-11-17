// Undo (issue 14): each player takes back their own road and zoning
// changes, newest first, while the result still makes sense.
//
// Every BuildRoad, BuildRoadGrid, BulldozeRoad and UpgradeRoad that applies leaves an undo
// record: the journal of network changes it made (roads/network.ts), tied to
// its log entry, with the zoning of any road it took away for good
// (zoning/zone-undo.ts). Every ZoneCells leaves one too, holding what each
// cell it painted held before (issue 111). Buildings never come back: the
// road and the zoning do, and the grower builds again. An `Undo` command finds its sender's newest record and runs
// the reverse of each change, last first. A segment or node the command
// removed and left removed is held under its id until then, so it comes back as it was, at
// the same place in its nodes' lists. Built and then undone with nothing in
// between, the network is byte for byte what it was before the build.
//
// The reverse is checked first on a copy of the few rows it touches, so an
// undo is applied whole or refused whole. It is refused when the network has
// moved on in a way it cannot follow: a road it would remove has been
// changed or bulldozed by someone else, another road now joins a junction it
// would remove, or a road it would put back would cross or touch one built
// since. A refused undo changes nothing and its record stays at the top of
// the player's history (PRD, "Undo").
//
// Each player keeps at most `undoSteps` records. Past that the oldest is
// forgotten and the ids it held go on the free list.
//
// `state.undo` is replaced, never changed in place, so a host can tell it
// changed by comparing references.

import type { SimState } from "./state";
import { noteFrontCells } from "./buildings/candidates";
import { noteCellsPainted } from "./zoning/cell-changes";
import { buildingsOnCells } from "./buildings/where";
import { CELL_KEY_STRIDE } from "./zoning/cell-changes";
import { laidOutCells, openCellsTakenBy, readyCells, restoreZones, syncCells, type ReturningSegment } from "./zoning/cell-index";
import { ZONING_BALANCE } from "./zoning/balance";
import { DENSITY_NONE, ZONE_NONE, localIndex } from "./zoning/cells";
import {
  ZONE_UNTOUCHED,
  checkJournals,
  isZoneValue,
  journalCells,
  journalFits,
  readJournals,
  type ZoneValue,
} from "./zoning/zone-undo";
import { ROAD_BUILD, ROAD_TYPES } from "./roads/balance";
import { hullBox, isStraight, quadsMeetAwayFrom, type Quad } from "./roads/curve";
import {
  LEVEL_COUNT,
  LEVEL_BRIDGE,
  NETWORK_PATH,
  NETWORK_ROAD,
  NONE,
  SEG_ALIVE,
  heldByOps,
  isNode,
  isSegment,
  nextSegmentAt,
  readSegment,
  releaseHeld,
  reverseOps,
  sameRow,
  type HeldIds,
  type NetworkOp,
  type RoadNetwork,
  type SegmentRow,
} from "./roads/network";
import { NETWORKS_ALL, roadIndexOf, segmentsInBox } from "./roads/spatial";

/** What one applied road command needs to be taken back. Plain data. */
export interface UndoRecord {
  /** Who sent the command. Only they can undo it. */
  playerId: string;
  /** Absolute index of the command's log entry. */
  entry: number;
  /** The command type, such as "BuildRoad". */
  type: string;
  /** Every change it made to the network, oldest first. Empty for a ZoneCells. */
  ops: NetworkOp[];
  /**
   * For a road command, the zoning of each segment it took away for good,
   * to give back with the segment. For a ZoneCells, what each cell it
   * painted held before. One flat array of journals: see zoning/zone-undo.ts.
   */
  zones: Int32Array;
  /** For a ZoneCells only: the zone and density it painted. */
  painted?: ZoneValue;
  /**
   * For a ZoneCells that is one part of a stroke too big for one command:
   * the stroke's id, the same on every part. One undo takes back the run of
   * the sender's newest records that share it (M2 review, #147).
   */
  stroke?: number;
}

/** The command type whose records hold a paint, not road changes. */
const ZONE_CELLS = "ZoneCells";

/** Most records each player keeps. */
export const UNDO_STEPS = ROAD_BUILD.undoSteps;

const NOTHING = "Nothing to undo";
const CHANGED = "Cannot undo: someone has changed or removed that road since";
const JOINED = "Cannot undo: another road now joins one of its junctions";
const IN_THE_WAY = "Cannot undo: a road built since is in the way";
const ROAD_GONE = "Cannot undo: someone has changed or removed a road those cells are on";
const REZONED = "Cannot undo: someone has rezoned those cells since";
const BUILT_ON = "Cannot undo: buildings now stand on ground that road would take back";

/** The ids a record holds: everything it removed and left removed, which waits for it to come back. */
export function heldBy(record: UndoRecord): HeldIds {
  return heldByOps(record.ops);
}

/** Every id the history holds, for checking a loaded network. */
export function heldIds(history: readonly UndoRecord[]): HeldIds {
  const nodes: number[] = [];
  const segs: number[] = [];
  for (const record of history) {
    const held = heldBy(record);
    nodes.push(...held.nodes);
    segs.push(...held.segs);
  }
  return { nodes, segs };
}

/** Frees what a forgotten record held, in ascending id order. */
function forget(net: RoadNetwork, record: UndoRecord): void {
  const held = heldBy(record);
  const ascending = (a: number, b: number) => a - b;
  releaseHeld(net, [...held.nodes].sort(ascending), [...held.segs].sort(ascending));
}

/**
 * Whether `later`, the next record of its player after `earlier`, is another
 * part of the same stroke: both ZoneCells with one stroke id, painting one
 * zone and density. Parts of one stroke paint cells no other part did, since
 * a part leaves alone cells that already hold what it paints, so they can be
 * taken back in any order (M2 review, #147).
 */
function sameStroke(earlier: UndoRecord, later: UndoRecord): boolean {
  return (
    later.stroke !== undefined &&
    earlier.stroke === later.stroke &&
    earlier.type === ZONE_CELLS &&
    later.type === ZONE_CELLS &&
    earlier.painted?.zone === later.painted?.zone &&
    earlier.painted?.density === later.painted?.density
  );
}

/**
 * `playerId`'s undo steps in `history`, oldest first, each the places of
 * its records, oldest first. A step is one record, or the run of parts of
 * one stroke, at most `UNDO_STEPS` of them, so a client that names one
 * stroke on every command still gets a bounded step (M2 review, #147).
 */
function playerSteps(history: readonly UndoRecord[], playerId: string): number[][] {
  const steps: number[][] = [];
  let last: UndoRecord | undefined;
  for (let i = 0; i < history.length; i++) {
    const record = history[i];
    if (record?.playerId !== playerId) continue;
    const current = steps[steps.length - 1];
    if (current && last && sameStroke(last, record) && current.length < UNDO_STEPS) current.push(i);
    else steps.push([i]);
    last = record;
  }
  return steps;
}

/**
 * Places in `history` of `playerId`'s newest step, newest first: the newest
 * record and, for a part of a stroke, the parts before it. Empty when the
 * player has nothing to undo.
 */
function newestStep(history: readonly UndoRecord[], playerId: string): number[] {
  return [...(playerSteps(history, playerId).at(-1) ?? [])].reverse();
}

/**
 * Adds a record for a command that just applied and forgets the player's
 * oldest steps past `UNDO_STEPS`. The parts of one stroke are one step.
 */
export function recordUndo(state: SimState, record: UndoRecord): void {
  const history = [...state.undo, record];
  const steps = playerSteps(history, record.playerId);
  const over = steps.length - UNDO_STEPS;
  if (over > 0) {
    // Forgets the oldest `over` steps, oldest record first.
    const goneIds = new Set(steps.slice(0, over).flat());
    for (const i of goneIds) forget(state.roads, history[i] as UndoRecord);
    state.undo = history.filter((_, i) => !goneIds.has(i));
    return;
  }
  state.undo = history;
}

/** Whether `playerId`'s next undo would put back roads its command removed, so it reads the cells (`takesBuiltGround`). */
export function undoPutsRoadsBack(state: SimState, playerId: string): boolean {
  const record = state.undo[newestStep(state.undo, playerId)[0] ?? -1];
  return record !== undefined && record.type !== ZONE_CELLS && returningSegments(state.roads, record.ops).back.length > 0;
}

/** Whether `playerId` has any record to undo, without checking it still applies. */
export function hasUndo(state: SimState, playerId: string): boolean {
  return state.undo.some((r) => r.playerId === playerId);
}

export type UndoPlanResult = { ok: true; index: number; indices: number[] } | { ok: false; reason: string };

/**
 * Checks that `playerId` has something to undo and that its reverse still
 * applies: its newest record, or every part of its newest stroke. `index`
 * is the newest record's place in `state.undo`, `indices` every record's,
 * newest first. Changes nothing.
 */
export function planUndo(state: SimState, playerId: string): UndoPlanResult {
  const indices = newestStep(state.undo, playerId);
  const index = indices[0] ?? -1;
  const record = state.undo[index];
  if (!record) return { ok: false, reason: NOTHING };
  if (record.type !== ZONE_CELLS) {
    const reason = rehearse(state.roads, record.ops) ?? takesBuiltGround(state, record.ops);
    return reason === null ? { ok: true, index, indices } : { ok: false, reason };
  }
  // The parts are taken back one after another, so they must not share a
  // cell: one that does, as when another player's command between two parts
  // changed a cell both painted, would find the cell changed by the time its
  // turn came and be skipped (M2 review, #147). Refused whole instead.
  const seen = new Set<number>();
  for (const i of indices) {
    const reason = checkPaint(state, state.undo[i] as UndoRecord);
    if (reason !== null) return { ok: false, reason };
    if (indices.length === 1) break;
    for (let k = 0; k < backCount; k++) {
      const slot = backSlots[k] ?? 0;
      if (seen.has(slot)) return { ok: false, reason: REZONED };
      seen.add(slot);
    }
  }
  return { ok: true, index, indices };
}

/** Applies a plan from `planUndo`: reverses each record's changes, newest first, and drops them from the history. */
export function applyUndo(state: SimState, indices: readonly number[]): void {
  for (const index of indices) {
    const record = state.undo[index];
    if (!record) continue;
    if (record.type === ZONE_CELLS) unpaint(state, record);
    else {
      // The cells must be laid out for the roads as they are before the
      // roads change back, so the next layout sees the segments come back.
      const zones = record.zones.length > 0;
      if (zones) readyCells(state);
      reverseOps(state.roads, record.ops);
      if (zones) restoreZones(state, record.zones);
    }
  }
  const gone = new Set(indices);
  state.undo = state.undo.filter((_, i) => !gone.has(i));
}

/**
 * The segments the reverse of `ops` puts back: each one the command
 * removed that it had not added itself first, and each one it changed to
 * another road type, as it was before, which can be wider. With the ids of
 * every segment the command touched, which the reverse removes or changes.
 */
function returningSegments(net: RoadNetwork, ops: readonly NetworkOp[]): { back: ReturningSegment[]; touched: Set<number> } {
  const touched = new Set<number>();
  const back: ReturningSegment[] = [];
  for (const op of ops) {
    if (op.op === "removeSeg" && !touched.has(op.id)) back.push({ id: op.id, row: op.row, ax: op.ax, az: op.az, bx: op.bx, bz: op.bz });
    if (op.op === "restyle" && op.from !== op.to && !touched.has(op.id) && isSegment(net, op.id)) {
      const row = readSegment(net, op.id);
      back.push({ id: op.id, row: { ...row, type: op.from }, ax: net.nodeX[row.a] ?? 0, az: net.nodeZ[row.a] ?? 0, bx: net.nodeX[row.b] ?? 0, bz: net.nodeZ[row.b] ?? 0 });
    }
    if (op.op === "addSeg" || op.op === "removeSeg" || op.op === "restyle") touched.add(op.id);
  }
  return { back, touched };
}

/**
 * Why putting back the roads `ops` removed would take ground buildings now
 * stand on, or null (M2 review, #147). A road that comes back is as old as
 * it was, so its cells win the ground back from any newer road's built
 * since, and its surface blocks what grew under it. With two players that
 * would clear another player's buildings without a word, so the undo is
 * refused instead. Buildings on the segments the undo removes go as for any
 * undo of a build. The cells must be settled: the step holds an Undo while
 * they settle (commands.ts).
 */
function takesBuiltGround(state: SimState, ops: readonly NetworkOp[]): string | null {
  const { back, touched } = returningSegments(state.roads, ops);
  if (back.length === 0) return null;
  const keys = openCellsTakenBy(syncCells(state), back, touched);
  return keys.length > 0 && buildingsOnCells(state, keys, CELL_KEY_STRIDE).length > 0 ? BUILT_ON : null;
}

// What an undo of a paint puts back: the slot of each cell and the zone
// and density it gets, gathered while the record is checked. Kept between
// undos, so taking back a stroke at the cap grows no lists (issue #155).
// Not state.
let backSlots = new Int32Array(1 << 12);
let backValues = new Uint8Array(2 << 12);
let backCount = 0;

/** Makes room for `more` cells after the ones gathered. */
function backRoom(more: number): void {
  if (backCount + more <= backSlots.length) return;
  let size = backSlots.length * 2;
  while (size < backCount + more) size *= 2;
  const slots = new Int32Array(size);
  slots.set(backSlots.subarray(0, backCount));
  const values = new Uint8Array(size * 2);
  values.set(backValues.subarray(0, backCount * 2));
  backSlots = slots;
  backValues = values;
}

/**
 * Gathers the slot in `state.cells` of each cell a ZoneCells record
 * changed, and what it held before, into the buffers above. Returns why
 * the record no longer applies, or null: a segment it painted is gone or
 * is not the road it was, or a cell no longer holds what it painted.
 */
function gatherPainted(state: SimState, record: UndoRecord): string | null {
  // The cells laid out for the roads as they are, which can replace `state.cells`.
  laidOutCells(state);
  const cells = state.cells;
  const painted = record.painted ?? { zone: ZONE_NONE, density: DENSITY_NONE };
  const zones = record.zones;
  const depth = ZONING_BALANCE.zoneDepthCells;
  backCount = 0;
  for (const journal of readJournals(zones)) {
    if (!journalFits(state.roads, journal)) return ROAD_GONE;
    const start = cells.offset[journal.seg] ?? 0;
    const count = (cells.offset[journal.seg + 1] ?? 0) - start;
    if (journalCells(zones, journal) !== count) return ROAD_GONE;
    backRoom(count);
    // The runs in the order they were written: side, depth, place along the road (zoning/zone-undo.ts).
    const places = count / (2 * depth);
    let at = journal.from;
    let left = zones[at] ?? 0;
    for (let side = 0; side < 2; side++) {
      for (let d = 0; d < depth; d++) {
        for (let place = 0; place < places; place++) {
          while (left === 0) {
            at += 3;
            if (at >= journal.to) return ROAD_GONE;
            left = zones[at] ?? 0;
          }
          left--;
          const zone = zones[at + 1] ?? 0;
          if (zone === ZONE_UNTOUCHED) continue;
          const slot = start + localIndex(side, place, d);
          if (cells.zone[slot] !== painted.zone || cells.density[slot] !== painted.density) return REZONED;
          backSlots[backCount] = slot;
          backValues[backCount * 2] = zone;
          backValues[backCount * 2 + 1] = zones[at + 2] ?? 0;
          backCount++;
        }
      }
    }
  }
  return null;
}

/** Why a ZoneCells record can no longer be undone, or null. */
function checkPaint(state: SimState, record: UndoRecord): string | null {
  return gatherPainted(state, record);
}

/** Puts back what a ZoneCells record's cells held. Only after `checkPaint` passed. */
function unpaint(state: SimState, record: UndoRecord): void {
  if (gatherPainted(state, record) !== null) return;
  const cells = state.cells;
  for (let i = 0; i < backCount; i++) {
    const slot = backSlots[i] ?? 0;
    cells.zone[slot] = backValues[i * 2] ?? ZONE_NONE;
    cells.density[slot] = backValues[i * 2 + 1] ?? DENSITY_NONE;
  }
  const slots = backSlots.subarray(0, backCount);
  noteCellsPainted(state.roads, cells, slots);
  noteFrontCells(state, slots);
}

/**
 * Runs the reverse of `ops` on an overlay of the rows it touches and returns
 * the first reason it cannot apply, or null.
 */
function rehearse(net: RoadNetwork, ops: readonly NetworkOp[]): string | null {
  // Rows the rehearsal changed: a segment's row, or null once it is gone; a
  // node's position, or null once it is gone.
  const segs = new Map<number, SegmentRow | null>();
  const nodes = new Map<number, { x: number; z: number } | null>();
  const segAt = (id: number): SegmentRow | null => {
    if (segs.has(id)) return segs.get(id) ?? null;
    return isSegment(net, id) ? readSegment(net, id) : null;
  };
  const nodeAt = (id: number): { x: number; z: number } | null => {
    if (nodes.has(id)) return nodes.get(id) ?? null;
    return isNode(net, id) ? { x: net.nodeX[id] ?? 0, z: net.nodeZ[id] ?? 0 } : null;
  };
  // Whether any segment joins `node` once the rehearsed changes are made. An
  // id in the node's list may since stand for something else, as when a
  // split's piece reused the id of the segment it came from.
  const touches = (node: number): boolean => {
    const ends = (row: SegmentRow | null) => row !== null && (row.a === node || row.b === node);
    for (let seg = net.nodeFirstSeg[node] ?? NONE; seg !== NONE; seg = nextSegmentAt(net, seg, node)) {
      if (ends(segAt(seg))) return true;
    }
    for (const row of segs.values()) if (ends(row)) return true;
    return false;
  };
  // Segments the rehearsal puts back: they stood together before, so they
  // are not checked against each other.
  const restored = new Set<number>();
  // Nodes the command added, which the undo takes away.
  const removedNodes = new Set<number>();
  for (const op of ops) if (op.op === "addNode") removedNodes.add(op.id);

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as NetworkOp;
    switch (op.op) {
      case "addNode":
        if (nodeAt(op.id) === null) return CHANGED;
        if (touches(op.id)) return JOINED;
        nodes.set(op.id, null);
        break;
      case "removeNode":
        nodes.set(op.id, { x: op.x, z: op.z });
        break;
      case "addSeg": {
        const row = segAt(op.id);
        if (row === null || !sameRow(row, op.row)) return CHANGED;
        segs.set(op.id, null);
        restored.delete(op.id);
        break;
      }
      case "removeSeg": {
        const a = nodeAt(op.row.a);
        const b = nodeAt(op.row.b);
        if (a === null || b === null) return CHANGED;
        // A node id is reused once its node is gone for good. The road goes
        // back only between the nodes it stood between.
        if (a.x !== op.ax || a.z !== op.az || b.x !== op.bx || b.z !== op.bz) return CHANGED;
        const shape: Quad = { ax: a.x, az: a.z, cx: op.row.cx, cz: op.row.cz, bx: b.x, bz: b.z };
        const other = blocking(net, shape, op.row, segAt, restored);
        if (other !== null) {
          // A road that joins a junction this undo would take away gets in
          // the way of what it puts back there: say which.
          return removedNodes.has(other.a) || removedNodes.has(other.b) ? JOINED : IN_THE_WAY;
        }
        segs.set(op.id, op.row);
        restored.add(op.id);
        break;
      }
      case "restyle": {
        const row = segAt(op.id);
        if (row === null || row.type !== op.to) return CHANGED;
        // A split leaves the id on one piece of the road: not the same road.
        if (row.a !== (op.reverse ? op.b : op.a) || row.b !== (op.reverse ? op.a : op.b)) return CHANGED;
        const back = { ...row, type: op.from };
        if (op.reverse) {
          back.a = row.b;
          back.b = row.a;
        }
        segs.set(op.id, back);
        break;
      }
    }
  }
  return null;
}

/**
 * A live segment that a segment put back with `shape` between nodes `row.a`
 * and `row.b` would meet anywhere but at a node they share, or null.
 */
function blocking(
  net: RoadNetwork,
  shape: Quad,
  row: SegmentRow,
  segAt: (id: number) => SegmentRow | null,
  restored: ReadonlySet<number>,
): SegmentRow | null {
  const box = hullBox(shape);
  for (const other of segmentsInBox(roadIndexOf(net), box.minX, box.minZ, box.maxX, box.maxZ, NETWORKS_ALL)) {
    if (restored.has(other)) continue;
    const live = segAt(other);
    if (live === null) continue;
    const shared: { x: number; z: number }[] = [];
    for (const node of [row.a, row.b]) {
      if (live.a === node || live.b === node) shared.push({ x: net.nodeX[node] ?? 0, z: net.nodeZ[node] ?? 0 });
    }
    const otherShape: Quad = {
      ax: net.nodeX[live.a] ?? 0,
      az: net.nodeZ[live.a] ?? 0,
      cx: live.cx,
      cz: live.cz,
      bx: net.nodeX[live.b] ?? 0,
      bz: net.nodeZ[live.b] ?? 0,
    };
    // Two straight segments that share a node meet only there.
    if (shared.length > 0 && isStraight(shape) && isStraight(otherShape)) continue;
    if (quadsMeetAwayFrom(shape, otherShape, shared)) return live;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isNumber = (v: unknown) => typeof v === "number";

const isRoadType = (v: unknown) => isId(v) && (v as number) < ROAD_TYPES.length;

function isRow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!["a", "b", "type", "network", "levelA", "levelB", "flags"].every((k) => isId(value[k]))) return false;
  if (!["cx", "cz", "length"].every((k) => isNumber(value[k]))) return false;
  if (!isId(value["order"])) return false;
  // The cell anchor, as `checkRoadNetwork` checks a live segment's.
  const anchor = value["anchor"];
  if (!isRecord(anchor)) return false;
  if (!["ax", "az", "cx", "cz", "bx", "bz", "tA", "tB"].every((k) => Number.isFinite(anchor[k]))) return false;
  if (!["tA", "tB"].every((k) => (anchor[k] as number) >= 0 && (anchor[k] as number) <= 1)) return false;
  if ((value["network"] as number) > NETWORK_PATH) return false;
  if ((value["levelA"] as number) >= LEVEL_COUNT || (value["levelB"] as number) >= LEVEL_COUNT) return false;
  if ((value["levelA"] === LEVEL_BRIDGE) !== (value["levelB"] === LEVEL_BRIDGE)) return false;
  if (value["network"] === NETWORK_ROAD && !isRoadType(value["type"])) return false;
  return value["a"] !== value["b"] && ((value["flags"] as number) & SEG_ALIVE) !== 0;
}

function isOp(value: unknown): boolean {
  if (!isRecord(value) || !isId(value["id"])) return false;
  switch (value["op"]) {
    case "addNode":
      return typeof value["grown"] === "boolean";
    case "removeNode":
      return ["x", "z", "height"].every((k) => isNumber(value[k])) && isId(value["flags"]);
    case "addSeg":
      return typeof value["grown"] === "boolean" && typeof value["fresh"] === "boolean" && isRow(value["row"]);
    case "removeSeg":
      return isRow(value["row"]) && isId(value["atA"]) && isId(value["atB"]) && ["ax", "az", "bx", "bz"].every((k) => isNumber(value[k]));
    case "restyle":
      return isRoadType(value["from"]) && isRoadType(value["to"]) && typeof value["reverse"] === "boolean" && isId(value["a"]) && isId(value["b"]);
    default:
      return false;
  }
}

function isRecordZones(record: Record<string, unknown>): boolean {
  const zones = record["zones"];
  if (record["type"] !== ZONE_CELLS) return record["painted"] === undefined && record["stroke"] === undefined && checkJournals(zones, false);
  const painted = record["painted"];
  if (!isRecord(painted) || !isZoneValue(painted["zone"], painted["density"])) return false;
  const stroke = record["stroke"];
  if (stroke !== undefined && !isId(stroke)) return false;
  return (record["ops"] as unknown[]).length === 0 && checkJournals(zones, true);
}

/** Why `value` is not an undo history, or null if it is. For loading a save. */
export function checkUndoHistory(value: unknown): string | null {
  if (!Array.isArray(value)) return "it is not a list";
  for (let i = 0; i < value.length; i++) {
    const record: unknown = value[i];
    if (
      !isRecord(record) ||
      typeof record["playerId"] !== "string" ||
      !isId(record["entry"]) ||
      typeof record["type"] !== "string" ||
      !Array.isArray(record["ops"]) ||
      !record["ops"].every(isOp) ||
      !isRecordZones(record)
    ) {
      return `record ${i} is malformed`;
    }
  }
  return null;
}

/**
 * How the undo history changed between two deltas (issue #155). The
 * history only changes by records added at the end and records dropped
 * from anywhere, and a record is never changed in place, so a copy that
 * held the history before needs only which of its records stay and the
 * new ones. Sending the whole history instead cost a host megabytes a
 * stroke once it held fifty strokes at the cap.
 */
export interface UndoDelta {
  /** Places in the history before of the records still in it, ascending. They come first, in this order. */
  kept: Int32Array;
  /** The records new since, after those, oldest first. */
  added: UndoRecord[];
}

/**
 * The change from history `before` to history `after`, by record identity:
 * the longest run at the start of `after` of records from `before`, in
 * their order there, and everything after that as new.
 */
export function diffUndo(before: readonly UndoRecord[], after: readonly UndoRecord[]): UndoDelta {
  const place = new Map<UndoRecord, number>();
  for (let i = 0; i < before.length; i++) place.set(before[i] as UndoRecord, i);
  const kept: number[] = [];
  let i = 0;
  for (; i < after.length; i++) {
    const at = place.get(after[i] as UndoRecord);
    if (at === undefined || (kept.length > 0 && at <= (kept[kept.length - 1] ?? -1))) break;
    kept.push(at);
  }
  return { kept: Int32Array.from(kept), added: after.slice(i) };
}

/** The history `delta` gives from `before`, or why it cannot belong to it. */
export function applyUndoDelta(before: readonly UndoRecord[], delta: UndoDelta): UndoRecord[] | string {
  const { kept, added } = delta;
  if (!(kept instanceof Int32Array) || !Array.isArray(added)) return "the undo delta is not a list of kept places and added records";
  const out: UndoRecord[] = [];
  for (let i = 0; i < kept.length; i++) {
    const at = kept[i] ?? -1;
    if (at < 0 || at >= before.length || (i > 0 && at <= (kept[i - 1] ?? -1))) return "the undo delta keeps a record the copy does not have";
    out.push(before[at] as UndoRecord);
  }
  for (const record of added) out.push(record);
  return out;
}
