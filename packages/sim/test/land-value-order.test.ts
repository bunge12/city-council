import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  LAND_VALUE_BALANCE,
  NONE,
  POPS_BALANCE,
  readPop,
  TIME_BALANCE,
  ZONING_BALANCE,
  checkLandValueBalance,
  connectionEnd,
  createState,
  deserialize,
  hashState,
  landValueAt,
  serialize,
  step,
  type CellRef,
  type Command,
  type SimState,
} from "../src/index";
import landValueJson from "../balance/landvalue.json" with { type: "json" };
import { bestCandidate, candidateSets, isCandidateSetAside, setAsideCount } from "../src/buildings/candidates";
import { seeBuilding } from "../src/buildings/bulldoze";
import { tryFindsLot } from "../src/buildings/grower";
import { buildingInfo, lotCentres, pollutionGrid, segmentBuildings } from "../src/buildings/where";
import { drawProfile, homeWeight } from "../src/pops/arrivals";
import { wealthMixAt } from "../src/landvalue/balance";
import { seedRng } from "../src/rng";
import { CELL_KEY_STRIDE } from "../src/zoning/cell-changes";
import { cellCorners, syncCells } from "../src/zoning/cell-index";
import { buildingValue, buildingValues, landValueAtPoint } from "../src/landvalue/land-value";
import { holdDemand } from "./demand-helper";
import { submit } from "./seen-ends";
import { withValue } from "./with-value";

// M3-25: land value orders the lots and shapes who moves in.
//
// Seed 2026's first outside connection runs east at z 3608 into dry ground,
// and the coast lies about 700 m south of it (arrivals.test.ts). A street
// from the connection runs east past a row of factories, and a second runs
// south from it to the shore, so one strip of houses sits by the water and
// another beside the factories, both reached from outside.

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const ZONES = ZONING_BALANCE.zones.length;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), type).toEqual({ ok: true });
  // A stroke waits for a change of roads to settle before it applies.
  for (let i = 0; i < 2000 && state.log.at(-1)?.seq !== c.seq; i++) expect(step(state), type).toEqual([]);
  expect(state.log.at(-1)?.seq, `${type} should apply`).toBe(c.seq);
}

function runDays(state: SimState, days: number): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) step(state);
}

/** Zones one rectangle: its centre line from `from` to `to`, `width` metres across. */
function zoneRect(state: SimState, zone: string, density: number, from: { x: number; z: number }, to: { x: number; z: number }, width: number): void {
  ok(state, "ZoneCells", { zone, density, rects: [{ from, to, width }] });
}

interface Layout {
  state: SimState;
  /** Where the street from the connection starts. */
  x0: number;
  z0: number;
  /** The x of the street south to the shore, and where it ends. */
  xs: number;
  zs: number;
}

/**
 * The city the scenarios share: the street east from the connection, the
 * street south from it to the shore, I3 factories along the north side of
 * the first street's far end, and two strips of R1 six deep: one along
 * the south street's last stretch by the water, one on the south side of
 * the first street facing the factories. Nothing grown yet.
 */
function layout(): Layout {
  // Each city numbers its commands from 1, so two built alike log alike.
  seq = 0;
  const state = createState(SEED);
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  expect(dx).toBe(1);
  const x0 = r.nodeX[inner] ?? 0;
  const z0 = r.nodeZ[inner] ?? 0;
  ok(state, "BuildRoad", { from: { x: x0, z: z0 }, to: { x: x0 + CELL * 96, z: z0 }, type: "street" });
  const xs = x0 + CELL * 32;
  const zs = z0 + CELL * 80;
  ok(state, "BuildRoad", { from: { x: xs, z: z0 }, to: { x: xs, z: zs }, type: "street" });
  return { state, x0, z0, xs, zs };
}

/** The factories: I3 six deep on the north side of the first street, from place 72 to 96. */
function zoneFactories(l: Layout): void {
  zoneRect(l.state, "industrial", 3, { x: l.x0 + CELL * 72 + 2, z: l.z0 - 5 - 24 }, { x: l.x0 + CELL * 96 - 2, z: l.z0 - 5 - 24 }, 44);
}

