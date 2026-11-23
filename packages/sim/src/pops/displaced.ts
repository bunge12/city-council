// Displaced pops (M3-12, PRD "Removing things" and "Rezoning").
//
// Removing a home, by `BulldozeBuilding`, by a road built through it, by
// `BulldozeRoad` or by redevelopment, displaces its pops: each loses its
// home and joins the queue in state, `pops.displaced` (pops.ts). It keeps
// its job, unless that went too, and it still counts in the population.
//
// The DISPLACED system places them, first in line first, up to
// `displacedPerTick` in pops.json a tick. It runs in the step that removed
// the buildings, after the commands, so a removal of no more than that
// many pops is settled before the tick ends. The rest wait for the ticks
// after. While the game is paused no system runs, so they wait until it
// goes on.
//
// A displaced pop with a job takes free room in a home on the same piece
// of road as its workplace (roads/outside.ts), so it can still reach it,
// and keeps the job. If no such home has room for it, or it has no job, it
// takes free room in a home whose road reaches an outside connection, as a
// newcomer would (room.ts), and loses any job it had. If none has room it
// leaves the city and counts as a departure.
//
// A pop moves whole: a home takes it only with room for all its people,
// within the size cap of the home's density, and a single family home only
// while nobody lives there. A tower's pop of 100 finds room only in
// another tower. Among the homes that take it, one is drawn from the
// generator in state, each as likely.
//
// The relocation payment, the satisfaction hit and the record of each
// expropriation are M4's.

import { BUILDING_TYPES } from "../buildings/balance";
import { BUILDING_ABANDONED, BUILDING_ALIVE } from "../buildings/buildings";
import { nextInt } from "../rng";
import { NETWORK_ROAD } from "../roads/network";
import { NO_PIECE, outsideReachByNode, roadPieceByNode } from "../roads/outside";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteYear } from "../stats/stats";
import { POPS_BALANCE } from "./balance";
import { NO_WORK, popSizeCap, rehomePop, removeHomelessPops, setPopWork } from "./pops";
import { popIndexOf } from "./where";

/** The name the timer hook reports for placing displaced pops. */
export const DISPLACED_SYSTEM = "displaced";

/** By type index: 1 for a type one household lives in. */
const ONE_HOUSEHOLD = Uint8Array.from(BUILDING_TYPES, (t) => (t.oneHousehold ? 1 : 0));

/** By type index: the most people one pop may hold in a home of that type. */
const SIZE_CAP = Int32Array.from(BUILDING_TYPES, (t) => popSizeCap(t.density));

/** The most room for one pop any home can have: the largest size cap. */
const MOST_ROOM = SIZE_CAP.reduce((a, b) => Math.max(a, b), 1);

/** Room classes: a home is filed under the room it has for one pop, from 1 to MOST_ROOM. */
const ROOMS = MOST_ROOM + 1;

/**
 * The homes with room for one more pop as a tick's placing starts, kept
 * current as pops move in. Scratch, not state, and worked out from state
 * alone each tick, so the order of every list is the same on every
 * machine and after a load.
 *
 * Homes are filed in groups: group 0 holds the homes whose road reaches an
 * outside connection, and each piece of road with homes on it has a group
 * of its own, numbered from 1 in the order the scan meets them. Within a
 * group, a bucket holds the homes with the same room for one pop, so a pop
 * of `s` draws among the buckets from `s` up and a draw costs the size
 * caps, not the homes. A bucket is a run of `order` from `start`, of
 * `count` homes, filed by one counting pass over the buildings; a home
 * whose room falls as a pop moves in goes to a short list of its new
 * bucket's (`extra`), since the runs cannot grow.
 */
