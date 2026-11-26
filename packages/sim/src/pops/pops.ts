// Pops in state (M3-03, PRD "M3 Demand").
//
// A pop is a block of people who share a home building, a workplace and a
// profile. One row per pop id in flat typed arrays, like the buildings: a
// removed id's row is zeros and its id goes on the free list, the next one
// to reuse last. A row is 23 bytes: the alive flag, the home and workplace
// as 32-bit building ids, a byte each for size, education, wealth,
// children, satisfaction, the game days its satisfaction has been below
// the threshold for leaving (M3-10) and the game days of grace it has
// left (#361), and the mark of its last displacement (M4-10): who cleared
// its home, a byte, the tick, 32 bits, and the people cleared with it, 16.
//
// Only the functions here change a pop, and each keeps the derived index
// (where.ts) current: which pops live in and work at each building, and
// each building's people and jobs filled. Each keeps the city's running
// totals current too (stats/stats.ts, M3-04): it takes the pop and the
// jobs filled at the workplaces it touches out of them before the change
// and puts them back after. They refuse a change that would
// put a home over the people it holds room for, or a workplace over its
// jobs. Newcomers arrive through `addPop` (arrivals.ts, M3-08).
//
// `sweep` is the cursor the daily systems share (sweep.ts), `owed` the
// day's plan of arrivals (arrivals.ts), and `leaveScore` and `leaveAtScore`
// the day's plan of departures while the residential bar is below zero
// (satisfaction.ts).
//
// A pop whose home is removed is displaced (M3-12, displaced.ts): its home
// becomes NO_HOME and its id joins `displaced`, the queue of pops waiting
// for a new home. A pop in the queue still counts in the population and
// keeps its job. Only a pop in the queue has no home.
//
// A pop displaced by the city clearing its home, or by its owner
// redeveloping it, is marked (M4-10): who cleared it, the tick, and how
// many people the building held. Satisfaction reads the mark on the pop's
// visits for a game year and clears it after (satisfaction.ts). The mark
// goes with the pop to its new home and to both parts of a split.

import { BUILDING_TYPES } from "../buildings/balance";
import { homeRoom, isAbandoned, isBuilding, type BuildingState } from "../buildings/buildings";
import { buildingJobs } from "../buildings/jobs";
import { capacityOf, resized, type AnyTypedArray } from "../roads/network";
import type { SimState } from "../state";
import { countEmployment, countFilled, countHomeDensity, countNewcomersUnemployed, countPop, countSatisfaction } from "../stats/stats";
import { DAYS_LOW_LIMIT, GRACE_DAYS_LIMIT, POPS_BALANCE } from "./balance";
import { notePopBuilding } from "./changes";
import { jobsProblem } from "./open-jobs";
import { emptyHome, emptyWork, popIndexOf, linkHome, linkWork, moveHome, unlinkHome, unlinkWork, moveSatisfactionPeople, type PopIndex } from "./where";

/** Set in `flags` for a live pop. */
export const POP_ALIVE = 1;

/** A pop's workplace when it has none. */
export const NO_WORK = -1;

/** A pop's home while it waits in the queue of displaced pops (M3-12). */
export const NO_HOME = -1;

/** The levels of education and of wealth, as a pop stores them: 0 low, 1 medium, 2 high. */
export const POP_LEVELS = 3;

/** The highest satisfaction. */
export const SATISFACTION_MAX = 100;

/** `displacedBy` for a pop with no mark: never displaced, or not for a game year. */
export const DISPLACED_BY_NONE = 0;

/** `displacedBy` for a pop whose home the city cleared: a bulldoze or a road, at the eminent domain price (M4-09). */
export const DISPLACED_BY_CITY = 1;

/** `displacedBy` for a pop whose home its owner redeveloped (M3-14). */
export const DISPLACED_BY_OWNER = 2;

/** The most `displacedWith` holds: it is 16 bits. A building of more people marks this many. */
export const DISPLACED_WITH_LIMIT = 65_535;

