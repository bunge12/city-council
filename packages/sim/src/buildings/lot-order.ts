// The grower's candidates in land value order (M3-25, #184, PRD "Land
// value"). The grower takes the free front cell of a zone with the highest
// land value first, and of two the same value the lower cell, the one that
// comes first in slot order. So the order follows from state alone, as the
// candidates do (candidates.ts), and a city loaded mid-growth takes the
// same cells as one that never stopped.
//
// Derived data, kept beside the candidates and current with them, so the
// grower never scans the city for its best cell. A cell's value is
// `base + road + water + centre - pollution`, held to 0..100
// (landvalue/land-value.ts). Its road and water points, `s` here, do not
// change while the cell is a candidate, since a change of roads looks at its
// segment again. The centre moves once a game month and pollution moves
// with industry, so those two are read when the order is asked.
//
// The candidates of each zone are kept in squares of `TILE` metres. Each
// square keeps the best of its own candidates, its value and key, good
// until the centre moves, pollution changes on the square or that
// candidate leaves. A query takes the best of the squares whose best is
// good, then looks again at the others whose bound could beat it, highest
// bound first. A square's bound is its highest `s` plus the centre's points
// at the square's nearest point: pollution only takes away, and the centre
// gives most where it is nearest. So a query costs a pass over the zone's
// squares and a look at the few whose best is stale.
//
// A cell where no lot fits is set aside (`setAside`): it leaves the order
// until its ground changes, so the grower does not try it again on every
// building (PRD "The grower"). Whether a lot fits at a cell follows from the
// cells, the buildings and the roads, and a try spends nothing from the
// generator, so a set-aside cell is only a cell the grower would try and
// pass over. It must come back whenever a try could now succeed, or a city
// loaded from a save, which has none set aside, would part from one that
// never stopped. A try at a cell reads its own strip, out to the ends of the
// free run it lies on (lots.ts, `freeFrontage`), and for a through-lot the
// strip across the block. So zoning painted, a building added and a
// building removed each bring back the cells on the runs their columns
// touch (`bringBackNear`), and zoning or a removal also the set-aside cells
// that grow through-lots within a try's reach of it. A change of roads does the same from the cells
// whose status it changed, at any depth, from the ends of each segment it
// laid out again, whose own cells come back new, and from each building it
// filed again; and it brings back every set-aside cell that grows
// through-lots, since it can join two blocks (`bringBackThrough`).

import { ROAD_TYPES } from "../roads/balance";
import type { SimState } from "../state";
import { terrainOf } from "../terrain/cache";
import { TERRAIN_BALANCE, mapSize } from "../terrain/terrain";
import { LAND_VALUE_BALANCE, LAND_VALUE_MAX, falloff } from "../landvalue/balance";
import { pollutionAt } from "../landvalue/pollution";
import { waterDistanceAt } from "../landvalue/water";
import { CELL_KEY_STRIDE } from "../zoning/cell-changes";
import { frontCellCornersIn, nextColumnInto, type CellIndex, type Column } from "../zoning/cell-index";
import type { RoadNetwork } from "../roads/network";
import { ZONING_BALANCE } from "../zoning/balance";
import { WIDEST_LOT } from "./balance";
import { FRONTAGE_REACH } from "./lots";

/** The side of a square the order keeps candidates in, in metres. */
const TILE = 256;
/** Squares along each side of the map. */
const SIDE = Math.ceil(mapSize(TERRAIN_BALANCE) / TILE);
const ZONES = ZONING_BALANCE.zones.length;
/** No square: a column that is not in the order. */
const NO_TILE = -1;

interface Tile {
  /** Where on the map: column and row of squares. */
  tx: number;
  tz: number;
  /** Its candidates, as `segment * CELL_KEY_STRIDE + column`, with their road and water points and where each cell's centre is. */
  keys: number[];
  s: number[];
  x: number[];
  z: number[];
  /** At least the highest `s` of its candidates: it is not lowered when one leaves, so it stays a bound. */
  maxS: number;
  /** The order's `epoch` the best below was found for, or -1 when it must be looked for again. */
  epoch: number;
  bestValue: number;
  bestKey: number;
}

