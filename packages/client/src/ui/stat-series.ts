// The statistics panel's series (issue M3-16). A series is one entry in
// `STAT_SERIES`: a label, a colour, where to read its monthly history and
// how to write its numbers. Later modules add their lines by adding
// entries, such as income and spending in M4 or average commute in M5.
//
// The reader turns a history ring, as the sim keeps it (stats.ts), into the
// samples one range of the graph shows, oldest first. Display only: nothing
// here writes state.

import { HISTORY_LENGTH, JOB_KINDS, TIME_BALANCE, ZONING_BALANCE, gameDate, type StatsState } from "@city-council/sim";

/**
 * A history as the sim keeps it: `values` grows by one sample a month until
 * it holds `capacity`, oldest first, and from then on `next` is where the
 * next sample overwrites the oldest.
 */
export interface HistoryRing {
  values: ArrayLike<number>;
  next: number;
  capacity: number;
}

/** What a series reads its numbers from: the copy's statistics, for now the only place a history lives. */
export interface SeriesSource {
  stats: Readonly<StatsState>;
}

export interface StatSeries {
  /** Unique, and the id of the button that puts it on the graph: `stat-<id>`. */
  id: string;
  /** Sentence case, as the panel and the graph's title show it. */
  label: string;
  /** The heading it sits under in the panel. */
  group: string;
  /** A CSS colour for its line, a theme token where one fits. */
  color: string;
  /** Its value now. */
  now(source: SeriesSource): number;
  /** Its monthly history, or null if it has none. */
  history(source: SeriesSource): HistoryRing | null;
  /** A value in full, with its unit, such as "1,204 people". */
  format(value: number): string;
}

/** Game years each range of the graph covers. */
export const STAT_RANGES = [1, 10, 100] as const;
export type StatRange = (typeof STAT_RANGES)[number];

/** Months of history one range covers. Never more than the history holds. */
export function rangeMonths(years: StatRange): number {
  return Math.min(HISTORY_LENGTH, years * 12);
}

/**
 * The last `months` samples of `ring`, oldest first: fewer when it holds
 * fewer. Works the same before and after the ring has wrapped.
 */
export function lastSamples(ring: HistoryRing, months: number): number[] {
  const count = ring.values.length;
  const n = Math.max(0, Math.min(count, Math.floor(months)));
  // Until it is full the oldest sample is at 0 and the newest at the end.
  // After, the newest is just before `next`.
  const newest = count < ring.capacity ? count - 1 : (ring.next - 1 + count) % count;
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = ring.values[(newest - (n - 1 - k) + count * 2) % count] ?? 0;
  return out;
}

const LINE = "var(--stat-line)";

function counted(unit: string, one: string): (value: number) => string {
  return (value) => `${value.toLocaleString("en-US")} ${value === 1 ? one : unit}`;
}

const people = counted("people", "person");

/** A series of one of the sim's running totals, which all keep a monthly history. */
function total(name: string, label: string, group: string, format: (value: number) => string): StatSeries {
  return {
    id: name,
    label,
    group,
    color: LINE,
    now: ({ stats }) => stats.totals[name] ?? 0,
    history: ({ stats }) => {
      const values = stats.history[name];
      return values ? { values, next: stats.next, capacity: HISTORY_LENGTH } : null;
    },
    format,
  };
}

const LEVELS = ["Low", "Medium", "High"] as const;
const KIND_NAMES: Record<(typeof JOB_KINDS)[number], string> = { commercial: "Commercial", office: "Office", industrial: "Industrial" };

/** Groups, in the order the panel lists them. */
export const STAT_GROUPS = ["People", "Residents by density", "Residents by education", "Residents by wealth", "Workers", "Jobs", "Buildings"] as const;

/**
 * Every series the panel offers, population first. The names of the totals
 * are built the way the sim builds them (stats.ts), from the same balance
 * data, and a unit test checks each one is a total the sim keeps.
 */
export const STAT_SERIES: readonly StatSeries[] = [
  total("population", "Population", "People", people),
  total("pops", "Households (pops)", "People", counted("pops", "pop")),
  total("popsWithChildren", "Pops with children", "People", counted("pops", "pop")),
  ...ZONING_BALANCE.densities.map((d) => total(`residentsDensity${d.level}`, `${d.name} density homes`, "Residents by density", people)),
  ...LEVELS.map((l) => total(`residentsEducation${l}`, `${l} education`, "Residents by education", people)),
  ...LEVELS.map((l) => total(`residentsWealth${l}`, `${l} wealth`, "Residents by wealth", people)),
  total("workersEmployed", "Employed", "Workers", counted("workers", "worker")),
  total("workersUnemployed", "Unemployed", "Workers", counted("workers", "worker")),
  ...JOB_KINDS.flatMap((k) => [
    total(`jobs${KIND_NAMES[k]}`, `${KIND_NAMES[k]} jobs offered`, "Jobs", counted("jobs", "job")),
    total(`filled${KIND_NAMES[k]}`, `${KIND_NAMES[k]} jobs filled`, "Jobs", counted("jobs", "job")),
  ]),
  ...ZONING_BALANCE.zones.flatMap((z) =>
    ZONING_BALANCE.densities.map((d) => total(`buildings${z.letter}${d.level}`, `${z.name} ${z.letter}${d.level} buildings`, "Buildings", counted("buildings", "building"))),
  ),
];

/** The series with id `id`, or population when there is none. */
export function seriesById(id: string): StatSeries {
  const found = STAT_SERIES.find((s) => s.id === id) ?? STAT_SERIES[0];
  if (!found) throw new Error("no statistics series");
  return found;
}

/**
 * The tick whose date the panel shows: the last tick the sim has stepped.
 * A step runs its systems at `tick` and then moves the clock on, so a copy
 * at the first tick of a month has not yet taken that month's sample, and
 * on 1 January the year has not yet rolled.
 */
export function steppedTick(tick: number): number {
  return Math.max(0, tick - 1);
}

/** Months since January of the first year for the month of the newest sample in a copy at `tick`. */
export function newestMonth(tick: number): number {
  const d = gameDate(steppedTick(tick));
  return (d.year - TIME_BALANCE.firstYear) * 12 + d.month - 1;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The short name of month number `month`, counted as `newestMonth` counts. */
export function monthShort(month: number): string {
  return MONTHS[month % 12] ?? "?";
}

/** When the sample of month number `month` was taken, such as "1 Apr, Year 51". */
export function sampleDate(month: number): string {
  return `1 ${monthShort(month)}, Year ${Math.floor(month / 12) + TIME_BALANCE.firstYear}`;
}

/** A tick value for the graph's axis: in full under 10,000, compact above (10K, 1.5M). */
export function axisNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10_000) return value.toLocaleString("en-US");
  if (abs < 1_000_000) return `${trim(value / 1000)}K`;
  return `${trim(value / 1_000_000)}M`;
}

function trim(value: number): string {
  const text = Math.abs(value) < 10 ? value.toFixed(1) : value.toFixed(0);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * Clean ticks from 0 to at least `max`, about `count` of them: steps of 1,
 * 2 or 5 times a power of ten. A series that never rose above 0 gets 0 and 1.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  let power = 1;
  while (power * 10 <= rough) power *= 10;
  while (power > rough) power /= 10;
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10;
  // Whole numbers only: a count never has a fraction.
  const whole = Math.max(1, Math.round(step));
  const ticks: number[] = [];
  for (let v = 0; v < max + whole; v += whole) ticks.push(v);
  return ticks;
}
