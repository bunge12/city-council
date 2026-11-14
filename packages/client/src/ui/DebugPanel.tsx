import { BUILD_LEVELS, simInfo } from "@city-council/sim";
import { useEffect, useState } from "react";
import { blocksReadout } from "../tools/block-overlay";
import { routeReadout } from "../tools/route-tool";
import { TICK_BUDGET_MS } from "./config";
import { formatSpeed } from "./format";
import { useServices, useSim } from "./hooks";
import { TickRateMeter } from "./rate";
import { CAMERA_KEYS, SHORTCUTS } from "./shortcuts";
import { presetLabel } from "../render/presets";
import { useGraphics, useUi, useViewReadout, type GraphicsState } from "./store";

const READOUT_MS = 250;

/** The graphics preset in use and what picked it, for the debug panel. */
export function graphicsReadout(g: GraphicsState): string {
  const shown = g.shown === null ? "starting" : presetLabel(g.shown);
  const switching = g.shown !== null && g.shown !== g.wanted ? `, switching to ${presetLabel(g.wanted)}` : "";
  const b = g.benchmark;
  const measured = b.ms === null ? "" : `: ${b.ms.toFixed(1)} ms per draw${b.backend ? ` on ${b.backend}` : ""}`;
  let why: string;
  if (b.state === "running") why = "benchmark running";
  else if (g.source === "address") why = "forced by ?preset= in the address, benchmark skipped";
  else if (g.source === "player") why = `chosen in settings${b.ms === null ? "" : `; the benchmark measured ${b.ms.toFixed(1)} ms per draw on its first run`}`;
  else why = b.thisVisit ? `picked by the benchmark on this visit${measured}` : `picked by the benchmark on an earlier visit${measured}`;
  return `${shown}${switching} (${why})`;
}

/** Ticks per second as the page sees them, refreshed a few times a second. */
function useTickRate(): number | null {
  const { mirror } = useServices();
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const meter = new TickRateMeter();
    const unsubscribe = mirror.subscribe(() => {
      if (mirror.state) meter.add(performance.now(), mirror.state.tick);
    });
    const timer = setInterval(() => setRate(meter.rate()), READOUT_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [mirror]);
  return rate;
}

interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** JS heap use where the browser reports it (Chromium), or null. */
function useMemory(): MemoryInfo | null {
  const read = () => (performance as Performance & { memory?: MemoryInfo }).memory ?? null;
  const [memory, setMemory] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => {
      const m = read();
      setMemory(m && { usedJSHeapSize: m.usedJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return memory;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Per-system time of the host's last step against the tick budget. */
function TickTimes() {
  const { mirror } = useServices();
  // Re-render with each delta; the timings arrive with it.
  useSim((s) => s?.tick);
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), READOUT_MS);
    return () => clearInterval(timer);
  }, []);
  const timings = mirror.stats.timings;
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  const share = total / TICK_BUDGET_MS;
  return (
    <div id="sim-timings" className="timings">
      {timings.length === 0 ? (
        "-"
      ) : (
        <>
          <ul>
            {timings.map((t) => (
              <li key={t.system}>
                {t.system} {t.ms.toFixed(3)} ms
              </li>
            ))}
          </ul>
          <div className="budget">
            <div
              className={share > 1 ? "bar over" : "bar"}
              role="meter"
              aria-label="Tick time against the budget"
              aria-valuemin={0}
              aria-valuemax={TICK_BUDGET_MS}
              aria-valuenow={Number(total.toFixed(3))}
              style={{ width: `${Math.min(share, 1) * 100}%` }}
            />
          </div>
          <span id="sim-budget">
            {total.toFixed(3)} of {TICK_BUDGET_MS} ms ({(share * 100).toFixed(1)}%)
          </span>
        </>
      )}
    </div>
  );
}

/** The route tool: a button to pick two points, and the route between them or why there is none. */
function RouteTool() {
  const { routeTool } = useServices();
  const on = useUi((s) => s.tool === "route");
  const readout = useUi((s) => routeReadout(s));
  const found = useUi((s) => s.routeResult?.ok ?? null);
  return (
    <div className="route-tool">
      <button
        id="route-tool"
        type="button"
        aria-pressed={on}
        title="Click two points on the map to see the quickest road route between them. Escape clears them."
        onClick={() => routeTool.toggle()}
      >
        Pick two points
      </button>
      <span id="route-readout" data-found={found === null ? "" : String(found)}>
        {readout}
      </span>
    </div>
  );
}

/** The block overlay: a button to outline every block with its area, and how many there are. */
function BlockOverlay() {
  const { blockOverlay } = useServices();
  const on = useUi((s) => s.showBlocks);
  const readout = useUi((s) => blocksReadout(s));
  const count = useUi((s) => s.blocks?.length ?? null);
  return (
    <div className="route-tool">
      <button
        id="blocks-toggle"
        type="button"
        aria-pressed={on}
        title="Outline every area enclosed by ground-level roads, with its area."
        onClick={() => blockOverlay.toggle()}
      >
        Show blocks
      </button>
      <span id="blocks-readout" data-count={count === null ? "" : String(count)}>
        {readout}
      </span>
    </div>
  );
}