interface Finder {
  state: SimState;
  pieces: Int32Array;
  /** By road node: its piece's group. Read only where `stampOfNode` is `stamp`, for a piece that has a home with room. */
  groupOfNode: Int32Array;
  stampOfNode: Int32Array;
  stamp: number;
  /** By building: the room it is filed under. Read only for a filed home. */
  room: Int32Array;
  /** By building: its piece's group. Read only for a filed home. */
  group: Int32Array;
  /**
   * By building: where it is in its piece's group's bucket, and in group
   * 0's: a place in `order`, or -(i + 2) for place i in the bucket's
   * `extra`, or -1 for not filed there. Read only for a filed home.
   */
  atPiece: Int32Array;
  atOutside: Int32Array;
  /** By group times ROOMS plus room: the bucket's first place in `order`, its homes there, and its homes in `extra`. */
  start: Int32Array;
  count: Int32Array;
  extraCount: Int32Array;
  extra: Map<number, number[]>;
  order: Int32Array;
}

/** The piece of road live building `id` stands on, or NO_PIECE. */
function pieceOf(state: SimState, pieces: Int32Array, id: number): number {
  const net = state.roads;
  const seg = state.buildings.firstSeg[id] ?? -1;
  if (net.segNetwork[seg] !== NETWORK_ROAD) return NO_PIECE;
  return pieces[net.segA[seg] ?? -1] ?? NO_PIECE;
}

/** The people live home `id` may still take as one pop: its room left within its size cap, none for a single family home anyone lives in. */
function roomForOnePop(state: SimState, people: Int32Array, id: number): number {
  const b = state.buildings;
  const t = b.type[id] ?? 0;
  const living = people[id] ?? 0;
  if (living > 0 && ONE_HOUSEHOLD[t] === 1) return 0;
  const left = (b.residents[id] ?? 0) - living;
  return Math.max(0, Math.min(left, SIZE_CAP[t] ?? 1));
}

/** The by-building and by-node arrays a Finder writes, kept from one tick to the next so a drain makes little garbage on a big city. Every entry a tick reads, it wrote that tick. */
interface Scratch {
  room: Int32Array;
  group: Int32Array;
  atPiece: Int32Array;
  atOutside: Int32Array;
  order: Int32Array;
  /** The homes pass 1 filed, in id order. */
  homes: Int32Array;
  groupOfNode: Int32Array;
  /** By road node: the pass that last gave its piece a group, so `groupOfNode` needs no clearing. */
  stampOfNode: Int32Array;
}

let scratch: Scratch | null = null;
/** Counts the passes that use `stampOfNode`. */
let pass = 0;

function scratchFor(buildings: number, nodes: number): Scratch {
  if (!scratch || scratch.room.length < buildings) {
    const n = Math.max(buildings, 64);
    const was: Scratch | null = scratch;
    scratch = {
      room: new Int32Array(n),
      group: new Int32Array(n),
      atPiece: new Int32Array(n),
      atOutside: new Int32Array(n),
      order: new Int32Array(2 * n),
      homes: new Int32Array(n),
      groupOfNode: was ? was.groupOfNode : new Int32Array(0),
      stampOfNode: was ? was.stampOfNode : new Int32Array(0),
    };
  }
  if (scratch.groupOfNode.length < nodes) {
    const m = Math.max(nodes, 64);
    scratch.groupOfNode = new Int32Array(m);
    scratch.stampOfNode = new Int32Array(m);
  }
  return scratch;
}

/**
 * Files every live home with room for a pop, as `Finder` says: a pass to
 * find each home's room and group, a pass to count the buckets, and a pass
 * to fill them. It runs on every tick the queue is not empty, over every
 * building, so the loops are kept tight, as in room.ts.
 */
