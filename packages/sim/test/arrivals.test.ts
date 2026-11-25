import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  NONE,
  POPS_BALANCE,
  TIME_BALANCE,
  ZONING_BALANCE,
  checkDemandBalance,
  checkPopsBalance,
  connectionEnd,
  createState,
  dayArrivals,
  deserialize,
  drawSize,
  hashState,
  homeRoomLeft,
  newcomerRoomLeft,
  homeUnfilled,
  homesHeld,
  popSizeCap,
  popsAtHome,
  reachableRoom,
  readPop,
  recountTotals,
  replay,
  serialize,
  step,
  whyNoNewcomers,
  workersFor,
  yearDays,
  type Command,
  type SimState,
} from "../src/index";
import { nextInt, seedRng } from "../src/rng";
import { drawnAt } from "../src/pops/arrivals";
import { submit } from "./seen-ends";
import { holdDemand, type HeldBars } from "./demand-helper";

// M3-08: pops move in. While the residential bar is above zero people
// arrive each game day, spread over its ticks, and take free room in homes
// whose road reaches an outside connection. New homes wait while the room
// standing homes have empty is more than a set share of it.

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

/** Where a street from `state`'s first connection starts, and the way it runs. */
interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** A street `places` cells long from the stub end of the first outside connection, or, `joined` false, the same street a cell's gap short of it. */
function street(state: SimState, places: number, joined = true): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const gap = joined ? 0 : 3 * CELL;
  const s = { x: (r.nodeX[inner] ?? 0) + dx * gap, z: (r.nodeZ[inner] ?? 0) + dz * gap, dx, dz };
  ok(state, "BuildRoad", { from: { x: s.x, z: s.z }, to: { x: s.x + dx * CELL * places, z: s.z + dz * CELL * places }, type: "street" });
  return s;
}

/** Zones `depth` cells deep from place `p0` for `width` places along `s`, on one side or the other. */
function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1 = 1): void {
  const off = side * (5 + (CELL * depth) / 2);
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

function runDays(state: SimState, days: number): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) step(state);
}

function homes(state: SimState): number[] {
  const out: number[] = [];
  const b = state.buildings;
  for (let id = 0; id < b.flags.length; id++) if (b.flags[id] && (b.residents[id] ?? 0) > 0) out.push(id);
  return out;
}

function pops(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.pops.flags.length; id++) if (state.pops.flags[id]) out.push(id);
  return out;
}

const typeOf = (state: SimState, building: number) => BUILDING_TYPES[state.buildings.type[building] ?? 0];

function expectRecount(state: SimState): void {
  expect(state.stats.totals).toEqual(recountTotals(state));
}

/** A city with an R1 street, both sides six deep, joined to the outside or not. */
function r1Street(joined = true, places = 24): { state: SimState; s: Street } {
  const state = createState(SEED);
  const s = street(state, places, joined);
  zone(state, s, "residential", 1, 0, places, 6, 1);
  zone(state, s, "residential", 1, 0, places, 6, -1);
  return { state, s };
}

/** A city with an empty R3 lot of 4 x 4 on a street joined to the outside. */
function towerLot(): { state: SimState; s: Street } {
  const state = createState(SEED);
  const s = street(state, 12);
  zone(state, s, "residential", 3, 4, 4, 4, 1);
  return { state, s };
}

const hold = <T>(bars: HeldBars, run: () => T): T => holdDemand(bars, run);

