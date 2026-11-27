// The M1 scale network (issue M1-17): a city of at least 30,000 road
// segments built through commands on a real seed's terrain, with street
// grids, curves and bridges, the way a player would build one. The scale
// bench, the scale tests, the soak run and the scale e2e test all use it, so
// every measurement is taken on the same city. No game code calls it.
//
// Each command goes through `submit` and `step`, so the city comes with its
// log and replays from its seed, onto a city funded as `createScaleState`
// funds it: roads cost money from M4, far more than a starting grant pays
// for (M4-03), and credited with every milestone, since it zones densities
// 2 and 3 from the start (M4-12). Refused commands (steep ground, water,
// a curve too tight where the terrain cuts a grid) are skipped. Everything
// is laid out from fixed numbers, so every run builds the same city.

import { BUILDING_TYPES, type BuildingType } from "./buildings/balance";
import { buildingCount } from "./buildings/buildings";
import { buildingJobs, jobsByKind } from "./buildings/jobs";
import { TIME_BALANCE } from "./calendar";
import { arrive } from "./pops/arrivals";
import { matchJobs } from "./pops/matching";
import { popCount, popIdLimit } from "./pops/pops";
import { buildingReachesOutside } from "./pops/room";
import { prepareTravelTimes, travelTimesReady } from "./travel-times";
import { findCentre, nextMonth } from "./landvalue/land-value";
import { roadPieceByNode, segmentsReachingOutside } from "./roads/outside";
import { growOne } from "./buildings/grower";
import { submit, type Command } from "./commands";
import { isStraight, segmentQuad } from "./roads/curve";
import { LEVEL_BRIDGE, NONE, isNode, isSegment, nextSegmentAt, nodeIdLimit, otherEnd, segmentCount, segmentIdLimit, type RoadNetwork } from "./roads/network";
import { createState, type SimState } from "./state";
import { fundCity } from "./economy/budget";
import { creditMilestones } from "./progression/milestones";
import { step } from "./step";
import { terrainOf } from "./terrain/cache";
import { isWaterAt, mapSize, type Terrain } from "./terrain/terrain";
import { ZONING_BALANCE } from "./zoning/balance";
import { cellsSettled } from "./zoning/cell-index";

/** The seed every scale measurement uses. Its map has lakes and hills. */
export const SCALE_SEED = 2026;
/** M1.md: "A generated network of 30,000 segments". */
export const SCALE_SEGMENTS = 30_000;
/** The player id the generator builds as. */
export const SCALE_PLAYER = "scale";

/**
 * The treasury a scale city starts with: a trillion dollars, so every
 * command the generators send and every one a test or a walkthrough sends
 * on the city after is paid for, and the city builds what it built before
 * roads cost money (M4-03). Far from the 2^53 a float64 holds exactly.
 */
export const SCALE_TREASURY = 1_000_000_000_000;

/**
 * A new city on `seed` funded as the scale city is, at `SCALE_TREASURY`, and
 * credited with every milestone without its grant (M4-12): what a replay of
 * a scale city's log starts from.
 */
export function createScaleState(seed = SCALE_SEED): SimState {
  const state = createState(seed);
  fundCity(state, SCALE_TREASURY);
  creditMilestones(state);
  return state;
}

/** Street grids: blocks 86 m between road edges put grid lines 96 m apart. */
const BLOCK = 86;
const LINE = 96;
/** Lines per side of one grid at the cap of 14 streets. */
const PER_SIDE = 7;
const GRID_SPAN = (PER_SIDE - 1) * LINE;
/** One grid per tile, with a gap between tiles for the avenues that join them. */
const TILE = GRID_SPAN + 2 * LINE;

export interface ScaleCounts {
  segments: number;
  bridges: number;
  curved: number;
  grids: number;
  roads: number;
  refused: number;
  commands: number;
}

export interface ScaleCity {
  state: SimState;
  counts: ScaleCounts;
  /** The corner of each grid that was built, in build order. */
  grids: { x: number; z: number }[];
}

function countShapes(net: RoadNetwork): { bridges: number; curved: number } {
  let bridges = 0;
  let curved = 0;
  for (let id = 0; id < segmentIdLimit(net); id++) {
    if (!isSegment(net, id)) continue;
    if (net.segLevelA[id] === LEVEL_BRIDGE) bridges++;
    if (!isStraight(segmentQuad(net, id))) curved++;
  }
  return { bridges, curved };
}

