// M3-22: save and resume through every pop system M3 added. A scripted
// session on a small city has newcomers arrive, take jobs, lose them and
// leave, families turn over, and houses on ground zoned up give way to
// towers. It runs once straight through, and again saved and loaded half
// way and at other points, through the plain snapshot and the autosave's
// path. Every run must end on the same state hash, and the log replays to
// it. The session runs twice: with the bars held, so every system has work
// whatever the tuning, and with them free, so the bars' own state is saved
// and loaded too.
import { describe, expect, it } from "vitest";
import {
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  captureState,
  connectionEnd,
  createCaptureBuffers,
  createState,
  deserialize,
  hashState,
  recountTotals,
  replay,
  seeBuilding,
  serialize,
  serializeDetachedSteps,
  step,
  type BuildingSeen,
  type SimState,
  type SnapshotBuffer,
} from "../src/index";
import { holdDemand, type HeldBars } from "./demand-helper";
import { submit } from "./seen-ends";
import { withValue } from "./with-value";

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const RESIDENTIAL = 1;
/** Game days in the session. */
const DAYS = 140;
const STEPS = DAYS * DAY;
/** The day the factories are bulldozed, so their workers lose their jobs and, a month on, leave. */
const BULLDOZE_DAY = 40;
/** The day the first houses' ground is zoned up to R3, so owners rebuild as towers. */
const REZONE_DAY = 45;

/**
 * The bars the session holds, so it does not depend on the economy's
 * tuning: homes wanted throughout, so the towers come and fill, and work
 * wanted until the factories go. Leaving is satisfaction's, not demand's,
 * so a pop without work still leaves.
 */
const BARS: HeldBars = { residential: 60, commercial: 40, office: 40, industrial: 40 };

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The stub end of the first outside connection, and the way into the map along it. */
function stubEnd(state: SimState): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
}

/** A ZoneCells payload `depth` cells deep for places `p0` to `p0 + width` along `s`, on `side`. */
function zoneRect(s: Street, zone: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): unknown {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  return {
    zone,
    density,
    rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }],
  };
}

/** Every industrial building standing, as BulldozeBuilding names them. */
function factories(state: SimState): BuildingSeen[] {
  const b = state.buildings;
  const out: BuildingSeen[] = [];
  const industrial = ZONING_BALANCE.zones.findIndex((z) => z.id === "industrial") + 1;
  for (let id = 0; id < b.flags.length; id++) {
    if (!b.flags[id] || b.zone[id] !== industrial) continue;
    const seen = seeBuilding(b, id);
    if (seen) out.push(seen);
  }
  return out;
}

/**
 * One step `i` of the session: a command picked from `i` and the state as
 * it stands, then a step. Two runs that reach step `i` with the same state
 * send the same command, so a run loaded half way sends what the straight
 * one did.
 */
function drive(state: SimState, i: number): void {
  const send = (type: string, payload: unknown) => submit(state, { seq: i, playerId: i < BULLDOZE_DAY * DAY ? "p1" : "p2", type, payload });
  const s = stubEnd(state);
  if (i === 0) send("BuildRoad", { from: { x: s.x, z: s.z }, to: { x: s.x + s.dx * CELL * 60, z: s.z + s.dz * CELL * 60 }, type: "street" });
  // Houses on both sides of the first 30 places, then shops, offices and factories past them.
  if (i === 2) send("ZoneCells", zoneRect(s, "residential", 1, 0, 30, 5, 1));
  if (i === 3) send("ZoneCells", zoneRect(s, "residential", 1, 0, 30, 5, -1));
  if (i === 5 * DAY) send("ZoneCells", zoneRect(s, "commercial", 1, 30, 10, 4, 1));
  if (i === 5 * DAY + 1) send("ZoneCells", zoneRect(s, "office", 1, 30, 10, 4, -1));
  if (i === 5 * DAY + 2) send("ZoneCells", zoneRect(s, "industrial", 1, 40, 20, 5, 1));
  if (i === 5 * DAY + 3) send("ZoneCells", zoneRect(s, "industrial", 1, 40, 20, 5, -1));
  // The factories go, and their ground is left unzoned, so they do not grow back.
  if (i === BULLDOZE_DAY * DAY) {
    const all = factories(state);
    if (all.length > 0) send("BulldozeBuilding", { buildings: all });
  }
  if (i === BULLDOZE_DAY * DAY + 1) send("ZoneCells", zoneRect(s, "none", 1, 40, 20, 5, 1));
  if (i === BULLDOZE_DAY * DAY + 2) send("ZoneCells", zoneRect(s, "none", 1, 40, 20, 5, -1));
  // The first ten places of houses zoned up to towers.
  if (i === REZONE_DAY * DAY) send("ZoneCells", zoneRect(s, "residential", 3, 0, 10, 5, 1));
  if (i === REZONE_DAY * DAY + 1) send("ZoneCells", zoneRect(s, "residential", 3, 0, 10, 5, -1));
  if (i % (17 * DAY) === 11) send("SetSpeed", { speed: [1, 2, 4][(i / (17 * DAY)) % 3 | 0] });
  step(state);
}

/**
 * Runs steps `from` to `to` with the bars held and owners keener to
 * rebuild than the tuned game, so the towers come within the session.
 * Every run here holds the same, so they agree.
 */
