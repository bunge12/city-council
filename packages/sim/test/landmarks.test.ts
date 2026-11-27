// M4-13: City Hall, the city's first landmark, in the sim.

import { describe, expect, it } from "vitest";
import {
  BUILDING_ALIVE,
  BUILDING_LANDMARK,
  CONNECTION_BALANCE,
  ECONOMY,
  LANDMARKS,
  LINE,
  MILESTONES,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  applyBuildingDelta,
  buildingInfo,
  buildingPeople,
  buildingUpkeepPerYear,
  compensationFor,
  connectionEnd,
  createState,
  creditMilestones,
  deserialize,
  drainBuildingDelta,
  findLandmark,
  hashState,
  isBuilding,
  isLandmark,
  jobsFilled,
  landmarkClearing,
  landmarkStage,
  landmarkStages,
  lockNote,
  planBulldozeBuildings,
  planPlaceLandmark,
  propertyValue,
  readBuilding,
  recordBuildingChanges,
  recountTotals,
  replayFrom,
  seeBuilding,
  serialize,
  step,
  yearDays,
  type Command,
  type DroppedCommand,
  type LedgerLine,
  type SimState,
} from "../src/index";
import { cloneState } from "../src/state";
import { buildingTaxByLine } from "../src/economy/tax";
import { isMonthStart } from "../src/calendar";
import { holdDemand } from "./demand-helper";
import { credited } from "./credited";
import { funded } from "./funds";
import { submit } from "./seen-ends";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import landmarksFixture from "./fixtures/replay/landmarks.json" with { type: "json" };
import { writeFileSync } from "node:fs";
import { BALANCE_STAMP, SCALE_TREASURY } from "../src/index";

/** Records the landmarks fixture again: `WRITE_LANDMARK_FIXTURE=1 pnpm exec vitest run test/landmarks.test.ts`. */
function writeFixture(): void {
  const start = credited(funded(createState(SEED)));
  const state = cloneState(start);
  const s = street(state, 40);
  const north = sideOf(state, s, 1);
  zone(state, s, "residential", 1, 0, 30, 6, -1);
  zone(state, s, "residential", 1, 0, 12, 6, 1);
  const id = placeHall(state, s, north, 2);
  holdDemand({ residential: 60, commercial: 60, office: 60, industrial: 60 }, () => {
    for (let i = 0; i < 6 * DAY; i++) step(state);
    ok(state, command("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, id)] }, "p2"));
    placeHall(state, s, north, 20);
    for (let i = 0; i < 6 * DAY; i++) step(state);
  });
  const fixture: ReplayFixture = {
    description:
      "City Hall on seed 2026 (M4-13). p1 builds a street from the first outside connection's stub and zones R1 along both sides, then places City Hall over part of the zoned north strip, which unzones its cells. Houses grow around it for six game days. p2 bulldozes it, paid the refund less its demolition, and p1 places it again further along. Twelve game days, every bar held at 60, the city funded and credited with every milestone.",
    seed: SEED,
    untilTick: state.tick,
    log: state.log,
    balance: BALANCE_STAMP,
    hash: hashState(state),
    heldDemand: 60,
    treasury: SCALE_TREASURY,
    credited: true,
  };
  writeFileSync(new URL("./fixtures/replay/landmarks.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
}

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const HALL = LANDMARKS.findIndex((l) => l.id === "cityHall");
const KIND = LANDMARKS[HALL] as (typeof LANDMARKS)[number];

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}

/** Submits `c`, which must be accepted, and steps until it has applied. */
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  const dropped: DroppedCommand[] = step(state);
  while (state.pending.length > 0) dropped.push(...step(state));
  expect(dropped).toEqual([]);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
  seg: number;
}

/** A street `places` cells long from the stub end of the first outside connection. */
function street(state: SimState, places: number): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const x = r.nodeX[inner] ?? 0;
  const z = r.nodeZ[inner] ?? 0;
  const segsBefore = r.segA.length;
  ok(state, command("BuildRoad", { from: { x, z }, to: { x: x + dx * CELL * places, z: z + dz * CELL * places }, type: "street" }));
  return { x, z, dx, dz, seg: segsBefore };
}

/** The ZoneCells payload for `width` places from `p0`, `depth` cells deep, on one side of the street. */
function zonePayload(s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): unknown {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  const rects = [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }];
  return zoneId === "none" ? { zone: "none", rects } : { zone: zoneId, density, rects };
}