/** Rounds to the build grid's 0.125 m so the log carries the exact point. */
const at = (v: number): number => Math.round(v * 8) / 8;

/**
 * Builds the scale city. `target` segments at least, unless the map runs out
 * of room first, which the tests catch.
 */
export function buildScaleCity(target = SCALE_SEGMENTS, seed = SCALE_SEED): ScaleCity {
  const state = createScaleState(seed);
  const terrain = terrainOf(seed);
  const size = mapSize(terrain);
  let seq = 0;
  const counts: ScaleCounts = { segments: 0, bridges: 0, curved: 0, grids: 0, roads: 0, refused: 0, commands: 0 };
  const grids: { x: number; z: number }[] = [];

  /** Submits one command and steps once. Returns whether it was applied. */
  const run = (type: string, payload: unknown): boolean => {
    const command: Command = { seq: ++seq, playerId: SCALE_PLAYER, type, payload };
    counts.commands++;
    const before = state.log.length + state.logOffset;
    if (!submit(state, command).ok) {
      counts.refused++;
      return false;
    }
    step(state);
    const applied = state.log.length + state.logOffset > before;
    if (!applied) counts.refused++;
    return applied;
  };
  const done = () => segmentCount(state.roads) >= target;
  const road = (from: [number, number], to: [number, number], type: string, control?: [number, number]): boolean => {
    const ok = run("BuildRoad", {
      from: { x: at(from[0]), z: at(from[1]) },
      to: { x: at(to[0]), z: at(to[1]) },
      type,
      ...(control ? { control: { x: at(control[0]), z: at(control[1]) } } : {}),
    });
    if (ok) counts.roads++;
    return ok;
  };

  const tiles = Math.floor((size - LINE) / TILE);
  const origin = (i: number): number => LINE + i * TILE;

  // 1. Bridges first, so the grids join them: roads straight across narrow
  // water, found by walking the map for runs of water between dry banks.
  bridgeAcross(terrain, size, 60, (from, to, type) => !done() && road(from, to, type));

  // 2. A street grid at the cap in every tile the ground allows.
  for (let j = 0; j < tiles && !done(); j++) {
    for (let i = 0; i < tiles && !done(); i++) {
      const x = origin(i);
      const z = origin(j);
      const ok = run("BuildRoadGrid", {
        origin: { x, z },
        along: { x: x + GRID_SPAN, z },
        across: { x, z: z + GRID_SPAN },
        depth: BLOCK,
        width: BLOCK,
        type: "street",
      });
      if (ok) {
        counts.grids++;
        grids.push({ x, z });
      }
    }
  }

  // 3. Avenues across the gaps between neighbouring tiles, from the middle
  // line of one grid to the middle line of the next. Over water they become
  // bridges, and on a lake shore they bend round on a curve.
  const mid = GRID_SPAN / 2;
  for (let j = 0; j < tiles && !done(); j++) {
    for (let i = 0; i < tiles && !done(); i++) {
      const x = origin(i);
      const z = origin(j);
      if (i + 1 < tiles) {
        const from: [number, number] = [x + GRID_SPAN, z + mid];
        const to: [number, number] = [origin(i + 1), z + mid];
        if (!road(from, to, "avenue")) road(from, to, "avenue", [(from[0] + to[0]) / 2, z + mid + LINE]);
      }
      if (j + 1 < tiles && !done()) {
        const from: [number, number] = [x + mid, z + GRID_SPAN];
        const to: [number, number] = [x + mid, origin(j + 1)];
        if (!road(from, to, "avenue")) road(from, to, "avenue", [x + mid + LINE, (from[1] + to[1]) / 2]);
      }
    }
  }

  // 4. Curved one-ways inside the grids' blocks, from the middle of one
  // street to the middle of the facing one, bowed to one side. Each crosses
  // nothing and joins two streets, splitting both.
  for (const g of grids) {
    if (done()) break;
    for (let k = 0; k + 1 < PER_SIDE && !done(); k += 2) {
      const x = g.x + k * LINE + LINE / 2;
      road([x, g.z + LINE], [x, g.z + 2 * LINE], "oneWay", [x + 30, g.z + 1.5 * LINE]);
    }
  }

  // 5. Until the target: avenues through the middle of the blocks, one tile
  // long each, which split every street they cross. Rows first, then
  // columns.
  for (let axis = 0; axis < 2 && !done(); axis++) {
    for (let row = 0; row < PER_SIDE - 1 && !done(); row++) {
      for (let j = 0; j < tiles && !done(); j++) {
        for (let i = 0; i < tiles && !done(); i++) {
          const across = origin(j) + row * LINE + LINE / 2;
          const a = origin(i) - LINE / 2;
          const b = origin(i) + GRID_SPAN + LINE / 2;
          if (axis === 0) road([a, across], [b, across], "avenue");
          else road([across, a], [across, b], "avenue");
        }
      }
    }
  }

  const shapes = countShapes(state.roads);
  counts.segments = segmentCount(state.roads);
  counts.bridges = shapes.bridges;
  counts.curved = shapes.curved;
  return { state, counts, grids };
}

