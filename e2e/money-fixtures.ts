// The city the money spec opens (M4-14): the M3 walkthrough's town of
// streets off the west outside connection (m3-walkthrough-city.ts), zoned
// at density 1 only and with no milestone credited, so its first milestone
// is reached in play. Built in Node with the sim and handed to the page as
// a city file.
//
// The town is stepped a day at a time until its population first passes
// the first milestone, and the file is the city as it stood the day before,
// saved paused. Stepping is the same on every host (CLAUDE.md rule 3), so
// the page reaches the milestone at the same tick Node did.

import { CHARGE_LINES, LINE, MILESTONES, TIME_BALANCE, createState, creditLeft, deserialize, fundCity, isMonthStart, previewBuildRoad, serialize, step, submit, type SimState } from "../packages/sim/src/index";
import { zoneSides } from "./building-fixtures";

const SEED = 2026;
const DAY = TIME_BALANCE.ticksPerDay;
/** Days the town is given to reach its first milestone before the fixture gives up. */
const MAX_DAYS = 365;

/** Residential, commercial, office and industrial at density 1, as `zoneSides` takes pairs: mostly homes, with work for them. */
const DENSITY_ONE_SIDES = [0, 0, 3, 0, 6, 0, 0, 9] as const;

/** The M3 walkthrough's streets: main street from the stub east, the spine south, and four streets across it. */
const TOWN_STREETS: readonly (readonly [readonly [number, number], readonly [number, number]])[] = [
  [[200, 3608], [680, 3608]],
  [[440, 3608], [440, 4400]],
  [[200, 3800], [680, 3800]],
  [[200, 4000], [680, 4000]],
  [[200, 4200], [680, 4200]],
  [[320, 4400], [680, 4400]],
];

/** The street the spec builds: east from the end of the houses' street, on open ground. */
export const NEW_STREET = { from: { x: 680, z: 4000 }, to: { x: 820, z: 4000 }, type: "street" } as const;

let seq = 0;
/** Sends a command as the fixture's player and steps until it has applied, or throws with why it was refused. */
export function send(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, { seq: ++seq, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
  // A command waits for a change of roads to settle before it applies.
  while (state.pending.length > 0) step(state);
}

/** The town's streets, built by commands and paid for from the starting grant, and its sides zoned at density 1. */
export function zonedTown(): SimState {
  const state = createState(SEED);
  for (const [a, b] of TOWN_STREETS) send(state, "BuildRoad", { from: { x: a[0], z: a[1] }, to: { x: b[0], z: b[1] }, type: "street" });
  zoneSides(state, 0, DENSITY_ONE_SIDES);
  return state;
}

export interface MilestoneEve {
  /** The city file, saved paused a day before the first milestone. */
  bytes: Uint8Array;
  /** The city in the file. */
  state: SimState;
  /** The tick the town reached the first milestone on when Node stepped it on. */
  reachedAt: number;
  /** What `NEW_STREET` costs on the city in the file: the price the road tool shows and the sim charges. */
  streetPrice: number;
}

/** The town a day short of its first milestone. */
export function milestoneEveCity(): MilestoneEve {
  const state = zonedTown();
  const first = MILESTONES[0];
  if (!first) throw new Error("no milestones in progression.json");
  let eve = serialize(state);
  for (let day = 0; state.milestones.length === 0; day++) {
    if (day >= MAX_DAYS) throw new Error(`the town has ${state.stats.highestPopulation} residents after ${MAX_DAYS} days, short of ${first.name} at ${first.population}`);
    eve = serialize(state);
    for (let i = 0; i < DAY; i++) step(state);
  }
  const reachedAt = state.milestones[0] ?? -1;
  // The file's own copy, paused, so the figures hold still until the spec runs it.
  const saved = deserialize(eve).state;
  saved.speed = 0;
  const preview = previewBuildRoad(saved, NEW_STREET);
  if (!preview.ok) throw new Error(`the spec's street is refused: ${preview.reason}`);
  if (preview.refusal) throw new Error(`the town cannot pay for the spec's street: ${preview.refusal}`);
  if (preview.clears.ids.length > 0) throw new Error("the spec's street would clear buildings");
  return { bytes: serialize(saved), state: saved, reachedAt, streetPrice: preview.price };
}

/**
 * A city a street has taken below zero, for the time card's warning colour.
 * Funded low in its first month, so the street in its second is paid for by
 * the overdraft, and the month's ledger in the tooltip holds the street's
 * construction rather than the funding.
 */
export function overdrawnCity(): { bytes: Uint8Array; treasury: number } {
  const state = createState(SEED);
  fundCity(state, 300_000);
  while (state.tick < 31 * DAY) step(state);
  send(state, "BuildRoad", { from: { x: 200, z: 3608 }, to: { x: 680, z: 3608 }, type: "street" });
  if (state.budget.treasury >= 0) throw new Error(`the street left the treasury at ${state.budget.treasury}, not below zero`);
  state.speed = 0;
  return { bytes: serialize(state), treasury: state.budget.treasury };
}

export interface BudgetCity {
  /** The city file, saved paused a few days into a month, with closed months behind it. */
  bytes: Uint8Array;
  /** The city in the file. */
  state: SimState;
  /** The treasury the month before the last one opened with, so last month's net is `state.budget.opening` less it. */
  lastMonthOpening: number;
  /** What the city may still borrow, as the sim works it out. */
  creditLeft: number;
}

/** Closed months the budget panel's city has behind it, so its graph has a line to draw. */
const BUDGET_MONTHS = 2;

/**
 * The money spec's town run on for `BUDGET_MONTHS` months' closes and a few
 * days more (M4-15), so the budget panel has a last month with taxes,
 * development charges and road upkeep on it, a month in progress and a
 * graph. Saved paused.
 */
export function budgetCity(): BudgetCity {
  const state = zonedTown();
  let closes = 0;
  let lastMonthOpening = state.budget.opening;
  while (closes < BUDGET_MONTHS) {
    const before = state.budget.opening;
    step(state);
    // The step onto a month's first tick closes the month before it.
    if (isMonthStart(state.tick)) {
      closes++;
      lastMonthOpening = before;
    }
  }
  for (let i = 0; i < 5 * DAY; i++) step(state);
  state.speed = 0;
  if (state.budget.lastMonth[LINE.taxResidential] === 0) throw new Error("the budget city's last month has no residential tax");
  if (CHARGE_LINES.every((line) => state.budget.lastMonth[LINE[line]] === 0)) throw new Error("the budget city's last month has no development charge");
  return { bytes: serialize(state), state, lastMonthOpening, creditLeft: creditLeft(state) };
}
