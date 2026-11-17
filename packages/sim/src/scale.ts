// The M1 scale network (issue M1-17): a city of at least 30,000 road
// segments built through commands on a real seed's terrain, with street
// grids, curves and bridges, the way a player would build one. The scale
// bench, the scale tests, the soak run and the scale e2e test all use it, so
// every measurement is taken on the same city. No game code calls it.
//
// Each command goes through `submit` and `step`, so the city comes with its
// log and replays from its seed. Refused commands (steep ground, water,
// a curve too tight where the terrain cuts a grid) are skipped. Everything
// is laid out from fixed numbers, so every run builds the same city.

import { buildingCount } from "./buildings/buildings";
import { growOne } from "./buildings/grower";
import { submit, type Command } from "./commands";
import { isStraight, segmentQuad } from "./roads/curve";
import { LEVEL_BRIDGE, segmentCount, segmentIdLimit, isSegment, type RoadNetwork } from "./roads/network";
import { createState, type SimState } from "./state";
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
  const state = createState(seed);
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