/**
 * Calls `build` across each stretch of water 24 to 360 m wide along lines
 * 48 m apart over the whole map, both ways: first with the banks 40 m back
 * from the water, then further back if the ramp needs more room. A street
 * on crossings under 300 m and an avenue on longer ones. That once followed
 * the bridge limits; since issue 47 every type bridges further than the map,
 * and the split stays so the scale city does not change.
 * Stops after `most` bridges.
 */
function bridgeAcross(
  terrain: Terrain,
  size: number,
  most: number,
  build: (from: [number, number], to: [number, number], type: string) => boolean,
): number {
  const stepM = 8;
  let built = 0;
  for (let axis = 0; axis < 2; axis++) {
    for (let line = LINE / 4; line < size; line += LINE / 2) {
      let wetFrom = -1;
      for (let s = 0; s < size; s += stepM) {
        const [x, z] = axis === 0 ? [s, line] : [line, s];
        const wet = isWaterAt(terrain, x, z);
        if (wet) {
          if (wetFrom < 0) wetFrom = s;
          continue;
        }
        if (wetFrom > 0) {
          const width = s - wetFrom;
          if (width >= 24 && width <= 360) {
            for (const back of [40, 80, 120]) {
              const a = wetFrom - back;
              const b = s + back;
              if (a < 0 || b > size) continue;
              const from: [number, number] = axis === 0 ? [a, line] : [line, a];
              const to: [number, number] = axis === 0 ? [b, line] : [line, b];
              if (build(from, to, width + 2 * back < 300 ? "street" : "avenue")) {
                built++;
                break;
              }
            }
            if (built >= most) return built;
          }
        }
        wetFrom = -1;
      }
    }
  }
  return built;
}

/** M2.md: "The 30,000 segment city from M1 with about 100,000 buildings". */
export const SCALE_BUILDINGS = 100_000;

export interface ScaleTown {
  /** ZoneCells commands applied. */
  zoneCommands: number;
  /** Zoned cells once they were all painted. */
  zonedCells: number;
  buildings: number;
  /** Draws in a row that found no lot when the fill stopped, or 0 if it reached its target. */
  misses: number;
}

/** Draws in a row with no building before the fill takes the city as full. */
const FULL_AFTER_MISSES = 2000;

/**
 * Fills the scale city with buildings (issue M2-13), in place. Zones the
 * whole map through ZoneCells commands, one 256 m square at a time, each
 * square one zone and density: high density in the middle of the map,
 * medium around it, low further out, and residential on six squares in
 * ten. Then asks the grower for buildings one at a time, with its own
 * draw and lot finder, until `target` stand or the draws stop finding
 * lots.
 *
 * The zoning goes through `submit` and `step` and is in the log. The
 * buildings do not come on ticks: at the grower's daily pace it
 * would take thousands of game years, so `growOne` is called directly, as
 * the grower bench does. A replay of the log gives the roads and the
 * zoning; the buildings are in the state, which is what a city file saves.
 *
 * Under M2's lot rules the 30,000 segment city holds about 57,000
 * buildings, short of the 100,000 the M2 spec names: every lot fronts a
 * road, and the network has about 108,000 cells of frontage.
 */
