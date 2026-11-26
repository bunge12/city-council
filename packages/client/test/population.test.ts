// Issue M3-15: population and demand in the top bar. The room the homes
// hold, for the population tooltip, is counted in the client from its copy
// of the city and moved by each building delta (it replaces the homes count
// of M2-18). Run against the same SimHost the worker runs, with an
// in-memory transport and a fake clock, so the grower, the bulldozer and
// undo all send real deltas. The trend arrow and the tooltips are checked
// from numbers set by hand.
import { describe, expect, it } from "vitest";
import {
  BUILDING_ABANDONED,
  CONNECTION_BALANCE,
  DEMAND_BALANCE,
  DEMAND_PARTS,
  NONE,
  SEG_FIXED,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingCount,
  connectionEnd,
  countZoneJobs,
  createState,
  createStats,
  homeRoom,
  isBuilding,
  reachableRoom,
  segmentEnds,
  segmentTypeId,
  step,
  submit,
  workplacesHeldBy,
  type DemandBar,
  type SimState,
} from "@city-council/sim";
import { creditMilestones, type SimState as Credited } from "@city-council/sim";

/** `state` with every milestone credited (M4-12), so the test zones densities 2 and 3 as it did before the locks. */
function credited<S extends Credited>(state: S): S {
  creditMilestones(state);
  return state;
}
import { countRoom, roomBefore } from "../src/protocol/room";
import { holdDemandBars } from "../src/protocol/held-demand";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { MIXED_NOTE } from "../src/ui/ZoneReadout";
import { PART_WORDS, formatDemandTitle, formatHomesWaiting, formatWaiting, formatParts, formatPopulationTitle, populationTrend, trendArrow } from "../src/ui/top-figures";

const SEED = 2026;
const RESIDENTIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;

function run(state: SimState, type: string, payload: unknown, seq: { n: number }): void {
  const result = submit(state, { seq: ++seq.n, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
}

/**
 * A street along z = 4600 from x = 4200 to 4392, zoned R1 on its north side
 * and C1 on its south side, grown until at least six buildings stand.
 */
function city(): SimState {
  const state = credited(createState(SEED));
  const seq = { n: 0 };
  run(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" }, seq);
  run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] }, seq);
  run(state, "ZoneCells", { zone: "commercial", density: 1, rects: [{ from: { x: 4202, z: 4629 }, to: { x: 4390, z: 4629 }, width: 44 }] }, seq);
  // Shops need commercial demand, which a city with no residents lacks (M3-07).
  const release = holdDemandBars(100);
  try {
    for (let t = 0; t < 6000 && buildingCount(state.buildings) < 6; t++) step(state);
  } finally {
    release();
  }
  if (buildingCount(state.buildings) < 6) throw new Error("the buildings did not grow");
  return state;
}

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  const ticks = (n: number) => {
    for (let t = 0; t < n * 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const send = async (type: string, payload: unknown = {}) => {
    const outcome = mirror.sendCommandSettled(type, payload);
    await settle();
    ticks(1);
    return outcome;
  };
  const copy = (): SimState => {
    const s = mirror.state;
    if (!s) throw new Error("no snapshot");
    return s as unknown as SimState;
  };
  /** The mirror's running room, and a full count of its copy, which must agree. */
  const check = () => {
    const full = countRoom(copy().buildings);
    expect(mirror.room).toBe(full);
    return full;
  };
  return { mirror, ticks, send, copy, check };
}

function homesIn(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id) && state.buildings.zone[id] === RESIDENTIAL) out.push(id);
  return out;
}

function street(state: SimState): number {
  const r = state.roads;
  for (let s = 0; s < r.segFlags.length; s++) {
    const flags = r.segFlags[s] ?? 0;
    if ((flags & 1) !== 0 && (flags & SEG_FIXED) === 0 && r.nodeZ[r.segA[s] ?? 0] === 4600) return s;
  }
  throw new Error("no street");
}

