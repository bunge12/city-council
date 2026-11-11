import { fnv1a64, generateTerrain, hashTerrain, simInfo, type CommandResult } from "@city-council/sim";
import { SimMirror } from "./protocol/mirror";
import { createWorkerTransport } from "./protocol/transport";

/** Single player has one player. Multiplayer assigns ids on join. */
const LOCAL_PLAYER_ID = "local";

const info = simInfo();
const infoEl = document.getElementById("sim-info");
if (infoEl) infoEl.textContent = `${info.name}, tick ${info.tickMs} ms`;

const mirror = new SimMirror(createWorkerTransport(), LOCAL_PLAYER_ID);

// A plain readout until the UI shell and debug panel land (issue 10).
function field(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el;
}
const tickEl = field("sim-tick");
const speedEl = field("sim-speed");
const logEl = field("sim-log-length");
const timingsEl = field("sim-timings");
const resultEl = field("sim-last-result");

mirror.subscribe(() => {
  const state = mirror.state;
  if (!state) return;
  tickEl.textContent = String(state.tick);
  speedEl.textContent = state.speed === 0 ? "paused" : `${state.speed}x`;
  logEl.textContent = String(state.logOffset + state.log.length);
  timingsEl.textContent = mirror.stats.timings
    .map((t) => `${t.system} ${t.ms.toFixed(3)} ms`)
    .join(", ");
});

/** Sends a command and shows the sim's answer on the page. */
async function sendCommand(type: string, payload: unknown = {}): Promise<CommandResult> {
  const result = await mirror.sendCommand(type, payload);
  resultEl.textContent = result.ok ? `${type}: ok` : `${type}: refused, ${result.reason}`;
  return result;
}

/** What a terrain check reports. */
interface TerrainCheck {
  heightsHash: string;
  terrainHash: string;
  buildableShare: number;
  attempts: number;
  ms: number;
}

/**
 * Generates terrain for `seed` in this browser and hashes it, so Playwright
 * can compare the result with the hashes Node produces. Only on demand: the
 * renderer (issue 06) decides where terrain is built for play.
 */
function terrainCheck(seed: number): TerrainCheck {
  const start = performance.now();
  const terrain = generateTerrain(seed);
  const ms = performance.now() - start;
  const bytes = new Uint8Array(terrain.heights.buffer, terrain.heights.byteOffset, terrain.heights.byteLength);
  return {
    heightsHash: fnv1a64(bytes),
    terrainHash: hashTerrain(terrain),
    buildableShare: terrain.buildableShare,
    attempts: terrain.attempts,
    ms,
  };
}

// For Playwright and the console until issue 10 adds controls. It only reads
// the mirror and sends commands, the same as any UI would.
declare global {
  interface Window {
    cityCouncil: { mirror: SimMirror; sendCommand: typeof sendCommand; terrainCheck: typeof terrainCheck };
  }
}
window.cityCouncil = { mirror, sendCommand, terrainCheck };
