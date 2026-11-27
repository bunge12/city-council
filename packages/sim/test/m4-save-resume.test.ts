// M4-20: save and resume through the economy. A scripted session on a new
// city, started on its grant with no funding and no milestone credited,
// lays the M3 walkthrough's streets off the west outside connection, zones
// them, and runs: taxes and upkeep move the treasury a day at a time,
// developers pay development charges, the player moves a tax rate and a
// charge, takes a loan that the closes then repay, the town passes its
// first milestone and is paid its grant, and the city expropriates an
// occupied home. It runs once straight through, and again saved and
// loaded half way and at other points, through the plain snapshot and the
// autosave's path. Every run must end on the same state hash, and the log
// replays to it from the seed.
import { describe, expect, it } from "vitest";
import {
  LINE,
  TAX_LINES,
  TIME_BALANCE,
  CHARGE_LINES,
  ZONING_BALANCE,
  buildingPeople,
  captureState,
  createCaptureBuffers,
  createState,
  creditLeft,
  deserialize,
  hashState,
  isMonthStart,
  loanCount,
  recountTotals,
  replayFrom,
  seeBuilding,
  serialize,
  serializeDetachedSteps,
  step,
  type SimState,
  type SnapshotBuffer,
} from "../src/index";
import { submit } from "./seen-ends";

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
/** Game days in the session. */
const DAYS = 130;
const STEPS = DAYS * DAY;
/** When the player moves the residential tax rate and the commercial charge. */
const RATES_DAY = 20;
/** When the player borrows half of what the city may. */
const LOAN_DAY = 40;
/** When the city clears the first occupied home, at the eminent domain price. */
const EXPROPRIATION_DAY = 75;

/** The M3 walkthrough's town (e2e/m3-walkthrough-city.ts): main street from the west stub, a spine south, four streets across it. */
const X0 = 200;
const XM = 440;
const X1 = 680;
const MAIN = 3608;
const SHOPS = 3800;
const HOMES = 4000;
const UPPER = 4200;
const SHORE = 4400;
const STREETS: [number, number, number, number][] = [
  [X0, MAIN, X1, MAIN],
  [XM, MAIN, XM, SHORE],
  [X0, SHOPS, X1, SHOPS],
  [X0, HOMES, X1, HOMES],
  [X0, UPPER, X1, UPPER],
  [320, SHORE, X1, SHORE],
];
const HALF = 5;

/** A ZoneCells payload for one side of one piece of a street, `depth` cells deep, as the zone tool's fill sends. */
function strip(z: number, piece: "west" | "east", side: 1 | -1, zone: string, depth: number): unknown {
  const [a, b] = piece === "west" ? [z === SHORE ? 320 : X0, XM] : [XM, X1];
  const mid = z + side * (HALF + (depth * CELL) / 2);
  return { zone, density: 1, rects: [{ from: { x: a + 6, z: mid }, to: { x: b - 6, z: mid }, width: depth * CELL - 2 }] };
}

/** The town's zoning, in the order it is sent: homes on five streets' sides, then shops, offices and factories. */
const ZONING: unknown[] = [
  ...(["west", "east"] as const).flatMap((piece) => [
    strip(HOMES, piece, -1, "residential", 6),
    strip(HOMES, piece, 1, "residential", 6),
    strip(UPPER, piece, -1, "residential", 6),
    strip(UPPER, piece, 1, "residential", 6),
    strip(SHORE, piece, -1, "residential", 5),
    strip(MAIN, piece, 1, "industrial", 6),
  ]),
  strip(SHOPS, "west", 1, "commercial", 6),
  strip(SHOPS, "east", 1, "commercial", 6),
  strip(SHOPS, "west", -1, "office", 5),
  strip(SHOPS, "east", -1, "residential", 5),
];

/** The first occupied home standing, as BulldozeBuilding names it, or null. */
function firstOccupiedHome(state: SimState): unknown {
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) {
    if (!b.flags[id] || b.zone[id] !== 1 || buildingPeople(state, id) === 0) continue;
    return seeBuilding(b, id);
  }
  return null;
}

/**
 * One step `i` of the session: a command picked from `i` and the state as
 * it stands, then a step. Two runs that reach step `i` with the same state
 * send the same command, so a run loaded half way sends what the straight
 * one did.
 */
function drive(state: SimState, i: number): void {
  const send = (type: string, payload: unknown) => submit(state, { seq: i, playerId: i < LOAN_DAY * DAY ? "p1" : "p2", type, payload });
  const street = STREETS[i];
  if (street) send("BuildRoad", { from: { x: street[0], z: street[1] }, to: { x: street[2], z: street[3] }, type: "street" });
  const z = ZONING[i - 10];
  if (z) send("ZoneCells", z);
  if (i === RATES_DAY * DAY) send("SetTaxRate", { zone: "residential", rate: 0.025 });
  if (i === RATES_DAY * DAY + 1) send("SetDevelopmentCharge", { zone: "commercial", rate: 300 });
  if (i === LOAN_DAY * DAY) send("TakeLoan", { principal: Math.floor(creditLeft(state) / 2), termMonths: 120 });
  if (i === EXPROPRIATION_DAY * DAY) {
    const home = firstOccupiedHome(state);
    if (home) send("BulldozeBuilding", { buildings: [home] });
  }
  if (i % (17 * DAY) === 11) send("SetSpeed", { speed: [1, 2, 4][(i / (17 * DAY)) % 3 | 0] });
  step(state);
}