describe("the room the homes hold", () => {
  it("is null before a snapshot and counts the residents of every building that is not abandoned", () => {
    const { client } = memoryTransportPair();
    const mirror = new SimMirror(client, "p1");
    expect(mirror.room).toBeNull();
    const state = city();
    const homes = homesIn(state);
    expect(homes.length).toBeGreaterThan(0);
    expect(countRoom(state.buildings)).toBe(homes.reduce((sum, id) => sum + (state.buildings.residents[id] ?? 0), 0));
    expect(countRoom(state.buildings)).toBeGreaterThan(0);
  });

  it("matches a full count over the mirror after grows, removals and an undo", async () => {
    const { mirror, ticks, send, copy, check } = setup(city());
    ticks(1);
    const start = check();
    expect(start).toBeGreaterThan(0);

    // The grower builds more.
    expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
    for (let i = 0; i < 40 && (mirror.room ?? 0) <= start; i++) ticks(100);
    const grown = check();
    expect(grown).toBeGreaterThan(start);
    expect(await send("SetSpeed", { speed: 0 })).toEqual({ ok: true });

    // The bulldozer takes one house, and its room goes with it.
    const state = copy();
    const [house] = homesIn(state);
    if (house === undefined) throw new Error("no house");
    const room = homeRoom(state.buildings, house);
    const seen = {
      id: house,
      segment: state.buildings.firstSeg[house],
      side: state.buildings.firstSide[house],
      place: state.buildings.firstPlace[house],
      builtAt: state.buildings.builtAt[house],
    };
    expect(await send("BulldozeBuilding", { buildings: [seen] })).toEqual({ ok: true });
    expect(check()).toBe(grown - room);

    // A road takes every building on its cells. Undo brings the road and
    // its zoning back, not the buildings: the grower builds them again.
    const seg = street(copy());
    const net = copy().roads;
    expect(await send("BulldozeRoad", { segments: [seg], ends: [segmentEnds(net, seg)], types: [segmentTypeId(net, seg)] })).toEqual({ ok: true });
    expect(check()).toBe(0);
    expect(await send("Undo")).toEqual({ ok: true });
    expect(check()).toBe(0);
    expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
    for (let i = 0; i < 40 && (mirror.room ?? 0) === 0; i++) ticks(100);
    expect(check()).toBeGreaterThan(0);
  });

  it("counts a building cut off past a shrunk id limit as gone, and an abandoned one as holding no room", () => {
    const b = { flags: Uint8Array.of(1, 1, 1), residents: Int32Array.of(2, 3, 4) };
    expect(roomBefore(b, { ids: Int32Array.of(0), limit: 1 })).toBe(9);
    expect(roomBefore(b, { ids: Int32Array.of(1, 2), limit: 1 })).toBe(7);
    const abandoned = { flags: Uint8Array.of(1, 1 | BUILDING_ABANDONED, 0), residents: Int32Array.of(2, 3, 4) };
    expect(countRoom(abandoned)).toBe(2);
  });
});

/**
 * Issue #330: a street of 48 cells from the first outside connection,
 * zoned R3 six cells deep on both sides, so towers grow and fill side by
 * side and hold new homes back while they do.
 */
function towerCity(north = "residential", south = "residential"): SimState {
  const state = credited(createState(SEED));
  const seq = { n: 0 };
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const x = r.nodeX[inner] ?? 0;
  const z = r.nodeZ[inner] ?? 0;
  const cell = ZONING_BALANCE.cellSize;
  const places = 48;
  run(state, "BuildRoad", { from: { x, z }, to: { x: x + dx * cell * places, z: z + dz * cell * places }, type: "street" }, seq);
  // Each side in two halves: a ZoneCells rect is at most 256 m a side.
  for (const side of [1, -1]) {
    const zone = side === 1 ? north : south;
    for (const p0 of [0, places / 2]) {
      const off = side * (5 + (cell * 6) / 2);
      const [a, b] = [cell * p0 + 2, cell * (p0 + places / 2) - 2];
      const rect = { from: { x: x + dx * a - dz * off, z: z + dz * a + dx * off }, to: { x: x + dx * b - dz * off, z: z + dz * b + dx * off }, width: cell * 6 - 4 };
      run(state, "ZoneCells", { zone, density: zone === "residential" ? 3 : 1, rects: [rect] }, seq);
    }
  }
  return state;
}

describe("the homes waiting to fill", () => {
  it("is null before a snapshot", () => {
    const { client } = memoryTransportPair();
    expect(new SimMirror(client, "p1").homesWaiting()).toBeNull();
  });

  it("agrees with the sim's count while towers grow and fill, held and then not", async () => {
    const state = towerCity();
    const { mirror, ticks, send } = setup(state);
    ticks(1);
    expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    let held = 0;
    let free = 0;
    const release = holdDemandBars(100);
    try {
      for (let day = 0; day < 60 && (held === 0 || free === 0 || day < 20); day++) {
        ticks(100);
        await settle();
        const room = reachableRoom(state);
        const waiting = mirror.homesWaiting();
        if (room.unfilled >= DEMAND_BALANCE.unfilledHomesMax) {
          expect(waiting, `day ${day}`).toEqual(room);
          held++;
        } else {
          expect(waiting, `day ${day}`).toBeNull();
          if (held > 0) free++;
        }
      }
    } finally {
      release();
    }
    expect(held).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
  });
});

