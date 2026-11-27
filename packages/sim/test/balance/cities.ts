// The standard cities of the balance check (M3-21, PRD "Balance checks").
//
// Each is a fixed list of commands on seed 2026: a street south from the
// north outside connection into a town of 24 by 24 street blocks, 2.3 km a
// side, on the plain below it, laid as nine grids of 8 by 8 since one grid
// may lay at most 360 sections. The blocks are zoned one by one from a map of
// letters. A city may change its zoning at the start of a later game year,
// the way a player would, with commands worked out from the city as it
// stands then. Nothing here reads the clock or draws a random number outside
// the sim, so a run is the same city every time.
//
// Imported by run.ts only after it has applied the balance overrides, since
// importing the sim reads the balance files.

import {
  BUILDING_TYPES,
  ZONE_CLEAR,
  buildingIdLimit,
  isBuilding,
  isUnlocked,
  planRoadGrid,
  seeBuilding,
  step,
  submit,
  terrainOf,
  type BuildingSeen,
  type SimState,
} from "../../src/index";

/** Seed 2026: its second outside connection comes in from the north edge at x 5592, above a plain of flat, dry ground. */
export const SEED = 2026;

/** The connection's stub end, where the street in starts. */
const STUB = { x: 5592, z: 200 };
/** The town's north-west corner. The street in meets its north edge at the ninth line from the west. */
const X0 = 4824;
const Z0 = 960;
/** Street centre lines 96 m apart leave blocks 86 m between road edges (grid.test.ts). */
const SPACING = 96;
/** Blocks a side of each grid, and grids a side of the town. */
const GRID = 8;
const GRIDS = 3;

/** What each letter of a block map zones. */
const LETTERS: Readonly<Record<string, readonly [string, number]>> = {
  r: ["residential", 1],
  R: ["residential", 2],
  T: ["residential", 3],
  c: ["commercial", 1],
  C: ["commercial", 2],
  o: ["office", 1],
  p: ["office", 2],
  O: ["office", 3],
  i: ["industrial", 1],
  I: ["industrial", 2],
  // Zoned R1 to start with, and R3 when the rezoned town zones it up in year five.
  h: ["residential", 1],
};

/**
 * The balanced town, rows from north to south, columns from west to east:
 * a downtown of offices, shops and towers, apartments around it, houses
 * with corner shops beyond, and a belt of factories down the east side, a
 * quarter of the ground, since industry has the fewest jobs a cell. There
 * is room of every kind left over for ten years, so the bars and not the
 * map decide what grows.
 */
const BALANCED = [
  "crrrcrorcrrrcrorcriiiIII",
  "rcrorcrrrcrorcrrrciiiIII",
  "orcrrrcrorcrrrcroriiiIII",
  "rrrcrorcrrrcrorcrriiiIII",
  "crorcrrrcrorcrrrcriiiIII",
  "rcrrrcrorcrrrcrorciiiIII",
  "rrccRRcRRcRRcRRcrriiiIII",
  "rorRRCRpRCRpRCRRroiiiIII",
  "crrRCpCpRRcpCppRcriiiIII",
  "rcrcRCpRRcpCpRRcrciiiIII",
  "orcRppRTpTTpRRCRoriiiIII",
  "rrrRRRRpOCOTRcRRrriiiIII",
  "crocCRcTCOCTcppccriiiIII",
  "rcrRRcpTOCOppCRRrciiiIII",
  "rrcRppCpTTpTCpCRrriiiIII",
  "rorcRCpRRcpCpRRcroiiiIII",
  "crrRCpRRcpCpRRpRcriiiIII",
  "rcrRRpRCRpRCRpRRrciiiIII",
  "orccRRcRRcRRcRRcoriiiIII",
  "rrrcrorcrrrcrorcrriiiIII",
  "crorcrrrcrorcrrrcriiiIII",
  "rcrrrcrorcrrrcrorciiiIII",
  "rrcrorcrrrcrorcrrriiiIII",
  "rorcrrrcrorcrrrcroiiiIII",
];

/**
 * The rezoned town: the balanced town with its towers and the apartments
 * around them zoned for houses, as `h`, to be zoned R3 in year five. Rows 6
 * to 18 and columns 3 to 15 are the ring of apartments.
 */
const LOW_RISE = BALANCED.map((line, row) =>
  [...line].map((ch, col) => (ch === "T" || (ch === "R" && row >= 6 && row <= 18 && col >= 3 && col <= 15) ? "h" : ch)).join(""),
);

/**
 * The town that loses its industry: the balanced town's north half with
 * houses on its office ground and its south half left unzoned, so it is
 * full of people before year five and its jobs are in shops and factories.
 * In the whole balanced town, still filling in year five and with office
 * ground to spare, the offices took up the workers the factories let go and
 * the town only grew more slowly.
 */
const MILL_TOWN = BALANCED.map((line, row) => (row < 12 ? line.replace(/[opO]/g, "r") : ".".repeat(line.length)));