function run(state: SimState, from: number, to: number): SimState {
  for (let i = from; i < to; i++) drive(state, i);
  return state;
}

function finish(steps: Generator<undefined, Uint8Array, undefined>): Uint8Array {
  for (;;) {
    const part = steps.next();
    if (part.done) return part.value;
  }
}

/** What the straight run saw on the way, to show each part of the economy had work to do. */
interface Seen {
  /** Summed over the months that closed. */
  tax: number;
  charges: number;
  repaid: number;
  interest: number;
  grants: number;
  compensation: number;
  loansAtEnd: number;
  /** The tick the first milestone was reached on. */
  milestoneAt: number;
  expropriations: number;
}

function straightRun(): { state: SimState; seen: Seen } {
  const state = createState(SEED);
  const seen: Seen = { tax: 0, charges: 0, repaid: 0, interest: 0, grants: 0, compensation: 0, loansAtEnd: 0, milestoneAt: -1, expropriations: 0 };
  for (let i = 0; i < STEPS; i++) {
    drive(state, i);
    if (!isMonthStart(state.tick)) continue;
    const l = state.budget.lastMonth;
    seen.tax += TAX_LINES.reduce((n, line) => n + (l[LINE[line]] ?? 0), 0);
    seen.charges += CHARGE_LINES.reduce((n, line) => n + (l[LINE[line]] ?? 0), 0);
    seen.repaid += l[LINE.loanRepayments] ?? 0;
    seen.interest += l[LINE.interest] ?? 0;
    seen.grants += l[LINE.grants] ?? 0;
    seen.compensation += l[LINE.compensation] ?? 0;
  }
  seen.loansAtEnd = loanCount(state.budget);
  seen.milestoneAt = state.milestones[0] ?? -1;
  seen.expropriations = state.expropriations.length;
  return { state, seen };
}

describe("M4 close-out: save and resume through taxes, charges, a loan, a milestone and an expropriation", () => {
  const { state: straight, seen } = straightRun();
  const want = hashState(straight);

  it("the straight run collects taxes and charges, repays a loan, reaches its first milestone and expropriates a home", () => {
    expect(seen.tax, "tax").toBeGreaterThan(0);
    expect(seen.charges, "development charges").toBeGreaterThan(0);
    expect(seen.interest + seen.repaid, "loan repayments").toBeGreaterThan(0);
    expect(seen.loansAtEnd, "the loan still open").toBe(1);
    expect(seen.milestoneAt, "the first milestone").toBeGreaterThan(0);
    expect(seen.grants, "its grant").toBeGreaterThan(0);
    expect(seen.compensation, "compensation").toBeGreaterThan(0);
    expect(seen.expropriations, "the expropriation's record").toBe(1);
    // The milestone came before the half-way save, and the expropriation after it.
    expect(seen.milestoneAt).toBeLessThan(STEPS / 2);
    expect(EXPROPRIATION_DAY * DAY).toBeGreaterThan(STEPS / 2);
    expect(straight.budget.taxRates[0]).toBe(0.025);
    expect(straight.stats.totals).toEqual(recountTotals(straight));
  });

  it("half way, save, load, the rest ends on the straight hash", () => {
    let s = run(createState(SEED), 0, STEPS / 2);
    s = deserialize(serialize(s)).state;
    run(s, STEPS / 2, STEPS);
    expect(hashState(s)).toBe(want);
    expect(s.budget.treasury).toBe(straight.budget.treasury);
  });

  // Around the rates, the loan, a month's close and the expropriation, mid-day and on a day's first tick.
  for (const at of [3, 37, RATES_DAY * DAY + 1, 3100, LOAN_DAY * DAY, LOAN_DAY * DAY + 1, 5900, 9000, EXPROPRIATION_DAY * DAY + 1, 9999]) {
    it(`a save after step ${at} ends on the straight hash`, () => {
      let s = run(createState(SEED), 0, at);
      s = deserialize(serialize(s)).state;
      run(s, at, STEPS);
      expect(hashState(s)).toBe(want);
    });
  }

  it("a reload every ten game days through the autosave path, with kept buffers, ends on the straight hash", () => {
    const capture = createCaptureBuffers();
    const out: SnapshotBuffer = { buffer: null };
    let s = createState(SEED);
    for (let at = 0; at < STEPS; at += 10 * DAY) {
      run(s, at, Math.min(STEPS, at + 10 * DAY));
      s = deserialize(finish(serializeDetachedSteps(captureState(s, capture), out)).slice()).state;
    }
    expect(hashState(s)).toBe(want);
  });

  it("the log replays to the straight hash from the seed alone", () => {
    const replayed = replayFrom(createState(SEED), straight.log, straight.tick);
    expect(hashState(replayed)).toBe(want);
  });
});
