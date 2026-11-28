// Money on the scale cities (issue M4-20): what the M4 close-out measures
// them with. A generated scale city (M3-20) is funded at a trillion dollars
// so its generator's commands are paid for (scale.ts), with every tax rate
// and development charge at its default and nothing borrowed. Before the
// close-out measures it, each city is given what a player's city of that
// size has: a treasury of its own size, tax rates moved off their
// defaults, a loan and City Hall. The rates, City Hall and the loan are
// commands, sent as the scale player and stepped until each applies, so
// they are in the city's log. The treasury is not: it is set with
// `fundCity`, as the generator's trillion is, on the grants line of the
// month in progress, so a replay of the log from a funded start does not
// reach it, and that month's ledger carries the move. No game code calls
// this.

import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "./chunks";
import { submit } from "./commands";
import { fundCity } from "./economy/budget";
import { creditLeft } from "./economy/loans";
import { ECONOMY } from "./economy/balance";
import { findLandmark, LANDMARKS, planPlaceLandmark } from "./buildings/landmarks";
import { buildingInfo } from "./buildings/where";
import { isSegment, segmentIdLimit } from "./roads/network";
import { SCALE_PLAYER } from "./scale";
import type { SimState } from "./state";
import { step } from "./step";
import { placesAlong } from "./zoning/cells";

/**
 * Whole dollars of treasury for each resident a scale city is given: about
 * four years of the other city spending a resident costs (economy.json),
 * and a few years of what the 30,000 segments the scale cities are built on
 * lose a month. A fixture's figure, not a balance number: no city in play
 * is given money.
 */
export const SCALE_TREASURY_PER_RESIDENT = 20_000;

/** The tax rates the scale cities are measured at, each a little above its default, so the demand bars carry a tax part. */
export const SCALE_TAX_RATES: Readonly<Record<string, number>> = { residential: 0.02, commercial: 0.04, office: 0.02, industrial: 0.02 };

/** What `furnishEconomy` gave a city. */
export interface ScaleEconomy {
  /** City Hall's building id. */
  hall: number;
  /** The middle of City Hall's lot. */
  hallAt: { x: number; z: number };
  /** The loan's principal, half of what the city could borrow. */
  loan: number;
  /** The treasury once City Hall is paid for and the loan is in. */
  treasury: number;
}

/** City Hall's kind in economy.json. */
function cityHall() {
  const kind = LANDMARKS.find((l) => l.id === "cityHall");
  if (!kind) throw new Error("no cityHall in economy.json");
  return kind;
}

/** Submits one command as the scale player and steps until it has applied, throwing if the sim refuses it. */
function send(state: SimState, type: string, payload: unknown): void {
  const seq = state.log.reduce((most, e) => Math.max(most, e.seq), 0) + 1;
  const before = state.log.length + state.logOffset;
  const result = submit(state, { seq, playerId: SCALE_PLAYER, type, payload });
  if (!result.ok) throw new Error(`${type} refused: ${result.reason}`);
  for (let i = 0; i < 100 && state.log.length + state.logOffset === before; i++) step(state);
  if (state.log.length + state.logOffset === before) throw new Error(`${type} did not apply`);
}

/**
 * Places City Hall with a `PlaceLandmark` on the first free lot along a
 * road, by the distance of the segment's first node from (x, z), the middle
 * of the map unless given. The city must have City Hall open and the money
 * for it. Returns its building id and the middle of its lot.
 */
export function placeCityHallNear(state: SimState, x = (CHUNKS_PER_SIDE * CHUNK_SIZE) / 2, z = (CHUNKS_PER_SIDE * CHUNK_SIZE) / 2): { hall: number; at: { x: number; z: number } } {
  const kind = cityHall();
  const net = state.roads;
  const segs: { seg: number; d: number }[] = [];
  for (let seg = 0; seg < segmentIdLimit(net); seg++) {
    if (!isSegment(net, seg)) continue;
    const a = net.segA[seg] ?? 0;
    const dx = (net.nodeX[a] ?? 0) - x;
    const dz = (net.nodeZ[a] ?? 0) - z;
    // The square of the distance, which orders them the same (CLAUDE.md rule 6).
    segs.push({ seg, d: dx * dx + dz * dz });
  }
  segs.sort((p, q) => p.d - q.d || p.seg - q.seg);
  for (const { seg } of segs) {
    for (const side of [0, 1]) {
      for (let place = 0; place < placesAlong(net, seg); place++) {
        const payload = { landmark: kind.id, segment: seg, side, place };
        const plan = planPlaceLandmark(state, payload);
        if (!plan.ok || plan.plan.refusal) continue;
        send(state, "PlaceLandmark", payload);
        const hall = findLandmark(state.buildings, LANDMARKS.indexOf(kind));
        const c = buildingInfo(state, hall)?.corners ?? [];
        return { hall, at: { x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4, z: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4 } };
      }
    }
  }
  throw new Error("no free lot for City Hall along any road");
}

/**
 * Gives a generated scale city of about `residents` people the money a
 * player's city has (see the top of the file): the treasury at
 * `SCALE_TREASURY_PER_RESIDENT` for each, `SCALE_TAX_RATES`, City Hall on
 * a lot near the middle of the map, and a loan of half its credit on the
 * longest term. The generator credits every milestone, so City Hall is
 * open. In place.
 */
export function furnishEconomy(state: SimState, residents: number): ScaleEconomy {
  const target = SCALE_TREASURY_PER_RESIDENT * residents;
  fundCity(state, target + cityHall().price);
  for (const [zone, rate] of Object.entries(SCALE_TAX_RATES)) send(state, "SetTaxRate", { zone, rate });
  const { hall, at } = placeCityHallNear(state);
  const offers = ECONOMY.loans.offers;
  const term = offers[offers.length - 1]?.termMonths;
  if (term === undefined) throw new Error("no loan offers in economy.json");
  const loan = Math.floor(creditLeft(state) / 2);
  if (loan <= 0) throw new Error("the scale city has no credit");
  send(state, "TakeLoan", { principal: loan, termMonths: term });
  return { hall, hallAt: at, loan, treasury: state.budget.treasury };
}