/** Per segment: what the order knows of each column, by `place * 2 + side`. */
interface SegColumns {
  /** The square it is filed in, as `tz * SIDE + tx`, or NO_TILE. */
  tile: Int32Array;
  /** Its place in the square's lists. */
  pos: Int32Array;
  /** Its zone number, while it is a candidate, filed or set aside; 0 otherwise. */
  zone: Uint8Array;
  /** 1 while set aside. */
  aside: Uint8Array;
  s: Int16Array;
  x: Float64Array;
  z: Float64Array;
}

export interface LotOrder {
  /** By zone number, 0 unused: the squares with candidates of that zone. */
  tiles: Map<number, Tile>[];
  /** By segment id. */
  segs: (SegColumns | null)[];
  /** Bumped when the centre moves, which makes every square's best stale. */
  epoch: number;
  /** The centre the epoch is for. */
  cx: number;
  cz: number;
  cw: number;
  /** Candidates set aside now. */
  asideCount: number;
  /** Keys set aside whose zone and density grow through-lots (M2-14), which read the strip across the block. A key may be listed after it came back; its flag says. */
  asideThrough: number[];
  /** Cells tried and set aside, ever: for tests that count the grower's tries. */
  setAsideCount: number;
  /**
   * Candidates added since the grower last asked, as keys, not yet filed in
   * a square: working out where each is and its points waits for the
   * grower's next ask (`fileWaiting`), so a command that frees thousands of
   * cells does not pay for it in its own step. A key may be listed twice, or
   * after it stopped being a candidate; its columns say.
   */
  waiting: number[];
}

export function createLotOrder(): LotOrder {
  return { tiles: Array.from({ length: ZONES + 1 }, () => new Map<number, Tile>()), segs: [], epoch: 0, cx: 0, cz: 0, cw: 0, asideCount: 0, asideThrough: [], setAsideCount: 0, waiting: [] };
}

/** Makes room in the order for a segment with `columns` columns, dropping whatever it held. Its candidates must be taken out first. */
export function resetSegment(order: LotOrder, seg: number, columns: number): void {
  while (order.segs.length <= seg) order.segs.push(null);
  if (columns === 0) {
    order.segs[seg] = null;
    return;
  }
  order.segs[seg] = {
    tile: new Int32Array(columns).fill(NO_TILE),
    pos: new Int32Array(columns),
    zone: new Uint8Array(columns),
    aside: new Uint8Array(columns),
    s: new Int16Array(columns),
    x: new Float64Array(columns),
    z: new Float64Array(columns),
  };
}

/** Takes every candidate of `seg` out of the order. */
export function dropSegment(order: LotOrder, seg: number): void {
  const cols = order.segs[seg];
  if (!cols) return;
  for (let col = 0; col < cols.zone.length; col++) if ((cols.zone[col] ?? 0) !== 0) removeCandidate(order, seg, col);
}

/** The road and water points of land at (x, z) fronting a road of type `roadType`. */
function staticPoints(state: SimState, x: number, z: number, roadType: number): number {
  const lv = LAND_VALUE_BALANCE;
  const id = ROAD_TYPES[roadType]?.id;
  const road = id === undefined ? 0 : (lv.roadAccess[id] ?? 0);
  return lv.base + road + falloff(lv.water, waterDistanceAt(terrainOf(state.seed), x, z));
}

/** Scratch for a cell's corners, one call at a time. */
const quad = new Float64Array(8);

/** Most keys `waiting` holds before they are filed without waiting for the grower, so a city that never grows does not gather them forever. */
const MOST_WAITING = 1 << 20;

