// Eminent domain (M4-09, PRD "Eminent domain" and "Removing things").
//
// Clearing a building the city does not own costs money, and the price is
// known before the click. An occupied building, one somebody lives or
// works in, costs its value (economy/value.ts), plus a relocation payment
// for each resident and each job filled that the clearing displaces, plus
// a premium on the value. A building nobody lives or works in, vacant,
// abandoned or just built, costs its demolition only: its floor space at
// the demolition price. Empty cells are free. A landmark, the city's own,
// costs its demolition less the refund share of its price (M4-13).
//
// Who counts as displaced is read from the pops as the plan sees them: the
// people living in the building and the jobs filled there. The sim reads
// its own pop index; a client's copy holds no pop rows and passes the
// counts its mirror keeps (M3-05), so the tag and the charge use the same
// function on the same numbers.
//
// Every command that clears buildings charges this on the compensation
// line: `BulldozeBuilding`, and the road commands for the buildings their
// rehearsal finds (buildings/bulldoze.ts). Rezoning charges nothing, and
// neither does redevelopment by an owner, which removes buildings through
// `removeBuildings` directly and never comes here.
//
// A road command pays for the buildings it takes on the tick it applies,
// but a new road's buildings go only once its cells settle, a few ticks on
// for a big change and not at all while the game is paused. So each
// building charged for is marked paid (`BuildingState.paid`), and one paid
// for and still standing costs nothing to clear again and leaves no second
// record. A road undone before its buildings go leaves them standing, paid
// for: undo never refunds compensation.
//
// Each occupied building cleared this way leaves an expropriation record
// in state: the tick, its lot's centre, the people and jobs displaced and
// the player. Issue M4-10 reads them for the neighbours' satisfaction.
// Records older than a game year are dropped as the tick passes them, and
// the list holds at most `expropriationsMax` (economy.json), the oldest
// dropped first.
//
// Whole dollars, and only multiply, add and floor, so every host agrees
// (rule 6).

import { BUILDING_TYPES } from "../buildings/balance";
import { isBuilding, isLandmark, type BuildingState } from "../buildings/buildings";
import { landmarkClearing } from "../buildings/landmarks";
import { noteBuildingChanged } from "../buildings/changes";
import { lotJobs } from "../buildings/jobs";
import { lotCentres } from "../buildings/where";
import { TIME_BALANCE, yearDays } from "../calendar";
import type { SimState } from "../state";
import { ECONOMY } from "./balance";
import { moveMoney } from "./budget";
import { floorSpaceOf, propertyValues } from "./value";

/** What clearing some buildings costs, and its parts. Whole dollars. */
export interface Compensation {
  /**
   * What the command charges: `value + relocation + premium + demolition +
   * cityDemolition - refund`. The city's own buildings' part,
   * `cityDemolition - refund`, goes on the demolition line, as a road's
   * does, and the rest on the compensation line (`chargeCompensation`).
   */
  total: number;
  /** The value of the occupied buildings. */
  value: number;
  /** The relocation payments: `relocationPerResident` for each resident and `relocationPerJob` for each job filled. */
  relocation: number;
  /** The premium on the occupied buildings' value. */
  premium: number;
  /** The demolition of the buildings nobody lives or works in. */
  demolition: number;
  /** The demolition of the city's own buildings, its landmarks (M4-13). */
  cityDemolition: number;
  /** The refund share of the city's own buildings' price, which comes off the total (M4-13). */
  refund: number;
  /** The people living in the occupied buildings, who are displaced. */
  residents: number;
  /** The jobs filled in them, whose workers lose their job. */
  jobs: number;
  /** How many of the buildings are occupied. */
  occupied: number;
  /** How many are priced at demolition only. */
  empty: number;
  /** How many the city has paid for already, which cost nothing. */
  paid: number;
  /** How many are the city's own, its landmarks, priced at demolition less the refund (M4-13). */
  cityOwned: number;
}

/** Clearing nothing: free. */
export const NO_COMPENSATION: Readonly<Compensation> = Object.freeze({ total: 0, value: 0, relocation: 0, premium: 0, demolition: 0, cityDemolition: 0, refund: 0, residents: 0, jobs: 0, occupied: 0, empty: 0, paid: 0, cityOwned: 0 });