/** The strip by the water: R1 six deep on both sides of the south street's last 16 places. */
function zoneWaterStrip(l: Layout): void {
  for (const side of [-1, 1]) {
    const x = l.xs + side * (5 + 24);
    zoneRect(l.state, "residential", 1, { x, z: l.zs - CELL * 16 + 2 }, { x, z: l.zs - 2 }, 44);
  }
}

/** The strip beside the factories: R1 six deep on the south side of the first street, from place 70 to 94. */
function zoneFactoryStrip(l: Layout): void {
  zoneRect(l.state, "residential", 1, { x: l.x0 + CELL * 70 + 2, z: l.z0 + 5 + 24 }, { x: l.x0 + CELL * 94 - 2, z: l.z0 + 5 + 24 }, 44);
}

const FACTORY_X = (l: Layout) => l.x0 + CELL * 60;

/** Whether a building's lot centre is on the strip by the water (south street) or the strip beside the factories. */
function stripOf(l: Layout, state: SimState, id: number): "water" | "factories" | "other" {
  const corners = buildingInfo(state, id)?.corners ?? [];
  const cx = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
  const cz = ((corners[1] ?? 0) + (corners[3] ?? 0) + (corners[5] ?? 0) + (corners[7] ?? 0)) / 4;
  if (Math.abs(cx - l.xs) < 60 && cz > l.zs - CELL * 17) return "water";
  if (cx > FACTORY_X(l) && cz > l.z0) return "factories";
  return "other";
}

function homesOn(l: Layout, strip: "water" | "factories"): number[] {
  const b = l.state.buildings;
  const out: number[] = [];
  for (let id = 0; id < b.flags.length; id++) if (b.flags[id] && (b.residents[id] ?? 0) > 0 && stripOf(l, l.state, id) === strip) out.push(id);
  return out;
}

/** The cell a candidate key names. */
function refOf(key: number): CellRef {
  const seg = Math.floor(key / CELL_KEY_STRIDE);
  const col = key - seg * CELL_KEY_STRIDE;
  return { segment: seg, side: col % 2, place: (col - (col % 2)) / 2, depth: 0 };
}

/** The free front cells whose centre is on `strip`. */
function freeOn(l: Layout, strip: "water" | "factories"): number {
  const state = l.state;
  const index = syncCells(state);
  const { kept } = candidateSets(state, index, () => segmentBuildings(state));
  let n = 0;
  for (const k of kept) {
    const cell = cellRefCentre(state, refOf(Math.floor(k)));
    const onWater = Math.abs(cell.x - l.xs) < 60 && cell.z > l.zs - CELL * 17;
    const onFactories = cell.x > FACTORY_X(l) && cell.z > l.z0;
    if ((strip === "water" && onWater) || (strip === "factories" && onFactories)) n++;
  }
  return n;
}

/** The middle of the cell `ref` names, as land value measures it. */
function cellRefCentre(state: SimState, ref: CellRef): { x: number; z: number } {
  const q = cellCorners(state, ref);
  if (!q) throw new Error("no cell");
  return { x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4, z: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4 };
}

/** Factories grown first, with workers' jobs not holding them back, and the centre found. */
function withFactories(): Layout {
  const l = layout();
  zoneFactories(l);
  holdDemand({ industrial: 100, residential: -1, commercial: -1, office: -1 }, () =>
    withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => runDays(l.state, 20)),
  );
  return l;
}

