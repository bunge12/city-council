// M4-09: clearing an occupied building means paying its owner and its
// people, and the price is known before the click.

import { describe, expect, it } from "vitest";
import {
  BUILDING_ABANDONED,
  BUILDING_ALIVE,
  BUILDING_TYPES,
  BUILDING_VACANT,
  CONNECTION_BALANCE,
  ECONOMY,
  LINE,
  NONE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingPeople,
  cellsSettled,
  compensationFor,
  connectionEnd,
  createState,
  deserialize,
  expropriationTicks,
  floorSpaceOf,
  fundCity,
  hashState,
  isBuilding,
  jobsFilled,
  lotJobs,
  planBulldozeBuildings,
  previewBuildRoad,
  previewBuildRoadGrid,
  previewBulldozeRoad,
  previewUpgradeRoad,
  propertyValue,
  replayFrom,
  seeBuilding,
  serialize,
  step,
  applyExpropriationDelta,
  expropriationDelta,
  type BuildingsInTheWay,
  type Expropriation,
  type Command,
  type DroppedCommand,
  type LedgerLine,
  type SimState,
} from "../src/index";
import { gridProblemReason } from "../src/roads/grid";
import { isSegment } from "../src/roads/network";
import { cloneState } from "../src/state";
import { holdDemand } from "./demand-helper";
import { funded } from "./funds";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import { submit, withEnds } from "./seen-ends";
import { watchTreasury } from "./treasury-helper";
import redevelopmentFixture from "./fixtures/replay/redevelopment.json" with { type: "json" };

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const D = ECONOMY.eminentDomain;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}

/** Submits `c`, which must be accepted, and steps until it has applied. */
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  const dropped: DroppedCommand[] = step(state);
  // A command that reads the cells waits while a change of roads settles.
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

function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): void {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  const rects = [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }];
  ok(state, command("ZoneCells", { zone: zoneId, density, rects }));
}

/**
 * Houses and towers on one side of a street 40 cells long, shops and
 * factories on the other, grown 40 game days with every bar held up, so
 * most buildings have people in them. Funded, since clearing a district
 * costs more than the starting grant. Built once; each test takes a copy.
 */
function grownTown(): { state: SimState; s: Street } {
  const state = funded(createState(SEED));
  const s = street(state, 40);
  zone(state, s, "residential", 1, 0, 12, 6, 1);
  zone(state, s, "residential", 3, 14, 20, 6, 1);
  zone(state, s, "commercial", 1, 0, 10, 4, -1);
  zone(state, s, "industrial", 1, 12, 14, 4, -1);
  holdDemand({ residential: 80, commercial: 80, office: 80, industrial: 80 }, () => {
    for (let i = 0; i < 40 * DAY; i++) step(state);
  });
  return { state, s };
}

const town = grownTown();
/** A copy of the grown town, with the street it grew on. */
const fresh = (): { state: SimState; s: Street } => ({ state: cloneState(town.state), s: town.s });

function live(state: SimState, keep: (id: number) => boolean): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id) && keep(id)) out.push(id);
  return out;
}

const typeOf = (state: SimState, id: number) => BUILDING_TYPES[state.buildings.type[id] ?? 0];
const occupied = (state: SimState, id: number) => buildingPeople(state, id) > 0 || jobsFilled(state, id) > 0;
const people = (state: SimState) => (id: number) => buildingPeople(state, id);
const filled = (state: SimState) => (id: number) => jobsFilled(state, id);
const onLine = (state: SimState, line: LedgerLine) => state.budget.month[LINE[line]] ?? 0;

/** The first live building of type `typeId`. */
function first(state: SimState, typeId: string): number {
  const id = live(state, (i) => typeOf(state, i)?.id === typeId)[0];
  if (id === undefined) throw new Error(`no ${typeId} in the town`);
  return id;
}

/** The demolition price of building `id`, worked out here from the balance numbers. */
function demolition(state: SimState, id: number): number {
  const type = typeOf(state, id);
  if (!type) throw new Error(`building ${id} has no type`);
  return Math.floor(floorSpaceOf(type, state.buildings.residents[id] ?? 0, lotJobs(state.buildings, id)).total * D.demolitionPerSquareMetre);
}

/** The occupied price of building `id`, worked out here from the balance numbers. */
function occupiedPrice(state: SimState, id: number): number {
  const value = propertyValue(state, id);
  return value + buildingPeople(state, id) * D.relocationPerResident + jobsFilled(state, id) * D.relocationPerJob + Math.floor(value * D.premium);
}