/** Counts by building id: the people living there, or the jobs filled there. */
export type CountIn = (id: number) => number;

/** The demolition price of building `id`: its floor space, as built, at `demolitionPerSquareMetre`. */
function demolitionOf(b: BuildingState, id: number): number {
  const type = BUILDING_TYPES[b.type[id] ?? 0];
  if (!type) return 0;
  const space = floorSpaceOf(type, b.residents[id] ?? 0, lotJobs(b, id)).total;
  return Math.floor(space * ECONOMY.eminentDomain.demolitionPerSquareMetre);
}

/**
 * What clearing buildings `ids` of `state` costs, with `people` and
 * `filled` giving each one's residents and jobs filled. An id that is not a
 * live building costs nothing, and so does one already paid for. The ids
 * need not be sorted, and the sum does not depend on their order.
 */
export function compensationFor(state: SimState, ids: readonly number[], people: CountIn, filled: CountIn): Compensation {
  if (ids.length === 0) return { ...NO_COMPENSATION };
  const d = ECONOMY.eminentDomain;
  const b = state.buildings;
  const values = propertyValues(state, ids);
  const out: Compensation = { ...NO_COMPENSATION };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    if (!isBuilding(b, id)) continue;
    if ((b.paid[id] ?? 0) !== 0) {
      out.paid++;
      continue;
    }
    if (isLandmark(b, id)) {
      const clearing = landmarkClearing(b, id);
      out.cityDemolition += clearing.demolition;
      out.refund += clearing.refund;
      out.cityOwned++;
      continue;
    }
    const residents = people(id);
    const jobs = filled(id);
    if (residents > 0 || jobs > 0) {
      const value = values[i] ?? 0;
      out.value += value;
      out.relocation += residents * d.relocationPerResident + jobs * d.relocationPerJob;
      out.premium += Math.floor(value * d.premium);
      out.residents += residents;
      out.jobs += jobs;
      out.occupied++;
    } else {
      out.demolition += demolitionOf(b, id);
      out.empty++;
    }
  }
  out.total = out.value + out.relocation + out.premium + out.demolition + out.cityDemolition - out.refund;
  return out;
}

/** One building cleared with people in it (M4-09), for issue M4-10's satisfaction hit and the overlay after it. */
export interface Expropriation {
  /** The tick the clearing was charged on. */
  tick: number;
  /** The centre of the building's lot, metres. */
  x: number;
  z: number;
  /** The people who lived there. */
  people: number;
  /** The jobs filled there. */
  jobs: number;
  /** Who cleared it. */
  playerId: string;
}

/** How long a record is kept, in ticks: a game year. */
export function expropriationTicks(): number {
  return yearDays() * TIME_BALANCE.ticksPerDay;
}

/**
 * Charges `compensation`, the price of clearing buildings `ids` that
 * `compensationFor` gave with the same `people` and `filled`, on the
 * compensation line, and a landmark's demolition less its refund on the
 * demolition line (M4-13), records each occupied one for `playerId`, and marks
 * every one paid for. One already paid for is passed over, as
 * `compensationFor` priced it. Called before the buildings go, while their
 * pops and lots are still there.
 */
export function chargeCompensation(state: SimState, playerId: string, ids: readonly number[], compensation: Compensation, people: CountIn, filled: CountIn): void {
  // The city's own buildings are not expropriated: theirs is a demolition, less its refund, as a road's is (M4-13).
  const owned = compensation.cityDemolition - compensation.refund;
  if (compensation.total - owned !== 0) moveMoney(state, "compensation", compensation.total - owned);
  if (owned !== 0) moveMoney(state, "demolition", owned);
  const b = state.buildings;
  const sorted = [...ids].sort((p, q) => p - q);
  const added: Expropriation[] = [];
  const centres = compensation.occupied > 0 ? lotCentres(state) : null;
  for (const id of sorted) {
    if (!isBuilding(b, id) || (b.paid[id] ?? 0) !== 0) continue;
    b.paid[id] = 1;
    noteBuildingChanged(b, id);
    const residents = people(id);
    const jobs = filled(id);
    if (centres && (residents > 0 || jobs > 0)) added.push({ tick: state.tick, x: centres.x[id] ?? 0, z: centres.z[id] ?? 0, people: residents, jobs, playerId });
  }
  if (added.length > 0) keepExpropriations(state, [...state.expropriations, ...added]);
}

