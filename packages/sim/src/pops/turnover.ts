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
// (`workersFor`). When its workplace has no job for the extra worker, the
// pop gives the job up and job matching, which runs after this in the same
// tick and visits the same slice, finds it one again, splitting it if it
// has to (matching.ts). A replaced household is on the same id, so it too
// looks for work that tick.
//
// Arithmetic is add, multiply and divide (CLAUDE.md rule 6), and nothing
// here is state beyond the pops and the generator.

import { yearDays } from "../calendar";
import { nextFloat } from "../rng";
import type { SimState } from "../state";
import type { System } from "../step";
import { noteYear } from "../stats/stats";
import { drawProfile, drawSize } from "./arrivals";
import { POPS_BALANCE } from "./balance";
import { jobsProblem } from "./open-jobs";
import { NO_WORK, POP_ALIVE, addPop, popSizeCap, removePop, setPopHousehold, setPopWork, workersFor } from "./pops";
import { homeReachesOutside, homeRoomLeft } from "./room";
import { popSlice } from "./sweep";
import { popIndexOf } from "./where";

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
  const profile = drawProfile(rng);
  // The id just freed is the last on the free list, so the newcomer takes it.
  addPop(state, { home, size, ...profile, satisfaction: POPS_BALANCE.newcomer.satisfaction });
  noteYear(state, "arrivals", size);
}

/** Sets pop `id` to `size` people and `children`, removing it at nobody, and giving up its job first when its workplace has none for its new workers. */
function reshape(state: SimState, id: number, size: number, children: number): void {
  if (size === 0) {
    removePop(state, id);
    return;
  }
  const p = state.pops;
  const work = p.work[id] ?? NO_WORK;
  if (work !== NO_WORK) {
    const education = p.education[id] ?? 0;
    const was = workersFor(p.size[id] ?? 0, p.children[id] ?? 0);
    if (jobsProblem(state, state.buildings, work, education, workersFor(size, children), education, was) !== null) setPopWork(state, id, NO_WORK);
  }
  setPopHousehold(state, id, size, children);
}

/** Whether pop `id` may gain a person: its home has room for one more and it is below its size cap. */
function roomForBirth(state: SimState, id: number): boolean {
  const p = state.pops;
  const home = p.home[id] ?? 0;
  const b = state.buildings;
  const size = p.size[id] ?? 0;
  if (size >= popSizeCap(b.density[home] ?? 1)) return false;
  return (popIndexOf(state).people[home] ?? 0) < (b.residents[home] ?? 0);
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
