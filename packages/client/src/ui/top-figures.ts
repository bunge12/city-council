// Issue M3-15: what the top bar says about population and demand. Display
// only: everything here reads the client's read-only copy and nothing feeds
// back into state.

import { DEMAND_PARTS, TIME_BALANCE, WAITING_PART, isMonthStart, type DemandBar, type StatsState } from "@city-council/sim";

/** Which way the population has gone over the last game month. */
export type Trend = "up" | "down" | "level";

/**
 * The population against the last monthly sample of it (M3-04), or null
 * when there is no sample to compare with.
 *
 * A sample is taken on a month's first tick, so for the rest of that day it
 * barely differs from the population, and the arrow would read "level" in a
 * growing city once a month. While the copy is still on a month's first day
 * the sample before is used instead, and with no sample before it there is
 * no arrow. `tick` is the copy's tick: the next one the sim will step.
 */
export function populationTrend(stats: Pick<StatsState, "totals" | "history" | "next">, tick: number, ticksPerDay = TIME_BALANCE.ticksPerDay): Trend | null {
  const series = stats.history["population"];
  if (!series || series.length === 0) return null;
  const count = series.length;
  // The newest sample is just before the write position.
  const newest = (stats.next - 1 + count) % count;
  const lastStepped = tick - 1;
  const today = lastStepped < 0 ? 0 : Math.floor(lastStepped / ticksPerDay) * ticksPerDay;
  const back = isMonthStart(today) ? 1 : 0;
  if (back >= count) return null;
  const sample = series[(newest - back + count) % count] ?? 0;
  const now = stats.totals["population"] ?? 0;
  return now > sample ? "up" : now < sample ? "down" : "level";
}

const ARROWS: Record<Trend, string> = { up: "▲", down: "▼", level: "▶" };
const TREND_WORDS: Record<Trend, string> = { up: "Up", down: "Down", level: "Level" };

/** The arrow beside the population, or nothing with no trend yet. */
export function trendArrow(trend: Trend | null): string {
  return trend ? ARROWS[trend] : "";
}

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** The tooltip on the population: people against the room the homes hold, and the trend. */
export function formatPopulationTitle(population: number | null, room: number | null, trend: Trend | null): string {
  if (population === null || room === null) return "People living in the city";
  const people = `${whole(population)} ${population === 1 ? "resident" : "residents"} in homes with room for ${whole(room)}.`;
  const month = trend ? ` ${TREND_WORDS[trend]} over the last game month.` : " No monthly figure to compare with yet.";
  return `${people}${month}`;
}

/** Each bar's name, as the tooltip starts. */
export const BAR_NAMES: Record<DemandBar, string> = {
  residential: "Residential",
  commercial: "Commercial",
  office: "Office",
  industrial: "Industrial",
};

/** Each part of each bar in plain words. Every name in `DEMAND_PARTS` has one; a unit test checks. */
export const PART_WORDS: Record<DemandBar, Record<string, string>> = {
  residential: {
    openJobs: "Open jobs",
    unemployment: "Unemployment",
    satisfaction: "Satisfaction",
    tax: "Residential tax rate",
    outsidePull: "Newcomers from outside",
    homesFilling: "Homes still filling",
  },
  commercial: {
    spendingPower: "Spending power",
    availableWorkers: "Available workers",
    shopSurplus: "More shop jobs than customers",
    tax: "Commercial tax rate",
    jobsOpen: "Shop jobs still open",
  },
  office: {
    educatedWorkers: "Educated workers",
    serviceBuyers: "Buyers of services",
    tax: "Office tax rate",
    jobsOpen: "Office jobs still open",
  },
  industrial: {
    unemployedWorkers: "Unemployed workers",
    goodsNeeded: "Goods shops need",
    openOfficeJobs: "Open office jobs",
    tax: "Industrial tax rate",
    outsideRoute: "No road to an outside connection",
    jobsOpen: "Factory jobs still open",
  },
};

/** A signed whole number: "+40", "-15". */
function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

/**
 * What pushes a bar up and down, in plain words, largest push up first and
 * largest push down last: "Open jobs +40, Unemployment -15". Parts that
 * round to 0 are left out.
 */
export function formatParts(bar: DemandBar, parts: Readonly<Record<string, number>>): string {
  const words = PART_WORDS[bar];
  const shown = DEMAND_PARTS[bar]
    .map((name) => ({ name, value: parts[name] ?? 0 }))
    .filter((p) => Math.round(p.value) !== 0)
    .sort((a, b) => b.value - a.value);
  return shown.map((p) => `${words[p.name] ?? p.name} ${signed(p.value)}`).join(", ");
}

/**
 * The line the residential bar's tooltip adds while new homes are held
 * (#330): the homes newcomers can reach still filling hold the grower and
 * redevelopment back, so nothing new is built. `empty` is the room left in
 * them, the mirror's `homesWaiting().empty`.
 */
export function formatHomesWaiting(empty: number): string {
  return `New homes waiting: ${whole(empty)} empty ${empty === 1 ? "place" : "places"} to fill first.`;
}

/** What each workplace bar's zone builds, as its waiting line names it. */
const WORKPLACES: Record<Exclude<DemandBar, "residential">, string> = { commercial: "shops", office: "offices", industrial: "factories" };

/**
 * The line a bar's tooltip adds while the grower holds its zone back for
 * what is already waiting: homes still filling (#330), or a workplace zone's
 * open jobs (#420). `waiting` is the empty places in those homes, or the
 * zone's open jobs, the mirror's `waitingFor`.
 */
export function formatWaiting(bar: DemandBar, waiting: number): string {
  if (bar === "residential") return formatHomesWaiting(waiting);
  return `New ${WORKPLACES[bar]} waiting: ${whole(waiting)} open ${waiting === 1 ? "job" : "jobs"} to fill first.`;
}

/**
 * The tooltip on a demand bar: its name and value, then its parts. With
 * `waiting`, while the grower holds the bar's zone back, and the bar pulling
 * above zero without its waiting part, rounded, a second line says what it
 * waits for (#330, #420). The bar itself may read 0 then: its waiting part
 * takes away what is waiting.
 */
export function formatDemandTitle(bar: DemandBar, value: number | null, parts: Readonly<Record<string, number>> | null, waiting: number | null = null): string {
  if (value === null || parts === null) return `${BAR_NAMES[bar]} demand`;
  const why = formatParts(bar, parts);
  const title = `${BAR_NAMES[bar]} demand ${signed(value)}. ${why === "" ? "Nothing pushes it either way." : why}`;
  const pull = value - (parts[WAITING_PART[bar]] ?? 0);
  return waiting !== null && Math.round(pull) > 0 ? `${title}\n${formatWaiting(bar, waiting)}` : title;
}