/** Adds the candidate at column `col` of `seg`, of zone `zone`, to the order, to be filed on the grower's next ask. */
export function addCandidate(order: LotOrder, state: SimState, index: CellIndex, seg: number, col: number, zone: number): void {
  const cols = order.segs[seg];
  if (!cols) throw new Error(`segment ${seg} has no columns in the lot order`);
  cols.zone[col] = zone;
  cols.aside[col] = 0;
  order.waiting.push(seg * CELL_KEY_STRIDE + col);
  if (order.waiting.length > MOST_WAITING) fileWaiting(order, state, index);
}

/** Files every candidate waiting, as the header of `waiting` says. */
export function fileWaiting(order: LotOrder, state: SimState, index: CellIndex): void {
  const waiting = order.waiting;
  if (waiting.length === 0) return;
  order.waiting = [];
  for (const key of waiting) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    const col = key - seg * CELL_KEY_STRIDE;
    const cols = order.segs[seg];
    if (!cols || (cols.zone[col] ?? 0) === 0 || cols.tile[col] !== NO_TILE || cols.aside[col] === 1) continue;
    place(order, state, index, seg, col);
  }
}

/** Works out where candidate `col` of `seg` is and its road and water points, and files it. */
function place(order: LotOrder, state: SimState, index: CellIndex, seg: number, col: number): void {
  const cols = order.segs[seg] as SegColumns;
  const q = frontCellCornersIn(index, seg, col, quad);
  if (!q) throw new Error(`no cell at column ${col} of segment ${seg}`);
  // As `landValueAt` measures a cell: at the mean of its corners.
  const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
  const z = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
  cols.s[col] = staticPoints(state, x, z, state.roads.segType[seg] ?? 0);
  cols.x[col] = x;
  cols.z[col] = z;
  file(order, seg, col);
}

/** Puts a candidate the order holds the details of into its square. */
function file(order: LotOrder, seg: number, col: number): void {
  const cols = order.segs[seg] as SegColumns;
  const x = cols.x[col] ?? 0;
  const z = cols.z[col] ?? 0;
  const tx = Math.min(SIDE - 1, Math.max(0, Math.floor(x / TILE)));
  const tz = Math.min(SIDE - 1, Math.max(0, Math.floor(z / TILE)));
  const at = tz * SIDE + tx;
  const zone = cols.zone[col] ?? 0;
  const tiles = order.tiles[zone] as Map<number, Tile>;
  let tile = tiles.get(at);
  if (!tile) {
    tile = { tx, tz, keys: [], s: [], x: [], z: [], maxS: -Infinity, epoch: -1, bestValue: -1, bestKey: Infinity };
    tiles.set(at, tile);
  }
  const s = cols.s[col] ?? 0;
  const key = seg * CELL_KEY_STRIDE + col;
  cols.tile[col] = at;
  cols.pos[col] = tile.keys.length;
  tile.keys.push(key);
  tile.s.push(s);
  tile.x.push(x);
  tile.z.push(z);
  if (s > tile.maxS) tile.maxS = s;
  // A best that is good stays good with one more candidate only if it still beats it, which needs its value: look again.
  tile.epoch = -1;
}

/** Takes a filed candidate out of its square, leaving its details. */
function unfile(order: LotOrder, seg: number, col: number): void {
  const cols = order.segs[seg] as SegColumns;
  const at = cols.tile[col] ?? NO_TILE;
  if (at === NO_TILE) return;
  const tiles = order.tiles[cols.zone[col] ?? 0] as Map<number, Tile>;
  const tile = tiles.get(at) as Tile;
  const pos = cols.pos[col] ?? 0;
  const last = tile.keys.length - 1;
  const key = tile.keys[pos] as number;
  if (pos !== last) {
    const moved = tile.keys[last] as number;
    tile.keys[pos] = moved;
    tile.s[pos] = tile.s[last] as number;
    tile.x[pos] = tile.x[last] as number;
    tile.z[pos] = tile.z[last] as number;
    const mseg = Math.floor(moved / CELL_KEY_STRIDE);
    (order.segs[mseg] as SegColumns).pos[moved - mseg * CELL_KEY_STRIDE] = pos;
  }
  tile.keys.pop();
  tile.s.pop();
  tile.x.pop();
  tile.z.pop();
  if (tile.keys.length === 0) tiles.delete(at);
  else if (tile.bestKey === key) tile.epoch = -1;
  cols.tile[col] = NO_TILE;
}

