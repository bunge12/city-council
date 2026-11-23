// Turnover (M3-11, PRD "Turnover").
//
// Pops do not age. A pop is a household slot, and over time the household
// in it changes. The TURNOVER system visits the day's slice of the pops
// (sweep.ts), so every pop once a game day, and gives each one draw from the
// generator in state. The draw picks at most one of four events, each with
// its yearly rate in `turnover` in pops.json turned into a daily chance by
// dividing by the days in a year:
//
// - Household replaced, `replacementsPerPopYear` a pop. The household moves
//   out and a newcomer takes the home: its size, education, wealth and
//   children are drawn again as for an arrival (arrivals.ts), its old job is
//   freed, and the newcomer starts with no job and a newcomer's
//   satisfaction. The old people count as a departure and the new as an
//   arrival. One rate for all housing: the game does not model owning or
//   renting. A home newcomers cannot reach, on a road joined to no outside
//   connection, gets nobody: the household leaves and the home stands empty.
// - Death, `deathsPerPersonYear` a person, so a pop's chance is the rate
//   times its size. The pop loses a person.
// - A child grows up and leaves, for a pop with children, 1 over
//   `childrenLeaveYears` a year. The pop loses a person, a departure, and no
//   longer counts as having children. A pop of one with children only drops
//   the mark: one person cannot be both the parent and the child who leaves.
// - Birth, `birthsPerPersonYear` a person, like deaths. The pop gains a
//   person and is marked as having children, if its home has room for one
//   more and the pop is below its size cap.
//
// The chances sit end to end on the draw in that order, so a pop has at
// most one event a day. Their sum stays far below 1 for any pop the size
// caps allow. A pop that falls to nobody is removed, and its home stands
// vacant until arrivals fill it.
//
// A birth or a child leaving can change how many of a pop's people work
// (`workersFor`): a tower pop of 100 whose child leaves goes from 40 workers
// to 59. When its workplace has no job for the extra workers, the pop splits
// as job matching splits one: the part whose workers fit keeps the job and
// the rest looks again. A single family home's household is not split; it
// gives the job up, and job matching, which runs after this in the same
// tick and visits the same slice, looks for one again. A replaced household
// is on the same id, so it too looks for work that tick.
//
// A replacement's newcomer is sized to the room the old household leaves
// and any other room beside it, even when that is below the least newcomer
// household for the density (room.ts): the slot stays filled rather than
// standing as a gap no arrival may take.
//
// Arithmetic is add, multiply and divide (CLAUDE.md rule 6), and nothing
// here is state beyond the pops and the generator.

import { yearDays } from "../calendar";
import { nextFloat } from "../rng";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteYear } from "../stats/stats";
import { drawProfile, drawSize } from "./arrivals";
import { buildingValue } from "../landvalue/land-value";
import { POPS_BALANCE } from "./balance";
import { BUILDING_TYPES } from "../buildings/balance";
import { homeRoom } from "../buildings/buildings";
import { partThatFits } from "./matching";
import { jobsProblem, openJobsFor } from "./open-jobs";
import { NO_HOME, NO_WORK, POP_ALIVE, addPop, popSizeCap, removePop, setPopHousehold, setPopSize, setPopWork, workersFor } from "./pops";
import { homeReachesOutside, homeRoomLeft } from "./room";
import { popSlice } from "./sweep";
import { popIndexOf } from "./where";

/** By type index: 1 for a type one household lives in, whose pop is never split. */
const ONE_HOUSEHOLD = Uint8Array.from(BUILDING_TYPES, (t) => (t.oneHousehold ? 1 : 0));

/** The name the timer hook reports for turnover. */
export const TURNOVER_SYSTEM = "turnover";

/** One game day's chances, from the yearly rates in pops.json. */
export interface DayChances {
  /** A pop's chance its household is replaced. */
  replace: number;
  /** One person's chance of dying. */
  deathPerPerson: number;
  /** A pop with children's chance a child leaves. */
  childLeaves: number;
  /** One person's chance of a birth. */
  birthPerPerson: number;
}

/** The yearly rates in pops.json as chances a game day, each divided by the days in a year. */
export function dayChances(): DayChances {
  const t = POPS_BALANCE.turnover;
  const days = yearDays();
  return {
    replace: t.replacementsPerPopYear / days,
    deathPerPerson: t.deathsPerPersonYear / days,
    childLeaves: 1 / (t.childrenLeaveYears * days),
    birthPerPerson: t.birthsPerPersonYear / days,
  };
}

/** What the draw gave a pop: nothing, or one of the four events. */
export type TurnoverEvent = "none" | "replaced" | "death" | "childLeaves" | "birth";