describe("the price of clearing a building", () => {
  it("prices an occupied house at its value, a relocation payment per resident, and the premium", () => {
    const { state } = fresh();
    const house = live(state, (id) => typeOf(state, id)?.oneHousehold === true && buildingPeople(state, id) > 0)[0] ?? NONE;
    expect(house).not.toBe(NONE);
    const residents = buildingPeople(state, house);
    const value = propertyValue(state, house);
    expect(value).toBeGreaterThan(0);
    const c = compensationFor(state, [house], people(state), filled(state));
    expect(c).toEqual({
      total: value + residents * D.relocationPerResident + Math.floor(value * D.premium),
      value,
      relocation: residents * D.relocationPerResident,
      premium: Math.floor(value * D.premium),
      demolition: 0,
      residents,
      jobs: 0,
      occupied: 1,
      empty: 0,
      paid: 0,
    });
  });

  it("prices an occupied tower the same way, at many times a house", () => {
    const { state } = fresh();
    const tower = live(state, (id) => typeOf(state, id)?.density === 3 && typeOf(state, id)?.zone === "residential" && buildingPeople(state, id) > 0)[0] ?? NONE;
    const house = live(state, (id) => typeOf(state, id)?.oneHousehold === true && buildingPeople(state, id) > 0)[0] ?? NONE;
    expect(tower).not.toBe(NONE);
    const c = compensationFor(state, [tower], people(state), filled(state));
    expect(c.total).toBe(occupiedPrice(state, tower));
    expect(c.residents).toBe(buildingPeople(state, tower));
    expect(c.residents).toBeGreaterThan(100);
    // Value follows floor space: hundreds of homes are worth far more than four.
    expect(c.total).toBeGreaterThan(50 * compensationFor(state, [house], people(state), filled(state)).total);
  });

  it("prices an occupied shop by its jobs filled, with a relocation payment per job", () => {
    const { state } = fresh();
    const shop = live(state, (id) => typeOf(state, id)?.zone === "commercial" && jobsFilled(state, id) > 0)[0] ?? NONE;
    expect(shop).not.toBe(NONE);
    const c = compensationFor(state, [shop], people(state), filled(state));
    expect(c.jobs).toBe(jobsFilled(state, shop));
    expect(c.relocation).toBe(jobsFilled(state, shop) * D.relocationPerJob);
    expect(c.total).toBe(occupiedPrice(state, shop));
  });

  it("prices a vacant shop and an abandoned factory at their demolition only", () => {
    const { state } = fresh();
    const b = state.buildings;
    const shop = first(state, "restaurant");
    const factory = first(state, "small-factory");
    // Emptied by hand, as the vacancy check leaves them: nobody works in either.
    b.flags[shop] = BUILDING_ALIVE | BUILDING_VACANT;
    b.flags[factory] = BUILDING_ALIVE | BUILDING_ABANDONED;
    const nobody = () => 0;
    const shopPrice = compensationFor(state, [shop], nobody, nobody);
    expect(shopPrice).toMatchObject({ total: demolition(state, shop), value: 0, relocation: 0, premium: 0, occupied: 0, empty: 1 });
    expect(shopPrice.total).toBeGreaterThan(0);
    // An abandoned building keeps the floor space it was built with, so its demolition is the same as in use.
    const factoryPrice = compensationFor(state, [factory], nobody, nobody);
    expect(factoryPrice).toMatchObject({ total: demolition(state, factory), value: 0, relocation: 0, premium: 0, occupied: 0, empty: 1 });
    expect(factoryPrice.total).toBe(Math.floor(lotJobs(b, factory) * ECONOMY.floorSpace.perJob.industrial * D.demolitionPerSquareMetre));
  });

  it("adds up the same in any order, and charges nothing for an id that is not a building", () => {
    const { state } = fresh();
    const ids = live(state, () => true);
    const all = compensationFor(state, ids, people(state), filled(state));
    expect(compensationFor(state, [...ids].reverse(), people(state), filled(state))).toEqual(all);
    expect(compensationFor(state, [...ids, 99_999, -1], people(state), filled(state))).toEqual(all);
    expect(all.total).toBe(all.value + all.relocation + all.premium + all.demolition);
    expect(all.occupied + all.empty).toBe(ids.length);
  });
});