describe("the day's arrivals", () => {
  it("are none while the residential bar is at or below zero, and follow it above", () => {
    const perDay = DEMAND_BALANCE.arrivalsPerYearAtFullDemand / yearDays();
    expect(dayArrivals(0)).toBe(0);
    expect(dayArrivals(-40, 5000)).toBe(0);
    expect(dayArrivals(100)).toBe(Math.ceil(perDay));
    expect(dayArrivals(50)).toBe(Math.ceil(perDay / 2));
    expect(dayArrivals(0.01)).toBe(1);
    // About 40,000 a year at full demand with little room empty (M3-21).
    expect(dayArrivals(100) * yearDays()).toBeGreaterThanOrEqual(40000);
    expect(dayArrivals(100) * yearDays()).toBeLessThan(40500);
  });

  it("follow the empty room where more stands empty, so towers fill in about fillDays days (M3-21)", () => {
    const days = DEMAND_BALANCE.fillDays;
    const perDay = DEMAND_BALANCE.arrivalsPerYearAtFullDemand / yearDays();
    // A street of houses with a few places empty arrives at the floor.
    expect(dayArrivals(100, 20)).toBe(Math.ceil(perDay));
    // Five empty towers of 1,000 bring their room over fillDays a day.
    expect(dayArrivals(100, 5000)).toBe(Math.ceil(5000 / days));
    expect(dayArrivals(50, 5000)).toBe(Math.ceil(2500 / days));
    expect(dayArrivals(-1, 5000)).toBe(0);
  });

  it("draw a home from the weights' tree where a walk along the weights in id order lands (M3-21)", () => {
    const rng = seedRng(11);
    for (let run = 0; run < 200; run++) {
      const n = 1 + nextInt(rng, 40);
      const weights = Array.from({ length: n }, () => (nextInt(rng, 4) === 0 ? 0 : 1 + nextInt(rng, 80)));
      weights[nextInt(rng, n)] = 1 + nextInt(rng, 80);
      const tree = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) for (let j = i + 1; j <= n; j += j & -j) tree[j] = (tree[j] ?? 0) + (weights[i] ?? 0);
      const total = weights.reduce((a, b) => a + b, 0);
      for (let u = 0; u < total; u++) {
        let at = 0;
        for (let edge = weights[0] ?? 0; u >= edge; edge += weights[at] ?? 0) at++;
        expect(drawnAt({ homes: weights, tree }, u), `run ${run}, u ${u}`).toBe(at);
      }
    }
  });

  it("draw a household's size within its density's range, the size cap and the room left", () => {
    const rng = seedRng(3);
    for (let density = 1; density <= 3; density++) {
      const [least, most] = POPS_BALANCE.newcomer.size[density - 1] ?? [1, 1];
      expect(most).toBeLessThanOrEqual(popSizeCap(density));
      const seen = new Set<number>();
      for (let i = 0; i < 400; i++) seen.add(drawSize(rng, density, 1000));
      expect(Math.min(...seen)).toBe(least);
      expect(Math.max(...seen)).toBe(most);
      for (let i = 0; i < 50; i++) expect(drawSize(rng, density, 2)).toBeLessThanOrEqual(2);
    }
  });
});

describe("a street from an outside connection, zoned R1", () => {
  const { state } = r1Street();
  runDays(state, 20);

  it("has houses with people in them, households of different sizes, on the pull from outside", () => {
    const people = pops(state);
    expect(people.length).toBeGreaterThan(10);
    const houses = homes(state).filter((id) => typeOf(state, id)?.id === "single-family-home");
    expect(houses.length).toBeGreaterThan(5);
    const sizes = new Set<number>();
    for (const house of houses) {
      // A house holds room for four and takes one household.
      expect(state.buildings.residents[house]).toBe(4);
      const living = popsAtHome(state, house);
      expect(living.length).toBeLessThanOrEqual(1);
      for (const id of living) sizes.add(readPop(state.pops, id).size);
    }
    expect(sizes.size).toBeGreaterThan(1);
    expectRecount(state);
  });

  it("gives every newcomer no job, a profile in range and a home with room for it", () => {
    for (const id of pops(state)) {
      const pop = readPop(state.pops, id);
      expect(pop.work).toBe(-1);
      // A newcomer starts at the newcomer's score, then each day moves toward its target (M3-10): down for one with workers and no job, up for one with nobody who works.
      const start = POPS_BALANCE.newcomer.satisfaction;
      if (workersFor(pop.size, pop.children) > 0) expect(pop.satisfaction).toBeLessThanOrEqual(start);
      else expect(pop.satisfaction).toBeGreaterThanOrEqual(start);
      expect(pop.size).toBeLessThanOrEqual(popSizeCap(state.buildings.density[pop.home] ?? 1));
    }
  });

  it("counts every arrival in the year's arrivals", () => {
    expect(state.stats.year.arrivals).toBe(state.stats.totals["population"]);
  });

  it("spreads a day's arrivals over its ticks, not all on the first", () => {
    // A street of houses built while joined to nothing, then joined, so
    // there is room for the whole day's arrivals.
    const { state: city, s } = r1Street(false);
    runDays(city, 10);
    expect(pops(city)).toEqual([]);
    const r = city.roads;
    const inner = connectionEnd(r, city.connections[0] ?? NONE);
    ok(city, "BuildRoad", { from: { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0 }, to: { x: s.x, z: s.z }, type: "street" });
    expect(whyNoNewcomers(city, homes(city)[0] ?? -1)).toBeNull();
    const ticksWithArrivals = new Set<number>();
    hold({ residential: 100 }, () => {
      while (city.tick % DAY !== 0) step(city);
      for (let t = 0; t < DAY; t++) {
        const before = city.stats.year.arrivals;
        step(city);
        if (city.stats.year.arrivals > before) ticksWithArrivals.add((city.tick - 1) % DAY);
      }
    });
    expect(ticksWithArrivals.size).toBeGreaterThan(5);
    expect(Math.max(...ticksWithArrivals)).toBeGreaterThan(DAY / 2);
  });

  it("has no reason for its homes to stay empty", () => {
    for (const home of homes(state)) expect(whyNoNewcomers(state, home)).toBeNull();
  });
});

