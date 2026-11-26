import { describe, expect, it } from "vitest";
import {
  BUILDING_ABANDONED,
  BUILDING_ALIVE,
  BUILDING_UNZONED,
  NO_BUILDING,
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  LAND_VALUE_BALANCE,
  NONE,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingGround,
  buildingOnSlot,
  connectionEnd,
  checkDemandBalance,
  checkLandValueBalance,
  createState,
  deserialize,
  hashState,
  isAbandoned,
  planRedevelopment,
  readBuilding,
  recountTotals,
  serialize,
  step,
  zonedUpTo,
  type Command,
  type SimState,
} from "../src/index";
import { popIndexOf } from "../src/pops/where";
import { NO_HOME, isPop, removePop } from "../src/pops/pops";
import { buildingSlots } from "../src/buildings/where";
import { cloneState } from "../src/state";
import { expectReplay, type ReplayFixture } from "./replay-helper";
import demandJson from "../balance/demand.json" with { type: "json" };
import landValueJson from "../balance/landvalue.json" with { type: "json" };
import fixtureJson from "./fixtures/replay/redevelopment.json" with { type: "json" };
import { buildingValue } from "../src/landvalue/land-value";
import { submit } from "./seen-ends";
import { holdDemand } from "./demand-helper";
import { withValue } from "./with-value";
import { credited } from "./credited";

// M3-14: redevelopment. Built ground zoned up rebuilds on its own, sooner
// where the land is worth more, a few buildings a day; a building on ground
// zoned for something else stands while it is in use, and once abandoned
// is cleared for what the ground is zoned for now.

// Seed 2026's first outside connection runs east into dry ground, where a
// street from its stub end zones on both sides (outside.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The ground at the stub end of the first outside connection, and the way east along it. */
function stubEnd(state: SimState): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
}

/** A road `places` cells long from `s` on, of `type`; returns where it ends, the way it ran. */
function road(state: SimState, s: Street, places: number, type = "street"): Street {
  const to = { x: s.x + s.dx * CELL * places, z: s.z + s.dz * CELL * places };
  ok(state, "BuildRoad", { from: { x: s.x, z: s.z }, to, type });
  return { ...to, dx: s.dx, dz: s.dz };
}

/** Zones `depth` cells deep from place `p0` for `width` places along `s`, on one side or the other. */
function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1, inset = 5): void {
  const off = side * (inset + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  ok(state, "ZoneCells", {
    zone: zoneId,
    density,
    rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }],
  });
}

/** Zones both sides of `s`. */
function zoneBoth(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, inset = 5): void {
  zone(state, s, zoneId, density, p0, width, depth, 1, inset);
  zone(state, s, zoneId, density, p0, width, depth, -1, inset);
}

function toDayStart(state: SimState): void {
  while (state.tick % DAY !== 0) step(state);
}

/** Runs `days` game days, calling `each` at the end of each. */
function runDays(state: SimState, days: number, each?: (day: number) => void): void {
  for (let day = 0; day < days; day++) {
    const until = state.tick + DAY;
    while (state.tick < until) step(state);
    each?.(day + 1);
  }
}

function live(state: SimState, keep: (id: number) => boolean = () => true): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id] && keep(id)) out.push(id);
  return out;
}

const ofDensity = (state: SimState, zoneNumber: number, density: number): number[] =>
  live(state, (id) => state.buildings.zone[id] === zoneNumber && state.buildings.density[id] === density);
const people = (state: SimState, id: number): number => popIndexOf(state).people[id] ?? 0;
const RESIDENTIAL = 1;
const COMMERCIAL = 2;

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
}

/** A building's lot as its row names it, to tell one building from another that took its freed id. */
const key = (state: SimState, id: number): string => {
  const b = readBuilding(state.buildings, id);
  return `${id}/${b.firstSeg}/${b.firstSide}/${b.firstPlace}/${b.builtAt}`;
};

/**
 * Houses on a street from the outside connection's stub and, straight on
 * from it, an avenue, both zoned R1 six deep on both sides and grown out
 * with the residential bar held up, people moved in. Land value counts the
 * avenue's frontage for much more than the street's, so its houses stand on
 * the more valuable ground.
 */