/** Takes the candidate at column `col` of `seg` out of the order, set aside or not. */
export function removeCandidate(order: LotOrder, seg: number, col: number): void {
  const cols = order.segs[seg];
  if (!cols || (cols.zone[col] ?? 0) === 0) return;
  unfile(order, seg, col);
  if (cols.aside[col] === 1) order.asideCount--;
  cols.zone[col] = 0;
  cols.aside[col] = 0;
}

/**
 * Sets the candidate at column `col` of `seg` aside, as the header says: it
 * leaves the order until its ground changes. `through` says whether its
 * zone and density grow through-lots.
 */
export function setAside(order: LotOrder, seg: number, col: number, through: boolean): void {
  const cols = order.segs[seg];
  if (!cols || (cols.zone[col] ?? 0) === 0 || cols.aside[col] === 1) return;
  unfile(order, seg, col);
  cols.aside[col] = 1;
  order.asideCount++;
  if (through) order.asideThrough.push(seg * CELL_KEY_STRIDE + col);
  order.setAsideCount++;
}

/** Puts a set-aside candidate back in the order. */
function bringBack(order: LotOrder, seg: number, col: number): void {
  const cols = order.segs[seg];
  if (!cols || cols.aside[col] !== 1) return;
  cols.aside[col] = 0;
  order.asideCount--;
  file(order, seg, col);
}

/** Scratch for `bringBackNear`'s walks. */
const walkCol: Column = { seg: 0, side: 0, place: 0, dir: 0 };

/** How far a walk reaches from a change: a try reads one column past its own walk to tell an open run from an end. */
const WALK_REACH = FRONTAGE_REACH + 2;

/**
 * How far from a change a set-aside cell that grows through-lots may be and
 * still read it: a try looks at the strip across the block behind each end
 * of its free run, which may be `FRONTAGE_REACH` columns away, and a
 * through-lot is up to `WIDEST_LOT` columns wide and both strips deep.
 */
const THROUGH_REACH = (WALK_REACH + 2 * WIDEST_LOT) * ZONING_BALANCE.cellSize;

/** How far a segment's front cells may lie from its curve: a road's half width and a cell, with room to spare. */
const SEGMENT_SLACK = 64;

/**
 * Brings back the set-aside candidates a change at each column of `keys`
 * could let a lot fit at (header): the column itself, and from it each way
 * along the strip, on while the columns are candidates, as far as a try's
 * walk to an end of its frontage reaches. A walk stops at another column of
 * `keys`, whose own walk reaches further that way. So a building added
 * stops the walks at its own columns and brings back the runs beside it,
 * and ground zoned or freed brings back the run it joins. Cells where a
 * through-lot can grow read the strip across the block too: unless only
 * buildings were added, which cannot make a lot fit, those within
 * `THROUGH_REACH` of a change come back as well.
 */
export function bringBackNear(order: LotOrder, index: CellIndex, net: RoadNetwork, keys: readonly number[], added: boolean): void {
  if (order.asideCount === 0 || keys.length === 0) return;
  const batch = new Set(keys);
  if (!added && order.asideThrough.length > 0) bringBackThroughNear(order, net, batch);
  for (const key of batch) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    const col = key - seg * CELL_KEY_STRIDE;
    bringBack(order, seg, col);
    for (let dir = 0; dir < 2; dir++) {
      walkCol.seg = seg;
      walkCol.side = col % 2;
      walkCol.place = (col - (col % 2)) / 2;
      walkCol.dir = dir;
      for (let left = WALK_REACH; left > 0 && nextColumnInto(index, walkCol, walkCol); left--) {
        const at = walkCol.place * 2 + walkCol.side;
        const cols = order.segs[walkCol.seg];
        if (!cols || (cols.zone[at] ?? 0) === 0 || batch.has(walkCol.seg * CELL_KEY_STRIDE + at)) break;
        bringBack(order, walkCol.seg, at);
      }
    }
  }
}