/** Every pop. Plain typed arrays and one number (CLAUDE.md rule 7). */
export interface PopState {
  /** POP_ALIVE for a live id, 0 for a free one. */
  flags: Uint8Array;
  /** The building it lives in, or NO_HOME while it waits in `displaced`. */
  home: Int32Array;
  /** The building it works in, or NO_WORK. */
  work: Int32Array;
  /** People in it, from 1 to the size cap of its home's density. */
  size: Uint8Array;
  /** 0 low, 1 medium, 2 high. */
  education: Uint8Array;
  /** 0 low, 1 medium, 2 high. */
  wealth: Uint8Array;
  /** 1 if it has children, 0 if not. */
  children: Uint8Array;
  /** 0 to SATISFACTION_MAX. */
  satisfaction: Uint8Array;
  /** Game days in a row its satisfaction has been below `satisfaction.leaveBelow` in pops.json, up to DAYS_LOW_LIMIT (M3-10). */
  daysLow: Uint8Array;
  /**
   * Game days left before a newcomer's workers count as unemployed in the
   * residential bar, from `newcomer.graceDays` in pops.json down to 0, one
   * each time the daily sweep visits it (#361). A pop that takes a freed id
   * the day's sweep has yet to reach loses its first day the day it arrives. 0 for a pop that has settled in.
   */
  graceDays: Uint8Array;
  /**
   * The mark of its last displacement (M4-10): DISPLACED_BY_CITY,
   * DISPLACED_BY_OWNER or DISPLACED_BY_NONE; the tick it was displaced on;
   * and the people living in the building it was displaced from, itself
   * among them, up to DISPLACED_WITH_LIMIT. The tick and the people are 0
   * while there is no mark.
   */
  displacedBy: Uint8Array;
  displacedTick: Int32Array;
  displacedWith: Uint16Array;
  /** Removed ids, the next one to reuse last. */
  free: Int32Array;
  /**
   * The pop id limit as it stood on the first tick of the game day: the
   * daily sweep visits ids below it, a slice a tick (sweep.ts). State, so
   * every machine visits the same pops on the same tick.
   */
  sweep: number;
  /**
   * The day's plan of arrivals: 0, or below 0 by the people a household
   * larger than the ticks' share brought early, which later ticks pay back
   * before anyone else arrives (arrivals.ts, M3-08). State, so a city saved
   * mid-day lands the same pops.
   */
  owed: number;
  /**
   * The day's plan of departures while the residential bar is below zero
   * (satisfaction.ts, M3-10): a pop whose satisfaction is below
   * `leaveScore` leaves when the day's sweep reaches it, and one at
   * `leaveScore` leaves while `leaveAtScore` people at that score are still
   * due to go. Below 0, `leaveAtScore` is the people sent away past the
   * plan, which the next day's plan pays back. `leaveScore` is NO_LEAVING on
   * a day nobody is due to go.
   * State, so a city saved mid-day sends the same pops away.
   */
  leaveScore: number;
  leaveAtScore: number;
  /**
   * The pops whose homes were removed, waiting for a new one, first in
   * line first (M3-12, displaced.ts). Each has home NO_HOME. State, so a
   * city saved with pops in the queue places the same pops in the same
   * homes.
   */
  displaced: Int32Array;
}

/** `leaveScore` on a day nobody is sent away by the residential bar. */
export const NO_LEAVING = -1;

/** The per-pop arrays, in the order a new state has them. */
export const POP_ARRAYS = ["flags", "home", "work", "size", "education", "wealth", "children", "satisfaction", "daysLow", "graceDays", "displacedBy", "displacedTick", "displacedWith"] as const;

type PopKey = (typeof POP_ARRAYS)[number];

const ARRAY_TYPES: Readonly<Record<PopKey | "free", new (n: number) => AnyTypedArray | Uint16Array>> = {
  flags: Uint8Array,
  home: Int32Array,
  work: Int32Array,
  size: Uint8Array,
  education: Uint8Array,
  wealth: Uint8Array,
  children: Uint8Array,
  satisfaction: Uint8Array,
  daysLow: Uint8Array,
  graceDays: Uint8Array,
  displacedBy: Uint8Array,
  displacedTick: Int32Array,
  displacedWith: Uint16Array,
  free: Int32Array,
};

/** Bytes one pop's row takes, the free list aside. */
export const POP_ROW_BYTES: number = POP_ARRAYS.reduce((sum, key) => sum + new ARRAY_TYPES[key](0).BYTES_PER_ELEMENT, 0);

/** No pops. */
export function createPops(): PopState {
  return {
    flags: new Uint8Array(0),
    home: new Int32Array(0),
    work: new Int32Array(0),
    size: new Uint8Array(0),
    education: new Uint8Array(0),
    wealth: new Uint8Array(0),
    children: new Uint8Array(0),
    satisfaction: new Uint8Array(0),
    daysLow: new Uint8Array(0),
    graceDays: new Uint8Array(0),
    displacedBy: new Uint8Array(0),
    displacedTick: new Int32Array(0),
    displacedWith: new Uint16Array(0),
    free: new Int32Array(0),
    sweep: 0,
    owed: 0,
    leaveScore: NO_LEAVING,
    leaveAtScore: 0,
    displaced: new Int32Array(0),
  };
}

/**
 * Gives every per-pop array room for its next id, as the first id past the
 * end would: a copy into a buffer of double the capacity. A city loaded
 * from a snapshot has arrays of exactly their length, so the first
 * newcomer after the load copied every one of them inside the tick the
 * arrivals placed it: about 1.5 ms on the scale city of 200,000 (issue
 * #372). A host calls this at load (`prepareDerived`), as it does
 * `reserveRoadRoom`. Values and lengths are unchanged, so state reads,
 * saves and hashes the same.
 */
export function reservePopRoom(p: PopState): void {
  const arrays = p as unknown as Record<PopKey, AnyTypedArray>;
  for (const key of POP_ARRAYS) {
    const array = arrays[key];
    if (capacityOf(array) > array.length) continue;
    arrays[key] = resized(resized(array, array.length + 1), array.length);
  }
}

/** Number of pop ids handed out, removed ones included. */
export function popIdLimit(p: PopState): number {
  return p.flags.length;
}

/** Live pops. Every id handed out is live or free, so this is a subtraction. */
export function popCount(p: PopState): number {
  return p.flags.length - p.free.length;
}