function run(state: SimState, from: number, to: number, held = true): SimState {
  const go = () => {
    for (let i = from; i < to; i++) drive(state, i);
  };
  withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () => withValue(DEMAND_BALANCE.redevelopment, "valueFrom", 0, () => (held ? holdDemand(BARS, go) : go())));
  return state;
}

/** The same session with the bars free, as a player has them, so the bars' eased values and parts go through the save too. */
const runFree = (state: SimState, from: number, to: number): SimState => run(state, from, to, false);

function finish(steps: Generator<undefined, Uint8Array, undefined>): Uint8Array {
  for (;;) {
    const part = steps.next();
    if (part.done) return part.value;
  }
}

/** What the straight run saw on the way, to show each system had work to do. */
interface Seen {
  employedMax: number;
  jobsLost: boolean;
  towers: number;
  housesAtRezone: number;
  housesAtEnd: number;
}

function straightRun(): { state: SimState; seen: Seen } {
  const state = createState(SEED);
  const seen: Seen = { employedMax: 0, jobsLost: false, towers: 0, housesAtRezone: 0, housesAtEnd: 0 };
  const houses = () => {
    let n = 0;
    for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && state.buildings.zone[id] === RESIDENTIAL && state.buildings.density[id] === 1) n++;
    return n;
  };
  for (let day = 0; day < DAYS; day++) {
    run(state, day * DAY, (day + 1) * DAY);
    const employed = state.stats.totals["workersEmployed"] ?? 0;
    if (day > BULLDOZE_DAY && employed < seen.employedMax) seen.jobsLost = true;
    seen.employedMax = Math.max(seen.employedMax, employed);
    if (day === REZONE_DAY - 1) seen.housesAtRezone = houses();
  }
  for (let id = 0; id < state.buildings.flags.length; id++) {
    if (state.buildings.flags[id] && state.buildings.zone[id] === RESIDENTIAL && state.buildings.density[id] === 3) seen.towers++;
  }
  seen.housesAtEnd = houses();
  return { state, seen };
}

describe("M3 close-out: save and resume through arrivals, jobs, leaving, turnover and redevelopment", () => {
  const { state: straight, seen } = straightRun();
  const want = hashState(straight);

  it("the straight run has newcomers, workers, departures, turnover and towers in place of houses", () => {
    const year = straight.stats.year;
    expect(year.arrivals, "arrivals").toBeGreaterThan(100);
    expect(seen.employedMax, "workers in jobs").toBeGreaterThan(20);
    expect(seen.jobsLost, "jobs lost when the factories went").toBe(true);
    expect(year.departures, "departures").toBeGreaterThan(0);
    expect(year.births + year.deaths, "turnover").toBeGreaterThan(0);
    expect(seen.towers, "towers").toBeGreaterThan(0);
    expect(seen.housesAtEnd, "houses replaced").toBeLessThan(seen.housesAtRezone);
    expect(straight.stats.totals).toEqual(recountTotals(straight));
  });

  it("half way, save, load, the rest ends on the straight hash", () => {
    let s = run(createState(SEED), 0, STEPS / 2);
    s = deserialize(serialize(s)).state;
    run(s, STEPS / 2, STEPS);
    expect(hashState(s)).toBe(want);
  });

  // Mid-day and on a day's first tick, before and after the factories go and around the rezone.
  for (const at of [37, 1250, 4000, 4001, 4073, 4550, 6111, 9999, 12_345]) {
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
      run(s, at, at + 10 * DAY);
      s = deserialize(finish(serializeDetachedSteps(captureState(s, capture), out)).slice()).state;
    }
    expect(hashState(s)).toBe(want);
  });

  it("the log replays to the straight hash", () => {
    const replayed = withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () =>
      withValue(DEMAND_BALANCE.redevelopment, "valueFrom", 0, () => holdDemand(BARS, () => replay(SEED, straight.log, straight.tick))),
    );
    expect(hashState(replayed)).toBe(want);
  });
});

describe("M3 close-out: save and resume with the demand bars free", () => {
  const straight = runFree(createState(SEED), 0, STEPS);
  const want = hashState(straight);

  it("the straight run's bars moved on their own, and people came, worked and left", () => {
    const year = straight.stats.year;
    expect(year.arrivals).toBeGreaterThan(100);
    expect(year.departures).toBeGreaterThan(0);
    // A free bar holds its value in its parts; a held one only in its first.
    const parts = Object.values(straight.demand.residential.parts).filter((v) => v !== 0);
    expect(parts.length).toBeGreaterThan(1);
  });

  for (const at of [STEPS / 2, 4073, 9999]) {
    it(`a save after step ${at} ends on the straight hash`, () => {
      let s = runFree(createState(SEED), 0, at);
      s = deserialize(serialize(s)).state;
      runFree(s, at, STEPS);
      expect(hashState(s)).toBe(want);
    });
  }

  it("the log replays to the straight hash", () => {
    const replayed = withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () => withValue(DEMAND_BALANCE.redevelopment, "valueFrom", 0, () => replay(SEED, straight.log, straight.tick)));
    expect(hashState(replayed)).toBe(want);
  });
});