/**
 * The new town's quarters: grids of 4 by 4 blocks, nearest the street in
 * first. The street in meets the town's north edge at column 8, so the
 * first quarter is columns 8 to 11 of the top four rows, and each later one
 * touches one laid before it.
 */
const QUARTER = 4;
const QUARTERS: readonly [number, number][] = (() => {
  const all: [number, number][] = [];
  for (let row = 0; row < 24; row += QUARTER) for (let col = 0; col < 24; col += QUARTER) all.push([col, row]);
  // By distance from the first quarter's centre, ties by row and then column, so the order is fixed.
  const d = ([col, row]: [number, number]) => (col - 8) * (col - 8) + row * row;
  return all.sort((a, b) => d(a) - d(b) || a[1] - b[1] || a[0] - b[0]);
})();

/**
 * The new town zones each quarter from the balanced town's map, at the
 * highest density the city has opened: a 3 waits for density 3, then
 * reads 2 if density 2 is open, and 1 if not.
 */
function zoneQuarter(player: Player, col: number, row: number): void {
  const opened = isUnlocked(player.state, "density3") ? 3 : isUnlocked(player.state, "density2") ? 2 : 1;
  const byLetter = new Map<string, [number, number][]>();
  for (let r = row; r < row + QUARTER; r++) {
    for (let c = col; c < col + QUARTER; c++) {
      const letter = BALANCED[r]?.[c];
      if (letter !== undefined) byLetter.set(letter, [...(byLetter.get(letter) ?? []), [c, r]]);
    }
  }
  for (const [letter, [zone, density]] of Object.entries(LETTERS)) {
    const blocks = byLetter.get(letter);
    if (blocks) zoneBlocks(player, blocks, zone, Math.min(density, opened));
  }
}

/** The quarters each new town has laid. */
const laid = new WeakMap<SimState, Set<string>>();

/** How much the new town keeps in hand when it lays a quarter, for the upkeep before tax comes in. */
const NEW_TOWN_RESERVE = 2_000_000;

/**
 * Lays and zones the new town's next quarter if the treasury pays for it
 * with the reserve left over. Run at the start of each month, so a quarter
 * a month at most, as a player who spends what the city has would.
 */
function growNewTown(player: Player): void {
  const state = player.state;
  const next = QUARTERS.findIndex(([col, row]) => !laid.get(state)?.has(`${col},${row}`));
  if (next < 0) return;
  const [col, row] = QUARTERS[next] as [number, number];
  const plan = planRoadGrid(state.roads, terrainOf(state.seed), gridPayload(col, row, QUARTER));
  if (!plan.ok || state.budget.treasury < plan.plan.cost + NEW_TOWN_RESERVE) return;
  player.send("BuildRoadGrid", gridPayload(col, row, QUARTER));
  zoneQuarter(player, col, row);
  const set = laid.get(state) ?? new Set<string>();
  set.add(`${col},${row}`);
  laid.set(state, set);
}

/** Homes and nothing else. */
const HOMES_ONLY = BALANCED.map((line) => "r".repeat(line.length));

/** Sends commands to one city and steps it until each has applied. */
export class Player {
  private seq = 0;

  constructor(readonly state: SimState) {}

  /** Submits a command, steps until it has left the queue, and throws if the sim refused it. */
  send(type: string, payload: unknown): void {
    const seq = ++this.seq;
    const result = submit(this.state, { seq, playerId: "balance", type, payload });
    if (!result.ok) throw new Error(`${type} was refused: ${result.reason}`);
    step(this.state);
    while (this.state.pending.length > 0) step(this.state);
    if (this.state.log.at(-1)?.seq !== seq) throw new Error(`${type} did not apply`);
  }
}

/** The street in from the connection, which meets the town's north edge. */
function buildStreetIn(player: Player): void {
  player.send("BuildRoad", { from: STUB, to: { x: STUB.x, z: Z0 }, type: "street" });
}

/** A grid of `blocks` by `blocks` street blocks whose north-west block is (col, row). */
function gridPayload(col: number, row: number, blocks: number) {
  const x = X0 + col * SPACING;
  const z = Z0 + row * SPACING;
  const side = blocks * SPACING;
  return { origin: { x, z }, along: { x: x + side, z }, across: { x, z: z + side }, depth: SPACING - 10, width: SPACING - 10, type: "street" };
}

/** The street in from the connection and the grids of street blocks. */
function buildRoads(player: Player): void {
  buildStreetIn(player);
  for (let gz = 0; gz < GRIDS; gz++) {
    for (let gx = 0; gx < GRIDS; gx++) player.send("BuildRoadGrid", gridPayload(gx * GRID, gz * GRID, GRID));
  }
}

