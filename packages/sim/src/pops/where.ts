// Where the pops are (M3-03): which pops live in and work at each building,
// each building's people and jobs filled, and the city's people at each
// satisfaction score, which the residential bar's departures read (M3-10). Derived, never saved or
// hashed: it lives in a WeakMap keyed by the pops object, like the building
// index, is built from the pop rows on first use and kept current by the
// functions in pops.ts, which also note each building whose numbers they
// touch for the host's deltas (changes.ts) and each workplace for job
// matching (opening-changes.ts). A city loaded from a save, cloned or replayed
// builds its own.
//
// Each building has two lists, its residents and its workers, linked
// through per-pop arrays and kept in ascending pop id, so a list reads the
// same whatever order the pops arrived in and a fresh build gives the same
// answers as one kept current.

import { buildingIdLimit } from "../buildings/buildings";
import type { SimState } from "../state";
import { notePopBuilding } from "./changes";
import { noteOpening } from "./opening-changes";
import { NO_HOME, NO_WORK, POP_ALIVE, POP_LEVELS, SATISFACTION_MAX, popWorkers, type PopState } from "./pops";

const NONE = -1;

export interface PopIndex {
  /** By building: the lowest pop id living there, or NONE. */
  homeHead: Int32Array;
  /** By building: the highest pop id living there, or NONE, so a pop with a higher id than any there joins in one step. */
  homeTail: Int32Array;
  /** By building: the lowest pop id working there, or NONE. */
  workHead: Int32Array;
  /** By building: the highest pop id working there, or NONE. Job matching adds workers in rising id order (M3-09). */
  workTail: Int32Array;
  /** By building: the people living there, the sum of its pops' sizes. */
  people: Int32Array;
  /** By building: its jobs filled, the sum of its workers' `popWorkers`. */
  filled: Int32Array;
  /**
   * By building times POP_LEVELS plus education: the jobs filled there by
   * pops of that education (M3-09), so a building's open jobs for each
   * level need no walk over its workers.
   */
  filledByEducation: Int32Array;
  /** By satisfaction score, 0 to SATISFACTION_MAX: the people in pops at that score (M3-10). */
  peopleBySatisfaction: Float64Array;
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
    index.homeTail = grown(index.homeTail, n, NONE);
    index.workHead = grown(index.workHead, n, NONE);
    index.workTail = grown(index.workTail, n, NONE);
    index.people = grown(index.people, n, 0);
    index.filled = grown(index.filled, n, 0);
    index.filledByEducation = grown(index.filledByEducation, n * POP_LEVELS, 0);
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
  const index: PopIndex = {
    homeHead: empty,
    homeTail: empty,
    workHead: empty,
    workTail: empty,
    people: empty,
    filled: empty,
    filledByEducation: empty,
    peopleBySatisfaction: new Float64Array(SATISFACTION_MAX + 1),
    homeNext: empty,
    homePrev: empty,
    workNext: empty,
    workPrev: empty,
  };
  const p = state.pops;
  fit(index, buildingIdLimit(state.buildings), p.flags.length);
  // Highest id first, each to the front of its lists, so every list ends up ascending.
  for (let id = p.flags.length - 1; id >= 0; id--) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    const home = p.home[id] ?? 0;
    if (home !== NO_HOME) {
      pushFront(index.homeHead, index.homeTail, index.homeNext, index.homePrev, home, id);
      index.people[home] = (index.people[home] ?? 0) + (p.size[id] ?? 0);
    }
    moveSatisfactionPeople(index, p.satisfaction[id] ?? 0, p.size[id] ?? 0);
    const work = p.work[id] ?? NO_WORK;
    if (work === NO_WORK) continue;
    pushFront(index.workHead, index.workTail, index.workNext, index.workPrev, work, id);
    addFilled(index, p, id, work, 1);
  }
  return index;
}

function pushFront(head: Int32Array, tail: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  const first = head[building] ?? NONE;
  next[id] = first;
  prev[id] = NONE;
  if (first !== NONE) prev[first] = id;
  else tail[building] = id;
  head[building] = id;
}

/** Puts `id` into `building`'s list where its id falls: at the end in one step when it is the highest, else by a walk from the front. */
function insertSorted(head: Int32Array, tail: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  const last = tail[building] ?? NONE;
  if (last !== NONE && last < id) {
    next[last] = id;
    prev[id] = last;
    next[id] = NONE;
    tail[building] = id;
    return;
  }
  let before = NONE;
  let at = head[building] ?? NONE;
  while (at !== NONE && at < id) {
    before = at;
    at = next[at] ?? NONE;
  }
  next[id] = at;
  prev[id] = before;
  if (at !== NONE) prev[at] = id;
  else tail[building] = id;
  if (before === NONE) head[building] = id;
  else next[before] = id;
}