/** Labels for the levels the debug panel can build at, in the order shown. */
const LEVEL_LABELS: Readonly<Record<string, string>> = {
  ground: "Ground",
  elevated1: "Elevated 1",
  elevated2: "Elevated 2",
  tunnel: "Tunnel",
};

/**
 * The level the road tool builds at. No player tool sets a level in M1
 * (issue 22): this is for seeing raised roads and crossings in the debug view.
 */
function RoadLevel() {
  const level = useUi((s) => s.roadLevel);
  return (
    <div className="route-tool">
      <select
        id="road-level"
        value={level}
        title="The level the road tool builds at. Roads on different levels cross without a junction when there is room between them."
        onChange={(e) => useUi.setState({ roadLevel: e.target.value, roadNote: null })}
      >
        {Object.keys(BUILD_LEVELS).map((key) => (
          <option key={key} value={key}>
            {LEVEL_LABELS[key] ?? key}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Numbers for whoever is building the next module. Toggled with the backquote key. */
export function DebugPanel() {
  const open = useUi((s) => s.debugOpen);
  const tick = useSim((s) => (s ? String(s.tick) : "waiting for snapshot"));
  const speed = useSim((s) => (s ? formatSpeed(s.speed) : "-"));
  const logLength = useSim((s) => (s ? String(s.logOffset + s.log.length) : "-"));
  const tps = useTickRate();
  const memory = useMemory();
  const view = useViewReadout();
  const graphics = useGraphics(graphicsReadout);
  const info = simInfo();

  return (
    <section id="debug-panel" className="panel debug-panel" aria-label="Debug panel" hidden={!open}>
      <h2>Debug</h2>
      <p id="sim-info" className="hint">{`${info.name}, tick ${info.tickMs} ms`}</p>
      <dl>
        <dt>Tick</dt>
        <dd id="sim-tick">{tick}</dd>
        <dt>Speed</dt>
        <dd id="sim-speed">{speed}</dd>
        <dt>Ticks/s</dt>
        <dd id="sim-tps">{tps === null ? "-" : tps.toFixed(1)}</dd>
        <dt>Tick time</dt>
        <dd>
          <TickTimes />
        </dd>
        <dt>Log entries</dt>
        <dd id="sim-log-length">{logLength}</dd>
        <dt>Renderer</dt>
        <dd id="render-backend">{view.backend}</dd>
        <dt>Graphics</dt>
        <dd id="render-preset">{graphics}</dd>
        <dt>Frame</dt>
        <dd id="render-frame">{view.frame}</dd>
        <dt>Draw calls</dt>
        <dd id="render-draws">{view.draws}</dd>
        <dt>Roads</dt>
        <dd id="road-stats">{view.roads}</dd>
        <dt>Road chunk rebuilds</dt>
        <dd id="road-rebuilds">{view.roadRebuilds}</dd>
        <dt>Zoning cells</dt>
        <dd id="cell-stats">{view.cells}</dd>
        <dt>Cell chunk rebuilds</dt>
        <dd id="cell-rebuilds">{view.cellRebuilds}</dd>
        <dt>Memory</dt>
        <dd id="memory">
          {memory ? `${mb(memory.usedJSHeapSize)} of ${mb(memory.jsHeapSizeLimit)} heap` : "not reported by this browser"}
        </dd>
        <dt>Camera</dt>
        <dd id="cam-position">{view.camPosition}</dd>
        <dt>Height</dt>
        <dd id="cam-height">{view.camHeight}</dd>
        <dt>Zoom band</dt>
        <dd id="cam-band">{view.zoomBand}</dd>
        <dt>Cursor</dt>
        <dd id="cursor-world">{view.cursor}</dd>
        <dt>Clicked</dt>
        <dd id="pick-world">{view.pick}</dd>
        <dt>Route</dt>
        <dd>
          <RouteTool />
        </dd>
        <dt>Blocks</dt>
        <dd>
          <BlockOverlay />
        </dd>
        <dt>Road level</dt>
        <dd>
          <RoadLevel />
        </dd>
      </dl>
      <h3>Keys</h3>
      <dl id="shortcut-list" className="keys">
        {SHORTCUTS.map((s) => (
          <div key={s.label}>
            <dt>
              <kbd>{s.label}</kbd>
            </dt>
            <dd>{s.description}</dd>
          </div>
        ))}
        {CAMERA_KEYS.map((k) => (
          <div key={k.label}>
            <dt>
              <kbd>{k.label}</kbd>
            </dt>
            <dd>{k.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
