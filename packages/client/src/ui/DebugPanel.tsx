import { simInfo } from "@city-council/sim";
import { useEffect, useState } from "react";
import { TICK_BUDGET_MS } from "./config";
import { formatSpeed } from "./format";
import { useServices, useSim } from "./hooks";
import { TickRateMeter } from "./rate";
import { CAMERA_KEYS, SHORTCUTS } from "./shortcuts";
import { useUi, useViewReadout } from "./store";

const READOUT_MS = 250;

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

/** Numbers for whoever is building the next module. Toggled with the backquote key. */
export function DebugPanel() {
  const open = useUi((s) => s.debugOpen);
  const tick = useSim((s) => (s ? String(s.tick) : "waiting for snapshot"));
  const speed = useSim((s) => (s ? formatSpeed(s.speed) : "-"));
  const logLength = useSim((s) => (s ? String(s.logOffset + s.log.length) : "-"));
  const tps = useTickRate();
  const memory = useMemory();
  const view = useViewReadout();
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
        <dt>Frame</dt>
        <dd id="render-frame">{view.frame}</dd>
        <dt>Draw calls</dt>
        <dd id="render-draws">{view.draws}</dd>
        <dt>Roads</dt>
        <dd id="road-stats">{view.roads}</dd>
        <dt>Road chunk rebuilds</dt>
        <dd id="road-rebuilds">{view.roadRebuilds}</dd>
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