/** A rectangle over block (col, row), inside its four streets' centre lines, so it takes every cell on the block. */
function blockRect(col: number, row: number) {
  const x0 = X0 + col * SPACING + 3;
  const x1 = X0 + (col + 1) * SPACING - 3;
  const z = Z0 + row * SPACING + SPACING / 2;
  return { from: { x: x0, z }, to: { x: x1, z }, width: SPACING - 6 };
}

/** The blocks of `map` whose letter is one of `letters`, as [col, row]. */
function blocksOf(map: readonly string[], letters: string): [number, number][] {
  const out: [number, number][] = [];
  map.forEach((line, row) => [...line].forEach((ch, col) => letters.includes(ch) && out.push([col, row])));
  return out;
}

/** Zones `blocks` as `zone` at `density`, or clears them for ZONE_CLEAR, a command per 64 blocks. */
function zoneBlocks(player: Player, blocks: readonly [number, number][], zone: string, density?: number): void {
  for (let k = 0; k < blocks.length; k += 64) {
    const rects = blocks.slice(k, k + 64).map(([col, row]) => blockRect(col, row));
    player.send("ZoneCells", density === undefined ? { zone, rects } : { zone, density, rects });
  }
}

/** Zones every block of `map` by its letter, one letter at a time in the order of `LETTERS`. */
function zoneMap(player: Player, map: readonly string[]): void {
  for (const [letter, [zone, density]] of Object.entries(LETTERS)) {
    const blocks = blocksOf(map, letter);
    if (blocks.length > 0) zoneBlocks(player, blocks, zone, density);
  }
}

/** Bulldozes every building of `zone`, at most `bulldozeMaxBuildings` a command (5,000). */
function bulldozeZone(player: Player, zone: string): void {
  const b = player.state.buildings;
  const seen: BuildingSeen[] = [];
  for (let id = 0; id < buildingIdLimit(b); id++) {
    if (!isBuilding(b, id) || BUILDING_TYPES[b.type[id] ?? 0]?.zone !== zone) continue;
    const s = seeBuilding(b, id);
    if (s) seen.push(s);
  }
  for (let k = 0; k < seen.length; k += 5000) player.send("BulldozeBuilding", { buildings: seen.slice(k, k + 5000) });
}

/** One standard city: how it is laid out, and what the player does to it at the start of later years. */
export interface City {
  name: string;
  /** One line for the table's heading. */
  about: string;
  /** Builds and zones the city on a new state. */
  setup(player: Player): void;
  /** What the player does at the start of game year `year`, from 2, before that year runs. */
  atYear?(player: Player, year: number): void;
  /** What the player does at the start of each game month after the first, once the month before has closed. */
  atMonth?(player: Player): void;
  /** Ground zoned up whose share under density 3 buildings the table prints, as zone and density. */
  watch?: { zone: string; density: number };
  /**
   * Whether it starts as a new city does, on the starting grant alone with
   * no milestones. The others are funded and credited with every milestone,
   * as the scale cities are, so they build what they built before M4.
   */
  onGrant?: boolean;
}

export const CITIES: readonly City[] = [
  {
    name: "new-town",
    about: "A new city on its starting grant: the street in and a first quarter of 4 by 4 blocks zoned from the balanced town's map at density 1, then a quarter more at the start of any month the treasury pays for it with $2M to spare, at the densities opened",
    onGrant: true,
    setup(player) {
      buildStreetIn(player);
      growNewTown(player);
    },
    atMonth(player) {
      growNewTown(player);
    },
  },
  {
    name: "homes",
    about: "Homes only: the whole town zoned R1, no jobs anywhere",
    setup(player) {
      buildRoads(player);
      zoneMap(player, HOMES_ONLY);
    },
  },
  {
    name: "balanced",
    about: "Balanced town: homes of all three densities, shops, offices and factories, room of every kind",
    setup(player) {
      buildRoads(player);
      zoneMap(player, BALANCED);
    },
  },
  {
    name: "industry-lost",
    about: "The balanced town's north half, with no offices; at the start of year 5 every factory is bulldozed and its ground unzoned, and at the start of year 7 it is zoned for industry again",
    setup(player) {
      buildRoads(player);
      zoneMap(player, MILL_TOWN);
    },
    atYear(player, year) {
      if (year === 5) {
        zoneBlocks(player, blocksOf(MILL_TOWN, "iI"), ZONE_CLEAR);
        bulldozeZone(player, "industrial");
      }
      if (year === 7) {
        zoneBlocks(player, blocksOf(MILL_TOWN, "i"), "industrial", 1);
        zoneBlocks(player, blocksOf(MILL_TOWN, "I"), "industrial", 2);
      }
    },
  },
  {
    name: "rezoned",
    about: "The balanced town with houses where its towers and apartments would be; at the start of year 5 that ground is zoned R3",
    setup(player) {
      buildRoads(player);
      zoneMap(player, LOW_RISE);
    },
    atYear(player, year) {
      if (year === 5) zoneBlocks(player, blocksOf(LOW_RISE, "h"), "residential", 3);
    },
    watch: { zone: "residential", density: 3 },
  },
];