/** The event a draw of `u` from [0, 1) gives a pop of `size` people, with `children`, as the header orders them. */
export function turnoverEvent(chances: DayChances, u: number, size: number, children: number): TurnoverEvent {
  let edge = chances.replace;
  if (u < edge) return "replaced";
  edge += chances.deathPerPerson * size;
  if (u < edge) return "death";
  if (children) {
    edge += chances.childLeaves;
    if (u < edge) return "childLeaves";
  }
  edge += chances.birthPerPerson * size;
  return u < edge ? "birth" : "none";
}

/** Moves pop `id`'s household out and, if newcomers can reach the home, a newcomer in on the same id. */
function replace(state: SimState, id: number): void {
  const p = state.pops;
  const home = p.home[id] ?? 0;
  noteYear(state, "departures", p.size[id] ?? 0);
  removePop(state, id);
  const room = homeRoomLeft(state, home);
  if (room === 0 || !homeReachesOutside(state, home)) return;
  const rng = state.rng;
  const size = drawSize(rng, state.buildings.density[home] ?? 1, room);
  const profile = drawProfile(rng, buildingValue(state, home));
  // The id just freed is the last on the free list, so the newcomer takes it.
  addPop(state, { home, size, ...profile, satisfaction: POPS_BALANCE.newcomer.satisfaction });
  noteYear(state, "arrivals", size);
}

/**
 * Sets pop `id` to `size` people and `children`, removing it at nobody. When
 * its workplace has no job for the workers it then has, it gives the job up
 * and, outside a single family home, splits as job matching splits a pop
 * (matching.ts): the largest part whose workers fit the open jobs keeps the
 * job, and the rest becomes a pop of its own that looks again. So a tower pop
 * whose child leaves does not put all of its workers out of work for the one
 * more it gained.
 */
function reshape(state: SimState, id: number, size: number, children: number): void {
  if (size === 0) {
    removePop(state, id);
    return;
  }
  const p = state.pops;
  const work = p.work[id] ?? NO_WORK;
  const education = p.education[id] ?? 0;
  const was = workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
  if (work === NO_WORK || jobsProblem(state, state.buildings, work, education, workersFor(size, children), education, was) === null) {
    setPopHousehold(state, id, size, children);
    return;
  }
  setPopWork(state, id, NO_WORK);
  setPopHousehold(state, id, size, children);
  const home = p.home[id] ?? 0;
  if (ONE_HOUSEHOLD[state.buildings.type[home] ?? 0] === 1) return;
  const part = partThatFits(size, children, openJobsFor(state, work, education));
  if (part === 0) return;
  setPopSize(state, id, part);
  // The rest keeps the household's score and its days low, as a split in job matching does.
  addPop(state, { home, size: size - part, education, wealth: p.wealth[id] ?? 0, children, satisfaction: p.satisfaction[id] ?? 0, daysLow: p.daysLow[id] ?? 0 });
  setPopWork(state, id, work);
}

/** Whether pop `id` may gain a person: its home has room for one more and it is below its size cap. */
function roomForBirth(state: SimState, id: number): boolean {
  const p = state.pops;
  const home = p.home[id] ?? 0;
  const b = state.buildings;
  const size = p.size[id] ?? 0;
  if (size >= popSizeCap(b.density[home] ?? 1)) return false;
  return (popIndexOf(state).people[home] ?? 0) < homeRoom(b, home);
}

/** The turnover system's work for one tick, as the header says. */
export function turnOver(state: SimState): void {
  const { from, to } = popSlice(state);
  if (from >= to) return;
  const chances = dayChances();
  const p = state.pops;
  const rng = state.rng;
  for (let id = from; id < to; id++) {
    if (((p.flags[id] ?? 0) & POP_ALIVE) === 0) continue;
    // A displaced pop waits in the queue for a home (M3-12); its household changes once it has one.
    if (p.home[id] === NO_HOME) continue;
    const size = p.size[id] ?? 0;
    const children = p.children[id] ?? 0;
    const event = turnoverEvent(chances, nextFloat(rng), size, children);
    if (event === "none") continue;
    if (event === "replaced") replace(state, id);
    else if (event === "death") {
      noteYear(state, "deaths", 1);
      reshape(state, id, size - 1, children);
    } else if (event === "childLeaves") {
      if (size > 1) noteYear(state, "departures", 1);
      reshape(state, id, size > 1 ? size - 1 : size, 0);
    } else if (roomForBirth(state, id)) {
      noteYear(state, "births", 1);
      reshape(state, id, size + 1, 1);
    }
  }
}

/**
 * The step's system for turnover. It runs after arrivals and before job
 * matching, so a newcomer who replaces a household, and a pop that gave up
 * a job it no longer fits, look for work the same tick, and before
 * satisfaction, which scores the day's households as they now are.
 */
export const TURNOVER: System = { name: TURNOVER_SYSTEM, run: turnOver };