export function isPop(p: PopState, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < p.flags.length && ((p.flags[id] ?? 0) & POP_ALIVE) !== 0;
}

/** Who a pop is: everything in its row but where it lives and works. */
export interface PopProfile {
  /** 0 low, 1 medium, 2 high. */
  education: number;
  /** 0 low, 1 medium, 2 high. */
  wealth: number;
  /** 1 if it has children. */
  children: number;
}

/** A new pop: its home, its size, its profile and its satisfaction. It starts with no job. */
export interface NewPop extends PopProfile {
  home: number;
  size: number;
  satisfaction: number;
  /** Game days its satisfaction has already been low, for the part of a split pop (M3-10). 0 if left out. */
  daysLow?: number;
  /** Game days left before its workers count as unemployed in the residential bar (#361): `newcomer.graceDays` for a newcomer, what is left of it for the part of a split pop. 0 if left out. */
  graceDays?: number;
  /** The mark of its last displacement, for the part of a split pop (M4-10). None if left out. */
  displaced?: DisplacedMark;
}

/** The mark of a pop's last displacement (M4-10), as `PopState` keeps it. */
export interface DisplacedMark {
  /** DISPLACED_BY_CITY, DISPLACED_BY_OWNER or DISPLACED_BY_NONE. */
  by: number;
  tick: number;
  /** The people living in the building it was displaced from, itself among them. */
  with: number;
}

/** One pop's row. */
export interface PopRow extends NewPop {
  id: number;
  /** The building it works in, or NO_WORK. */
  work: number;
  daysLow: number;
  graceDays: number;
  displaced: DisplacedMark;
}

/** The mark pop `id` carries. All zeros for none. */
export function popDisplacedMark(p: PopState, id: number): DisplacedMark {
  return { by: p.displacedBy[id] ?? 0, tick: p.displacedTick[id] ?? 0, with: p.displacedWith[id] ?? 0 };
}

/** The row of pop `id`. Throws if there is no such pop. */
export function readPop(p: PopState, id: number): PopRow {
  if (!isPop(p, id)) throw new RangeError(`pop ${id} does not exist`);
  return {
    id,
    home: p.home[id] ?? 0,
    work: p.work[id] ?? NO_WORK,
    size: p.size[id] ?? 0,
    education: p.education[id] ?? 0,
    wealth: p.wealth[id] ?? 0,
    children: p.children[id] ?? 0,
    satisfaction: p.satisfaction[id] ?? 0,
    daysLow: p.daysLow[id] ?? 0,
    graceDays: p.graceDays[id] ?? 0,
    displaced: popDisplacedMark(p, id),
  };
}

// --- Rules that are functions of a row ---------------------------------------

/** The most people one pop may hold in a home of `density`, from `popSizeCap` in pops.json. */
export function popSizeCap(density: number): number {
  const caps = POPS_BALANCE.popSizeCap;
  return caps[Math.min(caps.length, Math.max(1, density)) - 1] ?? 1;
}

/**
 * The sizes of the pops `people` residents of a home of `density` are cut
 * into: as few pops as the size cap allows, as even as whole people make
 * them, the larger first. A house of up to the density 1 cap is one pop; a
 * tower of 1,000 at a cap of 100 is ten. Empty for no people.
 */
export function cutPeople(people: number, density: number): number[] {
  if (!Number.isSafeInteger(people) || people <= 0) return [];
  const cap = popSizeCap(density);
  const count = Math.floor((people + cap - 1) / cap);
  const base = Math.floor(people / count);
  const larger = people - base * count;
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(i < larger ? base + 1 : base);
  return sizes;
}

/**
 * How many of a pop's people work: `workerShare` of its size from
 * pops.json, the lower share for a pop with children, rounded to the
 * nearest person, halves up. A function of the row alone, so a count of
 * workers needs no job to have been found.
 */
export function workersFor(size: number, children: number): number {
  const ws = POPS_BALANCE.workerShare;
  const share = children ? ws.withChildren : ws.withoutChildren;
  return Math.floor(size * share + 0.5);
}

/** How many of pop `id`'s people work. 0 for a free id. */
export function popWorkers(p: PopState, id: number): number {
  if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) return 0;
  return workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
}

// --- Changing pops -------------------------------------------------------------

/** The density of building `home`, for its pops' size cap. */
function homeDensity(b: BuildingState, home: number): number {
  return BUILDING_TYPES[b.type[home] ?? 0]?.density ?? 1;
}

function checkProfile(profile: PopProfile): void {
  const level = (v: number) => Number.isInteger(v) && v >= 0 && v < POP_LEVELS;
  if (!level(profile.education) || !level(profile.wealth)) throw new RangeError("education and wealth must each be 0, 1 or 2");
  if (profile.children !== 0 && profile.children !== 1) throw new RangeError("children must be 0 or 1");
}

function checkSatisfaction(satisfaction: number): void {
  if (!Number.isInteger(satisfaction) || satisfaction < 0 || satisfaction > SATISFACTION_MAX) {
    throw new RangeError(`satisfaction must be a whole number from 0 to ${SATISFACTION_MAX}`);
  }
}

function checkDaysLow(days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > DAYS_LOW_LIMIT) throw new RangeError(`days low must be a whole number from 0 to ${DAYS_LOW_LIMIT}`);
}