describe("a street joined to nothing, zoned R1", () => {
  const { state } = r1Street(false);
  runDays(state, 10);

  it("builds houses that stay empty, and says it is for want of a route outside", () => {
    expect(homes(state).length).toBeGreaterThan(3);
    expect(pops(state)).toEqual([]);
    expect(state.demand.residential.value).toBeGreaterThan(0);
    for (const home of homes(state)) expect(whyNoNewcomers(state, home)).toBe("noRoute");
    // Room nobody can reach does not hold new homes back.
    expect(reachableRoom(state)).toEqual({ capacity: 0, empty: 0, unfilled: 0 });
    expect(homesHeld(state)).toBe(false);
    expectRecount(state);
  });

  it("says a home with a route waits for demand while the residential bar is at or below zero", () => {
    const { state: joined } = r1Street(true, 8);
    hold({ residential: 100 }, () => runDays(joined, 1));
    const home = homes(joined)[0] ?? -1;
    expect(home).toBeGreaterThanOrEqual(0);
    expect(whyNoNewcomers(joined, home)).toBeNull();
    hold({ residential: -10 }, () => step(joined));
    expect(whyNoNewcomers(joined, home)).toBe("noDemand");
    // Not a home: no reason.
    expect(whyNoNewcomers(joined, -1)).toBeNull();
  });
});

describe("an R3 lot of 4 x 4 from an outside connection", () => {
  it("fills its tower with several pops, each within the size cap", () => {
    const { state } = towerLot();
    hold({ residential: 100 }, () => runDays(state, 2));
    const [tower] = homes(state);
    expect(tower).toBeDefined();
    const id = tower ?? -1;
    expect(typeOf(state, id)?.density).toBe(3);
    const room = state.buildings.residents[id] ?? 0;
    hold({ residential: 100 }, () => {
      for (let day = 0; day < 60 && homeRoomLeft(state, id) > 0; day++) runDays(state, 1);
    });
    expect(homeRoomLeft(state, id)).toBe(0);
    const living = popsAtHome(state, id);
    expect(living.length).toBeGreaterThan(2);
    let people = 0;
    for (const pop of living) {
      const size = readPop(state.pops, pop).size;
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(popSizeCap(3));
      people += size;
    }
    expect(people).toBe(room);
    expectRecount(state);
  });
});

describe("homes standing fill before more are built", () => {
  /** The homes newcomers can reach that are still filling, leaving out `added`. */
  function unfilledWithout(state: SimState, added: readonly number[]): number {
    let n = reachableRoom(state).unfilled;
    for (const id of added) if (homeUnfilled(state.buildings.residents[id] ?? 0, newcomerRoomLeft(state, id))) n--;
    return n;
  }

  it("holds homes back while unfilledHomesMax of them are still filling, fills several towers side by side, and builds again as they fill (M3-21)", () => {
    const state = createState(SEED);
    const s = street(state, 48);
    zone(state, s, "residential", 3, 0, 24, 6, 1);
    zone(state, s, "residential", 3, 24, 24, 6, 1);
    const most = DEMAND_BALANCE.unfilledHomesMax;
    hold({ residential: 100 }, () => {
      let filling = 0;
      for (let t = 0; t < 40 * DAY; t++) {
        const before = new Set(homes(state));
        step(state);
        const added = homes(state).filter((id) => !before.has(id));
        // A home comes only while fewer than the most were still filling before it.
        if (added.length > 0) expect(unfilledWithout(state, added), `tick ${state.tick}`).toBeLessThan(most);
        filling = Math.max(filling, reachableRoom(state).unfilled);
      }
      // More than one tower filled at once. A full tower a household leaves counts again, so the count can pass the most for a while.
      expect(filling).toBeGreaterThan(1);
      expect(homesHeld(state)).toBe(reachableRoom(state).unfilled >= most);
      // Towers filled in days, not weeks: most of what was built is lived in.
      const { capacity, empty } = reachableRoom(state);
      expect(homes(state).length).toBeGreaterThan(most);
      expect(empty).toBeLessThan(0.5 * capacity);
    });
    expectRecount(state);
  });
});