/** The ledger lines a command moved, as amounts: the month after less the month before. */
function moved(before: SimState, after: SimState): Partial<Record<LedgerLine, number>> {
  const out: Partial<Record<LedgerLine, number>> = {};
  for (const [line, i] of Object.entries(LINE) as [LedgerLine, number][]) {
    const d = (after.budget.month[i] ?? 0) - (before.budget.month[i] ?? 0);
    if (d !== 0) out[line] = d;
  }
  return out;
}

/**
 * Applies `c` on `state` paused, so nothing but the command moves money,
 * then runs until the cells settle, and checks it charged what `clears`
 * and `cost` say, on the right lines, and that the buildings `clears`
 * names, and only those, are gone once the cells settle.
 */
function expectCharged(state: SimState, c: Command, cost: number, costLine: LedgerLine, clears: BuildingsInTheWay): void {
  state.speed = 0;
  const before = cloneState(state);
  const standing = live(state, () => true);
  ok(state, c);
  const price = cost + clears.compensation.total;
  expect(state.logSpent.at(-1)).toBe(price);
  expect(before.budget.treasury - state.budget.treasury).toBe(price);
  const lines = moved(before, state);
  expect(lines["compensation"] ?? 0).toBe(clears.compensation.total);
  expect(lines[costLine] ?? 0).toBe(cost);
  // The buildings a new road takes go once its cells settle, a few ticks on for a big change.
  state.speed = 1;
  holdDemand({ residential: 0, commercial: 0, office: 0, industrial: 0 }, () => {
    while (!cellsSettled(state)) step(state);
    step(state);
  });
  const gone = standing.filter((id) => !isBuilding(state.buildings, id) || state.buildings.builtAt[id] !== before.buildings.builtAt[id]);
  expect(gone).toEqual(clears.ids);
}

describe("the commands that clear buildings charge what their plan says", () => {
  it("BulldozeBuilding: an occupied house, and a drag over a district", () => {
    const { state } = fresh();
    const house = live(state, (id) => typeOf(state, id)?.oneHousehold === true && buildingPeople(state, id) > 0)[0] ?? NONE;
    const one = { buildings: [seeBuilding(state.buildings, house)] };
    const plan = planBulldozeBuildings(state, one);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.compensation.total).toBe(occupiedPrice(state, house));
    expect(plan.refusal).toBeNull();
    expectCharged(state, command("BulldozeBuilding", one), 0, "construction", { ids: plan.ids, residents: plan.residents, compensation: plan.compensation });

    const ids = live(state, () => true);
    const many = { buildings: ids.map((id) => seeBuilding(state.buildings, id)) };
    const district = planBulldozeBuildings(state, many);
    if (!district.ok) throw new Error(district.reason);
    expect(district.compensation.occupied).toBeGreaterThan(5);
    expectCharged(state, command("BulldozeBuilding", many), 0, "construction", { ids: district.ids, residents: district.residents, compensation: district.compensation });
  });

  it("BulldozeRoad: the road's demolition less its refund, plus every building on it", () => {
    const { state, s } = fresh();
    const payload = withEnds(state.roads, { segments: [s.seg] });
    const preview = previewBulldozeRoad(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.clears.ids.length).toBeGreaterThan(10);
    expect(preview.clears.compensation.occupied).toBeGreaterThan(10);
    expect(preview.price).toBe(preview.plan.cost + preview.clears.compensation.total);
    expectCharged(state, command("BulldozeRoad", payload), preview.plan.cost, "demolition", preview.clears);
  });

  it("BuildRoad: a street cut across the houses", () => {
    const { state, s } = fresh();
    const at = CELL * 6.5;
    const payload = { from: { x: s.x + s.dx * at - s.dz * 90, z: s.z + s.dz * at + s.dx * 90 }, to: { x: s.x + s.dx * at + s.dz * 90, z: s.z + s.dz * at - s.dx * 90 }, type: "street" };
    const preview = previewBuildRoad(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.clears.compensation.occupied).toBeGreaterThan(0);
    expectCharged(state, command("BuildRoad", payload), preview.plan.cost, "construction", preview.clears);
  });

  it("BuildRoadGrid: a grid over the towers and the factories", () => {
    const { state, s } = fresh();
    const x = s.x + 130;
    const z = s.z - 60;
    const payload = { origin: { x, z }, along: { x: x + 96, z }, across: { x, z: z + 96 }, depth: 86, width: 86, type: "street" };
    const preview = previewBuildRoadGrid(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.problem === null ? null : gridProblemReason(preview.plan, preview.problem)).toBeNull();
    expect(preview.clears.compensation.occupied).toBeGreaterThan(0);
    expectCharged(state, command("BuildRoadGrid", payload), preview.plan.cost, "construction", preview.clears);
  });

  // An upgrade's lots move out with its wider surface, so on open ground it
  // takes nothing; where its surface does cover another road's cells, it
  // takes those buildings as a new road would (`upgradeClears`).
  it("UpgradeRoad: a cross street widened into an avenue is charged its plan, buildings included", () => {
    const { state, s } = fresh();
    const at = CELL * 6.5;
    const segsBefore = state.roads.segA.length;
    ok(state, command("BuildRoad", { from: { x: s.x + s.dx * at - s.dz * 90, z: s.z + s.dz * at + s.dx * 90 }, to: { x: s.x + s.dx * at + s.dz * 90, z: s.z + s.dz * at - s.dx * 90 }, type: "street" }));
    holdDemand({ residential: 80, commercial: 80, office: 80, industrial: 80 }, () => {
      for (let i = 0; i < 10 * DAY; i++) step(state);
    });
    const cross: number[] = [];
    for (let seg = segsBefore; seg < state.roads.segA.length; seg++) if (isSegment(state.roads, seg) && state.roads.segType[seg] === state.roads.segType[s.seg]) cross.push(seg);
    const payload = withEnds(state.roads, { segments: cross, type: "avenue" });
    const preview = previewUpgradeRoad(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expectCharged(state, command("UpgradeRoad", payload), preview.plan.cost, "construction", preview.clears);
  });

  it("a split drag: each part is charged its own plan when it applies", () => {
    const { state } = fresh();
    state.speed = 0;
    const ids = live(state, (id) => occupied(state, id));
    const half = Math.floor(ids.length / 2);
    const parts = [ids.slice(0, half), ids.slice(half)].map((part) => ({ buildings: part.map((id) => seeBuilding(state.buildings, id)) }));
    const first = planBulldozeBuildings(state, parts[0]);
    if (!first.ok) throw new Error(first.reason);
    ok(state, command("BulldozeBuilding", parts[0]));
    expect(state.logSpent.at(-1)).toBe(first.compensation.total);
    // The second part is priced as it stands once the first has applied.
    const second = planBulldozeBuildings(state, parts[1]);
    if (!second.ok) throw new Error(second.reason);
    ok(state, command("BulldozeBuilding", parts[1]));
    expect(state.logSpent.at(-1)).toBe(second.compensation.total);
  });
});

