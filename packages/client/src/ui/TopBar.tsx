import { DEMAND_BARS, SPEEDS, ZONING_BALANCE, gameDate, type DemandBar, type Speed } from "@city-council/sim";
import { cellColour } from "../render/cell-geometry";
import { PRESETS } from "../render/config";
import { isPreset, presetLabel } from "../render/presets";
import { formatGameDate } from "./format";
import { useRoom, useSaveStatus, useServices, useSim } from "./hooks";
import { useTip } from "./Tip";
import { BAR_NAMES, formatDemandTitle, formatPopulationTitle, populationTrend, trendArrow } from "./top-figures";
import { toggleDebug, toggleLog, toggleMenu, toggleSettings, toggleStats, useGraphics, useSound, useUi } from "./store";

/** The graphics setting: Low, Balanced or High, kept in this browser. */
function GraphicsSetting() {
  const { setPreset } = useServices();
  const wanted = useGraphics((s) => s.wanted);
  const shown = useGraphics((s) => s.shown);
  return (
    <label className="graphics-setting" title="Graphics preset. Kept in this browser. It changes how the city looks, never the city itself.">
      Graphics
      <select
        id="graphics-preset"
        value={wanted}
        data-shown={shown ?? ""}
        onChange={(e) => {
          if (isPreset(e.target.value)) setPreset(e.target.value);
        }}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {presetLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A volume slider, 0 to 100 on screen and 0 to 1 in the settings. */
function Volume({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <output htmlFor={id}>{Math.round(value * 100)}</output>
    </label>
  );
}

/** The sound settings: interface and ambience volumes and a mute, kept in this browser. */
function SoundSetting() {
  const { setSound } = useServices();
  const sound = useSound();
  return (
    <div className="sound-setting" id="sound-settings" role="group" aria-label="Sound" title="Sound settings. Kept in this browser.">
      <h3>Sound</h3>
      <Volume id="sound-interface" label="Interface" value={sound.interface} onChange={(v) => setSound({ interface: v })} />
      <Volume id="sound-ambience" label="Ambience" value={sound.ambience} onChange={(v) => setSound({ ambience: v })} />
      <label htmlFor="sound-mute" className="sound-mute">
        <input id="sound-mute" type="checkbox" checked={sound.muted} onChange={(e) => setSound({ muted: e.target.checked })} />
        Mute
      </label>
    </div>
  );
}

/**
 * The settings menu, under the top bar's Settings button (issue #332):
 * graphics and sound, and the buttons for the city, log and debug panels,
 * which open beside it.
 */
export function SettingsMenu() {
  const open = useUi((s) => s.settingsOpen);
  const menuOpen = useUi((s) => s.menuOpen);
  const logOpen = useUi((s) => s.logOpen);
  const debugOpen = useUi((s) => s.debugOpen);
  return (
    <section id="settings-menu" className="panel settings-menu" aria-label="Settings" hidden={!open}>
      <GraphicsSetting />
      <SoundSetting />
      <nav className="panels" aria-label="Panels">
        <button type="button" aria-expanded={menuOpen} aria-controls="city-menu" title="Start, open, save and download cities" onClick={toggleMenu}>City</button>
        <button type="button" aria-expanded={logOpen} aria-controls="activity-log" title="The commands the sim applied (L)" onClick={toggleLog}>Log</button>
        <button type="button" aria-expanded={debugOpen} aria-controls="debug-panel" title="Timings, the camera and every key (`)" onClick={toggleDebug}>Debug</button>
      </nav>
    </section>
  );
}

/** The people living in the city, with an arrow for the last game month, and people against room in the tooltip (issue M3-15). */
function Population() {
  const population = useSim((s) => s?.stats.totals["population"] ?? null);
  const trend = useSim((s) => (s ? populationTrend(s.stats, s.tick) : null));
  const room = useRoom();
  const { props, tip } = useTip(formatPopulationTitle(population, room, trend));
  return (
    <div className="population" id="population" {...props}>
      <span className="label">Population</span>
      <span id="population-count" data-room={room ?? ""}>
        {population === null ? "-" : population.toLocaleString("en-US")}
      </span>
      <span className="trend" id="population-trend" data-trend={trend ?? ""} aria-label={trend ? `trend ${trend}` : undefined}>
        {trendArrow(trend)}
      </span>
      {tip}
    </div>
  );
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
/** Each bar in its zone's middle shade from the zoning overlay. */
const BAR_COLOURS = Object.fromEntries(
  DEMAND_BARS.map((bar) => [bar, hex(cellColour(ZONING_BALANCE.zones.findIndex((z) => z.id === bar) + 1, 2))]),
) as Record<DemandBar, string>;

/**
 * One demand bar, lying on its side from -100 on the left to 100 on the
 * right of a centre line, with its name and value beside it and what pushes
 * it in the tooltip (issues M3-15, #332).
 */
function DemandMeter({ bar }: { bar: DemandBar }) {
  const value = useSim((s) => s?.demand[bar].value ?? null);
  const title = useSim((s) => (s ? formatDemandTitle(bar, s.demand[bar].value, s.demand[bar].parts) : formatDemandTitle(bar, null, null)));
  const { props, tip } = useTip(title);
  const shown = value === null ? null : Math.round(value);
  const size = value === null ? 0 : Math.min(100, Math.abs(value)) / 2;
  return (
    <div
      className="demand-bar"
      id={`demand-${bar}`}
      role="meter"
      aria-label={`${BAR_NAMES[bar]} demand`}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={shown ?? undefined}
      aria-valuetext={shown === null ? "-" : String(shown)}
      data-value={value ?? ""}
      {...props}
    >
      <span className="name">{BAR_NAMES[bar]}</span>
      <span className="track">
        <span className="fill" style={{ background: BAR_COLOURS[bar], width: `${size}%`, ...(value !== null && value < 0 ? { right: "50%" } : { left: "50%" }) }} />
      </span>
      <span className="value">{shown === null ? "-" : shown > 0 ? `+${shown}` : String(shown)}</span>
      {tip}
    </div>
  );
}

/** The four demand bars, or "-" before a city is open. */
function Demand() {
  const open = useSim((s) => s !== null);
  return (
    <div className="demand" id="demand" role="group" aria-label="Demand">
      {open ? DEMAND_BARS.map((bar) => <DemandMeter key={bar} bar={bar} />) : "-"}
    </div>
  );
}

/** Population and demand, in the bottom left corner (issue #332). */
export function CityStatus() {
  return (
    <section className="panel city-status" id="city-status" aria-label="Population and demand">
      <Population />
      <Demand />
    </section>
  );
}

const SPEED_LABELS: Record<Speed, string> = { 0: "Pause", 1: "1x", 2: "2x", 4: "4x" };

/** The game date and the speed buttons, in the bottom right corner (issue #332). */
export function GameClock() {
  const { sendCommand } = useServices();
  const date = useSim((s) => (s ? formatGameDate(gameDate(s.tick)) : "-"));
  const speed = useSim((s) => s?.speed ?? null);
  return (
    <section className="panel game-clock" id="game-clock" aria-label="Time">
      <span className="game-date" id="game-date" aria-label="Game date">{date}</span>
      <div className="speeds" role="group" aria-label="Game speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={speed === s}
            disabled={speed === null}
            onClick={() => void sendCommand("SetSpeed", { speed: s })}
          >
            {SPEED_LABELS[s]}
          </button>
        ))}
      </div>
    </section>
  );
}

/** The top bar: the city on the left, statistics and settings on the right (issue #332). */
export function TopBar() {
  const status = useSaveStatus();
  const city = !status ? "Loading…" : status.openElsewhere ? "No city open" : status.city.name;
  const settingsOpen = useUi((s) => s.settingsOpen);
  const statsOpen = useUi((s) => s.statsOpen);

  return (
    <header className="top-bar">
      <h1>City Council</h1>
      <span className="city-name" id="city-name">{city}</span>
      <nav className="panels" aria-label="Panels">
        <button type="button" id="stats-toggle" aria-expanded={statsOpen} aria-controls="stats-panel" title="Statistics: population and the city's numbers over time (P)" onClick={toggleStats}>Stats</button>
        <button type="button" id="settings-toggle" aria-expanded={settingsOpen} aria-controls="settings-menu" title="Settings: graphics, sound, cities, the log and the debug panel" onClick={toggleSettings}>Settings</button>
      </nav>
    </header>
  );
}