describe("arrivals and determinism", () => {
  /** A joined R1 street at full residential demand, run `days`, returning the state. */
  function busy(days: number): SimState {
    // Every run sends the same commands, the same seq included.
    seq = 0;
    const { state } = r1Street();
    hold({ residential: 100 }, () => runDays(state, days));
    return state;
  }

  it("replays a recorded log to the same pops and the same state hash", () => {
    const state = createState(SEED);
    const s = street(state, 24);
    zone(state, s, "residential", 1, 0, 24, 6, 1);
    zone(state, s, "residential", 2, 0, 24, 6, -1);
    runDays(state, 15);
    expect(pops(state).length).toBeGreaterThan(10);
    const again = replay(SEED, state.log, state.tick);
    expect(Array.from(again.pops.size)).toEqual(Array.from(state.pops.size));
    expect(Array.from(again.pops.home)).toEqual(Array.from(state.pops.home));
    expect(hashState(again)).toBe(hashState(state));
    expectRecount(again);
  });

  it("lands the same pops in a city saved and loaded while people arrive as in one that never stopped", () => {
    hold({ residential: 100 }, () => {
      const state = busy(3);
      // Mid-day, and owing people back to a household that came early, if any did.
      while (state.tick % DAY !== 37) step(state);
      const loaded = deserialize(serialize(state)).state;
      expect(hashState(loaded)).toBe(hashState(state));
      for (let t = 0; t < 4 * DAY; t++) {
        step(state);
        step(loaded);
      }
      expect(pops(state).length).toBeGreaterThan(20);
      expect(hashState(loaded)).toBe(hashState(state));
      expectRecount(loaded);
    });
  });

  it("is the same on every run", () => {
    expect(hashState(busy(4))).toBe(hashState(busy(4)));
  });
});

describe("the balance for arrivals", () => {
  it("refuses newcomer sizes out of range and an empty-room share outside 0 to 1", () => {
    const pops = (size: unknown) => ({ ...POPS_BALANCE, newcomer: { ...POPS_BALANCE.newcomer, size } });
    expect(checkPopsBalance(pops(POPS_BALANCE.newcomer.size))).toEqual([]);
    expect(checkPopsBalance(pops([[1, 4], [2, 20]]))).not.toEqual([]);
    expect(checkPopsBalance(pops([[0, 4], [2, 20], [20, 100]]))).not.toEqual([]);
    expect(checkPopsBalance(pops([[3, 2], [2, 20], [20, 100]]))).not.toEqual([]);
    expect(checkPopsBalance(pops([[1, 6], [2, 20], [20, 100]]))).toEqual(["newcomer.size[0] must not hold more than popSizeCap[0], 5"]);
    const newcomer = (satisfaction: unknown) => ({ ...POPS_BALANCE, newcomer: { ...POPS_BALANCE.newcomer, satisfaction } });
    expect(checkPopsBalance(newcomer(101))).not.toEqual([]);
    expect(checkPopsBalance(newcomer(0.5))).not.toEqual([]);
    // The numbers M3-21 added, each refused out of range by name, and the share M3-21 removed refused as unknown.
    const bad = (key: string, value: unknown) => checkDemandBalance({ ...DEMAND_BALANCE, [key]: value }).join();
    expect(bad("unfilledHomesMax", 0)).toContain("unfilledHomesMax");
    expect(bad("unfilledHomesMax", 2.5)).toContain("unfilledHomesMax");
    expect(bad("homeFullShare", 0)).toContain("homeFullShare");
    expect(bad("homeFullShare", 1.2)).toContain("homeFullShare");
    expect(bad("fillDays", 0)).toContain("fillDays");
    expect(bad("openJobsMin", -1)).toContain("openJobsMin");
    expect(bad("openJobsMin", 0.5)).toContain("openJobsMin");
    expect(bad("emptyRoomShareMax", 0.1)).toContain("emptyRoomShareMax");
    expect(checkDemandBalance(DEMAND_BALANCE)).toEqual([]);
  });
});
