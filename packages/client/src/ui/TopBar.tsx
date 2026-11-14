import { SPEEDS, gameDate, type Speed } from "@city-council/sim";
import { PRESETS } from "../render/config";
import { isPreset, presetLabel } from "../render/presets";
import { formatGameDate } from "./format";
import { useSaveStatus, useServices, useSim } from "./hooks";
import { toggleDebug, toggleLog, toggleMenu, useGraphics, useUi } from "./store";

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

const SPEED_LABELS: Record<Speed, string> = { 0: "Pause", 1: "1x", 2: "2x", 4: "4x" };

export function TopBar() {
  const { sendCommand, undo, mirror } = useServices();
  const canUndo = useSim((s) => s?.undo.some((r) => r.playerId === mirror.playerId) ?? false);
  const date = useSim((s) => (s ? formatGameDate(gameDate(s.tick)) : "-"));
  const speed = useSim((s) => s?.speed ?? null);
  const status = useSaveStatus();
  const city = !status ? "Loading…" : status.openElsewhere ? "No city open" : status.city.name;
  const menuOpen = useUi((s) => s.menuOpen);
  const logOpen = useUi((s) => s.logOpen);
  const debugOpen = useUi((s) => s.debugOpen);

  return (
    <header className="top-bar">
      <h1>City Council</h1>
      <span className="city-name" id="city-name">{city}</span>
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
      <button
        type="button"
        id="undo"
        disabled={!canUndo}
        title={canUndo ? "Undo your last road change (Ctrl+Z or Cmd+Z)" : "Nothing to undo"}
        onClick={() => void undo()}
      >
        Undo
      </button>
      <GraphicsSetting />
      <nav className="panels" aria-label="Panels">
        <button type="button" aria-expanded={menuOpen} aria-controls="city-menu" onClick={toggleMenu}>City</button>
        <button type="button" aria-expanded={logOpen} aria-controls="activity-log" onClick={toggleLog}>Log</button>
        <button type="button" aria-expanded={debugOpen} aria-controls="debug-panel" onClick={toggleDebug}>Debug</button>
      </nav>
    </header>
  );
}
