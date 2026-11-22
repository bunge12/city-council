// Where the pops are (M3-03): which pops live in and work at each building,
// and each building's people and jobs filled. Derived, never saved or
// hashed: it lives in a WeakMap keyed by the pops object, like the building
// index, is built from the pop rows on first use and kept current by the
// functions in pops.ts, which also note each building whose numbers they
// touch for the host's deltas (changes.ts). A city loaded from a save, cloned or replayed
// builds its own.
//
// Each building has two lists, its residents and its workers, linked
// through per-pop arrays and kept in ascending pop id, so a list reads the
// same whatever order the pops arrived in and a fresh build gives the same
// answers as one kept current.

import { buildingIdLimit } from "../buildings/buildings";
import type { SimState } from "../state";
import { notePopBuilding } from "./changes";
import { NO_WORK, POP_ALIVE, popWorkers, type PopState } from "./pops";

const NONE = -1;

export interface PopIndex {
  /** By building: the lowest pop id living there, or NONE. */
  homeHead: Int32Array;
  /** By building: the lowest pop id working there, or NONE. */
  workHead: Int32Array;
  /** By building: the people living there, the sum of its pops' sizes. */
  people: Int32Array;
  /** By building: its jobs filled, the sum of its workers' `popWorkers`. */
  filled: Int32Array;
  /** By pop: the next and previous pop in its home's list. */
  homeNext: Int32Array;
  homePrev: Int32Array;
  /** By pop: the next and previous pop in its workplace's list. */
  workNext: Int32Array;
  workPrev: Int32Array;
}

const indexes = new WeakMap<PopState, PopIndex>();

/** An Int32Array of `length` holding `array` and `fill` past it. */
function grown(array: Int32Array, length: number, fill: number): Int32Array {
  const next = new Int32Array(length);
  next.set(array);
  if (fill !== 0) next.fill(fill, array.length);
  return next;
}

/** Room for every building and pop id `state` has handed out. */
function fit(index: PopIndex, buildings: number, pops: number): void {
  if (index.homeHead.length < buildings) {
    const n = Math.max(buildings, index.homeHead.length * 2, 64);
    index.homeHead = grown(index.homeHead, n, NONE);
    index.workHead = grown(index.workHead, n, NONE);
    index.people = grown(index.people, n, 0);
    index.filled = grown(index.filled, n, 0);
  }
  if (index.homeNext.length < pops) {
    const n = Math.max(pops, index.homeNext.length * 2, 64);
    index.homeNext = grown(index.homeNext, n, NONE);
    index.homePrev = grown(index.homePrev, n, NONE);
    index.workNext = grown(index.workNext, n, NONE);
    index.workPrev = grown(index.workPrev, n, NONE);
  }
}

/** Builds the index from the pop rows alone. */
function buildIndex(state: SimState): PopIndex {
  const empty = new Int32Array(0);
  const index: PopIndex = { homeHead: empty, workHead: empty, people: empty, filled: empty, homeNext: empty, homePrev: empty, workNext: empty, workPrev: empty };
  const p = state.pops;
  fit(index, buildingIdLimit(state.buildings), p.flags.length);
  // Highest id first, each to the front of its lists, so every list ends up ascending.
  for (let id = p.flags.length - 1; id >= 0; id--) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    const home = p.home[id] ?? 0;
    pushFront(index.homeHead, index.homeNext, index.homePrev, home, id);
    index.people[home] = (index.people[home] ?? 0) + (p.size[id] ?? 0);
    const work = p.work[id] ?? NO_WORK;
    if (work === NO_WORK) continue;
    pushFront(index.workHead, index.workNext, index.workPrev, work, id);
    index.filled[work] = (index.filled[work] ?? 0) + popWorkers(p, id);
  }
  return index;
}

function pushFront(head: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  const first = head[building] ?? NONE;
  next[id] = first;
  prev[id] = NONE;
  if (first !== NONE) prev[first] = id;
  head[building] = id;
}