describe("buildings paid for and not yet gone", () => {
  /** The grid over the towers and factories from the test above, applied paused: its buildings stand until the game runs on past its settle. */
  function pausedGrid(): { state: SimState; clears: BuildingsInTheWay } {
    const { state, s } = fresh();
    state.speed = 0;
    const x = s.x + 130;
    const z = s.z - 60;
    const payload = { origin: { x, z }, along: { x: x + 96, z }, across: { x, z: z + 96 }, depth: 86, width: 86, type: "street" };
    const preview = previewBuildRoadGrid(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    ok(state, command("BuildRoadGrid", payload));
    expect(cellsSettled(state)).toBe(false);
    for (const id of preview.clears.ids) expect(isBuilding(state.buildings, id)).toBe(true);
    for (const id of preview.clears.ids) expect(state.buildings.paid[id]).toBe(1);
    return { state, clears: preview.clears };
  }

  it("charges nothing again for a building a road has paid for, and records it once", () => {
    const { state, clears } = pausedGrid();
    const charged = onLine(state, "compensation");
    expect(charged).toBe(clears.compensation.total);
    const records = state.expropriations.length;
    const payload = { buildings: clears.ids.map((id) => seeBuilding(state.buildings, id)) };
    const plan = planBulldozeBuildings(state, payload);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.compensation).toMatchObject({ total: 0, paid: clears.ids.length });
    ok(state, command("BulldozeBuilding", payload));
    expect(state.logSpent.at(-1)).toBe(0);
    expect(onLine(state, "compensation")).toBe(charged);
    expect(state.expropriations).toHaveLength(records);
  });

  it("leaves a road's buildings standing and paid for when it is undone before they go, and refunds only the road", () => {
    const { state, clears } = pausedGrid();
    const charged = onLine(state, "compensation");
    const construction = onLine(state, "construction");
    ok(state, command("Undo", {}));
    expect(onLine(state, "construction")).toBe(0);
    expect(construction).toBeGreaterThan(0);
    // Compensation stays paid, as undo never brings a building back.
    expect(onLine(state, "compensation")).toBe(charged);
    state.speed = 1;
    holdDemand({ residential: 0, commercial: 0, office: 0, industrial: 0 }, () => {
      while (!cellsSettled(state)) step(state);
      step(state);
    });
    const standing = clears.ids.filter((id) => isBuilding(state.buildings, id));
    expect(standing.length).toBeGreaterThan(0);
    for (const id of standing) expect(state.buildings.paid[id]).toBe(1);
    // Clearing one now costs nothing more.
    const plan = planBulldozeBuildings(state, { buildings: standing.map((id) => seeBuilding(state.buildings, id)) });
    expect(plan.ok && plan.compensation.total).toBe(0);
  });

  it("starts every new building unpaid, a lot rebuilt on a paid id included", () => {
    const { state, clears } = pausedGrid();
    state.speed = 1;
    holdDemand({ residential: 80, commercial: 80, office: 80, industrial: 80 }, () => {
      for (let i = 0; i < 5 * DAY; i++) step(state);
    });
    for (const id of live(state, () => true)) expect(state.buildings.paid[id], `building ${id}`).toBe(0);
    expect(clears.ids.length).toBeGreaterThan(0);
  });
});