function checkGraceDays(days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > GRACE_DAYS_LIMIT) throw new RangeError(`grace days must be a whole number from 0 to ${GRACE_DAYS_LIMIT}`);
}

/** Why `mark` is not a mark a pop can carry, or null. */
function displacedMarkProblem(by: number, tick: number, people: number): string | null {
  if (by === DISPLACED_BY_NONE) return tick === 0 && people === 0 ? null : "an unmarked pop must have no displacement tick or people";
  if (by !== DISPLACED_BY_CITY && by !== DISPLACED_BY_OWNER) return "a displacement mark must be by the city or by an owner";
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > 0x7fff_ffff) return "a displacement tick must be a whole number from 0";
  if (!Number.isSafeInteger(people) || people < 1 || people > DISPLACED_WITH_LIMIT) return `a displacement must have from 1 to ${DISPLACED_WITH_LIMIT} people`;
  return null;
}

function checkDisplacedMark(mark: DisplacedMark): void {
  const problem = displacedMarkProblem(mark.by, mark.tick, mark.with);
  if (problem !== null) throw new RangeError(problem);
}

/**
 * Throws unless `size` people fit one pop in building `home`, beside the
 * `others` people already there. `from` is the size of the pop these
 * people were before, when they were one: a pop past its home's size cap,
 * which a city saved under a higher cap may hold (PRD, "Pops"), can still
 * shrink or split, and only growth past the cap is refused (M3 review, #365).
 */
function checkHomeRoom(state: SimState, home: number, size: number, others: number, from = 0): void {
  const b = state.buildings;
  const cap = popSizeCap(homeDensity(b, home));
  if (!Number.isInteger(size) || size < 1 || (size > cap && size > from)) throw new RangeError(`a pop in building ${home} holds 1 to ${cap} people, not ${size}`);
  const room = homeRoom(b, home);
  if (others + size > room) throw new RangeError(`building ${home} has room for ${room} people, not ${others + size}`);
}

/**
 * Throws unless building `work` has jobs for `add` workers of education
 * `addLevel` once `drop` of education `dropLevel` leave, every worker in a
 * job its education allows (open-jobs.ts).
 */
function checkJobs(state: SimState, work: number, addLevel: number, add: number, dropLevel: number, drop: number): void {
  const problem = jobsProblem(state, state.buildings, work, addLevel, add, dropLevel, drop);
  if (problem) throw new RangeError(problem);
}

/**
 * Adds a pop to its home with no job and returns its id, the last free id
 * or a new one. Internal: the systems that move people in call it. Throws,
 * changing nothing, if the home is not a live building people live in, if
 * the size is past the cap for the home's density, if the home has no room
 * for that many more, or if the profile or satisfaction is out of range.
 */
export function addPop(state: SimState, spec: NewPop): number {
  return insertPop(state, spec, 0);
}

/**
 * `addPop` for the rest of a pop split in two, by job matching or turnover,
 * from a pop of `from` people: it may be past the size cap when the pop it
 * came from was (M3 review, #365). Internal to the pop systems.
 */
export function addSplitPop(state: SimState, spec: NewPop, from: number): number {
  return insertPop(state, spec, from);
}

function insertPop(state: SimState, spec: NewPop, splitFrom: number): number {
  if (!isBuilding(state.buildings, spec.home) || (state.buildings.residents[spec.home] ?? 0) <= 0) {
    throw new RangeError(`building ${spec.home} is not a home`);
  }
  if (isAbandoned(state.buildings, spec.home)) throw new RangeError(`building ${spec.home} is abandoned`);
  checkProfile(spec);
  checkSatisfaction(spec.satisfaction);
  checkDaysLow(spec.daysLow ?? 0);
  checkGraceDays(spec.graceDays ?? 0);
  if (spec.displaced) checkDisplacedMark(spec.displaced);
  const index = popIndexOf(state);
  checkHomeRoom(state, spec.home, spec.size, index.people[spec.home] ?? 0, splitFrom);
  const p = state.pops;
  let id: number;
  if (p.free.length > 0) {
    id = p.free[p.free.length - 1] ?? 0;
    p.free = resized(p.free, p.free.length - 1);
  } else {
    id = p.flags.length;
    const arrays = p as unknown as Record<PopKey, AnyTypedArray>;
    for (const key of POP_ARRAYS) arrays[key] = resized(arrays[key], id + 1);
  }
  p.flags[id] = POP_ALIVE;
  p.home[id] = spec.home;
  p.work[id] = NO_WORK;
  p.size[id] = spec.size;
  p.education[id] = spec.education;
  p.wealth[id] = spec.wealth;
  p.children[id] = spec.children;
  p.satisfaction[id] = spec.satisfaction;
  p.daysLow[id] = spec.daysLow ?? 0;
  p.graceDays[id] = spec.graceDays ?? 0;
  p.displacedBy[id] = spec.displaced?.by ?? DISPLACED_BY_NONE;
  p.displacedTick[id] = spec.displaced?.tick ?? 0;
  p.displacedWith[id] = spec.displaced?.with ?? 0;
  linkHome(index, p, id);
  countPop(state, id, 1);
  return id;
}