export function growScaleCity(city: ScaleCity, target = SCALE_BUILDINGS): ScaleTown {
  const { state } = city;
  const size = mapSize(terrainOf(state.seed));
  const side = ZONING_BALANCE.maxRectSide;
  const per = Math.ceil(size / side);
  const middle = Math.floor(per / 2);
  const zones = ["residential", "residential", "residential", "residential", "residential", "residential", "commercial", "commercial", "mixed", "office"];
  const groups = new Map<string, { from: { x: number; z: number }; to: { x: number; z: number }; width: number }[]>();
  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      const ring = Math.max(Math.abs(i - middle), Math.abs(j - middle));
      const density = ring < 3 ? 3 : ring < 7 ? 2 : 1;
      let zone = zones[(i * 7 + j * 13) % zones.length] ?? "residential";
      if (zone === "office" && j % 2 === 1) zone = "industrial";
      const key = `${zone}/${density}`;
      const list = groups.get(key) ?? [];
      list.push({ from: { x: i * side, z: j * side + side / 2 }, to: { x: (i + 1) * side, z: j * side + side / 2 }, width: side });
      groups.set(key, list);
    }
  }
  // A stroke waits for the cells to settle, and submit checks only its shape until then.
  while (!cellsSettled(state)) step(state);
  let seq = state.log.reduce((most, e) => Math.max(most, e.seq), 0);
  let zoneCommands = 0;
  for (const [key, rects] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [zone, density] = key.split("/");
    for (let k = 0; k < rects.length; k += ZONING_BALANCE.maxRectsPerCommand) {
      const command: Command = { seq: ++seq, playerId: SCALE_PLAYER, type: "ZoneCells", payload: { zone, density: Number(density), rects: rects.slice(k, k + ZONING_BALANCE.maxRectsPerCommand) } };
      // A square of water or steep ground has nothing to paint, and is refused.
      if (submit(state, command).ok) zoneCommands++;
      step(state);
    }
  }
  while (!cellsSettled(state)) step(state);
  let zonedCells = 0;
  for (let k = 0; k < state.cells.zone.length; k++) if ((state.cells.zone[k] ?? 0) > 0) zonedCells++;
  let misses = 0;
  while (buildingCount(state.buildings) < target && misses < FULL_AFTER_MISSES) {
    if (growOne(state) < 0) misses++;
    else misses = 0;
  }
  return { zoneCommands, zonedCells, buildings: buildingCount(state.buildings), misses: buildingCount(state.buildings) < target ? misses : 0 };
}

// --- The scale cities (M3-20) ----------------------------------------------------

/**
 * The residents of the three scale cities every milestone from M3 on is
 * measured on (PRD, "Scale checkpoints").
 */
export const SCALE_CITY_RESIDENTS = [50_000, 200_000, 500_000] as const;
export type ScaleCityResidents = (typeof SCALE_CITY_RESIDENTS)[number];

/** Of a city's jobs, the share of each kind. */
interface JobShares {
  commercial: number;
  office: number;
  industrial: number;
}

/**
 * How a scale city of a size is laid out: the share of its room in homes
 * at each density, lowest first, and the share of its jobs of each kind.
 */
interface ScaleCityPlan {
  densityShares: readonly [number, number, number];
  jobShares: JobShares;
}

/** Of the jobs, the share of each kind, as "Jobs per building" in the PRD works out 50,000 jobs. */
const PRD_JOB_SHARES: JobShares = { commercial: 0.35, office: 0.32, industrial: 0.33 };

/**
 * The mix of each size. A town of 50,000 is mostly houses with a few
 * blocks of flats; a city of 500,000 has about a third of its room in
 * towers, as the issue suggests, and most of the rest in mid-rise.
 *
 * The 500,000 city does not fit the M1 network with a third of its room
 * in houses and the PRD's job split: industry at a third of the jobs, at
 * 0.3 to 0.5 jobs a cell, needs about as much ground as every home, and
 * houses at under one resident a cell most of the rest. The map ran out
 * with a fifth of the room still to build. "Jobs per building" in the PRD
 * expects this: real dense cities shed industry to offices. So it takes
 * office jobs for part of the industrial share and fewer houses, rather
 * than a denser network, which would change the city every other bench
 * measures on.
 */
const SCALE_CITY_PLANS: Readonly<Record<ScaleCityResidents, ScaleCityPlan>> = {
  50_000: { densityShares: [0.6, 0.3, 0.1], jobShares: PRD_JOB_SHARES },
  200_000: { densityShares: [0.4, 0.4, 0.2], jobShares: PRD_JOB_SHARES },
  500_000: { densityShares: [0.25, 0.4, 0.35], jobShares: { commercial: 0.35, office: 0.43, industrial: 0.22 } },
};