function findHomes(state: SimState): Finder {
  const b = state.buildings;
  const people = popIndexOf(state).people;
  const pieces = roadPieceByNode(state);
  const reach = outsideReachByNode(state);
  const { flags, residents, firstSeg, type } = b;
  const { segNetwork, segA } = state.roads;
  const n = flags.length;
  const s = scratchFor(n, pieces.length);
  const { room: roomOf, group: groupOf, atOutside, groupOfNode, stampOfNode, homes } = s;
  const stamp = ++pass;
  // Imported constants as locals: under the test runner each import is a
  // property read on a module object.
  const alive = BUILDING_ALIVE;
  const abandoned = BUILDING_ABANDONED;
  const road = NETWORK_ROAD;
  const none = NO_PIECE;
  const oneHousehold = ONE_HOUSEHOLD;
  const sizeCap = SIZE_CAP;
  const rooms = ROOMS;
  // Pass 1: each home's room and group, and whether it reaches outside.
  let groups = 1;
  let lastPiece = none;
  let lastGroup = 0;
  let m = 0;
  for (let id = 0; id < n; id++) {
    const held = residents[id] as number;
    const f = flags[id] as number;
    // An abandoned home offers no room (M3-24), as for newcomers (room.ts).
    if (held <= 0 || (f & alive) === 0 || (f & abandoned) !== 0) continue;
    const living = people[id] as number;
    const t = type[id] as number;
    if (living > 0 && oneHousehold[t] === 1) continue;
    const cap = sizeCap[t] as number;
    const room = held - living < cap ? held - living : cap;
    if (room <= 0) continue;
    const seg = firstSeg[id] as number;
    if (segNetwork[seg] !== road) continue;
    const node = segA[seg] as number;
    const piece = pieces[node] as number;
    if (piece === none) continue;
    if (piece !== lastPiece) {
      if (stampOfNode[piece] !== stamp) {
        stampOfNode[piece] = stamp;
        groupOfNode[piece] = groups++;
      }
      lastPiece = piece;
      lastGroup = groupOfNode[piece] as number;
    }
    roomOf[id] = room;
    groupOf[id] = lastGroup;
    atOutside[id] = reach[node] === 1 ? 0 : -1;
    homes[m++] = id;
  }
  // Pass 2: count each bucket, then lay the buckets out one after another.
  const buckets = groups * rooms;
  const start = new Int32Array(buckets);
  const count = new Int32Array(buckets);
  for (let i = 0; i < m; i++) {
    const id = homes[i] as number;
    const room = roomOf[id] as number;
    const k = (groupOf[id] as number) * rooms + room;
    count[k] = (count[k] as number) + 1;
    if (atOutside[id] === 0) count[room] = (count[room] as number) + 1;
  }
  let at = 0;
  for (let k = 0; k < buckets; k++) {
    start[k] = at;
    at += count[k] as number;
    count[k] = 0;
  }
  // Pass 3: fill them, in id order, which is the order of `homes`.
  const { order, atPiece } = s;
  for (let i = 0; i < m; i++) {
    const id = homes[i] as number;
    const room = roomOf[id] as number;
    const k = (groupOf[id] as number) * rooms + room;
    const place = (start[k] as number) + (count[k] as number);
    count[k] = (count[k] as number) + 1;
    order[place] = id;
    atPiece[id] = place;
    if (atOutside[id] === 0) {
      const o = (start[room] as number) + (count[room] as number);
      count[room] = (count[room] as number) + 1;
      order[o] = id;
      atOutside[id] = o;
    }
  }
  return { state, pieces, groupOfNode, stampOfNode, stamp, room: roomOf, group: groupOf, atPiece, atOutside, start, count, extraCount: new Int32Array(buckets), extra: new Map(), order };
}

/** The group of the piece road node `piece` names, or -1 when no home on it has room. */
function groupOfPiece(f: Finder, piece: number): number {
  if (piece === NO_PIECE || f.stampOfNode[piece] !== f.stamp) return -1;
  return f.groupOfNode[piece] as number;
}

/** A home in group `g` with room for a pop of `size`, each as likely, or -1 for none. One draw. */
function drawHome(f: Finder, g: number, size: number): number {
  const { start, count, extraCount, order } = f;
  const base = g * ROOMS;
  let total = 0;
  for (let r = size; r < ROOMS; r++) total += (count[base + r] as number) + (extraCount[base + r] as number);
  if (total === 0) return -1;
  let k = nextInt(f.state.rng, total);
  for (let r = size; r < ROOMS; r++) {
    const b = base + r;
    const inRun = count[b] as number;
    if (k < inRun) return order[(start[b] as number) + k] as number;
    k -= inRun;
    const more = extraCount[b] as number;
    if (k < more) return (f.extra.get(b) as number[])[k] as number;
    k -= more;
  }
  return -1;
}

