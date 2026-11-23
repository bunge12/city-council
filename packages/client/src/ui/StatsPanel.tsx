import { useMemo, useState, type PointerEvent } from "react";
import { STAT_TOTALS, TIME_BALANCE, YEAR_COUNTS, gameDate, type YearCount } from "@city-council/sim";
import { useSim, type MirrorState } from "./hooks";
import { STAT_GROUPS, STAT_RANGES, STAT_SERIES, axisNumber, lastSamples, monthShort, newestMonth, niceTicks, rangeMonths, sampleDate, seriesById, steppedTick, type StatRange, type StatSeries } from "./stat-series";
import { setStatsRange, setStatsSeries, toggleStats, useUi } from "./store";

// The statistics panel (issue M3-16, PRD "City statistics"): a graph of one
// series' monthly history over 1, 10 or 100 game years, the breakdowns
// from the running totals, and the year's births, deaths, arrivals and
// departures. Read from the mirror; it sends nothing.

const YEAR_LABELS: Record<YearCount, string> = { births: "Births", deaths: "Deaths", arrivals: "Arrivals", departures: "Departures" };

/** The graph's size in SVG units; it scales to the panel's width. */
const W = 336;
const H = 168;
const PAD = { left: 40, right: 44, top: 10, bottom: 20 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** Months between the x axis's ticks, by range. */
const TICK_MONTHS: Record<StatRange, number> = { 1: 3, 10: 24, 100: 240 };
const RANGE_LABELS: Record<StatRange, string> = { 1: "1 year", 10: "10 years", 100: "100 years" };

/**
 * A key that changes whenever anything the panel shows does: the totals,
 * the year's counts and the history's write position. Cheap to build on
 * every update, and a string, so `useSim` re-renders only on a change.
 */
function statsKey(s: MirrorState): string {
  if (!s) return "";
  const st = s.stats;
  const parts: number[] = [st.next, st.history["population"]?.length ?? 0, newestMonth(s.tick)];
  for (const name of STAT_TOTALS) parts.push(st.totals[name] ?? 0);
  for (const what of YEAR_COUNTS) parts.push(st.year[what], st.lastYear[what]);
  return parts.join(",");
}

interface Plot {
  samples: number[];
  /** Month number of the newest sample. */
  newest: number;
  path: string;
  xOf(k: number): number;
  yOf(v: number): number;
  yTicks: number[];
  xTicks: { x: number; label: string }[];
}

/** The line and axes for `samples`, newest at the right edge of a window `months` long, or as long as the city is old. */
function plotOf(samples: number[], newest: number, months: number, range: StatRange): Plot {
  const n = samples.length;
  // The window never reaches back before the city's first month, so a young city fills the width.
  const span = Math.max(n, Math.min(months, newest + 1));
  const slots = Math.max(1, span - 1);
  // Sample k is (n - 1 - k) months before the newest, which sits on the right edge.
  const xOf = (k: number) => PAD.left + PLOT_W * (1 - (n - 1 - k) / slots);
  const max = samples.reduce((m, v) => (v > m ? v : m), 0);
  const yTicks = niceTicks(max);
  const top = yTicks.at(-1) ?? 1;
  const yOf = (v: number) => PAD.top + PLOT_H * (1 - v / top);
  let path = "";
  for (let k = 0; k < n; k++) path += `${k === 0 ? "M" : "L"}${xOf(k).toFixed(1)},${yOf(samples[k] ?? 0).toFixed(1)}`;
  const step = TICK_MONTHS[range];
  const first = newest - (span - 1);
  const xTicks: { x: number; label: string }[] = [];
  for (let m = Math.ceil(Math.max(0, first) / step) * step; m <= newest; m += step) {
    const x = PAD.left + PLOT_W * (1 - (newest - m) / slots);
    xTicks.push({ x, label: m % 12 === 0 ? `Year ${m / 12 + TIME_BALANCE.firstYear}` : monthShort(m) });
  }
  return { samples, newest, path, xOf, yOf, yTicks, xTicks };
}

/** The graph of one series. A crosshair and a tooltip follow the pointer to the nearest month. */
function Graph({ series, plot }: { series: StatSeries; plot: Plot }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = plot.samples.length;
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box || n === 0) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let k = 1; k < n; k++) if (Math.abs(plot.xOf(k) - x) < Math.abs(plot.xOf(best) - x)) best = k;
    setHover(best);
  };
  const last = plot.samples[n - 1];
  const at = hover !== null && hover < n ? hover : null;
  const atValue = at !== null ? (plot.samples[at] ?? 0) : null;
  return (
    <div className="stats-graph-wrap">
      <svg
        id="stats-graph"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={n === 0 ? `${series.label}: no history yet` : `${series.label} by month, ${n} months, ${series.format(last ?? 0)} now`}
        data-series={series.id}
        data-samples={n}
      >
        {plot.yTicks.map((v) => (
          <g key={v} className="stats-grid">
            <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={plot.yOf(v)} y2={plot.yOf(v)} />
            <text x={PAD.left - 4} y={plot.yOf(v)} dy="0.32em" textAnchor="end">{axisNumber(v)}</text>
          </g>
        ))}
        {plot.xTicks.map((t) => (
          <text key={t.x} className="stats-axis" x={t.x} y={H - 6} textAnchor="middle">{t.label}</text>
        ))}
        {n > 0 && <path id="stats-line" d={plot.path} stroke={series.color} />}
        {n > 0 && last !== undefined && (
          <>
            <circle className="stats-dot" cx={plot.xOf(n - 1)} cy={plot.yOf(last)} r={4} fill={series.color} />
            <text className="stats-end" x={plot.xOf(n - 1) + 7} y={plot.yOf(last)} dy="0.32em">{axisNumber(last)}</text>
          </>
        )}
        {at !== null && atValue !== null && (
          <g className="stats-cross">
            <line x1={plot.xOf(at)} x2={plot.xOf(at)} y1={PAD.top} y2={PAD.top + PLOT_H} />
            <circle className="stats-dot" cx={plot.xOf(at)} cy={plot.yOf(atValue)} r={4} fill={series.color} />
          </g>
        )}
        <rect
          className="stats-hit"
          x={PAD.left}
          y={0}
          width={PLOT_W}
          height={H}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {n === 0 && <p className="hint stats-empty">No history yet. The first sample is taken as the clock starts.</p>}
      {at !== null && atValue !== null && (
        <div
          className="stats-tooltip"
          id="stats-tooltip"
          role="status"
          style={{ left: `${(plot.xOf(at) / W) * 100}%`, transform: plot.xOf(at) > W / 2 ? "translateX(-100%)" : undefined }}
        >
          <span className="stats-tooltip-date">{sampleDate(plot.newest - (n - 1 - at))}:</span>{" "}
          <span><span className="stats-key" style={{ background: series.color }} />{series.format(atValue)}</span>
        </div>
      )}
    </div>
  );
}