/**
 * Brings back the set-aside cells that grow through-lots within
 * `THROUGH_REACH` of the box round the segments of the columns `keys` name.
 * A segment is a curve inside the box of its ends and its control point,
 * and its cells lie within `SEGMENT_SLACK` of the curve, so the box costs
 * a look per segment rather than a cell's corners per column.
 */
function bringBackThroughNear(order: LotOrder, net: RoadNetwork, keys: ReadonlySet<number>): void {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  const take = (x: number, z: number) => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  };
  const seen = new Set<number>();
  for (const key of keys) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    if (seen.has(seg)) continue;
    seen.add(seg);
    const a = net.segA[seg] ?? -1;
    const b = net.segB[seg] ?? -1;
    take(net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0);
    take(net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0);
    take(net.segCX[seg] ?? 0, net.segCZ[seg] ?? 0);
  }
  const reach = THROUGH_REACH + SEGMENT_SLACK;
  const kept: number[] = [];
  for (const key of order.asideThrough) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    const col = key - seg * CELL_KEY_STRIDE;
    const cols = order.segs[seg];
    if (!cols || cols.aside[col] !== 1) continue;
    const x = cols.x[col] ?? 0;
    const z = cols.z[col] ?? 0;
    if (x >= x0 - reach && x <= x1 + reach && z >= z0 - reach && z <= z1 + reach) bringBack(order, seg, col);
    else kept.push(key);
  }
  order.asideThrough = kept;
}

/** Brings back every set-aside candidate whose zone and density grow through-lots: a change of roads can join two blocks anywhere along them. */
export function bringBackThrough(order: LotOrder): void {
  for (const key of order.asideThrough) {
    const seg = Math.floor(key / CELL_KEY_STRIDE);
    bringBack(order, seg, key - seg * CELL_KEY_STRIDE);
  }
  order.asideThrough.length = 0;
}

/** The centre's points at distance `d`. */
function centrePoints(d: number): number {
  return falloff(LAND_VALUE_BALANCE.centre, d);
}

/** Moves the order to the centre in `state`, making every square's best stale if it moved. */
function followCentre(order: LotOrder, state: SimState): void {
  const c = state.centre;
  const w = c.weight > 0 ? 1 : 0;
  if (order.cw === w && (w === 0 || (order.cx === c.x && order.cz === c.z))) return;
  order.cx = c.x;
  order.cz = c.z;
  order.cw = w;
  order.epoch++;
}

/** The most a candidate of `tile` can be worth. */
function tileBound(order: LotOrder, tile: Tile): number {
  if (order.cw === 0) return Math.min(LAND_VALUE_MAX, tile.maxS);
  const x0 = tile.tx * TILE;
  const z0 = tile.tz * TILE;
  const dx = Math.max(0, x0 - order.cx, order.cx - (x0 + TILE));
  const dz = Math.max(0, z0 - order.cz, order.cz - (z0 + TILE));
  return Math.min(LAND_VALUE_MAX, tile.maxS + centrePoints(Math.sqrt(dx * dx + dz * dz)));
}

