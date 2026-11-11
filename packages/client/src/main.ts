import { fnv1a64, generateTerrain, hashTerrain, mapSize, simInfo, type CommandResult, type Terrain } from "@city-council/sim";
import { Vector3 } from "three/webgpu";
import { SimMirror } from "./protocol/mirror";
import { createWorkerTransport } from "./protocol/transport";
import { createCameraControls, type CameraControls } from "./camera/controls";
import type { GroundHit } from "./camera/pick";
import { createCameraRig, type CameraRig } from "./camera/rig";
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
const camPositionEl = field("cam-position");
const camHeightEl = field("cam-height");
const camBandEl = field("cam-band");
const cursorEl = field("cursor-world");
const pickEl = field("pick-world");

/** Sets an element's text only when it changes, so per-frame readouts stay cheap. */
function show(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function metres(hit: { x: number; y: number; z: number } | null): string {
  return hit ? `${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}, ${hit.z.toFixed(1)} m` : "off the map";
}

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

/** The camera and what it needs, once the first map is on screen. */
interface CameraHooks {
  rig: CameraRig;
  controls: CameraControls;
  /** The map the camera is over. Read only. */
  terrain: Terrain;
  /** Last ground point clicked, or null for a click off the map. */
  lastPick: GroundHit | null | undefined;
  /** Screen point, in CSS pixels, where world point (x, y, z) is drawn. */
  project(x: number, y: number, z: number): { x: number; y: number };
}

let resolveCamera: (hooks: CameraHooks) => void = () => undefined;
const cameraReady = new Promise<CameraHooks>((resolve) => {
  resolveCamera = resolve;
});

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
  let hooks: CameraHooks | null = null;
  const showMap = () => {
    const state = mirror.state;
    if (!state || state.seed === shownSeed) return;
    shownSeed = state.seed;
    const t0 = performance.now();
    const terrain = generateTerrain(state.seed);
    const t1 = performance.now();
    view.showTerrain(terrain);
    const t2 = performance.now();
    if (hooks) {
      hooks.terrain = terrain;
      hooks.rig.setTerrain(terrain);
    } else {
      hooks = startCamera(view, canvas, terrain);
      resolveCamera(hooks);
    }
    // Start on a view of the whole map from the south.
    const size = mapSize(terrain);
    hooks.rig.setPose([size / 2, size * 0.7, size * 1.32], [size / 2, 0, size * 0.47]);
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
  mirror.subscribe(showMap);
  showMap();
  return view;
});
viewReady.catch((error: unknown) => {
  backendEl.textContent = `failed: ${String(error)}`;
});

/** Builds the camera rig and its input over `terrain`, and the readouts that follow it. */
function startCamera(view: View, canvas: HTMLCanvasElement, terrain: Terrain): CameraHooks {
  const rig = createCameraRig(view.camera, terrain, () => ({ width: canvas.clientWidth, height: canvas.clientHeight }));
  const controls = createCameraControls(canvas, rig, view.scene);
  const v = new Vector3();
  const hooks: CameraHooks = {
    rig,
    controls,
    terrain,
    lastPick: undefined,
    project(x, y, z) {
      v.set(x, y, z).project(view.camera);
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    },
  };
  controls.onPick((hit) => {
    hooks.lastPick = hit;
    show(pickEl, metres(hit));
  });
  view.onBeforeFrame((seconds) => {
    controls.update(seconds);
    const p = view.camera.position;
    show(camPositionEl, `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} m`);
    show(camHeightEl, `${rig.heightAboveGround().toFixed(0)} m`);
    const band = rig.zoomBand();
    show(camBandEl, band);
    document.body.dataset["zoomBand"] = band;
    const cursor = controls.cursor();
    show(cursorEl, cursor ? metres(cursor) : "-");
  });
  return hooks;
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
    cityCouncil: {
      mirror: SimMirror;
      sendCommand: typeof sendCommand;
      terrainCheck: typeof terrainCheck;
      view: Promise<View>;
      camera: Promise<CameraHooks>;
      renderStatus: () => RenderStatus | null;
    };
  }
}
window.cityCouncil = { mirror, sendCommand, terrainCheck, view: viewReady, camera: cameraReady, renderStatus: () => status };