function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): void {
  ok(state, command("ZoneCells", zonePayload(s, zoneId, density, p0, width, depth, side)));
}

const onLine = (state: SimState, line: LedgerLine) => state.budget.month[LINE[line]] ?? 0;

/** The cell side the zone helper's `side` 1 paints: the side whose cells a 1 stroke zones. */
function sideOf(state: SimState, s: Street, side: 1 | -1): number {
  const probe = cloneState(state);
  zone(probe, s, "residential", 1, 0, 1, 1, side);
  for (const cellSide of [0, 1]) {
    const plan = planPlaceLandmark(probe, { landmark: "cityHall", segment: s.seg, side: cellSide, place: 0 });
    if (plan.ok && plan.plan.slots.some((slot) => (probe.cells.zone[slot] ?? 0) !== 0)) return cellSide;
  }
  throw new Error("neither side holds the stroke");
}

/** A funded city with every milestone credited and a street 40 cells long. */
function town(): { state: SimState; s: Street; north: number; south: number } {
  const state = credited(funded(createState(SEED)));
  const s = street(state, 40);
  return { state, s, north: sideOf(state, s, 1), south: sideOf(state, s, -1) };
}

const base = town();
const fresh = () => ({ ...base, state: cloneState(base.state) });

/** The PlaceLandmark payload for City Hall at `place` on side `side` of the street. */
const hallAt = (s: Street, side: number, place: number) => ({ landmark: "cityHall", segment: s.seg, side, place });

function placeHall(state: SimState, s: Street, side: number, place: number): number {
  ok(state, command("PlaceLandmark", hallAt(s, side, place)));
  const id = findLandmark(state.buildings, HALL);
  expect(id).toBeGreaterThanOrEqual(0);
  return id;
}

describe("City Hall's balance", () => {
  it("has a lot, a price with its source year and an upkeep share in economy.json", () => {
    expect(KIND).toMatchObject({ id: "cityHall", name: "City Hall", unlock: "cityHall", width: 6, depth: 6 });
    expect(KIND.price).toBeGreaterThan(80_000_000);
    expect(Number.isSafeInteger(KIND.price)).toBe(true);
    expect(KIND.upkeepPerYear).toBe(Math.round(KIND.price * 0.02));
  });

  it("grows at three milestones after the one that unlocks it, so it has four stages", () => {
    expect(landmarkStages(HALL)).toBe(4);
    const opened = MILESTONES.findIndex((m) => m.unlocks.includes("cityHall"));
    const grows = MILESTONES.flatMap((m, i) => (m.grows.includes("cityHall") ? [i] : []));
    expect(grows).toHaveLength(3);
    for (const i of grows) expect(i).toBeGreaterThan(opened);
  });
});

