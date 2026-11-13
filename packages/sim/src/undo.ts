// Undo (issue 14): each player takes back their own road changes, newest
// first, while the result still makes sense.
//
// Every BuildRoad, BulldozeRoad and UpgradeRoad that applies leaves an undo
// record: the journal of network changes it made (roads/network.ts), tied to
// its log entry. An `Undo` command finds its sender's newest record and runs
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
import { ROAD_BUILD, ROAD_TYPES } from "./roads/balance";
import { hullBox, isStraight, quadsMeetAwayFrom, type Quad } from "./roads/curve";
import {
  LEVEL_ELEVATED,
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
  restoreNode,
  restoreSegment,
  restyleSegment,
  sameRow,
  unaddNode,
  unaddSegment,
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
  /** Every change it made to the network, oldest first. */
  ops: NetworkOp[];
}

/** Most records each player keeps. */
export const UNDO_STEPS = ROAD_BUILD.undoSteps;

const NOTHING = "Nothing to undo";
const CHANGED = "Cannot undo: someone has changed or removed that road since";
const JOINED = "Cannot undo: another road now joins one of its junctions";
const IN_THE_WAY = "Cannot undo: a road built since is in the way";

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
 * Adds a record for a command that just applied and forgets the player's
 * oldest records past `UNDO_STEPS`.
 */
export function recordUndo(state: SimState, record: UndoRecord): void {
  const history = [...state.undo, record];
  let count = 0;
  for (const r of history) if (r.playerId === record.playerId) count++;
  while (count > UNDO_STEPS) {
    const oldest = history.findIndex((r) => r.playerId === record.playerId);
    const [gone] = history.splice(oldest, 1);
    if (gone) forget(state.roads, gone);
    count--;
  }
  state.undo = history;
}

/** Index in `state.undo` of the newest record `playerId` can undo, or -1. */
function newestRecord(history: readonly UndoRecord[], playerId: string): number {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]?.playerId === playerId) return i;
  return -1;
}

export type UndoPlanResult = { ok: true; index: number } | { ok: false; reason: string };

/**
 * Checks that `playerId` has something to undo and that its reverse still
 * applies. Changes nothing.
 */
export function planUndo(state: SimState, playerId: string): UndoPlanResult {
  const index = newestRecord(state.undo, playerId);
  const record = state.undo[index];
  if (!record) return { ok: false, reason: NOTHING };
  const reason = rehearse(state.roads, record.ops);
  return reason === null ? { ok: true, index } : { ok: false, reason };
}

/** Applies a plan from `planUndo`: reverses the record's changes and drops it from the history. */
export function applyUndo(state: SimState, index: number): void {
  const record = state.undo[index];
  if (!record) return;
  const net = state.roads;
  for (let i = record.ops.length - 1; i >= 0; i--) {
    const op = record.ops[i] as NetworkOp;
    switch (op.op) {
      case "addNode":
        unaddNode(net, op.id, op.grown);
        break;
      case "removeNode":
        restoreNode(net, op.id, op.x, op.z, op.height, op.flags);
        break;
      case "addSeg":
        unaddSegment(net, op.id, op.grown);
        break;
      case "removeSeg":
        restoreSegment(net, op.id, op.row, op.atA, op.atB);
        break;
      case "restyle":
        restyleSegment(net, op.id, op.from, op.reverse);
        break;
    }
  }
  state.undo = state.undo.filter((_, i) => i !== index);
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
  if (!["a", "b", "type", "network", "level", "flags"].every((k) => isId(value[k]))) return false;
  if (!["cx", "cz", "length"].every((k) => isNumber(value[k]))) return false;
  if ((value["network"] as number) > NETWORK_PATH || (value["level"] as number) > LEVEL_ELEVATED) return false;
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
      return typeof value["grown"] === "boolean" && isRow(value["row"]);
    case "removeSeg":
      return isRow(value["row"]) && isId(value["atA"]) && isId(value["atB"]);
    case "restyle":
      return isRoadType(value["from"]) && isRoadType(value["to"]) && typeof value["reverse"] === "boolean";
    default:
      return false;
  }
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
      !record["ops"].every(isOp)
    ) {
      return `record ${i} is malformed`;
    }
  }
  return null;
}