function houses(depth = 6): { state: SimState; street: Street; avenue: Street } {
  const state = credited(createState(SEED));
  const s = stubEnd(state);
  const end = road(state, s, 24);
  road(state, end, 24, "avenue");
  zoneBoth(state, s, "residential", 1, 0, 24, depth);
  // An avenue's edge is further from its middle than a street's.
  zoneBoth(state, end, "residential", 1, 0, 24, depth, 9);
  // No development charge, so the houses grow at the bar's full pace (M4-08).
  ok(state, "SetDevelopmentCharge", { zone: "residential", rate: 0 });
  holdDemand({ residential: 60 }, () => {
    toDayStart(state);
    runDays(state, 25);
  });
  return { state, street: s, avenue: end };
}

/**
 * Runs `body` with the street's frontage worth no points and the avenue's
 * 40, so the avenue's houses stand on ground worth 100 and the street's on
 * ground worth 60, and with owners counting land value from 40, so an owner
 * on the avenue is three times as likely to rebuild on a given day.
 */
function avenueWorthMore<T>(body: () => T): T {
  return withValue(LAND_VALUE_BALANCE.roadAccess, "street", 0, () =>
    withValue(LAND_VALUE_BALANCE.roadAccess, "avenue", 40, () => withValue(DEMAND_BALANCE.redevelopment, "valueFrom", 40, () => noHomeHold(body))),
  );
}

/**
 * Runs `body` with the hold on new homes out of reach (M3-21). These towns
 * have no jobs and their bar is held up, so newcomers leave for want of
 * work as fast as they come, the towers never fill, and the hold would
 * stop redevelopment for good. The hold has a test of its own below.
 */
function noHomeHold<T>(body: () => T): T {
  return withValue(DEMAND_BALANCE, "unfilledHomesMax", 1_000_000, body);
}

/** Rezones the houses' ground, six deep on both sides of the street and the avenue. */
function rezone(state: SimState, street: Street, avenue: Street, zoneId: string, density: number, depth = 6): void {
  zoneBoth(state, street, zoneId, density, 0, 24, depth);
  zoneBoth(state, avenue, zoneId, density, 0, 24, depth, 9);
}

/** The game day a tick falls on. */
const dayOf = (tick: number): number => Math.floor(tick / DAY);

describe("the balance", () => {
  it("checks the redevelopment numbers in demand.json and landvalue.json", () => {
    expect(checkDemandBalance(demandJson)).toEqual([]);
    expect(checkLandValueBalance(landValueJson)).toEqual([]);
    const pace = (over: Record<string, unknown>) => checkDemandBalance({ ...demandJson, redevelopment: { ...demandJson.redevelopment, ...over } }).join();
    expect(pace({ chancePerDay: 1.5 })).toContain("chancePerDay");
    expect(pace({ perDayMax: 2.5 })).toContain("perDayMax");
    expect(pace({ valueFrom: 100 })).toContain("valueFrom");
    const worth = (over: Record<string, unknown>) => checkLandValueBalance({ ...landValueJson, redevelopment: { ...landValueJson.redevelopment, ...over } }).join();
    expect(worth({ worthByDensity: [1, 2] })).toContain("worthByDensity");
    expect(worth({ worthByDensity: [3, 2, 1] })).toContain("rise");
    expect(worth({ margin: -1 })).toContain("margin");
    expect(worth({ extra: 1 })).toContain("extra");
  });
});