/** Room in homes for every this many residents, so a few homes stand part empty, under the grower's `emptyRoomShareMax`. */
const ROOM_PER_RESIDENT = 1.1;
/** Of the room, the share in mixed buildings, shops below flats. */
const MIXED_ROOM_SHARE = 0.08;
/** Jobs per resident (PRD, "Jobs per building": about 0.5 in US metro areas). */
const JOBS_PER_RESIDENT = 0.5;
/** Game days of job matching once the pops are in, so pops split by a draw look again. */
const MATCHING_DAYS = 5;

export interface ScaleCityTotals {
  /** The residents asked for. */
  target: number;
  population: number;
  pops: number;
  buildings: number;
  /** Room in homes that reach outside. */
  room: number;
  /** Room in homes of density 1, 2 and 3. */
  roomByDensity: [number, number, number];
  jobs: { commercial: number; office: number; industrial: number };
  workersEmployed: number;
  workersUnemployed: number;
  /** ZoneCells commands applied, one 256 m square each. */
  zoneCommands: number;
  /** Roads built from the outside connections' stubs to the network. */
  joins: number;
}

export interface GeneratedScaleCity extends ScaleCity {
  totals: ScaleCityTotals;
}

/**
 * The squares of `ZONING_BALANCE.maxRectSide` over the map, the middle one
 * first and then ring by ring outward, each ring from its top left corner
 * round, so the city grows from the middle.
 */
function squaresFromMiddle(size: number): { i: number; j: number }[] {
  const per = Math.ceil(size / ZONING_BALANCE.maxRectSide);
  const middle = Math.floor(per / 2);
  const out: { i: number; j: number }[] = [];
  for (let ring = 0; ring <= middle + 1; ring++) {
    for (let j = middle - ring; j <= middle + ring; j++) {
      for (let i = middle - ring; i <= middle + ring; i++) {
        if (Math.max(Math.abs(i - middle), Math.abs(j - middle)) !== ring) continue;
        if (i < 0 || j < 0 || i >= per || j >= per) continue;
        out.push({ i, j });
      }
    }
  }
  return out;
}

/** Nearest nodes an outside connection's join is tried to before it gives up. */
const JOIN_TRIES = 40;

/**
 * Joins each outside connection's stub to the largest piece of road with
 * an avenue from its inner end to the nearest of its nodes that takes one.
 * The M1 scale city was laid out before connections mattered and reaches
 * neither, so without these no newcomer could arrive and no job be
 * offered. On seed 2026 the north stub joins 220 m from its end; the west
 * one is 2 km from the piece across ground every straight avenue meets a
 * street too near a junction on, and stays as it is. One join is enough:
 * the piece holds 28,400 of the 30,000 segments.
 */
function joinOutside(state: SimState, run: (type: string, payload: unknown) => boolean): number {
  const net = state.roads;
  const stubEnds = new Set<number>(state.connections);
  const inner: number[] = [];
  for (const edge of state.connections) {
    for (let s = net.nodeFirstSeg[edge] ?? NONE; s !== NONE; s = nextSegmentAt(net, s, edge)) {
      const other = otherEnd(net, s, edge);
      inner.push(other);
      stubEnds.add(other);
    }
  }
  // Only to the largest piece of road: the generator's avenues join most of its grids into one.
  const pieces = roadPieceByNode(state);
  const sizes = new Map<number, number>();
  for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n) && !stubEnds.has(n)) sizes.set(pieces[n] ?? -1, (sizes.get(pieces[n] ?? -1) ?? 0) + 1);
  let largest = -1;
  let most = 0;
  for (const [piece, count] of sizes) {
    if (count > most || (count === most && piece < largest)) {
      most = count;
      largest = piece;
    }
  }
  let joins = 0;
  for (const end of inner) {
    const ex = net.nodeX[end] ?? 0;
    const ez = net.nodeZ[end] ?? 0;
    const near: { id: number; d: number }[] = [];
    for (let n = 0; n < nodeIdLimit(net); n++) {
      if (!isNode(net, n) || stubEnds.has(n) || pieces[n] !== largest) continue;
      const dx = (net.nodeX[n] ?? 0) - ex;
      const dz = (net.nodeZ[n] ?? 0) - ez;
      near.push({ id: n, d: dx * dx + dz * dz });
    }
    near.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const { id } of near.slice(0, JOIN_TRIES)) {
      const to = { x: net.nodeX[id] ?? 0, z: net.nodeZ[id] ?? 0 };
      if (run("BuildRoad", { from: { x: ex, z: ez }, to, type: "avenue" })) {
        joins++;
        break;
      }
    }
  }
  return joins;
}