describe("money and the overdraft", () => {
  it("refuses a clearing the treasury cannot pay, with the price and what is left", () => {
    const { state, s } = fresh();
    const ids = live(state, (id) => occupied(state, id));
    const payload = { buildings: ids.map((id) => seeBuilding(state.buildings, id)) };
    const plan = planBulldozeBuildings(state, payload);
    if (!plan.ok) throw new Error(plan.reason);
    fundCity(state, 0);
    const refusal = planBulldozeBuildings(state, payload);
    expect(refusal.ok && refusal.refusal).toMatch(/^Costs \$[\d.]+[KMB]?, \$1M available$/);
    expect(submit(state, command("BulldozeBuilding", payload))).toEqual({ ok: false, reason: refusal.ok ? refusal.refusal : "" });
    // The road under them too: its refund does not cover the buildings on it.
    const road = withEnds(state.roads, { segments: [s.seg] });
    const preview = previewBulldozeRoad(state, road);
    expect(preview.ok && preview.refusal).toMatch(/^Costs /);
    expect(submit(state, command("BulldozeRoad", road)).ok).toBe(false);
  });

  it("charges nothing for rezoning built land or for an owner's redevelopment", () => {
    const state = expectReplay(redevelopmentFixture as ReplayFixture);
    // The fixture rezones built houses to R3 and their owners rebuild them as towers.
    expect(state.log.some((e) => e.type === "ZoneCells")).toBe(true);
    expect(onLine(state, "compensation")).toBe(0);
    expect(state.budget.lastMonth[LINE.compensation]).toBe(0);
    expect(state.expropriations).toEqual([]);
  });

  it("keeps the treasury equal to its opening plus the month's lines through a session of clearings", () => {
    const { state, s } = fresh();
    const watch = watchTreasury(state);
    const ids = live(state, (id) => occupied(state, id));
    ok(state, command("BulldozeBuilding", { buildings: ids.slice(0, 3).map((id) => seeBuilding(state.buildings, id)) }));
    watch.check(state);
    ok(state, command("BulldozeRoad", withEnds(state.roads, { segments: [s.seg] })));
    watch.check(state);
  });
});