/**
 * Removes pop `id`, freeing its home's room and its job. Its row becomes
 * zeros and its id goes on the free list. A pop with no home leaves the
 * queue of displaced pops too.
 */
export function removePop(state: SimState, id: number): void {
  const p = state.pops;
  if (!isPop(p, id)) throw new RangeError(`pop ${id} does not exist`);
  if (p.home[id] === NO_HOME) p.displaced = withoutEntry(p.displaced, id);
  clearPop(state, id);
  const free = resized(p.free, p.free.length + 1);
  free[p.free.length] = id;
  p.free = free;
}

/**
 * `queue` without its one entry `id`, in the same order. Two copies of the
 * parts either side, not a filter: satisfaction and turnover can send the
 * pops of a long queue away one at a time (issue #306).
 */
function withoutEntry(queue: Int32Array, id: number): Int32Array {
  const at = queue.indexOf(id);
  if (at < 0) return queue;
  const out = new Int32Array(queue.length - 1);
  out.set(queue.subarray(0, at));
  out.set(queue.subarray(at + 1), at);
  return out;
}

/**
 * Removes pops `ids`, each with no home and none of them in the queue of
 * displaced pops, as `removePop` would one at a time, with one growth of
 * the free list: the placing of displaced pops takes its batch off the
 * queue first, and sends away those it finds no room for together
 * (displaced.ts). Throws, changing nothing, if any is not a live pop with
 * no home or is named twice. That none is in the queue is the caller's to
 * keep: checking would cost a pass over the queue every tick it drains.
 */
export function removeHomelessPops(state: SimState, ids: readonly number[]): void {
  const p = state.pops;
  const named = new Set<number>();
  for (const id of ids) {
    if (!isPop(p, id) || p.home[id] !== NO_HOME || named.has(id)) throw new RangeError(`pop ${id} is not a pop with no home, named once`);
    named.add(id);
  }
  if (ids.length === 0) return;
  for (const id of ids) clearPop(state, id);
  const free = resized(p.free, p.free.length + ids.length);
  free.set(ids, p.free.length);
  p.free = free;
}

/** Takes live pop `id` out of the index and the totals and clears its row, leaving the free list to the caller. */
function clearPop(state: SimState, id: number): void {
  const p = state.pops;
  const index = popIndexOf(state);
  const work = p.work[id] ?? NO_WORK;
  uncount(state, id, work, NO_WORK);
  unlinkWork(index, p, id);
  unlinkHome(index, p, id);
  if (work !== NO_WORK) countFilled(state, work, 1);
  clearRow(p, id);
}

function clearRow(p: PopState, id: number): void {
  p.flags[id] = 0;
  p.home[id] = 0;
  p.work[id] = 0;
  p.size[id] = 0;
  p.education[id] = 0;
  p.wealth[id] = 0;
  p.children[id] = 0;
  p.satisfaction[id] = 0;
  p.daysLow[id] = 0;
  p.graceDays[id] = 0;
  p.displacedBy[id] = 0;
  p.displacedTick[id] = 0;
  p.displacedWith[id] = 0;
}

/**
 * Takes live pop `id`, and the jobs filled at workplaces `a` and `b`, out
 * of the running totals before a change. Either may be NO_WORK, and `b`
 * may be `a`.
 */
function uncount(state: SimState, id: number, a: number, b: number): void {
  countPop(state, id, -1);
  if (a !== NO_WORK) countFilled(state, a, -1);
  if (b !== NO_WORK && b !== a) countFilled(state, b, -1);
}

/** Puts live pop `id`, and the jobs filled at `a` and `b`, back into the running totals after the change `uncount` came before. */
function recount(state: SimState, id: number, a: number, b: number): void {
  countPop(state, id, 1);
  if (a !== NO_WORK) countFilled(state, a, 1);
  if (b !== NO_WORK && b !== a) countFilled(state, b, 1);
}

/** The live pop `id` and the index, or throws. */
function livePop(state: SimState, id: number): PopIndex {
  if (!isPop(state.pops, id)) throw new RangeError(`pop ${id} does not exist`);
  return popIndexOf(state);
}

/**
 * Sets pop `id`'s size. Throws, changing nothing, if it has no home
 * (M3-12), the new size is past the cap for its home's density, its home
 * has no room for it, or its
 * workplace has too few jobs for the workers it then has. A pop left with
 * nobody who works loses its job.
 */
export function setPopSize(state: SimState, id: number, size: number): void {
  const index = livePop(state, id);
  const p = state.pops;
  const home = p.home[id] ?? 0;
  if (home === NO_HOME) throw new RangeError(`pop ${id} has no home, so its size waits until it finds one`);
  const old = p.size[id] ?? 0;
  checkHomeRoom(state, home, size, (index.people[home] ?? 0) - old, old);
  const work = p.work[id] ?? NO_WORK;
  const children = p.children[id] ?? 0;
  const education = p.education[id] ?? 0;
  if (work !== NO_WORK) checkJobs(state, work, education, workersFor(size, children), education, workersFor(old, children));
  uncount(state, id, work, NO_WORK);
  unlinkWork(index, p, id);
  index.people[home] = (index.people[home] ?? 0) - old + size;
  moveSatisfactionPeople(index, p.satisfaction[id] ?? 0, size - old);
  notePopBuilding(p, home);
  p.size[id] = size;
  keepJobIfWorking(p, id);
  linkWork(index, p, id);
  recount(state, id, work, NO_WORK);
}