describe("a built R1 street rezoned to R3", () => {
  it("finds houses replaced by towers over game months, the most valuable ground first, and their pops housed elsewhere (scenario test)", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      const b = state.buildings;
      const before = live(state);
      expect(before.length).toBeGreaterThan(30);
      expect(before.every((id) => b.zone[id] === RESIDENTIAL && b.density[id] === 1)).toBe(true);
      const onAvenue = (seg: number) => before.some((id) => b.firstSeg[id] === seg && buildingValue(state, id) > 80);
      const population = state.stats.totals["population"] ?? 0;
      expect(population).toBeGreaterThan(200);
      rezone(state, street, avenue, "residential", 3);
      const rezonedOn = dayOf(state.tick);
      for (const id of before) expect(zonedUpTo(state, id)).toBe(3);
      const lived = new Map<number, number>();
      for (let pop = 0; pop < state.pops.home.length; pop++) if (isPop(state.pops, pop)) lived.set(pop, state.pops.home[pop] ?? NO_HOME);
      const standing = new Set(before.map((id) => key(state, id)));
      const worthAt = new Map(before.map((id) => [id, buildingValue(state, id)]));
      const goneOn = new Map<number, number>();
      holdDemand({ residential: 60 }, () =>
        runDays(state, 200, () => {
          // Each house goes whole, all at once with the ones its tower takes in.
          for (const k of [...standing]) {
            const id = Number(k.split("/")[0]);
            if (b.flags[id] && key(state, id) === k) continue;
            standing.delete(k);
            goneOn.set(id, state.tick);
          }
          // Displaced pops find homes within the day.
          expect(state.pops.displaced.length).toBe(0);
        }),
      );
      const towers = ofDensity(state, RESIDENTIAL, 3);
      expect(towers.length).toBeGreaterThan(8);
      expect(towers.every((id) => ["low-tower", "high-tower"].includes(BUILDING_TYPES[b.type[id] ?? 0]?.id ?? ""))).toBe(true);
      // Most houses went.
      expect(standing.size).toBeLessThan(before.length / 4);
      // Over game months, not in a day: the first and the last tower about two months apart or more, none before the rezone.
      // An owner the day's slice reaches after the rezone may rebuild that same day.
      const days = towers.map((id) => dayOf(b.builtAt[id] ?? 0)).sort((p, q) => p - q);
      expect(days[0]).toBeGreaterThanOrEqual(rezonedOn);
      expect((days.at(-1) ?? 0) - (days[0] ?? 0)).toBeGreaterThan(45);
      const counts = new Map<number, number>();
      for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(DEMAND_BALANCE.redevelopment.perDayMax);
      // Towers came on both the avenue and the street.
      const avenueTowers = towers.filter((id) => onAvenue(b.firstSeg[id] ?? -1));
      const streetTowers = towers.filter((id) => !onAvenue(b.firstSeg[id] ?? -1));
      expect(avenueTowers.length).toBeGreaterThan(2);
      expect(streetTowers.length).toBeGreaterThan(2);
      // The houses on the most valuable ground went first (M3-21: by the houses' own value, since a
      // tower count of a dozen made the avenue's and the street's median towers a matter of chance).
      // Since M4-08 by the day each went: a tower takes two or three houses at once, so the first and
      // second half of the houses by the order they went was a dozen draws, and swung either way.
      const gone = [...goneOn].sort((p, q) => p[1] - q[1]);
      const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);
      const wentOn = (keep: (worth: number) => boolean) => mean(gone.filter(([id]) => keep(worthAt.get(id) ?? 0)).map(([, tick]) => tick / DAY));
      expect(gone.length).toBeGreaterThan(20);
      // The avenue's houses stand on ground worth 100 and the street's on 60 (`avenueWorthMore`).
      expect(gone.some(([id]) => (worthAt.get(id) ?? 0) < 80)).toBe(true);
      expect(wentOn((worth) => worth > 80) + 15).toBeLessThan(wentOn((worth) => worth < 80));
      // The pops of the houses replaced live elsewhere now, nobody waits, and the towers hold more people than the houses did.
      let moved = 0;
      for (const [pop, home] of lived) {
        if (!isPop(state.pops, pop)) continue;
        const now = state.pops.home[pop] ?? NO_HOME;
        expect(now).not.toBe(NO_HOME);
        if (now !== home) moved++;
      }
      expect(moved).toBeGreaterThan(20);
      expect(state.pops.displaced.length).toBe(0);
      expect(state.stats.totals["population"] ?? 0).toBeGreaterThan(population);
      expectRecount(state);
    });
  });

  it("finds nothing replaced with the residential bar below zero", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      const before = live(state).map((id) => key(state, id));
      rezone(state, street, avenue, "residential", 3);
      // Shorter than a home takes to stand vacant and be abandoned, so every house stands as it was.
      holdDemand({ residential: -20 }, () => runDays(state, 60));
      expect(live(state).map((id) => key(state, id))).toEqual(before);
      expect(ofDensity(state, RESIDENTIAL, 3)).toEqual([]);
      expect(state.redevelopedToday).toBe(0);
      expectRecount(state);
    });
  });

  it("finds the houses stay on a strip only 2 cells deep, since no R3 lot fits", () => {
    const { state, street, avenue } = avenueWorthMore(() => houses(2));
    const b = state.buildings;
    const ids = live(state);
    expect(ids.length).toBeGreaterThan(20);
    const before = ids.map((id) => key(state, id));
    rezone(state, street, avenue, "residential", 3, 2);
    for (const id of ids) {
      expect(zonedUpTo(state, id)).toBe(3);
      expect(planRedevelopment(state, id)).toBeNull();
    }
    avenueWorthMore(() => holdDemand({ residential: 60 }, () => runDays(state, 60)));
    expect(live(state).map((id) => key(state, id))).toEqual(before);
    for (const id of ids) expect(buildingGround(state, id)).toEqual({ kind: "zoned-up", zone: RESIDENTIAL, density: 3 });
    // Abandoned there, a house is not cleared: no R3 lot would take the bare ground.
    withValue(DEMAND_BALANCE.vacancy, "newDays", 5, () =>
      withValue(DEMAND_BALANCE.vacancy, "abandonDays", 10, () => holdDemand({ residential: -60 }, () => runDays(state, 50))),
    );
    const abandoned = ids.filter((id) => isAbandoned(b, id));
    expect(abandoned.length).toBeGreaterThan(0);
    for (const id of abandoned) expect(b.flags[id]).toBe(BUILDING_ALIVE | BUILDING_ABANDONED | BUILDING_UNZONED);
    expect(live(state).map((id) => key(state, id))).toEqual(before);
    expectRecount(state);
  });

  it("replaces several houses with one tower worth clearly more than they are together", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      rezone(state, street, avenue, "residential", 3);
      const b = state.buildings;
      const plans = live(state).map((id) => [id, planRedevelopment(state, id)] as const);
      const found = plans.filter(([, plan]) => plan !== null);
      expect(found.length).toBeGreaterThan(plans.length / 2);
      for (const [id, plan] of found) {
        if (!plan) continue;
        expect(plan.replaces).toContain(id);
        expect(plan.replaces.length).toBeGreaterThan(1);
        expect(plan.worth).toBeGreaterThanOrEqual(plan.worthReplaced * (1 + LAND_VALUE_BALANCE.redevelopment.margin));
        for (const other of plan.replaces) expect(b.zone[other]).toBe(RESIDENTIAL);
      }
      // With no margin a tower could never be worth enough, so none is planned.
      withValue(LAND_VALUE_BALANCE.redevelopment, "margin", 100, () => {
        for (const id of live(state)) expect(planRedevelopment(state, id)).toBeNull();
      });
    });
  });
});