describe("expropriation records", () => {
  it("records each occupied building cleared, with its tick, lot centre, people, jobs and player", () => {
    const { state } = fresh();
    const house = live(state, (id) => typeOf(state, id)?.oneHousehold === true && buildingPeople(state, id) > 0)[0] ?? NONE;
    const shop = live(state, (id) => typeOf(state, id)?.zone === "commercial" && jobsFilled(state, id) > 0)[0] ?? NONE;
    const empty = live(state, (id) => !occupied(state, id));
    const residents = buildingPeople(state, house);
    const jobs = jobsFilled(state, shop);
    const tick = state.tick;
    ok(state, command("BulldozeBuilding", { buildings: [house, shop, ...empty.slice(0, 1)].map((id) => seeBuilding(state.buildings, id)) }, "p2"));
    expect(state.expropriations).toHaveLength(2);
    const [a, b] = [...state.expropriations].sort((p, q) => p.people - q.people);
    expect(b).toMatchObject({ tick, people: residents, jobs: 0, playerId: "p2" });
    expect(a).toMatchObject({ tick, people: 0, jobs, playerId: "p2" });
    for (const r of state.expropriations) expect(Number.isFinite(r.x) && Number.isFinite(r.z) && r.x !== 0).toBe(true);
  });

  it("drops a record on the tick it turns a game year old", () => {
    const { state } = fresh();
    const house = live(state, (id) => buildingPeople(state, id) > 0)[0] ?? NONE;
    ok(state, command("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, house)] }));
    const at = state.expropriations[0]?.tick ?? NaN;
    expect(state.expropriations).toHaveLength(1);
    holdDemand({ residential: 0, commercial: 0, office: 0, industrial: 0 }, () => {
      while (state.tick < at + expropriationTicks() - 1) step(state);
      expect(state.expropriations).toHaveLength(1);
      step(state);
    });
    expect(state.tick).toBe(at + expropriationTicks());
    expect(state.expropriations).toEqual([]);
  });

  it("holds the list to its cap, dropping the oldest first", () => {
    const { state } = fresh();
    const most = ECONOMY.expropriationsMax;
    const old = { tick: 0, x: 1, z: 1, people: 1, jobs: 0, playerId: "old" };
    state.expropriations = Array.from({ length: most - 1 }, (_, i) => ({ ...old, tick: Math.min(i, state.tick) }));
    const ids = live(state, (id) => occupied(state, id)).slice(0, 3);
    ok(state, command("BulldozeBuilding", { buildings: ids.map((id) => seeBuilding(state.buildings, id)) }));
    expect(state.expropriations).toHaveLength(most);
    expect(state.expropriations.slice(-3).every((r) => r.playerId === "p1")).toBe(true);
    expect(state.expropriations[0]?.tick).toBe(2);
  });

  it("comes back the same from a save, and a replay gives the same state hash", () => {
    const start = cloneState(town.state);
    const { state, s } = fresh();
    const logFrom = state.log.length;
    const ids = live(state, (id) => occupied(state, id));
    ok(state, command("BulldozeBuilding", { buildings: ids.slice(0, 4).map((id) => seeBuilding(state.buildings, id)) }));
    for (let i = 0; i < 30; i++) step(state);
    const at = CELL * 6.5;
    ok(state, command("BuildRoad", { from: { x: s.x + s.dx * at, z: s.z - 90 }, to: { x: s.x + s.dx * at, z: s.z + 90 }, type: "street" }));
    for (let i = 0; i < 30; i++) step(state);
    ok(state, command("BulldozeRoad", withEnds(state.roads, { segments: [s.seg] })));
    for (let i = 0; i < 30; i++) step(state);
    expect(state.expropriations.length).toBeGreaterThan(4);
    const back = deserialize(serialize(state)).state;
    expect(back.expropriations).toEqual(state.expropriations);
    expect(hashState(back)).toBe(hashState(state));
    // The log from the grown town on, replayed from the town as it stood.
    const replayed = replayFrom(start, state.log.slice(logFrom), state.tick);
    expect(hashState(replayed)).toBe(hashState(state));
  });
});

describe("expropriations in a delta", () => {
  const r = (tick: number, playerId = "p1") => ({ tick, x: 1, z: 2, people: 3, jobs: 0, playerId });

  it("sends what dropped from the head and what was added at the tail, and the copy ends up with the sim's list", () => {
    const a = r(1);
    const b = r(2);
    const c = r(3);
    const d = r(4);
    const cases: [Expropriation[], Expropriation[]][] = [
      [[], [a, b]],
      [[a, b], [b, c]],
      [[a, b], [c, d]],
      [[a, b], []],
      [[a], [a, b, c]],
    ];
    for (const [sent, now] of cases) {
      const delta = expropriationDelta(sent, now);
      expect(applyExpropriationDelta(sent.map((x) => ({ ...x })), delta, 10)).toEqual(now);
    }
    expect(expropriationDelta([a, b], [b, c])).toEqual({ dropped: 1, added: [c] });
  });

  it("refuses a delta that does not fit the copy's list", () => {
    expect(applyExpropriationDelta([r(1)], { dropped: 2, added: [] }, 10)).toMatch(/drops more/);
    expect(applyExpropriationDelta([r(5)], { dropped: 0, added: [r(4)] }, 10)).toMatch(/in order/);
    expect(applyExpropriationDelta([], { dropped: 0, added: [{ ...r(1), people: -1 }] }, 10)).toMatch(/whole numbers/);
  });
});