/**
 * Sets pop `id`'s size and children at once, for a birth or a child who
 * leaves (turnover.ts, M3-11): one check of its home and its workplace for
 * the pair, where setting them one after the other could pass through a
 * row its workplace has no jobs for. Throws, changing nothing, if the new
 * size is past the cap for its home's density, its home has no room for
 * it, children is not 0 or 1, or its workplace has too few jobs for the
 * workers it then has. A pop left with nobody who works loses its job.
 */
export function setPopHousehold(state: SimState, id: number, size: number, children: number): void {
  const index = livePop(state, id);
  const p = state.pops;
  const education = p.education[id] ?? 0;
  checkProfile({ education, wealth: p.wealth[id] ?? 0, children });
  const home = p.home[id] ?? 0;
  if (home === NO_HOME) throw new RangeError(`pop ${id} has no home, so its household waits until it finds one`);
  const old = p.size[id] ?? 0;
  checkHomeRoom(state, home, size, (index.people[home] ?? 0) - old, old);
  const work = p.work[id] ?? NO_WORK;
  if (work !== NO_WORK) checkJobs(state, work, education, workersFor(size, children), education, popWorkers(p, id));
  uncount(state, id, work, NO_WORK);
  unlinkWork(index, p, id);
  index.people[home] = (index.people[home] ?? 0) - old + size;
  moveSatisfactionPeople(index, p.satisfaction[id] ?? 0, size - old);
  notePopBuilding(p, home);
  p.size[id] = size;
  p.children[id] = children;
  keepJobIfWorking(p, id);
  linkWork(index, p, id);
  recount(state, id, work, NO_WORK);
}

/** Takes the job of pop `id`, unlinked from its workplace, if it no longer has anyone who works. */
function keepJobIfWorking(p: PopState, id: number): void {
  if (popWorkers(p, id) === 0) p.work[id] = NO_WORK;
}

/**
 * Sets pop `id`'s workplace, or takes its job with NO_WORK. Throws,
 * changing nothing, if the building is not a live one that offers jobs, it
 * has too few jobs left for the pop's workers, or the pop has no workers.
 */
export function setPopWork(state: SimState, id: number, work: number): void {
  const index = livePop(state, id);
  const p = state.pops;
  if (work !== NO_WORK) {
    if (!isBuilding(state.buildings, work) || buildingJobs(state.buildings, work) <= 0) throw new RangeError(`building ${work} offers no jobs`);
    if (popWorkers(p, id) === 0) throw new RangeError(`pop ${id} has nobody who works`);
    const education = p.education[id] ?? 0;
    const already = p.work[id] === work ? popWorkers(p, id) : 0;
    checkJobs(state, work, education, popWorkers(p, id), education, already);
  }
  const before = p.work[id] ?? NO_WORK;
  // Only the jobs filled and whether the pop's workers are employed change,
  // so only those totals move: job matching calls this for a slice of the
  // pops every tick (M3-09).
  if (before !== NO_WORK) countFilled(state, before, -1);
  if (work !== NO_WORK && work !== before) countFilled(state, work, -1);
  unlinkWork(index, p, id);
  p.work[id] = work;
  linkWork(index, p, id);
  if (before !== NO_WORK) countFilled(state, before, 1);
  if (work !== NO_WORK && work !== before) countFilled(state, work, 1);
  if ((before === NO_WORK) !== (work === NO_WORK)) countEmployment(state, popWorkers(p, id), work === NO_WORK ? -1 : 1, (p.graceDays[id] ?? 0) > 0);
}

/**
 * Sets pop `id`'s education, wealth and children. Throws, changing
 * nothing, if any is out of range, or a change of children leaves its
 * workplace too few jobs for its workers. A pop left with nobody who works
 * loses its job.
 */
export function setPopProfile(state: SimState, id: number, profile: PopProfile): void {
  const index = livePop(state, id);
  checkProfile(profile);
  const p = state.pops;
  const work = p.work[id] ?? NO_WORK;
  const size = p.size[id] ?? 0;
  if (work !== NO_WORK) checkJobs(state, work, profile.education, workersFor(size, profile.children), p.education[id] ?? 0, popWorkers(p, id));
  uncount(state, id, work, NO_WORK);
  unlinkWork(index, p, id);
  p.education[id] = profile.education;
  p.wealth[id] = profile.wealth;
  p.children[id] = profile.children;
  keepJobIfWorking(p, id);
  linkWork(index, p, id);
  recount(state, id, work, NO_WORK);
}

/**
 * Sets pop `id`'s satisfaction, keeping the residents' summed satisfaction
 * and the index's people by score current. Throws if it is not a whole
 * number from 0 to SATISFACTION_MAX.
 */