describe("the jobs waiting to fill (#420)", () => {
  it("is null before a snapshot, for every bar", () => {
    const { client } = memoryTransportPair();
    const mirror = new SimMirror(client, "p1");
    for (const bar of ["residential", "commercial", "office", "industrial"] as const) expect(mirror.waitingFor(bar)).toBeNull();
  });

  it("agrees with the sim's count of a zone's open jobs while the grower holds it, and is null while it does not", async () => {
    // Shops with nobody to staff them: every job open. With no floor on open jobs, that holds commercial back.
    const was = DEMAND_BALANCE.openJobsMin;
    DEMAND_BALANCE.openJobsMin = 0;
    try {
      // Shops on both sides of a street from the outside connection, and nobody living near to staff them.
      const state = towerCity("commercial", "commercial");
      const { mirror, ticks, send } = setup(state);
      ticks(1);
      expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
      const release = holdDemandBars(100);
      try {
        for (let i = 0; i < 30 && !workplacesHeldBy(countZoneJobs(state), ZONING_BALANCE.zones.findIndex((z) => z.id === "commercial") + 1); i++) ticks(100);
      } finally {
        release();
      }
      await new Promise((r) => setTimeout(r, 0));
      const counts = countZoneJobs(state);
      let held = 0;
      for (const bar of ["commercial", "office", "industrial"] as const satisfies readonly DemandBar[]) {
        const zone = ZONING_BALANCE.zones.findIndex((z) => z.id === bar) + 1;
        if (workplacesHeldBy(counts, zone)) {
          expect(mirror.waitingFor(bar), bar).toBe(counts.open[zone]);
          held++;
        } else {
          expect(mirror.waitingFor(bar), bar).toBeNull();
        }
      }
      expect(held).toBeGreaterThan(0);
    } finally {
      DEMAND_BALANCE.openJobsMin = was;
    }
  });
});

/** Statistics with population `now` and monthly samples `samples`, oldest first. */
function stats(now: number, samples: number[]) {
  const s = createStats();
  s.totals["population"] = now;
  s.history["population"] = Int32Array.from(samples);
  s.next = samples.length;
  return s;
}

const DAY = TIME_BALANCE.ticksPerDay;
/** A tick in the middle of the year's second day, which is no month's first. */
const MID_MONTH = DAY + DAY / 2;
/** The first tick after 1 February's first was stepped: still the month's first day. */
const FEB_FIRST = (TIME_BALANCE.monthDays[0] ?? 31) * DAY + 1;

describe("the population trend", () => {
  it("compares the population with the last monthly sample", () => {
    expect(populationTrend(stats(120, [0, 100]), MID_MONTH)).toBe("up");
    expect(populationTrend(stats(80, [0, 100]), MID_MONTH)).toBe("down");
    expect(populationTrend(stats(100, [0, 100]), MID_MONTH)).toBe("level");
  });

  it("shows no arrow with no sample yet", () => {
    expect(populationTrend(stats(50, []), MID_MONTH)).toBeNull();
    expect(trendArrow(null)).toBe("");
  });

  it("on a month's first day, compares with the sample before the one just taken, and shows none with only one", () => {
    // Just sampled at 120: against it the city would read level.
    expect(populationTrend(stats(120, [100, 120]), FEB_FIRST)).toBe("up");
    expect(populationTrend(stats(90, [100, 120]), FEB_FIRST)).toBe("down");
    expect(populationTrend(stats(0, [0]), 1)).toBeNull();
    // A day later the newest sample is the one to compare with.
    expect(populationTrend(stats(120, [100, 120]), FEB_FIRST + DAY)).toBe("level");
  });

  it("reads a full history as a ring, newest just before the write position", () => {
    const s = stats(100, [90, 200, 150]);
    s.next = 1; // 90 is the newest
    expect(populationTrend(s, MID_MONTH)).toBe("up");
    s.next = 0; // 150 is the newest
    expect(populationTrend(s, MID_MONTH)).toBe("down");
  });

  it("draws an arrow for each way", () => {
    expect(new Set([trendArrow("up"), trendArrow("down"), trendArrow("level")]).size).toBe(3);
  });
});

