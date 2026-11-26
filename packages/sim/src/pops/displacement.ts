// Displacement lowers satisfaction (M4-10, PRD "Eminent domain" and
// "Satisfaction").
//
// Clearing a home people live in hurts the city politically: the people
// moved, and their neighbours, like it less for a while. Two inputs feed a
// pop's satisfaction target on its daily visit (satisfaction.ts):
//
// - Its neighbours' displacement. Each expropriation record (M4-09,
//   economy/compensation.ts) within `radius` of the pop's home takes
//   `neighbours.perPerson` points for each person it displaced, faded in a
//   straight line from the full amount on the tick it was cleared to
//   nothing a game year later. All the records near a pop together take at
//   most `neighbours.most`. The distance is the straight line from the
//   centre of the pop's home's lot to the cleared lot's centre, compared
//   squared, so no square root is taken. A pop waiting for a home has no
//   neighbours.
// - Its own. A pop the city displaced carries a mark wherever it moved
//   (pops.ts): the tick, and the people its old home held. It takes
//   `own.base` plus `own.perPerson` for each of them, at most `own.most`,
//   faded over the same game year. A pop its owner displaced by
//   redeveloping its home takes `own.byOwnerShare` of that. Redevelopment
//   leaves no record, so its neighbours take nothing: an owner rebuilding
//   on rezoned ground is the market, not the city's hand. Once a mark is a
//   game year old the visit clears it.
//
// The records are found through a coarse grid of them, square cells of
// `radius` a side, so a visit reads the records of the nine cells around
// the pop's home and not the whole list. What a home's nine cells add up
// to is kept per building and worked out again only when a record comes
// or goes in one of them, so the pops of a tower beside a cleared block
// share one pass over its records, and the days after share it too. The grid is derived, never saved
// or hashed: built from the list on first use and kept up with it as the
// list drops records from its head and adds them at its tail, which is the
// only way it changes. A grid built afresh at load holds what one kept
// through a session holds.
//
// Arithmetic is add, subtract, multiply, divide and floor (CLAUDE.md rule
// 6), and nothing here draws from the generator.

import { lotCentres } from "../buildings/where";
import { expropriationTicks, type Expropriation } from "../economy/compensation";
import type { SimState } from "../state";
import { POPS_BALANCE } from "./balance";
import { DISPLACED_BY_CITY, DISPLACED_BY_NONE, NO_HOME, clearPopDisplaced } from "./pops";

/** Takes pop `id`'s displacement mark off once it is a game year old, on its visit. */
export function clearOldMark(state: SimState, id: number): void {
  const p = state.pops;
  if ((p.displacedBy[id] ?? DISPLACED_BY_NONE) === DISPLACED_BY_NONE) return;
  if (state.tick - (p.displacedTick[id] ?? 0) >= expropriationTicks()) clearPopDisplaced(state, id);
}

/** One cell of the grid: its records, oldest first, with their place, people and tick laid out flat for the scan. */
interface GridCell {
  records: Expropriation[];
  x: number[];
  z: number[];
  people: number[];
  tick: number[];
  /** `ExpropriationGrid.version` when a record last came or went here. */
  stamp: number;
}

/**
 * What the records near one home add up to, kept per building id: the
 * people they displaced (`people`) and those people times each record's
 * tick (`ticks`). With every record under a game year old, the faded sum
 * on tick t is ((year - t) × people + ticks) / year, so the two do not
 * change as time passes and are worked out again only when a record comes
 * or goes in one of the nine cells around the home. `at` is the grid's
 * version they were worked out at, or -1 for none; `x` and `z` are the
 * home's centre then, since a building id is reused.
 */
interface NearCache {
  people: Float64Array;
  ticks: Float64Array;
  at: Float64Array;
  x: Float64Array;
  z: Float64Array;
}

/** The grid of expropriation records for one state. Derived. */
export interface ExpropriationGrid {
  /** The list it was last brought up to: `state.expropriations` as it was then. */
  list: readonly Expropriation[];
  /** A cell's side, metres: `radius` as the grid was built. */
  size: number;
  /** By cell key. A cell that has had records keeps its entry, empty or not, so its stamp stays. */
  cells: Map<number, GridCell>;
  /** Records filed. */
  count: number;
  /** Counts the changes to the cells, so a home's sums know when they are stale. */
  version: number;
  near: NearCache;
}

const grids = new WeakMap<SimState, ExpropriationGrid>();

// Cell coordinates fit well within ±2^20 for any map: a cell is metres wide.
const OFFSET = 1 << 20;
const SPAN = 1 << 21;

function cellOf(v: number, size: number): number {
  return Math.floor(v / size);
}

function keyOf(cx: number, cz: number): number {
  return (cx + OFFSET) * SPAN + (cz + OFFSET);
}

function recordKey(r: Expropriation, size: number): number {
  return keyOf(cellOf(r.x, size), cellOf(r.z, size));
}