export function setPopSatisfaction(state: SimState, id: number, satisfaction: number): void {
  const index = livePop(state, id);
  checkSatisfaction(satisfaction);
  const p = state.pops;
  const old = p.satisfaction[id] ?? 0;
  if (old === satisfaction) return;
  const size = p.size[id] ?? 0;
  moveSatisfactionPeople(index, old, -size);
  moveSatisfactionPeople(index, satisfaction, size);
  countSatisfaction(state, size * (satisfaction - old));
  p.satisfaction[id] = satisfaction;
}

/**
 * Sets the game days of grace pop `id` has left (#361). Its workers, if it
 * has no job, move between the unemployed newcomers and the settled
 * unemployed when that takes it to or from 0. Throws if it is not a whole
 * number from 0 to GRACE_DAYS_LIMIT.
 */
export function setPopGraceDays(state: SimState, id: number, days: number): void {
  livePop(state, id);
  checkGraceDays(days);
  const p = state.pops;
  const was = (p.graceDays[id] ?? 0) > 0;
  p.graceDays[id] = days;
  if (was !== days > 0 && p.work[id] === NO_WORK) countNewcomersUnemployed(state, popWorkers(p, id), days > 0 ? 1 : -1);
}

/** Sets the game days pop `id`'s satisfaction has been low. Throws if it is not a whole number from 0 to DAYS_LOW_LIMIT. */
export function setPopDaysLow(state: SimState, id: number, days: number): void {
  livePop(state, id);
  checkDaysLow(days);
  state.pops.daysLow[id] = days;
}

/** Takes the mark of its last displacement off pop `id`, once it is a game year old (satisfaction.ts). */
export function clearPopDisplaced(state: SimState, id: number): void {
  livePop(state, id);
  const p = state.pops;
  p.displacedBy[id] = DISPLACED_BY_NONE;
  p.displacedTick[id] = 0;
  p.displacedWith[id] = 0;
}

/**
 * Displaces the pops who live in buildings `ids` and takes the jobs of
 * those who work in them, so state never names a building that is gone
 * (M3-12). Each resident's home becomes NO_HOME and it joins the end of the
 * queue of displaced pops, by building and then pop id as given, so the
 * queue reads the same on every machine. It keeps its job unless that was
 * in one of `ids` too, and its people stay in the population. The
 * building module calls it before it clears the rows. Free when the city
 * has no pops.
 *
 * Each resident is marked (M4-10) with this tick and the people its
 * building held: by its owner when `byOwner` says the buildings are being
 * redeveloped, else by the city for a building the city paid to clear
 * (`BuildingState.paid`, M4-09). A pop moved out any other way, as when
 * a road change leaves a lot with no ground, is not marked.
 */
export function displaceBuildingPops(state: SimState, ids: readonly number[], byOwner = false): void {
  if (popCount(state.pops) === 0) return;
  const paid = state.buildings.paid;
  const index = popIndexOf(state);
  const p = state.pops;
  const queued: number[] = [];
  for (const building of ids) {
    if ((index.workHead[building] ?? -1) >= 0) {
      countFilled(state, building, -1);
      // Only its workers' employment moves: the building's jobs filled are already out of the totals.
      const { all, newcomers } = emptyWork(index, p, building);
      countEmployment(state, all - newcomers, -1, false);
      countEmployment(state, newcomers, -1, true);
    }
    // Only the residents of the home's density move in the totals: its pops are still the city's people.
    const people = index.people[building] ?? 0;
    if (people > 0) countHomeDensity(state, building, -people);
    const from = queued.length;
    emptyHome(index, p, building, queued);
    // An owner's redevelopment is the owner's, even of a building the city once paid to clear and left standing, as a road undone before its buildings went does.
    const by = byOwner ? DISPLACED_BY_OWNER : (paid[building] ?? 0) !== 0 ? DISPLACED_BY_CITY : DISPLACED_BY_NONE;
    if (by === DISPLACED_BY_NONE) continue;
    const together = Math.min(people, DISPLACED_WITH_LIMIT);
    for (let i = from; i < queued.length; i++) {
      const id = queued[i] as number;
      p.displacedBy[id] = by;
      p.displacedTick[id] = state.tick;
      p.displacedWith[id] = together;
    }
  }
  if (queued.length === 0) return;
  const queue = resized(p.displaced, p.displaced.length + queued.length);
  queue.set(queued, p.displaced.length);
  p.displaced = queue;
}

/**
 * Moves pop `id`, which has no home, into building `home` (M3-12). It
 * keeps its size, profile, satisfaction and job. Throws, changing nothing,
 * if the pop has a home already, the building is not a live home, its
 * size is past the cap for the home's density, or the home has no room
 * for it. The caller takes it off the queue of displaced pops.
 */
export function rehomePop(state: SimState, id: number, home: number): void {
  const index = livePop(state, id);
  const p = state.pops;
  if (p.home[id] !== NO_HOME) throw new RangeError(`pop ${id} has a home`);
  if (!isBuilding(state.buildings, home) || (state.buildings.residents[home] ?? 0) <= 0) throw new RangeError(`building ${home} is not a home`);
  if (isAbandoned(state.buildings, home)) throw new RangeError(`building ${home} is abandoned`);
  checkHomeRoom(state, home, p.size[id] ?? 0, index.people[home] ?? 0);
  moveHome(index, p, id, home);
  countHomeDensity(state, home, p.size[id] ?? 0);
}