describe("the land value balance for newcomers", () => {
  it("is well formed, and refuses bands out of order or not adding up", () => {
    expect(checkLandValueBalance(landValueJson)).toEqual([]);
    const n = landValueJson.newcomers;
    const bad = (over: unknown) => checkLandValueBalance({ ...landValueJson, newcomers: over }).join();
    expect(bad({ ...n, homeWeightFrom: -1 })).toMatch(/homeWeightFrom/);
    expect(bad({ ...n, wealth: [] })).toMatch(/at least one band/);
    expect(bad({ ...n, wealth: [{ from: 10, low: 0.5, medium: 0.5, high: 0 }] })).toMatch(/wealth\[0\]\.from must be 0/);
    expect(bad({ ...n, wealth: [n.wealth[0], { ...n.wealth[1], from: 0 }] })).toMatch(/above the band before/);
    expect(bad({ ...n, wealth: [{ ...n.wealth[0], high: 0.9 }] })).toMatch(/wealth\[0\]/);
    expect(bad({ ...n, extra: 1 })).toMatch(/extra/);
  });

  it("weighs a home by its value less homeWeightFrom, at least 1, and picks the band its value falls in", () => {
    const from = LAND_VALUE_BALANCE.newcomers.homeWeightFrom;
    expect(homeWeight(from + 30)).toBe(30);
    expect(homeWeight(from)).toBe(1);
    expect(homeWeight(0)).toBe(1);
    const bands = LAND_VALUE_BALANCE.newcomers.wealth;
    expect(wealthMixAt(0)).toBe(bands[0]);
    for (const band of bands) {
      expect(wealthMixAt(band.from)).toBe(band);
      expect(wealthMixAt(band.from + 1)).toBe(band);
    }
    expect(wealthMixAt(100)).toBe(bands.at(-1));
    // Richer ground draws richer newcomers, on average.
    const mean = (v: number) => {
      const rng = seedRng(5);
      let sum = 0;
      for (let i = 0; i < 4000; i++) sum += drawProfile(rng, v).wealth;
      return sum / 4000;
    };
    expect(mean(90)).toBeGreaterThan(mean(55));
    expect(mean(55)).toBeGreaterThan(mean(20));
  });
});

/** R3 six deep on the first street's north side in runs of 3 places with a place between: no tower fits any of them. */
function zoneR3Gaps(l: Layout, from = 4, runs = 5): void {
  for (let i = 0; i < runs; i++) {
    const p = from + i * 4;
    zoneRect(l.state, "residential", 3, { x: l.x0 + CELL * p + 2, z: l.z0 - 5 - 24 }, { x: l.x0 + CELL * (p + 3) - 2, z: l.z0 - 5 - 24 }, 44);
  }
}

/**
 * Checks the order against every free cell worked out afresh: for each
 * zone, and every zone together, the cell the order gives is the free cell
 * of highest value, the lower key of two the same, among those not set
 * aside; and no cell set aside could take a lot now.
 */
function expectOrder(state: SimState, when: string): void {
  const index = syncCells(state);
  const onCell = () => segmentBuildings(state);
  const { kept } = candidateSets(state, index, onCell);
  for (const k of kept) {
    const key = Math.floor(k);
    const ref = refOf(key);
    if (isCandidateSetAside(state, ref.segment, ref.place * 2 + ref.side)) expect(tryFindsLot(state, ref), `${when}: ${key} is set aside but has a lot`).toBe(false);
  }
  // A building's value, as newcomers weigh it and the building index keeps it, is the value at its lot's centre.
  const ids = [...state.buildings.flags.keys()].filter((id) => state.buildings.flags[id]);
  const { x, z } = lotCentres(state);
  expect(Array.from(buildingValues(state, ids)), `${when}: building values`).toEqual(ids.map((id) => landValueAtPoint(state, x[id] ?? 0, z[id] ?? 0, state.roads.segType[state.buildings.firstSeg[id] ?? 0] ?? 0).value));
  for (let zone = 0; zone <= ZONES; zone++) {
    let bestValue = -1;
    let bestKey = Infinity;
    for (const k of kept) {
      const key = Math.floor(k);
      if (zone !== 0 && Math.round((k - key) * 10) !== zone) continue;
      const ref = refOf(key);
      if (isCandidateSetAside(state, ref.segment, ref.place * 2 + ref.side)) continue;
      const v = landValueAt(state, ref)?.value ?? -1;
      if (v > bestValue || (v === bestValue && key < bestKey)) {
        bestValue = v;
        bestKey = key;
      }
    }
    const got = bestCandidate(state, index, onCell, () => pollutionGrid(state), zone);
    const gotKey = got ? got.segment * CELL_KEY_STRIDE + got.place * 2 + got.side : Infinity;
    expect(gotKey, `${when}, zone ${zone}`).toBe(bestKey);
  }
}