describe("placing City Hall", () => {
  it("charges its price on the construction line, unzones its cells and stands as a landmark", () => {
    const { state, s, north } = fresh();
    zone(state, s, "residential", 1, 0, 12, 6, 1);
    const plan = planPlaceLandmark(state, hallAt(s, north, 2));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.price).toBe(KIND.price);
    expect(plan.plan.refusal).toBeNull();
    expect(plan.plan.slots).toHaveLength(KIND.width * KIND.depth);
    for (const slot of plan.plan.slots) expect(state.cells.zone[slot]).not.toBe(0);
    const treasury = state.budget.treasury;
    const construction = onLine(state, "construction");
    const id = placeHall(state, s, north, 2);
    expect(state.budget.treasury).toBe(treasury - KIND.price);
    expect(onLine(state, "construction") - construction).toBe(KIND.price);
    expect(state.logSpent.at(-1)).toBe(KIND.price);
    expect(state.buildings.flags[id]).toBe(BUILDING_ALIVE | BUILDING_LANDMARK);
    expect(isLandmark(state.buildings, id)).toBe(true);
    expect(readBuilding(state.buildings, id)).toMatchObject({ type: HALL, zone: 0, density: 0, residents: 0, width: KIND.width, depth: KIND.depth, landmark: true });
    expect(buildingInfo(state, id)).toMatchObject({ landmark: true, jobs: 0, value: 0 });
    for (const slot of plan.plan.slots) {
      expect(state.cells.zone[slot]).toBe(0);
      expect(state.cells.density[slot]).toBe(0);
    }
  });

  it("keeps its cells out of the zoning: a stroke over it passes over them, and one over it alone changes nothing", () => {
    const { state, s, north } = fresh();
    placeHall(state, s, north, 2);
    const id = findLandmark(state.buildings, HALL);
    const hallSlots = lotSlotsOf(state, id);
    // A stroke over the hall and the cells beside it paints only the cells beside it.
    zone(state, s, "residential", 1, 0, 12, 6, 1);
    for (const slot of hallSlots) expect(state.cells.zone[slot]).toBe(0);
    // A stroke over the hall alone has nothing to change, and is refused.
    expect(submit(state, command("ZoneCells", zonePayload(s, "commercial", 1, 3, 4, 4, 1)))).toEqual({ ok: false, reason: expect.stringMatching(/no cell would change/) });
  });

  it("is passed over by a zoning undo, which puts back only the cells beside it", () => {
    const { state, s, north } = fresh();
    zone(state, s, "residential", 1, 0, 12, 6, 1);
    // A clear over the strip, then City Hall on part of it: undoing the clear must not zone the hall's cells.
    zone(state, s, "none", 0, 0, 12, 6, 1);
    const id = placeHall(state, s, north, 2);
    const hallSlots = lotSlotsOf(state, id);
    ok(state, command("Undo", {}));
    for (const slot of hallSlots) expect(state.cells.zone[slot]).toBe(0);
    const zoned = [...state.cells.zone].filter((z) => z !== 0).length;
    expect(zoned).toBe(12 * 6 - KIND.width * KIND.depth);
  });

  it("is refused for a second City Hall while one stands", () => {
    const { state, s, north, south } = fresh();
    placeHall(state, s, north, 2);
    const plan = planPlaceLandmark(state, hallAt(s, south, 20));
    expect(plan).toEqual({ ok: false, reason: expect.stringMatching(/has a City Hall already/) });
    expect(submit(state, command("PlaceLandmark", hallAt(s, south, 20))).ok).toBe(false);
  });

  it("is refused before the milestone that unlocks it", () => {
    const state = funded(createState(SEED));
    const s = street(state, 40);
    const note = lockNote(state, "cityHall");
    expect(note).toMatch(/City Hall is locked until the Village milestone/);
    expect(planPlaceLandmark(state, hallAt(s, 0, 2))).toEqual({ ok: false, reason: note });
    creditMilestones(state, 1);
    expect(planPlaceLandmark(state, hallAt(s, 0, 2)).ok).toBe(true);
  });

  it("is refused without road frontage: off a road, on an outside connection's stub, or past the end of its segment", () => {
    const { state, s, north } = fresh();
    const frontage = /needs road frontage/;
    expect(planPlaceLandmark(state, { ...hallAt(s, north, 2), segment: 999_999 })).toEqual({ ok: false, reason: expect.stringMatching(frontage) });
    const stub = state.roads.segA.findIndex((_, seg) => ((state.roads.segFlags[seg] ?? 0) & 2) !== 0);
    expect(stub).toBeGreaterThanOrEqual(0);
    expect(planPlaceLandmark(state, { ...hallAt(s, north, 0), segment: stub })).toEqual({ ok: false, reason: expect.stringMatching(frontage) });
    expect(planPlaceLandmark(state, hallAt(s, north, 10_000))).toEqual({ ok: false, reason: expect.stringMatching(frontage) });
    // Too near the street's end for six columns: the strip ends before the lot does.
    expect(planPlaceLandmark(state, hallAt(s, north, 37))).toEqual({ ok: false, reason: expect.stringMatching(/needs a free lot/) });
  });

  it("is refused over a building, and never clears one", () => {
    const { state, s, north } = fresh();
    zone(state, s, "residential", 1, 0, 12, 6, 1);
    holdDemand({ residential: 80, commercial: 0, office: 0, industrial: 0 }, () => {
      for (let i = 0; i < 10 * DAY; i++) step(state);
    });
    const before = state.buildings.flags.filter((f) => f !== 0).length;
    expect(before).toBeGreaterThan(0);
    const plan = planPlaceLandmark(state, hallAt(s, north, 0));
    expect(plan).toEqual({ ok: false, reason: expect.stringMatching(/needs a free lot of 6 by 6 cells: .*has a building/) });
    expect(submit(state, command("PlaceLandmark", hallAt(s, north, 0))).ok).toBe(false);
  });

  it("is refused when the treasury cannot pay, with the price still planned", () => {
    const state = credited(createState(SEED));
    const s = street(state, 40);
    const plan = planPlaceLandmark(state, hallAt(s, 0, 2));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.price).toBe(KIND.price);
    expect(plan.plan.refusal).toMatch(/Costs/);
    expect(submit(state, command("PlaceLandmark", hallAt(s, 0, 2)))).toEqual({ ok: false, reason: plan.plan.refusal });
  });

  it("refuses a malformed payload", () => {
    const { state, s } = fresh();
    for (const payload of [null, {}, { ...hallAt(s, 0, 2), landmark: "museum" }, { ...hallAt(s, 0, 2), side: 2 }, { ...hallAt(s, 0, 2), dir: 3 }, { ...hallAt(s, 0, 2), place: 1.5 }]) {
      expect(planPlaceLandmark(state, payload).ok).toBe(false);
    }
  });
});