describe("the hold on new homes", () => {
  it("replaces no house while unfilledHomesMax homes are still filling, and starts again as they fill (M3-21)", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      const before = new Map(live(state).map((id) => [id, key(state, id)]));
      rezone(state, street, avenue, "residential", 3);
      const replaced = () => [...before].filter(([id, k]) => !(state.buildings.flags[id] && key(state, id) === k)).length;
      withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () =>
        holdDemand({ residential: 100 }, () => {
          // Every home still filling: none replaced, however keen the owners.
          withValue(DEMAND_BALANCE, "unfilledHomesMax", 0, () => runDays(state, 5));
          expect(replaced()).toBe(0);
          // With room for one more home filling, towers come.
          withValue(DEMAND_BALANCE, "unfilledHomesMax", 1_000_000, () => runDays(state, 3));
          expect(replaced()).toBeGreaterThan(0);
        }),
      );
      expectRecount(state);
    });
  });
});

describe("the daily cap", () => {
  it("counts every house a tower takes in, and spreads them over the day", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      const most = 6;
      const before = new Map(live(state).map((id) => [id, key(state, id)]));
      rezone(state, street, avenue, "residential", 3);
      toDayStart(state);
      // Houses an owner rebuilt on the rest of the rezone's day, at the balance's own chance, are not the loop's to count.
      const gone = new Set([...before].filter(([id, k]) => !(state.buildings.flags[id] && key(state, id) === k)).map(([id]) => id));
      let towers = 0;
      // Every owner draws, so the cap and not the chance sets the pace.
      withValue(DEMAND_BALANCE.redevelopment, "perDayMax", most, () =>
        withValue(DEMAND_BALANCE.redevelopment, "chancePerDay", 1, () =>
          holdDemand({ residential: 100 }, () =>
            runDays(state, 8, () => {
              let today = 0;
              for (const [id, k] of before) {
                if (gone.has(id) || (state.buildings.flags[id] && key(state, id) === k)) continue;
                gone.add(id);
                today++;
              }
              expect(today).toBeLessThanOrEqual(most);
              expect(state.redevelopedToday).toBe(today);
              towers = ofDensity(state, RESIDENTIAL, 3).length;
            }),
          ),
        ),
      );
      expect(gone.size).toBeGreaterThan(most * 4);
      expect(towers).toBeGreaterThan(1);
      expectRecount(state);
    });
  });
});