/** Sets the list to `list`, less what is past the cap, the oldest first. Replaced, never changed in place. */
function keepExpropriations(state: SimState, list: Expropriation[]): void {
  const most = ECONOMY.expropriationsMax;
  state.expropriations = list.length > most ? list.slice(list.length - most) : list;
}

/**
 * Drops the records a game year old or older on `state.tick`. The step
 * calls it once a tick, after it advances the tick. The list is oldest
 * first, so this looks at its head only.
 */
export function dropOldExpropriations(state: SimState): void {
  const list = state.expropriations;
  if (list.length === 0) return;
  const from = state.tick - expropriationTicks();
  let keep = 0;
  while (keep < list.length && (list[keep] as Expropriation).tick <= from) keep++;
  if (keep > 0) state.expropriations = list.slice(keep);
}

// --- Deltas ------------------------------------------------------------------------

/**
 * How the list changed from one a client last had: how many records went
 * from its head, and the records added at its tail, copies. The list only
 * drops from its head and adds at its tail, so that is the whole change.
 */
export interface ExpropriationDelta {
  dropped: number;
  added: Expropriation[];
}

/**
 * The change from `sent` to `now`, two lists the sim held, `now` a later one.
 * Records are shared between them, never copied (`chargeCompensation`), so
 * the first record of `now` that `sent` holds tells how many it dropped.
 */
export function expropriationDelta(sent: readonly Expropriation[], now: readonly Expropriation[]): ExpropriationDelta {
  const first = now[0];
  const at = first === undefined ? -1 : sent.indexOf(first);
  const dropped = at < 0 ? sent.length : at;
  const kept = sent.length - dropped;
  return { dropped, added: now.slice(kept).map((r) => ({ ...r })) };
}

/** `list` with `delta` applied, a new list, or why it cannot apply: more dropped than `list` holds, or a record that is malformed or out of order. */
export function applyExpropriationDelta(list: readonly Expropriation[], delta: ExpropriationDelta, tick: number): Expropriation[] | string {
  if (!Number.isSafeInteger(delta.dropped) || delta.dropped < 0 || delta.dropped > list.length) return "it drops more records than the list holds";
  if (!Array.isArray(delta.added)) return "its added records are not a list";
  const next = [...list.slice(delta.dropped), ...delta.added.map((r) => ({ ...r }))];
  const problem = checkExpropriations(next, tick);
  return problem === null ? next : problem;
}

// --- Loading -----------------------------------------------------------------------

const RECORD_KEYS = ["tick", "x", "z", "people", "jobs", "playerId"];

/** Why `value` is not a well-formed expropriation list for a city on tick `tick`, or null if it is. */
export function checkExpropriations(value: unknown, tick: number): string | null {
  if (!Array.isArray(value)) return "it is not a list";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const r = value[i] as Record<string, unknown>;
    if (typeof r !== "object" || r === null || Array.isArray(r)) return `record ${i} is not an object`;
    const keys = Object.keys(r);
    if (keys.length !== RECORD_KEYS.length || RECORD_KEYS.some((key, k) => keys[k] !== key)) return `record ${i} has missing or unknown fields`;
    const { tick: at, x, z, people, jobs, playerId } = r;
    if (!Number.isSafeInteger(at) || (at as number) < last || (at as number) > tick) return `record ${i}'s tick is not a whole number in order up to the city's`;
    if (!(typeof x === "number" && Number.isFinite(x) && typeof z === "number" && Number.isFinite(z))) return `record ${i}'s place is not two numbers`;
    if (!Number.isSafeInteger(people) || (people as number) < 0 || !Number.isSafeInteger(jobs) || (jobs as number) < 0) return `record ${i}'s people or jobs are not whole numbers`;
    if (typeof playerId !== "string" || playerId === "") return `record ${i} names no player`;
    last = at as number;
  }
  return null;
}