/** The slots of building `id`'s lot, through the plan's arithmetic on a copy with the hall gone. */
function lotSlotsOf(state: SimState, id: number): number[] {
  const b = state.buildings;
  const copy = cloneState(state);
  ok(copy, command("BulldozeBuilding", { buildings: [seeBuilding(copy.buildings, id)] }));
  creditMilestones(copy);
  const plan = planPlaceLandmark(copy, { landmark: "cityHall", segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], dir: b.dir[id] });
  if (!plan.ok) throw new Error(plan.reason);
  return plan.plan.slots;
}

describe("bulldozing City Hall", () => {
  it("charges its demolition less the refund share of its price, on the demolition line, and frees its cells unzoned", () => {
    const { state, s, north } = fresh();
    const id = placeHall(state, s, north, 2);
    const slots = lotSlotsOf(state, id);
    const { demolition, refund } = landmarkClearing(state.buildings, id);
    expect(demolition).toBe(Math.floor(9300 * ECONOMY.eminentDomain.demolitionPerSquareMetre));
    expect(refund).toBe(Math.floor(KIND.price * ECONOMY.eminentDomain.refundShare));
    const plan = planBulldozeBuildings(state, { buildings: [seeBuilding(state.buildings, id)] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.compensation).toMatchObject({ total: demolition - refund, value: 0, relocation: 0, premium: 0, demolition: 0, cityDemolition: demolition, refund, cityOwned: 1, occupied: 0, empty: 0 });
    expect(plan.refusal).toBeNull();
    const treasury = state.budget.treasury;
    const compensation = onLine(state, "compensation");
    const demolitionLine = onLine(state, "demolition");
    ok(state, command("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, id)] }));
    // The refund is the larger, so the city is paid.
    expect(state.budget.treasury).toBe(treasury - (demolition - refund));
    expect(state.budget.treasury).toBeGreaterThan(treasury);
    expect(onLine(state, "demolition") - demolitionLine).toBe(demolition - refund);
    expect(onLine(state, "compensation")).toBe(compensation);
    expect(state.expropriations).toEqual([]);
    expect(isBuilding(state.buildings, id)).toBe(false);
    expect(findLandmark(state.buildings, HALL)).toBe(-1);
    for (const slot of slots) expect(state.cells.zone[slot]).toBe(0);
    // Free cells: they zone again, and a new City Hall may stand on them.
    zone(state, s, "office", 1, 2, 6, 6, 1);
    for (const slot of slots) expect(state.cells.zone[slot]).not.toBe(0);
    zone(state, s, "none", 0, 2, 6, 6, 1);
    expect(planPlaceLandmark(state, hallAt(s, north, 2)).ok).toBe(true);
  });

  it("goes with its road at the same price when the street under it is bulldozed", () => {
    const { state, s, north } = fresh();
    const id = placeHall(state, s, north, 2);
    const { demolition, refund } = landmarkClearing(state.buildings, id);
    const city = compensationFor(state, [id], () => 0, () => 0);
    expect(city.total).toBe(demolition - refund);
    ok(state, command("BulldozeRoad", { segments: [s.seg] }));
    expect(isBuilding(state.buildings, id)).toBe(false);
  });
});

describe("City Hall's stage", () => {
  it("follows the milestones reached, from 1 to 4, whenever it was placed", () => {
    const state = funded(createState(SEED));
    const stages: number[] = [];
    for (let n = 0; n <= MILESTONES.length; n++) {
      creditMilestones(state, n);
      stages.push(landmarkStage(state, HALL));
    }
    // Village unlocks it; Town, City and Large city grow it.
    expect(stages).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 4]);
    expect(Math.max(...stages)).toBe(landmarkStages(HALL));
  });
});

describe("City Hall's upkeep", () => {
  it("joins the building upkeep, charged a day at a time, its year to the dollar", () => {
    const { state, s, north } = fresh();
    expect(buildingUpkeepPerYear(state)).toBe(0);
    placeHall(state, s, north, 2);
    expect(buildingUpkeepPerYear(state)).toBe(KIND.upkeepPerYear);
    // From 1 January of the next year, a whole year of closes.
    while (state.tick % (DAY * yearDays()) !== 0) step(state);
    let paid = 0;
    const end = state.tick + DAY * yearDays();
    while (state.tick < end) {
      step(state);
      if (isMonthStart(state.tick)) paid += state.budget.lastMonth[LINE.buildingUpkeep] as number;
    }
    expect(paid).toBe(KIND.upkeepPerYear);
  });
});

describe("City Hall in a save, a delta and a replay", () => {
  it("comes back from a save with the same hash, and a save with two is refused", () => {
    const { state, s, north } = fresh();
    const id = placeHall(state, s, north, 2);
    const back = deserialize(serialize(state)).state;
    expect(hashState(back)).toBe(hashState(state));
    expect(isLandmark(back.buildings, id)).toBe(true);
    // A second row of the same kind cannot load.
    const twice = cloneState(state);
    zone(twice, s, "residential", 1, 20, 6, 6, -1);
    holdDemand({ residential: 80, commercial: 0, office: 0, industrial: 0 }, () => {
      for (let i = 0; i < 5 * DAY; i++) step(twice);
    });
    const other = [...twice.buildings.flags.keys()].find((i) => i !== id && isBuilding(twice.buildings, i)) ?? -1;
    expect(other).toBeGreaterThanOrEqual(0);
    // Made into a second City Hall of the house's lot: refused for its lot, and for being a second.
    const b = twice.buildings;
    b.flags[other] = BUILDING_ALIVE | BUILDING_LANDMARK;
    b.type[other] = HALL;
    expect(() => deserialize(serialize(twice))).toThrow(/City Hall/);
  });

  it("goes to a client's copy with its flag in the building delta", () => {
    const { state, s, north } = fresh();
    const copy = cloneState(state);
    recordBuildingChanges(state);
    drainBuildingDelta(state);
    const id = placeHall(state, s, north, 2);
    const delta = drainBuildingDelta(state);
    expect(delta).not.toBeNull();
    if (!delta) return;
    const at = delta.ids.indexOf(id);
    expect(delta.rows.flags[at]).toBe(BUILDING_ALIVE | BUILDING_LANDMARK);
    expect(typeof applyBuildingDelta(copy, delta)).not.toBe("string");
    expect(isLandmark(copy.buildings, id)).toBe(true);
  });

  it("replays the committed fixture to its recorded hash", () => {
    const state = expectReplay(landmarksFixture as ReplayFixture);
    const id = findLandmark(state.buildings, HALL);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(isLandmark(state.buildings, id)).toBe(true);
  });

  it("replays its placing and its clearing to the same hash", () => {
    if (process.env["WRITE_LANDMARK_FIXTURE"]) writeFixture();
    const start = credited(funded(createState(SEED)));
    const state = cloneState(start);
    const s = street(state, 40);
    const north = sideOf(state, s, 1);
    zone(state, s, "residential", 1, 0, 30, 6, -1);
    const id = placeHall(state, s, north, 2);
    for (let i = 0; i < 3 * DAY; i++) step(state);
    ok(state, command("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, id)] }));
    placeHall(state, s, north, 10);
    for (let i = 0; i < 2 * DAY; i++) step(state);
    expect(hashState(replayFrom(cloneState(start), state.log, state.tick))).toBe(hashState(state));
  });
});

describe("a game year with City Hall standing", () => {
  it("leaves it alone: never vacant, abandoned or redeveloped, in no zone's statistics, with nobody living or working there and no tax", () => {
    const { state, s, north } = fresh();
    const id = placeHall(state, s, north, 8);
    const row = readBuilding(state.buildings, id);
    // Homes and shops around it, zoned up later so redevelopment runs beside it.
    zone(state, s, "residential", 1, 0, 8, 6, 1);
    zone(state, s, "commercial", 1, 14, 12, 4, 1);
    zone(state, s, "residential", 1, 0, 30, 6, -1);
    let seen = 0;
    holdDemand({ residential: 80, commercial: 60, office: 0, industrial: 0 }, () => {
      for (let d = 0; d < yearDays(); d++) {
        if (d === 60) zone(state, s, "residential", 2, 0, 8, 6, 1);
        for (let t = 0; t < DAY; t++) step(state);
        expect(readBuilding(state.buildings, id), `day ${d}`).toEqual({ ...row });
        expect(buildingPeople(state, id)).toBe(0);
        expect(jobsFilled(state, id)).toBe(0);
        seen++;
      }
    });
    expect(seen).toBe(yearDays());
    // The running totals agree with a recount, which leaves landmarks out, and count only the private buildings.
    const totals = state.stats.totals;
    expect(recountTotals(state)).toEqual(totals);
    const byZone = Object.entries(totals).filter(([name]) => name.startsWith("buildings")).reduce((n, [, v]) => n + v, 0);
    const privateBuildings = state.buildings.flags.filter((f, i) => f !== 0 && i !== id).length;
    expect(byZone).toBe(privateBuildings);
    expect(privateBuildings).toBeGreaterThan(10);
    // Redevelopment ran beside it: the strip zoned up holds density 2 now.
    expect(state.buildings.density.some((d, i) => d === 2 && isBuilding(state.buildings, i))).toBe(true);
    expect(state.stats.totals["population"]).toBeGreaterThan(100);
    expect(buildingTaxByLine(state, id)).toEqual([0, 0, 0, 0]);
    expect(propertyValue(state, id)).toBe(0);
  });
});