/** A breakdown's value as a button that puts its series on the graph. */
function Pick({ series, value, plotted }: { series: StatSeries; value: number; plotted: boolean }) {
  return (
    <button
      type="button"
      id={`stat-${series.id}`}
      className="stat-pick"
      aria-pressed={plotted}
      title={`Graph ${series.label.toLowerCase()} over time`}
      onClick={() => setStatsSeries(series.id)}
    >
      {value.toLocaleString("en-US")}
    </button>
  );
}

function Breakdowns({ s, plotted }: { s: NonNullable<MirrorState>; plotted: string }) {
  const source = { stats: s.stats };
  return (
    <>
      {STAT_GROUPS.map((group) => (
        <section key={group} className="stats-group" aria-label={group}>
          <h3>{group}</h3>
          <dl>
            {STAT_SERIES.filter((series) => series.group === group).map((series) => (
              <div key={series.id} className="stats-row">
                <dt>{series.label}</dt>
                <dd>
                  <Pick series={series} value={series.now(source)} plotted={plotted === series.id} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

function YearTable({ s }: { s: NonNullable<MirrorState> }) {
  const year = gameDate(steppedTick(s.tick)).year;
  return (
    <section className="stats-group" aria-label="The year">
      <h3>People in and out</h3>
      <table className="stats-year" id="stats-year">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">{year > TIME_BALANCE.firstYear ? `Year ${year - 1}` : "Last year"}</th>
            <th scope="col">Year {year} so far</th>
          </tr>
        </thead>
        <tbody>
          {YEAR_COUNTS.map((what) => (
            <tr key={what}>
              <th scope="row">{YEAR_LABELS[what]}</th>
              <td id={`stats-${what}-last`}>{s.stats.lastYear[what].toLocaleString("en-US")}</td>
              <td id={`stats-${what}-now`}>{s.stats.year[what].toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatsBody() {
  // Re-renders when anything shown changes, and when a snapshot replaces the copy.
  useSim(statsKey);
  const s = useSim((state) => state);
  const seriesId = useUi((u) => u.statsSeries);
  const range = useUi((u) => u.statsRange);
  const series = seriesById(seriesId);
  const ring = s ? series.history({ stats: s.stats }) : null;
  const months = rangeMonths(range);
  const next = s?.stats.next ?? 0;
  const count = ring?.values.length ?? 0;
  const newest = s ? newestMonth(s.tick) : 0;
  // The line changes only when a sample is taken, a snapshot lands, or the choice changes.
  const plot = useMemo(
    () => plotOf(ring ? lastSamples(ring, months) : [], newest, months, range),
    // `ring` is a new object each render over the same arrays: these say when the arrays changed.
    [s, series, months, range, next, count, newest],
  );
  if (!s) return <h2>Statistics</h2>;
  return (
    <>
      {/* Stays in view while the breakdowns scroll under it, so a number picked below is graphed where it can be seen. */}
      <div className="stats-sticky">
        <div className="stats-title">
          <h2>Statistics</h2>
          <button type="button" className="stats-close" aria-label="Close statistics" onClick={toggleStats}>×</button>
        </div>
        <div className="stats-head">
          <h3 id="stats-series-title">{series.label}</h3>
          <span className="stats-now">{series.format(series.now({ stats: s.stats }))}</span>
        </div>
        <Graph series={series} plot={plot} />
        <div className="stats-ranges" role="group" aria-label="Range">
          {STAT_RANGES.map((r) => (
            <button key={r} type="button" id={`stats-range-${r}`} aria-pressed={range === r} onClick={() => setStatsRange(r)}>
              {RANGE_LABELS[r]}
            </button>
          ))}
          {series.id !== "population" && (
            <button type="button" id="stats-back" onClick={() => setStatsSeries("population")}>Back to population</button>
          )}
        </div>
        <p className="hint">Pick a number below to graph it.</p>
      </div>
      <YearTable s={s} />
      <Breakdowns s={s} plotted={series.id} />
    </>
  );
}

/** The panel itself. Closed, it reads nothing and draws nothing. */
export function StatsPanel() {
  const open = useUi((u) => u.statsOpen);
  return (
    <section id="stats-panel" className="panel stats-panel" aria-label="Statistics" hidden={!open}>
      {open && <StatsBody />}
    </section>
  );
}
