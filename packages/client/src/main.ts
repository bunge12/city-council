import { fnv1a64, generateTerrain, hashTerrain, mapSize, simInfo, type CommandResult } from "@city-council/sim";
import { SimMirror } from "./protocol/mirror";
import { createWorkerTransport } from "./protocol/transport";
import { createView, wantsWebGL, type View } from "./render/view";

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

// The renderer. Terrain is derived from the seed, so the client rebuilds it
// from the mirror's copy of state and draws it. Nothing here writes state.
const canvas = document.getElementById("view");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#view canvas is missing from index.html");
const backendEl = field("render-backend");
const frameEl = field("render-frame");
const drawsEl = field("render-draws");

/** What the page reports once the map is on screen. */
interface RenderStatus {
  backend: View["backend"];
  seed: number;
  terrainMs: number;
  buildMs: number;
  /** Milliseconds from navigation start to the first frame with terrain. */
  readyMs: number;
}

let status: RenderStatus | null = null;

const viewReady = createView(canvas, wantsWebGL(location.search)).then((view) => {
  backendEl.textContent = view.backend === "webgpu" ? "WebGPU" : "WebGL 2";
  let shownSeed: number | null = null;
  let lastReadout = 0;
  view.onFrame((stats) => {
    if (stats.frameMs === 0 || performance.now() - lastReadout < 250) return;
    lastReadout = performance.now();
    frameEl.textContent = `${stats.frameMs.toFixed(1)} ms (${stats.fps.toFixed(0)} fps)`;
    drawsEl.textContent = `${stats.drawCalls}, ${(stats.triangles / 1000).toFixed(0)}k triangles`;
  });
  const show = () => {
    const state = mirror.state;
    if (!state || state.seed === shownSeed) return;
    shownSeed = state.seed;
    const t0 = performance.now();
    const terrain = generateTerrain(state.seed);
    const t1 = performance.now();
    view.showTerrain(terrain);
    const t2 = performance.now();
    // A view of the whole map from the south, until camera controls land (issue 07).
    const size = mapSize(terrain);
    view.setCamera([size / 2, size * 0.7, size * 1.32], [size / 2, 0, size * 0.47]);
    requestAnimationFrame(() => {
      status = {
        backend: view.backend,
        seed: state.seed,
        terrainMs: t1 - t0,
        buildMs: t2 - t1,
        readyMs: performance.now(),
      };
      document.body.dataset["renderReady"] = "true";
    });
  };
  mirror.subscribe(show);
  show();
  return view;
});
viewReady.catch((error: unknown) => {
  backendEl.textContent = `failed: ${String(error)}`;
});

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
    cityCouncil: {
      mirror: SimMirror;
      sendCommand: typeof sendCommand;
      terrainCheck: typeof terrainCheck;
      view: Promise<View>;
      renderStatus: () => RenderStatus | null;
    };
  }
}
window.cityCouncil = { mirror, sendCommand, terrainCheck, view: viewReady, renderStatus: () => status };
