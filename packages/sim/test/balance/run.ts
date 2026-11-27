// The balance check (M3-21, PRD "Balance checks"): builds a standard city by
// its fixed list of commands, steps the sim for ten game years with no worker
// and no clock, and prints a line a game year, so a tuning change shows its
// effect. Started by `pnpm balance` (scripts/balance.mjs), one process a city.
//
//   run.ts --city balanced [--years 10] [--set demand.arrivalsPerYearAtFullDemand=30000 ...]
//
// `--set` changes one balance number for the run: a file name from
// packages/sim/balance/ without `.json`, then the path to the number, with
// dots between keys and array places, then `=` and a JSON value of the same
// type as the one it replaces. The files are changed in memory before the sim
// is imported, so a number the sim reads once when it loads, such as a
// building type's `jobsPerCell`, takes the new value too, and the sim's own
// checks of each file see it. Nothing is written to disk.
//
// The table is the same on every run of the same city and balance. It is for
// reading, not a test: the scenario tests pin behaviour (M3-21, out of scope).

import buildings from "../../balance/buildings.json" with { type: "json" };
import demand from "../../balance/demand.json" with { type: "json" };
import economy from "../../balance/economy.json" with { type: "json" };
import landvalue from "../../balance/landvalue.json" with { type: "json" };
import pops from "../../balance/pops.json" with { type: "json" };
import progression from "../../balance/progression.json" with { type: "json" };
import roads from "../../balance/roads.json" with { type: "json" };
import time from "../../balance/time.json" with { type: "json" };
import type { City } from "./cities";

/** The balance files `--set` may change. Each is the module the sim itself imports, so a change here is a change there. */
const FILES: Readonly<Record<string, unknown>> = { buildings, demand, economy, landvalue, pops, progression, roads, time };