function emptyNear(n: number): NearCache {
  return { people: new Float64Array(n), ticks: new Float64Array(n), at: new Float64Array(n).fill(-1), x: new Float64Array(n), z: new Float64Array(n) };
}

function file(grid: ExpropriationGrid, r: Expropriation): void {
  const key = recordKey(r, grid.size);
  let cell = grid.cells.get(key);
  if (!cell) {
    cell = { records: [], x: [], z: [], people: [], tick: [], stamp: 0 };
    grid.cells.set(key, cell);
  }
  cell.records.push(r);
  cell.x.push(r.x);
  cell.z.push(r.z);
  cell.people.push(r.people);
  cell.tick.push(r.tick);
  cell.stamp = grid.version;
  grid.count++;
}

function buildGrid(list: readonly Expropriation[], size: number): ExpropriationGrid {
  const grid: ExpropriationGrid = { list, size, cells: new Map(), count: 0, version: 1, near: emptyNear(0) };
  for (const r of list) file(grid, r);
  return grid;
}

/**
 * Brings `grid` from the list it holds to `now`, a later list of the same
 * state, by taking the records `now` dropped from the head and filing those
 * it added at the tail. Records are shared between the lists, never copied
 * (economy/compensation.ts), so the first record of `now` says how many
 * went. False when `now` is not such a later list, for the caller to build
 * afresh.
 */
function keepUp(grid: ExpropriationGrid, now: readonly Expropriation[]): boolean {
  const sent = grid.list;
  const first = now[0];
  const dropped = first === undefined ? sent.length : sent.indexOf(first);
  if (dropped < 0) return false;
  const kept = Math.min(sent.length - dropped, now.length);
  if (kept > 0 && now[kept - 1] !== sent[sent.length - 1]) return false;
  grid.version++;
  for (let i = 0; i < dropped; i++) {
    const r = sent[i] as Expropriation;
    const cell = grid.cells.get(recordKey(r, grid.size));
    if (!cell || cell.records[0] !== r) return false;
    cell.records.shift();
    cell.x.shift();
    cell.z.shift();
    cell.people.shift();
    cell.tick.shift();
    cell.stamp = grid.version;
    grid.count--;
  }
  for (let i = kept; i < now.length; i++) file(grid, now[i] as Expropriation);
  grid.list = now;
  return true;
}

/** The grid of `state`'s expropriation records, built on first use and brought up to the list as it stands. */
export function expropriationGridOf(state: SimState): ExpropriationGrid {
  const size = POPS_BALANCE.satisfaction.displacement.radius;
  const now = state.expropriations;
  let grid = grids.get(state);
  if (grid && grid.size === size && (grid.list === now || keepUp(grid, now))) return grid;
  grid = buildGrid(now, size);
  grids.set(state, grid);
  return grid;
}

/** The grid's records by cell as sorted [key, records] pairs, cells with none left out, for comparing two grids. */
export function expropriationGridCells(grid: ExpropriationGrid): [number, Expropriation[]][] {
  return [...grid.cells.entries()]
    .filter(([, cell]) => cell.records.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([key, cell]) => [key, cell.records.slice()]);
}

/** The share left on tick `tick` of something that started on `from` and fades to nothing over `span` ticks: from 1 down, 0 once it is `span` old. */
function fadeShare(tick: number, from: number, span: number): number {
  const age = tick - from;
  if (age < 0 || age >= span) return 0;
  return (span - age) / span;
}

/** Calls `each` with the cells around point (x, z) that have records: the nine whose records may lie within `radius`. */
function cellsAround(grid: ExpropriationGrid, x: number, z: number, each: (cell: GridCell) => void): void {
  const cx = cellOf(x, grid.size);
  const cz = cellOf(z, grid.size);
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cz - 1; j <= cz + 1; j++) {
      const cell = grid.cells.get(keyOf(i, j));
      if (cell && cell.records.length > 0) each(cell);
    }
  }
}

/** The newest stamp of the nine cells around (x, z), records or not. */
function newestStampAround(grid: ExpropriationGrid, x: number, z: number): number {
  const cx = cellOf(x, grid.size);
  const cz = cellOf(z, grid.size);
  let newest = 0;
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cz - 1; j <= cz + 1; j++) {
      const stamp = grid.cells.get(keyOf(i, j))?.stamp ?? 0;
      if (stamp > newest) newest = stamp;
    }
  }
  return newest;
}

/**
 * The people the records within `radius` of (x, z) displaced, and those
 * people times each record's tick, into `out` as [people, ticks]. Whole
 * numbers added in the order the cells and their records are kept, so a
 * grid built at load sums them as one kept through a session does.
 */
function sumsNear(grid: ExpropriationGrid, x: number, z: number, out: [number, number]): void {
  const radius = POPS_BALANCE.satisfaction.displacement.radius;
  const reach = radius * radius;
  let people = 0;
  let ticks = 0;
  cellsAround(grid, x, z, (cell) => {
    const { x: xs, z: zs, people: ps, tick: ts } = cell;
    for (let k = 0; k < xs.length; k++) {
      const dx = (xs[k] as number) - x;
      const dz = (zs[k] as number) - z;
      if (dx * dx + dz * dz > reach) continue;
      const p = ps[k] as number;
      people += p;
      ticks += p * (ts[k] as number);
    }
  });
  out[0] = people;
  out[1] = ticks;
}