/** Takes `home` out of bucket `b`, whose places `at` holds, in one step: the bucket's last home takes its place. */
function unfile(f: Finder, at: Int32Array, b: number, home: number): void {
  const i = at[home] as number;
  if (i >= 0) {
    const lastPlace = (f.start[b] as number) + (f.count[b] as number) - 1;
    const last = f.order[lastPlace] as number;
    f.order[i] = last;
    at[last] = i;
    f.count[b] = (f.count[b] as number) - 1;
  } else {
    const list = f.extra.get(b) as number[];
    const j = -i - 2;
    const last = list.pop() as number;
    if (last !== home) {
      list[j] = last;
      at[last] = -j - 2;
    }
    f.extraCount[b] = (f.extraCount[b] as number) - 1;
  }
  at[home] = -1;
}

/** Puts `home` in bucket `b`'s extra list. */
function fileExtra(f: Finder, at: Int32Array, b: number, home: number): void {
  let list = f.extra.get(b);
  if (!list) f.extra.set(b, (list = []));
  at[home] = -list.length - 2;
  list.push(home);
  f.extraCount[b] = (f.extraCount[b] as number) + 1;
}

/** Moves pop `id` into `home` and files the home again under the room it has left. */
function moveIn(f: Finder, id: number, home: number): void {
  const state = f.state;
  rehomePop(state, id, home);
  const was = f.room[home] as number;
  const now = roomForOnePop(state, popIndexOf(state).people, home);
  if (now === was) return;
  const g = f.group[home] as number;
  const outside = (f.atOutside[home] as number) !== -1;
  unfile(f, f.atPiece, g * ROOMS + was, home);
  if (outside) unfile(f, f.atOutside, was, home);
  f.room[home] = now;
  if (now === 0) return;
  fileExtra(f, f.atPiece, g * ROOMS + now, home);
  if (outside) fileExtra(f, f.atOutside, now, home);
}

/** Places displaced pop `id`, off the queue already, as the header says. Returns false when it found no home and is to leave. */
function place(f: Finder, id: number): boolean {
  const state = f.state;
  const p = state.pops;
  const size = p.size[id] ?? 0;
  const work = p.work[id] ?? NO_WORK;
  if (work !== NO_WORK) {
    const near = groupOfPiece(f, pieceOf(state, f.pieces, work));
    const home = near >= 0 ? drawHome(f, near, size) : -1;
    if (home >= 0) {
      moveIn(f, id, home);
      return true;
    }
    setPopWork(state, id, NO_WORK);
  }
  const home = drawHome(f, 0, size);
  if (home < 0) return false;
  moveIn(f, id, home);
  return true;
}

/** The displaced system's work for one tick: takes up to `displacedPerTick` pops off the front of the queue and places each, and sends away together those it found no room for. */
export function placeDisplaced(state: SimState): void {
  const p = state.pops;
  const queue = p.displaced;
  if (queue.length === 0) return;
  const n = Math.min(queue.length, POPS_BALANCE.displacedPerTick);
  const batch = queue.slice(0, n);
  p.displaced = queue.slice(n);
  const f = findHomes(state);
  const leaving: number[] = [];
  for (const id of batch) {
    if (place(f, id)) continue;
    noteYear(state, "departures", p.size[id] ?? 0);
    leaving.push(id);
  }
  removeHomelessPops(state, leaving);
}

/**
 * The step's system for displaced pops. It runs before arrivals, so the
 * city's own people take free room before newcomers do, and after the
 * statistics, so a day's sample counts them where they were.
 */
export const DISPLACED: System = { name: DISPLACED_SYSTEM, run: placeDisplaced };