describe("the grower's order", () => {
  it("is the free cell of highest value, the lower of two the same, through growth, industry, the centre moving, zoning, a bulldozer and a change of roads", () => {
    const l = layout();
    const state = l.state;
    zoneFactories(l);
    zoneWaterStrip(l);
    zoneFactoryStrip(l);
    zoneR3Gaps(l);
    expectOrder(state, "zoned");
    holdDemand({ industrial: 100, residential: 100, commercial: -1, office: -1 }, () =>
      withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
        for (let day = 0; day < 40; day++) {
          for (let t = 0; t < DAY; t += 10) {
            for (let i = 0; i < 10; i++) step(state);
            expectOrder(state, `day ${day} tick ${state.tick}`);
          }
          // Ground joined to a gap brings it back, and a tower takes the wider run.
          if (day === 6) zoneRect(state, "residential", 3, { x: l.x0 + CELL * 7 + 2, z: l.z0 - 5 - 24 }, { x: l.x0 + CELL * 8 - 2, z: l.z0 - 5 - 24 }, 44);
          // A house cleared from the strip by the water.
          if (day === 10) {
            const [home] = homesOn(l, "water");
            if (home === undefined) throw new Error("no house by the water");
            ok(state, "BulldozeBuilding", { buildings: [seeBuilding(state.buildings, home)] });
          }
          if (day === 14) ok(state, "BuildRoad", { from: { x: l.xs - CELL * 20, z: l.zs - CELL * 8 }, to: { x: l.xs + CELL * 20, z: l.zs - CELL * 8 }, type: "street" });
        }
      }),
    );
    expect(state.centre.weight).toBeGreaterThan(0);
    expect(setAsideCount(state)).toBeGreaterThan(0);
    // The run made 7 wide grew a tower.
    const towers = [...state.buildings.flags.keys()].filter((id) => state.buildings.flags[id] && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.density === 3 && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.zone === "residential");
    expect(towers.length).toBe(1);
  });
});

/** Steps `state` until the strip beside the factories has a home, checking on each tick that it has none while the strip by the water has free ground. */
function growStrips(l: Layout, days: number): void {
  const until = l.state.tick + days * DAY;
  let started = false;
  while (l.state.tick < until) {
    step(l.state);
    if (!started && homesOn(l, "factories").length > 0) {
      started = true;
      expect(freeOn(l, "water"), `tick ${l.state.tick}: the factory strip started with ground by the water free`).toBe(0);
      expect(homesOn(l, "water").length).toBeGreaterThan(10);
    }
  }
  expect(started).toBe(true);
}

/** The mean wealth, 0 low to 2 high, of the pops living on `strip`, and how many. */
function meanWealth(l: Layout, strip: "water" | "factories"): { mean: number; pops: number } {
  const homes = new Set(homesOn(l, strip));
  const p = l.state.pops;
  let sum = 0;
  let n = 0;
  for (let id = 0; id < p.flags.length; id++) {
    if (!p.flags[id] || !homes.has(p.home[id] ?? -1)) continue;
    sum += readPop(p, id).wealth;
    n++;
  }
  return { mean: n > 0 ? sum / n : NaN, pops: n };
}

const RESIDENTIAL_ONLY = { residential: 100, industrial: -1, commercial: -1, office: -1 };