describe("a built R1 street rezoned to C2", () => {
  it("finds every house standing while people live in it, and a shop in place of one that was abandoned (scenario test)", () => {
    const { state, street, avenue } = houses();
    const b = state.buildings;
    const before = live(state);
    rezone(state, street, avenue, "commercial", 2);
    for (const id of before) expect(buildingGround(state, id)).toEqual({ kind: "existing-use", zone: COMMERCIAL, density: 2 });
    // Empty one house: nobody arrives with the residential bar at zero, so it stays empty.
    const emptied = before.find((id) => BUILDING_TYPES[b.type[id] ?? 0]?.id === "plex" && people(state, id) > 0) ?? -1;
    expect(emptied).toBeGreaterThanOrEqual(0);
    const emptiedKey = key(state, emptied);
    const ground = buildingSlots(state, emptied) ?? [];
    expect(ground.length).toBeGreaterThan(0);
    for (let pop = 0; pop < state.pops.home.length; pop++) if (isPop(state.pops, pop) && state.pops.home[pop] === emptied) removePop(state, pop);
    expect(people(state, emptied)).toBe(0);
    // A shorter wait for vacancy and abandonment, so the test runs in a few
    // game months, and nobody leaves for want of a job: the street has none.
    const keys = new Map(before.map((id) => [id, key(state, id)]));
    const abandonedBefore = new Set<number>();
    withValue(DEMAND_BALANCE.vacancy, "newDays", 5, () =>
      withValue(DEMAND_BALANCE.vacancy, "abandonDays", 20, () =>
        withValue(DEMAND_BALANCE, "openJobsShareMax", 1, () =>
          withValue(POPS_BALANCE.satisfaction, "leaveAfterDays", 250, () =>
          holdDemand({ residential: 0, commercial: 60 }, () =>
            runDays(state, 40, () => {
              for (const [id, k] of keys) {
                const stands = b.flags[id] !== 0 && key(state, id) === k;
                // A house with people in it stands.
                if (stands && people(state, id) > 0) expect(b.flags[id]).toBe(BUILDING_ALIVE);
                if (!stands) expect(abandonedBefore.has(id), "only an abandoned house is cleared").toBe(true);
                if (stands && b.flags[id] === (BUILDING_ALIVE | BUILDING_ABANDONED | BUILDING_UNZONED)) abandonedBefore.add(id);
                if (stands && isAbandoned(b, id)) abandonedBefore.add(id);
                if (!stands) keys.delete(id);
              }
            }),
          ),
          ),
        ),
      ),
    );
    // The emptied house went, and a shop stands on its ground.
    expect(keys.has(emptied) && key(state, emptied) === emptiedKey).toBe(false);
    const shops = new Set(ground.map((slot) => buildingOnSlot(state, slot)).filter((id) => id !== NO_BUILDING));
    expect(shops.size).toBeGreaterThan(0);
    for (const id of shops) expect(b.zone[id]).toBe(COMMERCIAL);
    // Every house still lived in stands, a permitted existing use, and nothing went that people lived in.
    const lived = before.filter((id) => keys.has(id));
    expect(lived.length).toBeGreaterThan(before.length - 5);
    for (const id of lived) {
      expect(isAbandoned(b, id)).toBe(false);
      expect(buildingGround(state, id)?.kind).toBe("existing-use");
    }
    expectRecount(state);
  });
});

describe("a save mid-way", () => {
  it("carries on to the same city, and counts the day's redevelopments in the save", () => {
    avenueWorthMore(() => {
      const { state, street, avenue } = houses();
      rezone(state, street, avenue, "residential", 3);
      holdDemand({ residential: 60 }, () => {
        runDays(state, 20);
        while (state.redevelopedToday === 0) step(state);
        for (let i = 0; i < 37; i++) step(state);
        const saved = deserialize(serialize(state)).state;
        expect(saved.redevelopedToday).toBe(state.redevelopedToday);
        const straight = cloneState(state);
        runDays(straight, 30);
        runDays(saved, 30);
        expect(hashState(saved)).toBe(hashState(straight));
      });
    });
  });
});

describe("replay fixture redevelopment", () => {
  it("replays to its recorded hash, with towers in place of houses", () => {
    const state = expectReplay(fixtureJson as ReplayFixture);
    expect(ofDensity(state, RESIDENTIAL, 3).length).toBeGreaterThan(0);
    expect(ofDensity(state, RESIDENTIAL, 1).length).toBeGreaterThan(0);
    expectRecount(state);
  });
});