/** Puts `id` into `building`'s list where its id falls. */
function insertSorted(head: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  let before = NONE;
  let at = head[building] ?? NONE;
  while (at !== NONE && at < id) {
    before = at;
    at = next[at] ?? NONE;
  }
  next[id] = at;
  prev[id] = before;
  if (at !== NONE) prev[at] = id;
  if (before === NONE) head[building] = id;
  else next[before] = id;
}

function unlink(head: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  const before = prev[id] ?? NONE;
  const after = next[id] ?? NONE;
  if (before === NONE) head[building] = after;
  else next[before] = after;
  if (after !== NONE) prev[after] = before;
  next[id] = NONE;
  prev[id] = NONE;
}

/** The index for `state`, built on first use and grown to its buildings and pops. */
export function popIndexOf(state: SimState): PopIndex {
  let index = indexes.get(state.pops);
  if (!index) {
    index = buildIndex(state);
    indexes.set(state.pops, index);
  }
  fit(index, buildingIdLimit(state.buildings), state.pops.flags.length);
  return index;
}

/** Files live pop `id` under its home and adds its people there. */
export function linkHome(index: PopIndex, p: PopState, id: number): void {
  fit(index, 0, p.flags.length);
  const home = p.home[id] ?? 0;
  insertSorted(index.homeHead, index.homeNext, index.homePrev, home, id);
  index.people[home] = (index.people[home] ?? 0) + (p.size[id] ?? 0);
  notePopBuilding(p, home);
}

/** Takes live pop `id` off its home's list and its people out of the count. */
export function unlinkHome(index: PopIndex, p: PopState, id: number): void {
  const home = p.home[id] ?? 0;
  unlink(index.homeHead, index.homeNext, index.homePrev, home, id);
  index.people[home] = (index.people[home] ?? 0) - (p.size[id] ?? 0);
  notePopBuilding(p, home);
}

/** Files live pop `id` under its workplace, if it has one, and adds its workers to the jobs filled there. */
export function linkWork(index: PopIndex, p: PopState, id: number): void {
  const work = p.work[id] ?? NO_WORK;
  if (work === NO_WORK) return;
  insertSorted(index.workHead, index.workNext, index.workPrev, work, id);
  index.filled[work] = (index.filled[work] ?? 0) + popWorkers(p, id);
  notePopBuilding(p, work);
}

/** Takes live pop `id` off its workplace's list, if it has one, and its workers out of the jobs filled. */
export function unlinkWork(index: PopIndex, p: PopState, id: number): void {
  const work = p.work[id] ?? NO_WORK;
  if (work === NO_WORK) return;
  unlink(index.workHead, index.workNext, index.workPrev, work, id);
  index.filled[work] = (index.filled[work] ?? 0) - popWorkers(p, id);
  notePopBuilding(p, work);
}

// --- Queries -------------------------------------------------------------------

function list(head: Int32Array, next: Int32Array, building: number): number[] {
  const out: number[] = [];
  for (let id = head[building] ?? NONE; id !== NONE; id = next[id] ?? NONE) out.push(id);
  return out;
}

/** The pops living in building `id`, ascending. Empty for a building nobody lives in or an id that is not one. */
export function popsAtHome(state: SimState, id: number): number[] {
  const index = popIndexOf(state);
  return id >= 0 && id < index.homeHead.length ? list(index.homeHead, index.homeNext, id) : [];
}

/** The pops working in building `id`, ascending. */
export function popsAtWork(state: SimState, id: number): number[] {
  const index = popIndexOf(state);
  return id >= 0 && id < index.workHead.length ? list(index.workHead, index.workNext, id) : [];
}

/** The people living in building `id`: the sum of its pops' sizes. */
export function buildingPeople(state: SimState, id: number): number {
  return popIndexOf(state).people[id] ?? 0;
}

/** Building `id`'s jobs filled: the workers of the pops working there. */
export function jobsFilled(state: SimState, id: number): number {
  return popIndexOf(state).filled[id] ?? 0;
}