// --- Loading -----------------------------------------------------------------

/**
 * Why `value` is not a well-formed set of pops for `buildings`, or null if
 * it is. For loading a save: every id live or free, never both, a free
 * id's row all zeros, every live pop in a live home, or with no home and
 * in the queue of displaced pops, which names each live pop at most once,
 * with at least one person and its fields in range, working nowhere or at a live building
 * with jobs, no home holding more people than its stored room, the
 * sweep's limit within the ids handed out, the plan of arrivals a whole
 * number of 0 or below, and the plan of departures a score to leave at, or
 * NO_LEAVING, and a whole number of people.
 *
 * What depends on the balance files is not checked: the size cap, a
 * building's jobs and the share of a pop who work. A save made before they
 * were tuned may break them, and it still loads. Until displacement and
 * job matching settle such a pop (M3-12, M3-09), it keeps its size and its
 * job.
 */
export function checkPops(value: unknown, buildings: BuildingState, tick = Number.MAX_SAFE_INTEGER): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not an object";
  const raw = value as Record<string, unknown>;
  for (const [key, Type] of Object.entries(ARRAY_TYPES)) {
    if (!(raw[key] instanceof Type)) return `${key} is not a ${Type.name}`;
  }
  if (!(raw["displaced"] instanceof Int32Array)) return "displaced is not an Int32Array";
  const others = ["sweep", "owed", "leaveScore", "leaveAtScore", "displaced"];
  const extra = Object.keys(raw).find((key) => !(key in ARRAY_TYPES) && !others.includes(key));
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  const p = raw as unknown as PopState;
  const limit = p.flags.length;
  if (POP_ARRAYS.some((key) => p[key].length !== limit)) return "its arrays differ in length";
  if (!Number.isSafeInteger(p.sweep) || p.sweep < 0 || p.sweep > limit) return "its sweep is not a pop id limit";
  if (!Number.isSafeInteger(p.owed) || p.owed > 0) return "its plan of arrivals is not a whole number of 0 or below";
  if (!Number.isSafeInteger(p.leaveScore) || p.leaveScore < NO_LEAVING || p.leaveScore > SATISFACTION_MAX) return "its plan of departures has no score to leave at";
  if (!Number.isSafeInteger(p.leaveAtScore)) return "its plan of departures is not a whole number of people";
  const seen = new Uint8Array(limit);
  for (const id of p.free) {
    if (id < 0 || id >= limit || seen[id] || isPop(p, id)) return "its free list is malformed";
    seen[id] = 1;
  }
  const waiting = new Uint8Array(limit);
  for (const id of p.displaced) {
    if (id < 0 || id >= limit || waiting[id] || !isPop(p, id)) return "its queue of displaced pops names a pop twice or one that does not exist";
    waiting[id] = 1;
  }
  const people = new Float64Array(buildings.flags.length);
  for (let id = 0; id < limit; id++) {
    const flags = p.flags[id] ?? 0;
    if (flags !== 0 && flags !== POP_ALIVE) return `pop ${id} has unknown flags`;
    if (flags === 0) {
      if (!seen[id]) return `id ${id} is neither live nor free`;
      if (POP_ARRAYS.some((key) => p[key][id] !== 0)) return `free id ${id} has a row`;
      continue;
    }
    const home = p.home[id] ?? 0;
    if ((home === NO_HOME) !== (waiting[id] === 1)) return `pop ${id} has no home and is not in the queue of displaced pops, or is in it with a home`;
    if (home !== NO_HOME && (!isBuilding(buildings, home) || (buildings.residents[home] ?? 0) <= 0)) return `pop ${id} lives in a building that is not a home`;
    if (home !== NO_HOME && isAbandoned(buildings, home)) return `pop ${id} lives in an abandoned building`;
    const size = p.size[id] ?? 0;
    if (size < 1) return `pop ${id} has nobody in it`;
    if ((p.education[id] ?? 0) >= POP_LEVELS || (p.wealth[id] ?? 0) >= POP_LEVELS) return `pop ${id} has a bad education or wealth`;
    if ((p.children[id] ?? 0) > 1) return `pop ${id} has a bad children flag`;
    if ((p.satisfaction[id] ?? 0) > SATISFACTION_MAX) return `pop ${id} is past the highest satisfaction`;
    const markProblem = displacedMarkProblem(p.displacedBy[id] ?? 0, p.displacedTick[id] ?? 0, p.displacedWith[id] ?? 0);
    if (markProblem !== null) return `pop ${id}'s mark: ${markProblem}`;
    if ((p.displacedTick[id] ?? 0) > tick) return `pop ${id} was displaced after the city's tick`;
    if (home !== NO_HOME) people[home] = (people[home] ?? 0) + size;
    const work = p.work[id] ?? NO_WORK;
    if (work === NO_WORK) continue;
    if (!isBuilding(buildings, work) || buildingJobs(buildings, work) <= 0) return `pop ${id} works at a building with no jobs`;
  }
  for (let b = 0; b < buildings.flags.length; b++) {
    if ((people[b] ?? 0) > (buildings.residents[b] ?? 0)) return `building ${b} holds more people than it has room for`;
  }
  return null;
}