/**
 * Generates a scale city of about `residents` people (M3-20), from the M1
 * scale city's roads: `base`, a copy of `buildScaleCity(SCALE_SEGMENTS,
 * seed)`, or built afresh. In place, on `base` when given.
 *
 * 1. Pauses the city, so no system runs while it is laid out, and joins
 *    the outside connections to the roads.
 * 2. Walks the map's 256 m squares from the middle outward. Each square
 *    gets the zone furthest behind its target, at the density whose share
 *    of the room is furthest behind, through one
 *    ZoneCells command. Then the grower's own `growOne` builds that zone
 *    until its target is met or it finds no lot. The targets: room in
 *    homes for ROOM_PER_RESIDENT times the residents, MIXED_ROOM_SHARE of
 *    it in mixed buildings, and JOBS_PER_RESIDENT jobs a resident split as
 *    the plan's shares. Only buildings on roads that reach outside count.
 * 3. Brings the residents in through the arrivals system's own `arrive`,
 *    with that many people owed: homes drawn by land value, households
 *    and profiles drawn as newcomers'.
 * 4. Finds them work with job matching's own `matchJobs`, over
 *    MATCHING_DAYS game days of slices.
 * 5. Unpauses it.
 *
 * Every command goes through `submit` and `step` and is in the log, so a
 * replay gives the roads and the zoning; the buildings and pops are in the
 * state, which a city file saves. Everything is laid out from fixed numbers
 * and the generator in state, so a seed gives the same city every run.
 */
