import {
  deserialize,
  fnv1a64,
  generateTerrain,
  hashState,
  hashTerrain,
  mapSize,
  simInfo,
  type CommandResult,
  type Terrain,
} from "@city-council/sim";
import { Vector3 } from "three/webgpu";
import { SimMirror } from "./protocol/mirror";
import { createWorkerTransport } from "./protocol/transport";
import { SaveClient, requestPersistence, type PersistenceResult } from "./save/page";
import type { SaveStatus } from "./save/channel";
import { wantsExportReminder } from "./save/city-file";
import { EXPORT_REMINDER_INTERVAL_MS } from "./save/config";
import { createCameraControls, type CameraControls } from "./camera/controls";
import type { GroundHit } from "./camera/pick";
import { createCameraRig, type CameraRig } from "./camera/rig";
import { createView, wantsWebGL, type View } from "./render/view";

/** Single player has one player. Multiplayer assigns ids on join. */
const LOCAL_PLAYER_ID = "local";

const info = simInfo();
const infoEl = document.getElementById("sim-info");
if (infoEl) infoEl.textContent = `${info.name}, tick ${info.tickMs} ms`;

const worker = createWorkerTransport();
const mirror = new SimMirror(worker.sim, LOCAL_PLAYER_ID);
const saves = new SaveClient(worker.saves);

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

// Saving. The worker loads the latest city and saves it; the page asks for
// saves and shows how they went.
const cityEl = field("save-city");
const saveStatusEl = field("save-status");
const saveProblemEl = field("save-problem");
const storageNoteEl = field("storage-note");
const saveButton = field("save-now");

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function showNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? "";
  el.hidden = text === null;
}

saves.subscribe((status: SaveStatus) => {
  cityEl.textContent = `${status.city.name}, seed ${status.city.seed} (${status.cities.length} saved)`;
  const last = status.lastSave;
  saveStatusEl.textContent = last
    ? `tick ${last.tick} at ${clockTime(last.savedAt)} (${last.reason})`
    : `not yet, resumed at tick ${status.loadedTick} from ${status.loadedFrom}`;
  showNote(saveProblemEl, [status.problem, status.saveError].filter(Boolean).join(" ") || null);
  document.body.dataset["saveLoaded"] = "true";
});

/** Saves now and resolves with the worker's status after the write. */
function saveNow(): Promise<SaveStatus> {
  return saves.save("manual");
}
saveButton.addEventListener("click", () => void saveNow());

// Save when the tab is hidden: the player may be closing it, and a hidden
// tab may be frozen or discarded without further warning.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void saves.save("hidden");
});

// City files. The worker writes the file bytes and checks imported ones; the
// page only hands bytes to and from the browser's file handling.
const downloadButton = field("download-city");
const importInput = field("import-file");
if (!(importInput instanceof HTMLInputElement)) throw new Error("#import-file must be an input");
const fileNoteEl = field("file-note");
const fileProblemEl = field("file-problem");
const reminderEl = field("export-reminder");
const reminderTextEl = field("export-reminder-text");

/** What a download wrote, for the page and Playwright. */
interface DownloadedCity {
  fileName: string;
  tick: number;
  /** `hashState` of the city in the file. */
  hash: string;
}

/** Downloads the running city as a `.city` file named after it. */
async function downloadCity(): Promise<DownloadedCity> {
  const result = await saves.exportCity();
  if (!result.ok) {
    showNote(fileProblemEl, result.error);
    throw new Error(result.error);
  }
  const { fileName, tick, bytes } = result;
  const hash = hashState(deserialize(new Uint8Array(bytes)).state);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // The browser has the file by the time this runs.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  showNote(fileProblemEl, null);
  showNote(fileNoteEl, `Downloaded ${fileName} at tick ${tick}.`);
  reminderEl.hidden = true;
  return { fileName, tick, hash };
}

const IMPORTED_NOTE_KEY = "city-council:imported";

/**
 * Imports a city file as a new city and opens it by reloading the page; the
 * worker opens the most recently imported city. A file that is not a good
 * city is reported and nothing changes.
 */
async function importCityFile(file: File): Promise<void> {
  showNote(fileProblemEl, null);
  const result = await saves.importCity(file.name, await file.arrayBuffer());
  if (!result.ok) {
    showNote(fileProblemEl, result.error);
    return;
  }
  try {
    sessionStorage.setItem(IMPORTED_NOTE_KEY, `Imported "${result.city.name}" from ${file.name}.`);
  } catch {
    // The note is a nicety.
  }
  location.reload();
}

downloadButton.addEventListener("click", () => void downloadCity().catch(() => undefined));
field("reminder-download").addEventListener("click", () => void downloadCity().catch(() => undefined));
importInput.addEventListener("change", () => {
  const file = importInput.files?.[0];
  // Clear it so picking the same file again still fires `change`.
  importInput.value = "";
  if (file) void importCityFile(file);
});

try {
  const imported = sessionStorage.getItem(IMPORTED_NOTE_KEY);
  sessionStorage.removeItem(IMPORTED_NOTE_KEY);
  showNote(fileNoteEl, imported);
} catch {
  // As above.
}

// A gentle reminder to download a copy now and then, since the browser may
// clear saved cities. "Not now" hides it until the page is next opened.
let reminderDismissed = false;
function updateReminder(): void {
  const status = saves.status;
  const city = status?.cities.find((c) => c.id === status.city.id);
  const show = !reminderDismissed && city !== undefined && wantsExportReminder(city, Date.now(), EXPORT_REMINDER_INTERVAL_MS);
  if (show && city) {
    reminderTextEl.textContent =
      `You have not downloaded a copy of "${city.name}" for a while. ` +
      "The browser can clear saved cities, so a file is the copy to keep.";
  }
  reminderEl.hidden = !show;
}
field("reminder-later").addEventListener("click", () => {
  reminderDismissed = true;
  updateReminder();
});
saves.subscribe(updateReminder);
setInterval(updateReminder, 60_000);

let persistence: PersistenceResult | null = null;
void requestPersistence().then((result) => {
  persistence = result;
  document.body.dataset["persistence"] = result;
  if (result !== "persisted") {
    showNote(
      storageNoteEl,
      result === "declined"
        ? "This browser did not agree to keep saved cities for good, so it may clear them if disk space runs low."
        : "This browser cannot promise to keep saved cities, so it may clear them if disk space runs low.",
    );
  }
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
      saves: SaveClient;
      saveNow: typeof saveNow;
      downloadCity: typeof downloadCity;
      persistence: () => PersistenceResult | null;
      terrainCheck: typeof terrainCheck;
      view: Promise<View>;
      camera: Promise<CameraHooks>;
      renderStatus: () => RenderStatus | null;
    };
  }
}
window.cityCouncil = {
  mirror,
  sendCommand,
  saves,
  saveNow,
  downloadCity,
  persistence: () => persistence,
  terrainCheck,
  view: viewReady,
  camera: cameraReady,
  renderStatus: () => status,
};