describe("the top bar's tooltips", () => {
  it("gives people against room on the population", () => {
    expect(formatPopulationTitle(null, null, null)).toBe("People living in the city");
    expect(formatPopulationTitle(1200, 1500, "up")).toBe("1,200 residents in homes with room for 1,500. Up over the last game month.");
    expect(formatPopulationTitle(1, 4, null)).toBe("1 resident in homes with room for 4. No monthly figure to compare with yet.");
  });

  it("lists what pushes a bar up and down in plain words, ups first", () => {
    expect(formatParts("residential", { openJobs: 40.2, unemployment: -15.4, satisfaction: 0.3, outsidePull: 0 })).toBe("Open jobs +40, Unemployment -15");
    expect(formatParts("residential", { unemployment: -15, openJobs: 40, outsidePull: 25 })).toBe("Open jobs +40, Newcomers from outside +25, Unemployment -15");
    expect(formatParts("industrial", { unemployedWorkers: 30, goodsNeeded: 0, openOfficeJobs: 0, outsideRoute: -30 })).toBe("Unemployed workers +30, No road to an outside connection -30");
  });

  it("gives the bar's name and value first, and says so when nothing pushes it", () => {
    expect(formatDemandTitle("residential", 24.6, { openJobs: 40, unemployment: -15.4 })).toBe("Residential demand +25. Open jobs +40, Unemployment -15");
    expect(formatDemandTitle("office", 0, { educatedWorkers: 0, serviceBuyers: 0 })).toBe("Office demand 0. Nothing pushes it either way.");
    expect(formatDemandTitle("commercial", null, null)).toBe("Commercial demand");
  });

  it("adds a line on new homes waiting while the bar is above zero, and none at or below it (#330)", () => {
    expect(formatHomesWaiting(3100)).toBe("New homes waiting: 3,100 empty places to fill first.");
    expect(formatHomesWaiting(1)).toBe("New homes waiting: 1 empty place to fill first.");
    expect(formatDemandTitle("residential", 40, { openJobs: 40 }, 3100)).toBe("Residential demand +40. Open jobs +40\nNew homes waiting: 3,100 empty places to fill first.");
    expect(formatDemandTitle("residential", 40, { openJobs: 40 }, null)).toBe("Residential demand +40. Open jobs +40");
    expect(formatDemandTitle("residential", 0.3, { openJobs: 0.3 }, 3100)).toBe("Residential demand 0. Nothing pushes it either way.");
    expect(formatDemandTitle("residential", 0, { openJobs: 0 }, 3100)).toBe("Residential demand 0. Nothing pushes it either way.");
    expect(formatDemandTitle("residential", -20, { unemployment: -20 }, 3100)).toBe("Residential demand -20. Unemployment -20");
  });

  it("names what each workplace zone waits for, and says so while the bar pulls above zero even when it reads 0 (#420)", () => {
    expect(formatWaiting("residential", 3100)).toBe(formatHomesWaiting(3100));
    expect(formatWaiting("commercial", 1)).toBe("New shops waiting: 1 open job to fill first.");
    expect(formatWaiting("office", 3644)).toBe("New offices waiting: 3,644 open jobs to fill first.");
    expect(formatWaiting("industrial", 12)).toBe("New factories waiting: 12 open jobs to fill first.");
    // Held: what pulls the bar is all taken away by the jobs still open, so it reads 0 and says why.
    expect(formatDemandTitle("office", 0, { educatedWorkers: 23, serviceBuyers: 0, jobsOpen: -23 }, 3644)).toBe(
      "Office demand 0. Educated workers +23, Office jobs still open -23\nNew offices waiting: 3,644 open jobs to fill first.",
    );
    expect(formatDemandTitle("residential", 6, { openJobs: 30, homesFilling: -24 }, 1410)).toBe(
      "Residential demand +6. Open jobs +30, Homes still filling -24\nNew homes waiting: 1,410 empty places to fill first.",
    );
    // Nothing pulls the bar: nothing to wait for.
    expect(formatDemandTitle("office", 0, { educatedWorkers: 0, serviceBuyers: 0, jobsOpen: 0 }, 3644)).toBe("Office demand 0. Nothing pushes it either way.");
  });

  it("has plain words for every part the sim sends", () => {
    for (const [bar, names] of Object.entries(DEMAND_PARTS)) {
      for (const name of names) expect(PART_WORDS[bar as keyof typeof PART_WORDS][name], `${bar}.${name}`).toBeTruthy();
    }
  });

  it("explains mixed ground, which has no bar", () => {
    expect(MIXED_NOTE).toBe("Builds when residential and commercial demand are both above zero, not counting homes and jobs still filling");
  });
});