export function generateScaleCity(residents: ScaleCityResidents, base?: ScaleCity): GeneratedScaleCity {
  const plan = SCALE_CITY_PLANS[residents];
  const city = base ?? buildScaleCity();
  const { state } = city;
  while (!cellsSettled(state)) step(state);
  let seq = state.log.reduce((most, e) => Math.max(most, e.seq), 0);
  let zoneCommands = 0;
  /** Submits one command and steps until it applied and the cells settled. */
  const run = (type: string, payload: unknown): boolean => {
    const before = state.log.length + state.logOffset;
    if (!submit(state, { seq: ++seq, playerId: SCALE_PLAYER, type, payload }).ok) return false;
    step(state);
    while (!cellsSettled(state)) step(state);
    return state.log.length + state.logOffset > before;
  };
  const joins = joinOutside(state, run);
  // The joins change the roads: the travel times job matching reads are rebuilt over the next ticks, with nothing zoned yet for any system to act on.
  while (!travelTimesReady(state)) step(state);
  run("SetSpeed", { speed: 0 });

  const room: [number, number, number] = [0, 0, 0];
  let mixedRoom = 0;
  const jobs = { commercial: 0, office: 0, industrial: 0 };
  const roomTarget = Math.ceil(residents * ROOM_PER_RESIDENT);
  const jobTarget = residents * JOBS_PER_RESIDENT;
  const totalRoom = () => room[0] + room[1] + room[2];
  /** Each zone's progress toward its target, 1 when met. */
  const progress: Record<string, () => number> = {
    residential: () => totalRoom() / roomTarget,
    mixed: () => mixedRoom / (MIXED_ROOM_SHARE * roomTarget),
    commercial: () => jobs.commercial / (plan.jobShares.commercial * jobTarget),
    office: () => jobs.office / (plan.jobShares.office * jobTarget),
    industrial: () => jobs.industrial / (plan.jobShares.industrial * jobTarget),
  };
  const zoneIds = ZONING_BALANCE.zones.map((z) => z.id);
  const behind = (): string | null => {
    let worst: string | null = null;
    let least = 1;
    for (const id of zoneIds) {
      const p = progress[id]?.() ?? 1;
      if (p < least) {
        least = p;
        worst = id;
      }
    }
    return worst;
  };
  /** The density whose share of the room is furthest behind its plan. */
  const density = (): number => {
    let pick = 1;
    let least = Infinity;
    for (let d = 3; d >= 1; d--) {
      const share = plan.densityShares[d - 1] ?? 0;
      if (share <= 0) continue;
      const p = (room[d - 1] ?? 0) / (share * roomTarget);
      if (p < least) {
        least = p;
        pick = d;
      }
    }
    return pick;
  };
  const b = state.buildings;
  const add = (id: number) => {
    if (!buildingReachesOutside(state, id)) return;
    const people = b.residents[id] ?? 0;
    const type = BUILDING_TYPES[b.type[id] ?? 0] as BuildingType;
    if (people > 0) {
      const d = (b.density[id] ?? 1) - 1;
      room[d] = (room[d] ?? 0) + people;
      if (type.zone === "mixed") mixedRoom += people;
    }
    const byKind = jobsByKind(type, buildingJobs(b, id));
    jobs.commercial += byKind.commercial;
    jobs.office += byKind.office;
    jobs.industrial += byKind.industrial;
  };

  const side = ZONING_BALANCE.maxRectSide;
  for (const { i, j } of squaresFromMiddle(mapSize(terrainOf(state.seed)))) {
    const zone = behind();
    if (zone === null) break;
    const d = density();
    const rects = [{ from: { x: i * side, z: j * side + side / 2 }, to: { x: (i + 1) * side, z: j * side + side / 2 }, width: side }];
    // A square of water, steep ground or no roads has nothing to paint, and is refused.
    if (!run("ZoneCells", { zone, density: d, rects })) continue;
    zoneCommands++;
    const zoneNumber = zoneIds.indexOf(zone) + 1;
    while ((progress[zone]?.() ?? 1) < 1) {
      const id = growOne(state, zoneNumber);
      if (id < 0) break;
      add(id);
    }
  }
  if (behind() !== null) throw new Error(`the map ran out of room for a city of ${residents}: ${behind()} is short (${JSON.stringify({ reach: segmentsReachingOutside(state), joins, room, mixedRoom, jobs, zoneCommands })})`);

  // The city centre, as the land value system would work it out on the
  // month's first tick, so the homes newcomers draw, and their wealth,
  // follow land value with its distance to the centre in it. Paused, the
  // system has not run since the buildings went up.
  state.centre = { ...findCentre(state), due: nextMonth(state.tick) };
  // The residents, as arrivals bring them, all owed at once.
  state.pops.owed = residents;
  arrive(state);
  // They were placed, not arrivals of the city's first year: the year's
  // counts start from nothing, so a city file's statistics and the soak's
  // count of the hour's arrivals hold only people who came later.
  state.stats.year = { births: 0, deaths: 0, arrivals: 0, departures: 0 };
  // Job matching over whole days of slices, as the sweep gives them: the
  // tick is set to each tick of the next game day in turn, once for each of
  // MATCHING_DAYS days, which is all `matchJobs` reads of it (through
  // `popSlice` and `travelTimesReady`), and put back after. If matching
  // ever reads the tick for anything else, this must change with it. Each day starts the sweep
  // afresh, so the pops a split made look on the next.
  prepareTravelTimes(state);
  const tick = state.tick;
  const perDay = TIME_BALANCE.ticksPerDay;
  const dayStart = Math.floor((tick + perDay - 1) / perDay) * perDay;
  for (let day = 0; day < MATCHING_DAYS; day++) {
    state.pops.sweep = popIdLimit(state.pops);
    for (let k = 0; k < perDay; k++) {
      state.tick = dayStart + k;
      matchJobs(state);
    }
  }
  state.tick = tick;
  run("SetSpeed", { speed: 1 });
  // Every entry still in live state, so a host can take the city as it is
  // and a city file carries the whole log (log.ts pages past LOG_LIVE_LIMIT).
  if (state.logOffset !== 0) throw new Error(`the generator's log of ${state.log.length + state.logOffset} entries passed the live limit`);

  const totals = state.stats.totals;
  return {
    ...city,
    totals: {
      target: residents,
      population: totals["population"] ?? 0,
      pops: popCount(state.pops),
      buildings: buildingCount(b),
      room: totalRoom(),
      roomByDensity: [...room],
      jobs: { ...jobs },
      workersEmployed: totals["workersEmployed"] ?? 0,
      workersUnemployed: totals["workersUnemployed"] ?? 0,
      zoneCommands,
      joins,
    },
  };
}