interface Options {
  city: string;
  years: number;
  sets: string[];
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { city: "", years: 10, sets: [] };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const value = argv[k + 1];
    if (arg === "--city" && value !== undefined) options.city = value;
    else if (arg === "--years" && value !== undefined) options.years = Number(value);
    else if (arg === "--set" && value !== undefined) options.sets.push(value);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}: expected --city <name>, --years <n> or --set <file.path=value>`);
    k++;
  }
  if (!Number.isSafeInteger(options.years) || options.years < 1) throw new Error("--years must be a whole number of at least 1");
  return options;
}

/** Applies one `file.path=value` to the balance files in memory, refusing a path that does not exist or a value of another type. */
function applySet(spec: string): void {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`--set ${spec}: expected file.path=value`);
  const [file, ...path] = spec.slice(0, eq).split(".");
  let raw: unknown;
  try {
    raw = JSON.parse(spec.slice(eq + 1));
  } catch {
    throw new Error(`--set ${spec}: the value must be JSON, such as 30000, 0.05, true or [1, 4]`);
  }
  let target = FILES[file ?? ""];
  if (target === undefined) throw new Error(`--set ${spec}: the file must be one of ${Object.keys(FILES).join(", ")}`);
  const key = path.pop();
  if (key === undefined) throw new Error(`--set ${spec}: name a number inside ${file}`);
  for (const step of path) {
    const next = (target as Record<string, unknown>)[step];
    if (typeof next !== "object" || next === null) throw new Error(`--set ${spec}: ${file} has no ${step} to go into`);
    target = next;
  }
  const record = target as Record<string, unknown>;
  if (!(key in record)) throw new Error(`--set ${spec}: ${file} has no ${[...path, key].join(".")}`);
  const was = record[key];
  if (typeof was !== typeof raw || Array.isArray(was) !== Array.isArray(raw)) {
    throw new Error(`--set ${spec}: ${[...path, key].join(".")} is ${JSON.stringify(was)}, and the new value must be of the same type`);
  }
  record[key] = raw;
}

const options = parseArgs(process.argv.slice(2));
for (const spec of options.sets) applySet(spec);

// Only now import the sim and the cities, so the sim reads the changed files as it loads.
const sim = await import("../../src/index");
const { CITIES, Player, SEED } = await import("./cities");
const { BUILDING_TYPES, CHARGE_LINES, DEMAND_BARS, ECONOMY, LEDGER_LINES, LINE, SCALE_TREASURY, TAX_LINES, TIME_BALANCE, buildingIdLimit, buildingOnSlot, buildingTaxPerYear, createState, creditMilestones, fundCity, homeRoom, isAbandoned, isBuilding, isLandmark, isMonthStart, isVacant, milestonesReached, step, yearDays, ZONING_BALANCE } = sim;
type SimState = import("../../src/index").SimState;

const city: City | undefined = CITIES.find((c) => c.name === options.city);
if (!city) throw new Error(`--city must be one of ${CITIES.map((c) => c.name).join(", ")}`);

const DAY = TIME_BALANCE.ticksPerDay;
const YEAR = yearDays() * DAY;

/** The building counts the table prints. */
function buildingCounts(state: SimState): { vacant: number; abandoned: number; room: number } {
  const b = state.buildings;
  let vacant = 0;
  let abandoned = 0;
  let room = 0;
  for (let id = 0; id < buildingIdLimit(b); id++) {
    if (!isBuilding(b, id)) continue;
    room += homeRoom(b, id);
    if (isAbandoned(b, id)) abandoned++;
    else if (isVacant(b, id)) vacant++;
  }
  return { vacant, abandoned, room };
}

/** Of the cells zoned `zone`, the share with no building on them. */
function openShare(state: SimState, zone: string): number {
  const zoneNumber = ZONING_BALANCE.zones.findIndex((z) => z.id === zone) + 1;
  let zoned = 0;
  let open = 0;
  for (let slot = 0; slot < state.cells.zone.length; slot++) {
    if (state.cells.zone[slot] !== zoneNumber) continue;
    zoned++;
    if (buildingOnSlot(state, slot) < 0) open++;
  }
  return zoned === 0 ? 0 : open / zoned;
}

/** Of the cells zoned `zone` at `density`, the share under a building of that density. */
function builtShare(state: SimState, zone: string, density: number): number {
  const zoneNumber = ZONING_BALANCE.zones.findIndex((z) => z.id === zone) + 1;
  const cells = state.cells;
  let zoned = 0;
  let built = 0;
  for (let slot = 0; slot < cells.zone.length; slot++) {
    if (cells.zone[slot] !== zoneNumber || cells.density[slot] !== density) continue;
    zoned++;
    const id = buildingOnSlot(state, slot);
    if (id >= 0 && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.density === density) built++;
  }
  return zoned === 0 ? 0 : built / zoned;
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

const state = createState(SEED);
if (!city.onGrant) {
  // Funded as the scale cities are (M4-03), so each city builds what it built before roads cost money.
  fundCity(state, SCALE_TREASURY);
  // And credited with every milestone (M4-12), so a city zones densities 2 and 3 from its first year.
  creditMilestones(state);
}
/** What the city was given beyond the starting grant, which the money table takes off the treasury it prints. */
const funding = state.budget.treasury - ECONOMY.startingGrant;
const player = new Player(state);
city.setup(player);

const COLUMNS: [string, number][] = [
  ["Year", 4],
  ["People", 7],
  ["Res", 5],
  ["Com", 5],
  ["Off", 5],
  ["Ind", 5],
  ["Flips R/C/O/I", 13],
  ["Unemp", 6],
  ["Jobs/res", 8],
  ["Vacant", 6],
  ["Aband", 5],
  ["Births", 6],
  ["Deaths", 6],
  ["Arrive", 7],
  ["Depart", 7],
  ["Room", 6],
  ["Open R/C/O/I", 12],
  ["Shop/Off/Fac", 12],
];
if (city.watch) COLUMNS.push([`${city.watch.zone[0]?.toUpperCase()}${city.watch.density} built`, 9]);

const MONEY: [string, number][] = [
  ["Year", 4],
  ["Treasury", 8],
  ["Tax R", 7],
  ["Tax C", 7],
  ["Tax O", 7],
  ["Tax I", 7],
  ["Charges", 7],
  ["Grants", 7],
  ["Loans", 6],
  ["Build", 7],
  ["Roads", 6],
  ["Bldgs", 6],
  ["Repay", 6],
  ["Other", 7],
  ["Net", 7],
  ["Tax/res", 7],
  ["Spend/res", 9],
  ["Tax/cell 1/2/3", 20],
  ["Ratio", 9],
  ["Milestone", 9],
];

console.log(`${city.name}: ${city.about}`);
console.log(`Seed ${SEED}, ${options.years} game years. ${options.sets.length === 0 ? "Balance as in packages/sim/balance/." : `Balance changed: ${options.sets.join(", ")}.`}`);
console.log("Res to Ind: each bar's average over the year. Flips: times each bar changed sign in the year, as the top bar shows it, rounded. The rest at the year's end. Unemp: workers without a job. Room: empty places in homes. Open R/C/O/I: the percent of each zone's cells with no building. Shop/Off/Fac: the jobs by kind, in percent.");
console.log(COLUMNS.map(([name, width]) => pad(name, width)).join(" "));

/** Whole dollars in the short form the UI uses: $950, $12K, $4.2M, $3.1B, with a minus sign before a loss. */
function money(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  const d = Math.abs(dollars);
  if (d >= 1e9) return `${sign}${(d / 1e9).toFixed(d >= 1e10 ? 0 : 1)}B`;
  if (d >= 1e6) return `${sign}${(d / 1e6).toFixed(d >= 1e7 ? 0 : 1)}M`;
  if (d >= 1e3) return `${sign}${(d / 1e3).toFixed(0)}K`;
  return `${sign}${Math.round(d)}`;
}

/**
 * The tax the city's private buildings pay a year for each cell of their
 * lots, by the density they were built under, every zone together, at
 * today's rates, land values and jobs filled (`buildingTaxPerYear`). The
 * PRD's ratios to aim for are 1x, 10x and 50x.
 */
function taxPerCell(state: SimState): number[] {
  const b = state.buildings;
  const tax = [0, 0, 0];
  const cells = [0, 0, 0];
  for (let id = 0; id < buildingIdLimit(b); id++) {
    if (!isBuilding(b, id) || isLandmark(b, id)) continue;
    const d = (b.density[id] ?? 0) - 1;
    if (d < 0 || d > 2) continue;
    tax[d] = (tax[d] ?? 0) + buildingTaxPerYear(state, id);
    cells[d] = (cells[d] ?? 0) + (b.width[id] ?? 0) * (b.depth[id] ?? 0);
  }
  return tax.map((t, d) => ((cells[d] ?? 0) === 0 ? 0 : t / (cells[d] ?? 1)));
}

/** The ledger lines a game year moved, summed over its months as each closes. */
const yearLedger = new Float64Array(LEDGER_LINES.length);
const at = (line: string): number => yearLedger[LINE[line as keyof typeof LINE]] ?? 0;
const sumOf = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + at(line), 0);
const moneyRows: string[] = [];

// The year the setup ran in counts as year 1: setting up takes a few ticks.
for (let year = 1; year <= options.years; year++) {
  if (year > 1) {
    city.atYear?.(player, year);
    city.atMonth?.(player);
  }
  const end = year * YEAR;
  const sums: Record<string, number> = {};
  const flips: Record<string, number> = {};
  const signs: Record<string, number> = {};
  let days = 0;
  yearLedger.fill(0);
  // Year 1 counts the month a new city files before its first, the starting grant, too.
  if (year === 1) yearLedger.set(createState(SEED).budget.lastMonth);
  for (const bar of DEMAND_BARS) {
    sums[bar] = 0;
    flips[bar] = 0;
    signs[bar] = Math.sign(Math.round(state.demand[bar].value));
  }
  while (state.tick < end) {
    step(state);
    if (isMonthStart(state.tick)) {
      for (let i = 0; i < yearLedger.length; i++) yearLedger[i] = (yearLedger[i] ?? 0) + (state.budget.lastMonth[i] ?? 0);
      // The year's last tick is the next year's first, whose month the next pass starts.
      if (state.tick < end) city.atMonth?.(player);
    }
    // The bars move on a day's first tick; read them once it has run.
    if (state.tick % DAY !== 1) continue;
    days++;
    for (const bar of DEMAND_BARS) {
      const value = state.demand[bar].value;
      sums[bar] = (sums[bar] ?? 0) + value;
      // The sign the top bar shows: a bar between -0.5 and 0.5 reads 0 there and changes nothing.
      const sign = Math.sign(Math.round(value));
      if (sign !== 0 && sign !== signs[bar]) {
        if (signs[bar] !== 0) flips[bar] = (flips[bar] ?? 0) + 1;
        signs[bar] = sign;
      }
    }
  }
  if (year === 1) yearLedger.set(yearLedger.map((v, i) => v - (i === LINE.grants ? funding : 0)));
  const t = state.stats.totals;
  const workers = (t["workersEmployed"] ?? 0) + (t["workersUnemployed"] ?? 0);
  const jobs = (t["jobsCommercial"] ?? 0) + (t["jobsOffice"] ?? 0) + (t["jobsIndustrial"] ?? 0);
  const people = t["population"] ?? 0;
  const { vacant, abandoned, room } = buildingCounts(state);
  const counts = state.stats.year;
  const average = (bar: string) => Math.round((sums[bar] ?? 0) / Math.max(1, days));
  const row: (string | number)[] = [
    year,
    people,
    average("residential"),
    average("commercial"),
    average("office"),
    average("industrial"),
    DEMAND_BARS.map((bar) => flips[bar] ?? 0).join("/"),
    `${((100 * (t["workersUnemployed"] ?? 0)) / Math.max(1, workers)).toFixed(1)}%`,
    (jobs / Math.max(1, people)).toFixed(2),
    vacant,
    abandoned,
    counts.births,
    counts.deaths,
    counts.arrivals,
    counts.departures,
    Math.max(0, room - people),
    ["residential", "commercial", "office", "industrial"].map((zone) => Math.round(100 * openShare(state, zone))).join("/"),
    ["jobsCommercial", "jobsOffice", "jobsIndustrial"].map((k) => Math.round((100 * (t[k] ?? 0)) / Math.max(1, jobs))).join("/"),
  ];
  if (city.watch) row.push(`${Math.round(100 * builtShare(state, city.watch.zone, city.watch.density))}%`);
  console.log(row.map((value, k) => pad(value, COLUMNS[k]?.[1] ?? 0)).join(" "));

  const tax = sumOf(TAX_LINES);
  const upkeep = sumOf(["roadUpkeep", "buildingUpkeep"]);
  const repay = sumOf(["loanRepayments", "interest"]);
  const other = at("otherSpending");
  const perCell = taxPerCell(state);
  const base = perCell[0] ?? 0;
  const reached = milestonesReached(state);
  const firstAt = state.milestones[0];
  moneyRows.push(
    [
      year,
      money(state.budget.treasury - funding),
      ...TAX_LINES.map((line) => money(at(line))),
      money(sumOf(CHARGE_LINES)),
      money(at("grants")),
      money(at("loansTaken")),
      money(sumOf(["construction", "demolition", "compensation"])),
      money(at("roadUpkeep")),
      money(at("buildingUpkeep")),
      money(repay),
      money(other),
      money(tax - upkeep - repay - other),
      money(tax / Math.max(1, people)),
      money((upkeep + other) / Math.max(1, people)),
      perCell.map((v) => money(v)).join("/"),
      base === 0 ? "-" : perCell.map((v) => Math.round(v / base)).join("/"),
      firstAt === undefined ? "none" : firstAt < 0 ? `${reached} given` : `${reached}, 1st d${Math.floor(firstAt / DAY)}`,
    ]
      .map((value, k) => pad(value, MONEY[k]?.[1] ?? 0))
      .join(" "),
  );
}

console.log("");
console.log(`Money by game year${city.onGrant ? ", on the starting grant alone" : ", the funding the city was given taken off the treasury"}. Tax R to I, Charges and Grants are income; Build (construction, demolition and compensation), Roads and Bldgs (upkeep), Repay (loan repayments and interest) and Other (other city spending) are expenses. Net: tax less upkeep, repayments and other spending, so growth's one-off money is left out. Tax/res and Spend/res: tax, and upkeep with other spending, per resident at the year's end. Tax/cell: what private buildings pay a year a cell of lot by the density they were built under, today; Ratio: the same over density 1's. Milestone: how many are reached, and the day the first was.`);
console.log(MONEY.map(([name, width]) => pad(name, width)).join(" "));
for (const line of moneyRows) console.log(line);