/** The sums near home building `home`, whose lot centre is (x, z): from the cache while none of its nine cells has changed, else worked out and kept. */
function homeSums(grid: ExpropriationGrid, home: number, x: number, z: number, out: [number, number]): void {
  let near = grid.near;
  if (home >= near.at.length) {
    const grown = emptyNear(Math.max(64, home + 1, near.at.length * 2));
    grown.people.set(near.people);
    grown.ticks.set(near.ticks);
    grown.at.set(near.at);
    grown.x.set(near.x);
    grown.z.set(near.z);
    near = grid.near = grown;
  }
  const at = near.at[home] as number;
  if (at >= 0 && near.x[home] === x && near.z[home] === z && newestStampAround(grid, x, z) <= at) {
    out[0] = near.people[home] as number;
    out[1] = near.ticks[home] as number;
    return;
  }
  sumsNear(grid, x, z, out);
  near.people[home] = out[0];
  near.ticks[home] = out[1];
  near.at[home] = grid.version;
  near.x[home] = x;
  near.z[home] = z;
}

const scratchSums: [number, number] = [0, 0];

/**
 * The points the expropriation records in `grid` near point (x, z) take off
 * a target on tick `tick`, as the header says: each one's people times its
 * fade, summed, times `neighbours.perPerson`, at most `neighbours.most`.
 * `home` names the building at (x, z), whose sums are kept between visits;
 * -1 works them out afresh.
 *
 * The step drops each record on the tick it turns a game year old, so
 * every record in the list is younger and the sums give the faded total
 * exactly. A list with an older record, as a test may set, is read record
 * by record instead.
 */
export function neighbourLoss(grid: ExpropriationGrid, x: number, z: number, tick: number, home = -1): number {
  if (grid.count === 0) return 0;
  const { radius, neighbours } = POPS_BALANCE.satisfaction.displacement;
  const span = expropriationTicks();
  const oldest = grid.list[0];
  let faded: number;
  if (oldest !== undefined && (tick - oldest.tick >= span || tick < (grid.list[grid.list.length - 1] as Expropriation).tick)) {
    const reach = radius * radius;
    faded = 0;
    cellsAround(grid, x, z, (cell) => {
      for (const r of cell.records) {
        const dx = r.x - x;
        const dz = r.z - z;
        if (dx * dx + dz * dz <= reach) faded += r.people * fadeShare(tick, r.tick, span);
      }
    });
  } else {
    if (home >= 0) homeSums(grid, home, x, z, scratchSums);
    else sumsNear(grid, x, z, scratchSums);
    faded = ((span - tick) * scratchSums[0] + scratchSums[1]) / span;
  }
  return Math.min(neighbours.most, faded * neighbours.perPerson);
}

/** The points a mark of `by`, set on `from` with `people` displaced together, takes off a target on tick `tick`, as the header says. */
export function ownLoss(by: number, from: number, people: number, tick: number): number {
  if (by === DISPLACED_BY_NONE) return 0;
  const { own } = POPS_BALANCE.satisfaction.displacement;
  const full = Math.min(own.most, own.base + own.perPerson * people);
  const share = by === DISPLACED_BY_CITY ? 1 : own.byOwnerShare;
  return full * share * fadeShare(tick, from, expropriationTicks());
}

/** What one tick's visits read, worked out once a tick: the grid, and the lot centres when the grid has records. */
export interface DisplacementView {
  grid: ExpropriationGrid;
  centres: { x: Float64Array; z: Float64Array } | null;
}

/** The view of `state` for this tick's visits. */
export function displacementView(state: SimState): DisplacementView {
  const grid = expropriationGridOf(state);
  return { grid, centres: grid.count > 0 ? lotCentres(state) : null };
}

/**
 * The points displacement takes off pop `id`'s target today: its
 * neighbours' and its own, each capped, as the header says. Reads state
 * only: a mark a game year old takes nothing, and the satisfaction
 * system clears it on the pop's visit (`clearOldMark`).
 */
export function displacementLoss(state: SimState, id: number, view: DisplacementView = displacementView(state)): number {
  const p = state.pops;
  const tick = state.tick;
  let loss = 0;
  const by = p.displacedBy[id] ?? DISPLACED_BY_NONE;
  if (by !== DISPLACED_BY_NONE) {
    loss += ownLoss(by, p.displacedTick[id] ?? 0, p.displacedWith[id] ?? 0, tick);
  }
  const centres = view.centres;
  const home = p.home[id] ?? NO_HOME;
  if (centres && home !== NO_HOME) loss += neighbourLoss(view.grid, centres.x[home] ?? 0, centres.z[home] ?? 0, tick, home);
  return loss;
}