describe("land value orders the lots", () => {
  it("fills a strip by the water before a strip beside factories starts", () => {
    const l = withFactories();
    zoneWaterStrip(l);
    zoneFactoryStrip(l);
    holdDemand(RESIDENTIAL_ONLY, () => growStrips(l, 120));
    expect(freeOn(l, "factories")).toBe(0);
  });

  it("tries an R3 strip whose gaps are under 4 cells wide once, and spends no tick on them after", () => {
    const l = layout();
    const state = l.state;
    zoneR3Gaps(l);
    holdDemand(RESIDENTIAL_ONLY, () => {
      runDays(state, 1);
      const tried = setAsideCount(state);
      // Every front cell of the five runs of three, once.
      expect(tried).toBe(15);
      runDays(state, 20);
      expect(setAsideCount(state)).toBe(tried);
      expect(bestCandidate(state, syncCells(state), () => segmentBuildings(state), () => pollutionGrid(state), 1)).toBeNull();
      // A city loaded from a save tries them once more, and builds the same.
      const loaded = deserialize(serialize(state)).state;
      runDays(loaded, 1);
      expect(setAsideCount(loaded)).toBe(tried);
      runDays(state, 1);
      expect(hashState(loaded)).toBe(hashState(state));
    });
    expect([...state.buildings.flags].filter(Boolean)).toEqual([]);
  });

  it("hashes the same saved and loaded while it grows as a city that never stopped, through a street, a bulldozer, zoning and new factories", () => {
    const run = (saveAt: number[]): string => {
      const l = layout();
      zoneFactories(l);
      zoneWaterStrip(l);
      zoneFactoryStrip(l);
      zoneR3Gaps(l);
      let state = l.state;
      const start = state.tick;
      const send = (type: string, payload: unknown) => expect(submit(state, { seq: ++seq, playerId: "p1", type, payload }), type).toEqual({ ok: true });
      holdDemand({ residential: 100, industrial: 100, commercial: -1, office: -1 }, () =>
        withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () => {
          while (state.tick < start + 60 * DAY) {
            const t = state.tick - start;
            if (saveAt.includes(t)) state = deserialize(serialize(state)).state;
            if (t === 1500) send("BuildRoad", { from: { x: l.xs - CELL * 20, z: l.zs - CELL * 8 }, to: { x: l.xs + CELL * 20, z: l.zs - CELL * 8 }, type: "street" });
            if (t === 2500) {
              const [home] = homesOn({ ...l, state }, "water");
              if (home !== undefined) send("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, home)] });
            }
            if (t === 3500) send("ZoneCells", { zone: "residential", density: 3, rects: [{ from: { x: l.x0 + CELL * 7 + 2, z: l.z0 - 29 }, to: { x: l.x0 + CELL * 8 - 2, z: l.z0 - 29 }, width: 44 }] });
            step(state);
          }
        }),
      );
      expect(state.log.filter((e) => e.tick >= start).map((e) => e.type)).toEqual(["BuildRoad", "BulldozeBuilding", "ZoneCells"]);
      expect([...state.buildings.flags].filter(Boolean).length).toBeGreaterThan(20);
      return hashState(state);
    };
    const straight = run([]);
    for (const at of [150, 1500, 1501, 2501, 3501, 4321]) expect(run([at]), `saved at ${at}`).toBe(straight);
  });
});

describe("land value shapes who moves in", () => {
  it("finds wealthier pops on the more valuable strip, among first arrivals and households replaced later", () => {
    const l = withFactories();
    zoneWaterStrip(l);
    zoneFactoryStrip(l);
    const water = homesOn(l, "water");
    expect(water).toEqual([]);
    holdDemand(RESIDENTIAL_ONLY, () =>
      // Nobody leaves for want of work: this is about who comes.
      withValue(POPS_BALANCE.satisfaction, "leaveBelow", 0, () => {
        growStrips(l, 120);
        runDays(l.state, 20);
        const values = { water: homesOn(l, "water").map((id) => buildingValue(l.state, id)), factories: homesOn(l, "factories").map((id) => buildingValue(l.state, id)) };
        expect(Math.min(...values.water)).toBeGreaterThan(Math.max(...values.factories));
        const first = { water: meanWealth(l, "water"), factories: meanWealth(l, "factories") };
        expect(first.water.pops).toBeGreaterThan(20);
        expect(first.factories.pops).toBeGreaterThan(20);
        expect(first.water.mean).toBeGreaterThan(first.factories.mean + 0.4);
        // Then a few years' worth of households replaced, in a few months.
        const departures = l.state.stats.year.departures;
        withValue(POPS_BALANCE.turnover, "replacementsPerPopYear", 12, () => runDays(l.state, 90));
        expect(l.state.stats.year.departures - departures).toBeGreaterThan(first.water.pops + first.factories.pops);
        const later = { water: meanWealth(l, "water"), factories: meanWealth(l, "factories") };
        expect(later.water.mean).toBeGreaterThan(later.factories.mean + 0.4);
      }),
    );
  });
});