/** Finds `tile`'s best candidate afresh, and its highest `s`. */
function lookAgain(order: LotOrder, tile: Tile, grid: Int32Array): void {
  const lv = LAND_VALUE_BALANCE;
  const { keys, s, x, z } = tile;
  const centred = order.cw !== 0;
  const cx = order.cx;
  const cz = order.cz;
  let bestValue = -1;
  let bestKey = Infinity;
  let maxS = -Infinity;
  for (let i = 0; i < keys.length; i++) {
    const si = s[i] as number;
    if (si > maxS) maxS = si;
    const xi = x[i] as number;
    const zi = z[i] as number;
    const centre = centred ? centrePoints(Math.sqrt((xi - cx) * (xi - cx) + (zi - cz) * (zi - cz))) : 0;
    const pollution = Math.min(lv.maxPollution, Math.max(0, pollutionAt(grid, xi, zi)));
    const value = Math.min(LAND_VALUE_MAX, Math.max(0, si + centre - pollution));
    const key = keys[i] as number;
    if (value > bestValue || (value === bestValue && key < bestKey)) {
      bestValue = value;
      bestKey = key;
    }
  }
  tile.bestValue = bestValue;
  tile.bestKey = bestKey;
  tile.maxS = maxS;
  tile.epoch = order.epoch;
}

/** Scratch for `bestCandidate`: the squares to look at again. */
const stale: Tile[] = [];
const staleBound: number[] = [];

/**
 * The key of the candidate of zone number `zone`, or of every zone for 0,
 * with the highest land value, the lower key of two the same; or -1 for
 * none. `grid` is the pollution grid (buildings/where.ts).
 */
export function bestCandidate(order: LotOrder, state: SimState, index: CellIndex, zone: number, grid: Int32Array): number {
  fileWaiting(order, state, index);
  followCentre(order, state);
  let bestValue = -1;
  let bestKey = Infinity;
  stale.length = 0;
  staleBound.length = 0;
  const from = zone === 0 ? 1 : zone;
  const to = zone === 0 ? ZONES : zone;
  for (let z = from; z <= to; z++) {
    for (const tile of (order.tiles[z] as Map<number, Tile>).values()) {
      if (tile.epoch === order.epoch) {
        if (tile.bestValue > bestValue || (tile.bestValue === bestValue && tile.bestKey < bestKey)) {
          bestValue = tile.bestValue;
          bestKey = tile.bestKey;
        }
        continue;
      }
      stale.push(tile);
      staleBound.push(tileBound(order, tile));
    }
  }
  if (stale.length > 0) {
    // Highest bound first, so the first looks raise the best and the rest are passed over. Only those that can reach the best so far.
    const ids: number[] = [];
    for (let i = 0; i < stale.length; i++) if ((staleBound[i] as number) >= bestValue) ids.push(i);
    ids.sort((p, q) => (staleBound[q] as number) - (staleBound[p] as number));
    for (const i of ids) {
      // A square bound to the best's value may still hold the same value on a lower key.
      if ((staleBound[i] as number) < bestValue) break;
      const tile = stale[i] as Tile;
      lookAgain(order, tile, grid);
      if (tile.bestValue > bestValue || (tile.bestValue === bestValue && tile.bestKey < bestKey)) {
        bestValue = tile.bestValue;
        bestKey = tile.bestKey;
      }
    }
    stale.length = 0;
  }
  return bestValue < 0 ? -1 : bestKey;
}

/**
 * Tells the order that pollution changed around (x, z), out to `radius`
 * metres: the squares that reach that far have a stale best. Each pollution
 * square is read at a cell's centre, so the box takes in one more square.
 */
export function notePollution(order: LotOrder, x: number, z: number, radius: number): void {
  const r = radius + LAND_VALUE_BALANCE.squareSize;
  const tx0 = Math.max(0, Math.floor((x - r) / TILE));
  const tx1 = Math.min(SIDE - 1, Math.floor((x + r) / TILE));
  const tz0 = Math.max(0, Math.floor((z - r) / TILE));
  const tz1 = Math.min(SIDE - 1, Math.floor((z + r) / TILE));
  for (let zone = 1; zone <= ZONES; zone++) {
    const tiles = order.tiles[zone] as Map<number, Tile>;
    if (tiles.size === 0) continue;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = tiles.get(tz * SIDE + tx);
        if (tile) tile.epoch = -1;
      }
    }
  }
}

/** Whether column `col` of `seg` is set aside. For tests. */
export function isSetAside(order: LotOrder, seg: number, col: number): boolean {
  return order.segs[seg]?.aside[col] === 1;
}