function unlink(head: Int32Array, tail: Int32Array, next: Int32Array, prev: Int32Array, building: number, id: number): void {
  const before = prev[id] ?? NONE;
  const after = next[id] ?? NONE;
  if (before === NONE) head[building] = after;
  else next[before] = after;
  if (after !== NONE) prev[after] = before;
  else tail[building] = before;
  next[id] = NONE;
  prev[id] = NONE;
}

/** Adds `sign` times live pop `id`'s workers to the jobs filled at `work`, in all and by its education. */
function addFilled(index: PopIndex, p: PopState, id: number, work: number, sign: 1 | -1): void {
  const workers = sign * popWorkers(p, id);
  index.filled[work] = (index.filled[work] ?? 0) + workers;
  const at = work * POP_LEVELS + Math.min(POP_LEVELS - 1, p.education[id] ?? 0);
  index.filledByEducation[at] = (index.filledByEducation[at] ?? 0) + workers;
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

/**
 * Files live pop `id` under its home and adds its people there, and to the
 * city's people by satisfaction. A pop with no home, displaced and waiting
 * for one (M3-12), is filed under no building but still counts by
 * satisfaction, since it is still one of the city's people.
 */
export function linkHome(index: PopIndex, p: PopState, id: number): void {
  fit(index, 0, p.flags.length);
  const home = p.home[id] ?? 0;
  moveSatisfactionPeople(index, p.satisfaction[id] ?? 0, p.size[id] ?? 0);
  if (home === NO_HOME) return;
  insertSorted(index.homeHead, index.homeTail, index.homeNext, index.homePrev, home, id);
  index.people[home] = (index.people[home] ?? 0) + (p.size[id] ?? 0);
  notePopBuilding(p, home);
}

/** Takes live pop `id` off its home's list and its people out of the counts `linkHome` adds them to. */
export function unlinkHome(index: PopIndex, p: PopState, id: number): void {
  const home = p.home[id] ?? 0;
  moveSatisfactionPeople(index, p.satisfaction[id] ?? 0, -(p.size[id] ?? 0));
  if (home === NO_HOME) return;
  unlink(index.homeHead, index.homeTail, index.homeNext, index.homePrev, home, id);
  index.people[home] = (index.people[home] ?? 0) - (p.size[id] ?? 0);
  notePopBuilding(p, home);
}

/**
 * Moves live pop `id` out of its home's list and its people out of the
 * home's count, and sets its home to `home`, filing it there unless that
 * is NO_HOME: for a pop displaced or placed again (M3-12). Its people stay
 * at their score, since it stays one of the city's people.
 */
export function moveHome(index: PopIndex, p: PopState, id: number, home: number): void {
  const was = p.home[id] ?? 0;
  const size = p.size[id] ?? 0;
  if (was !== NO_HOME) {
    unlink(index.homeHead, index.homeTail, index.homeNext, index.homePrev, was, id);
    index.people[was] = (index.people[was] ?? 0) - size;
    notePopBuilding(p, was);
  }
  p.home[id] = home;
  if (home === NO_HOME) return;
  insertSorted(index.homeHead, index.homeTail, index.homeNext, index.homePrev, home, id);
  index.people[home] = (index.people[home] ?? 0) + size;
  notePopBuilding(p, home);
}

/** Adds `people` to the count at satisfaction `score`, or takes them away when negative. pops.ts calls it around every change of a pop's size or score. */
export function moveSatisfactionPeople(index: PopIndex, score: number, people: number): void {
  index.peopleBySatisfaction[score] = (index.peopleBySatisfaction[score] ?? 0) + people;
}

/** Files live pop `id` under its workplace, if it has one, and adds its workers to the jobs filled there. */
export function linkWork(index: PopIndex, p: PopState, id: number): void {
  const work = p.work[id] ?? NO_WORK;
  if (work === NO_WORK) return;
  insertSorted(index.workHead, index.workTail, index.workNext, index.workPrev, work, id);
  addFilled(index, p, id, work, 1);
  notePopBuilding(p, work);
  noteOpening(p, work);
}

/** Takes live pop `id` off its workplace's list, if it has one, and its workers out of the jobs filled. */
export function unlinkWork(index: PopIndex, p: PopState, id: number): void {
  const work = p.work[id] ?? NO_WORK;
  if (work === NO_WORK) return;
  unlink(index.workHead, index.workTail, index.workNext, index.workPrev, work, id);
  addFilled(index, p, id, work, -1);
  notePopBuilding(p, work);
  noteOpening(p, work);
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
