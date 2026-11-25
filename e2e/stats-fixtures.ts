// The statistics panel's city (M3-16): a street off an outside connection
// with shops and houses, stepped in Node for fifty game years so the
// monthly history holds about 600 samples. Built with the sim itself, as the M2
// walkthrough's city is, and saved paused.

import { CONNECTION_BALANCE, NONE, TIME_BALANCE, ZONING_BALANCE, connectionEnd, createState, step, submit, yearDays, type SimState } from "../packages/sim/src/index";

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
export const DAY = TIME_BALANCE.ticksPerDay;
export const YEAR = yearDays() * DAY;
/** Game years the city is stepped for. */
export const STATS_CITY_YEARS = 50;

let seq = 0;
function apply(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, { seq: ++seq, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`${type}: ${result.reason}`);
  step(state);
  // A stroke waits for a change of roads to settle before it applies.
  while (state.pending.length > 0) step(state);
  if (state.log.at(-1)?.seq !== seq) throw new Error(`${type} did not apply`);
}

interface Street {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

function street(state: SimState, places: number): Street {
  const r = state.roads;
  const edge = state.connections[0] ?? NONE;
  const inner = connectionEnd(r, edge);
  const dx = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const s = { x: r.nodeX[inner] ?? 0, z: r.nodeZ[inner] ?? 0, dx, dz };
  apply(state, "BuildRoad", { from: { x: s.x, z: s.z }, to: { x: s.x + dx * CELL * places, z: s.z + dz * CELL * places }, type: "street" });
  return s;
}

function zone(state: SimState, s: Street, zoneId: string, density: number, p0: number, width: number, depth: number, side: 1 | -1): void {
  const off = side * (5 + (CELL * depth) / 2);
  const nx = -s.dz * off;
  const nz = s.dx * off;
  const a = CELL * p0 + 2;
  const b = CELL * (p0 + width) - 2;
  apply(state, "ZoneCells", {
    zone: zoneId,
    density,
    rects: [{ from: { x: s.x + s.dx * a + nx, z: s.z + s.dz * a + nz }, to: { x: s.x + s.dx * b + nx, z: s.z + s.dz * b + nz }, width: CELL * depth - 4 }],
  });
}

function runTicks(state: SimState, ticks: number): void {
  const until = state.tick + ticks;
  while (state.tick < until) step(state);
}

/**
 * Fifty game years in three stages, with the sim's own demand bars. A few
 * shops and a row of houses first. At year 12, apartments, more homes than
 * the shops have jobs, so unemployment climbs. At year 25, more shops with
 * offices above and another row of houses, which take the workers on. The
 * population and unemployment graphs then each have a shape to read.
 */
export function statsCity(): SimState {
  const state = createState(SEED);
  const s = street(state, 64);
  zone(state, s, "commercial", 2, 0, 8, 3, 1);
  zone(state, s, "residential", 1, 16, 24, 2, 1);
  runTicks(state, 12 * YEAR - state.tick);
  zone(state, s, "residential", 2, 16, 24, 6, -1);
  runTicks(state, 25 * YEAR - state.tick);
  zone(state, s, "commercial", 3, 0, 14, 4, -1);
  zone(state, s, "residential", 1, 40, 24, 2, 1);
  // A little past fifty years, so the year so far has counts in it too.
  runTicks(state, STATS_CITY_YEARS * YEAR + 100 * DAY - state.tick);
  // Saved paused, so the figures hold still while the test reads them.
  state.speed = 0;
  return state;
}
