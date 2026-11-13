import {
  deserialize,
  fnv1a64,
  generateTerrain,
  hashState,
  hashTerrain,
  mapSize,
  replay,
  snapToGrid,
  type CommandResult,
  type LogEntry,
  type Terrain,
} from "@city-council/sim";
import { Vector3 } from "three/webgpu";
import { SimMirror, type MirrorUpdate } from "./protocol/mirror";
import { LOCAL_PLAYER_ID } from "./protocol/player";
import { createWorkerTransport } from "./protocol/transport";
import { SaveClient, requestPersistence, type PersistenceResult } from "./save/page";
import type { SaveStatus } from "./save/channel";
import { createCameraControls, type CameraControls } from "./camera/controls";
import type { GroundHit } from "./camera/pick";
import { createCameraRig, type CameraRig } from "./camera/rig";
import { createView, wantsWebGL, type View } from "./render/view";
import { createRoadPreviewLayer } from "./render/road-preview";
import type { PreviewShape } from "./render/road-preview-geometry";
import { createSnapMarkLayer } from "./render/snap-marks";
import { snapMarks } from "./render/snap-marks-geometry";
import { RoadToolController, type RoadPreview } from "./tools/road-tool";
import type { Snap } from "./tools/snap";
import { mountUi } from "./ui/App";
import type { AppServices, DownloadedCity } from "./ui/services";
import { setRoadHover, setViewReadout, useUi } from "./ui/store";

/** The city this tab runs, kept for the tab's life so a reload comes back to it. */
const TAB_CITY_KEY = "city-council:city";

function tabCity(): string | null {
  try {
    return sessionStorage.getItem(TAB_CITY_KEY);
  } catch {
    return null;
  }
}

function setTabCity(id: string): void {
  try {
    sessionStorage.setItem(TAB_CITY_KEY, id);
  } catch {
    // Without it a reload opens the most recently opened city, as a new tab does.
  }
}

/** True from the moment this tab has chosen another city until the reload that opens it. */
let switching = false;

const worker = createWorkerTransport(tabCity());
const mirror = new SimMirror(worker.sim, LOCAL_PLAYER_ID);
const saves = new SaveClient(worker.saves);

saves.subscribe((status) => {
  document.body.dataset["saveLoaded"] = "true";
  document.body.dataset["openElsewhere"] = String(status.openElsewhere);
  // Once a switch has picked the next city, a status still on its way from
  // the worker must not put the old one back.
  if (!switching) setTabCity(status.city.id);
  // Nothing runs in this tab, so show the menu that offers another city.
  if (status.openElsewhere && !useUi.getState().menuOpen) useUi.setState({ menuOpen: true });
});

/** Saves now and resolves with the worker's status after the write. */
function saveNow(): Promise<SaveStatus> {
  return saves.save("manual");
}

// Save when the tab is hidden: the player may be closing it, and a hidden
// tab may be frozen or discarded without further warning.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void saves.save("hidden");
});

/** Sends a command and records the sim's answer for the activity log. */
async function sendCommand(type: string, payload: unknown = {}): Promise<CommandResult> {
  const result = await mirror.sendCommand(type, payload);
  useUi.setState({ lastCommand: result.ok ? `${type}: ok` : `${type}: refused, ${result.reason}` });
  return result;
}

// City files. The worker writes the file bytes and checks imported ones; the
// page only hands bytes to and from the browser's file handling.

/** Downloads the running city as a `.city` file named after it. */
async function downloadCity(): Promise<DownloadedCity> {
  const result = await saves.exportCity();
  if (!result.ok) {
    useUi.setState({ fileProblem: result.error });
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
  useUi.setState({ fileProblem: null, fileNote: `Downloaded ${fileName} at tick ${tick}.` });
  return { fileName, tick, hash };
}

/** A note to show after the reload that opens another city. */
const RELOAD_NOTE_KEY = "city-council:imported";

/**
 * Opens city `cityId`, which the worker has just stored or marked, by
 * reloading the page, with `note` shown once it has. The worker opens the
 * city this tab asks for.
 */
function reloadInto(cityId: string, note: string): void {
  switching = true;
  setTabCity(cityId);
  try {
    sessionStorage.setItem(RELOAD_NOTE_KEY, note);
  } catch {
    // The note is a nicety.
  }
  location.reload();
}

/**
 * Imports a city file as a new city and opens it. A file that is not a good
 * city is reported and nothing changes.
 */
async function importCityFile(file: File): Promise<void> {
  useUi.setState({ fileProblem: null, busy: true });
  const result = await saves.importCity(file.name, await file.arrayBuffer());
  if (!result.ok) {
    useUi.setState({ fileProblem: result.error, busy: false });
    return;
  }
  reloadInto(result.city.id, `Imported "${result.city.name}" from ${file.name}.`);
}

/** Saves the running city, starts a new one from `seed` and opens it. */
async function newCity(name: string, seed: number): Promise<void> {
  useUi.setState({ fileProblem: null, busy: true });
  const result = await saves.newCity(name, seed);
  if (!result.ok) {
    useUi.setState({ fileProblem: result.error, busy: false });
    return;
  }
  reloadInto(result.city.id, `Started "${result.city.name}" from seed ${result.city.seed}.`);
}

/** Saves the running city and opens saved city `id`. */
async function openCity(id: string): Promise<void> {
  useUi.setState({ fileProblem: null, busy: true });
  const result = await saves.openCity(id);
  if (!result.ok) {
    useUi.setState({ fileProblem: result.error, busy: false });
    return;
  }
  reloadInto(result.city.id, `Opened "${result.city.name}" at tick ${result.city.tick}.`);
}

try {
  const note = sessionStorage.getItem(RELOAD_NOTE_KEY);
  sessionStorage.removeItem(RELOAD_NOTE_KEY);
  useUi.setState({ fileNote: note });
} catch {
  // As above.
}

// `?debug` opens the debug panel at load, for walkthroughs and bug reports.
if (new URLSearchParams(location.search).has("debug")) useUi.setState({ debugOpen: true });

let persistence: PersistenceResult | null = null;
void requestPersistence().then((result) => {
  persistence = result;
  document.body.dataset["persistence"] = result;
  if (result !== "persisted") {
    useUi.setState({
      storageNote:
        result === "declined"
          ? "This browser did not agree to keep saved cities for good, so it may clear them if disk space runs low."
          : "This browser cannot promise to keep saved cities, so it may clear them if disk space runs low.",
    });
  }
});

/** The map on screen, once there is one. The road tool checks previews against it. */
let shownTerrain: Terrain | null = null;

const roadTool = new RoadToolController({
  get: () => useUi.getState(),
  set: (patch) => useUi.setState(patch),
  world: () => (mirror.state && shownTerrain ? { net: mirror.state.roads, terrain: shownTerrain } : null),
  send: (payload) => sendCommand("BuildRoad", payload),
});
mirror.subscribe((update) => roadTool.mirrorUpdated(update));

const services: AppServices = {
  mirror,
  saves,
  sendCommand,
  saveNow,
  downloadCity,
  importCityFile,
  newCity,
  openCity,
  roadTool,
};
const uiRoot = document.getElementById("ui");
if (!uiRoot) throw new Error("#ui is missing from index.html");
mountUi(uiRoot, services);

// The renderer. Terrain is derived from the seed, so the client rebuilds it
// from the mirror's copy of state and draws it. Nothing here writes state.
const canvas = document.getElementById("view");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#view canvas is missing from index.html");

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
  /** Where the road tool's cursor lands now, with the guides that are on, or null. */
  snap(): Snap | null;
}

let resolveCamera: (hooks: CameraHooks) => void = () => undefined;
const cameraReady = new Promise<CameraHooks>((resolve) => {
  resolveCamera = resolve;
});

const viewReady = createView(canvas, wantsWebGL(location.search)).then((view) => {
  setViewReadout({ backend: view.backend === "webgpu" ? "WebGPU" : "WebGL 2" });
  let shownSeed: number | null = null;
  let lastReadout = 0;
  view.onFrame((stats) => {
    if (stats.frameMs === 0 || performance.now() - lastReadout < 250) return;
    lastReadout = performance.now();
    setViewReadout({
      frame: `${stats.frameMs.toFixed(1)} ms (${stats.fps.toFixed(0)} fps)`,
      draws: `${stats.drawCalls}, ${(stats.triangles / 1000).toFixed(0)}k triangles`,
    });
  });
  let hooks: CameraHooks | null = null;
  const showMap = () => {
    const state = mirror.state;
    if (!state || state.seed === shownSeed) return;
    shownSeed = state.seed;
    const t0 = performance.now();
    const terrain = generateTerrain(state.seed);
    shownTerrain = terrain;
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
  // Roads come from the mirror alone: a snapshot draws them all, a delta
  // redraws the chunks its changed rows touch.
  const showRoads = (update: MirrorUpdate) => {
    const state = mirror.state;
    if (!state) return;
    if (update.kind === "snapshot") view.showRoads(state.roads);
    else if (update.roadNodes.length > 0 || update.roadSegs.length > 0) view.updateRoads(update.roadNodes, update.roadSegs);
    else return;
    const roads = view.roadStats();
    if (roads) {
      setViewReadout({
        roads: `${roads.segmentPieces} segment pieces in ${roads.chunks} chunks`,
        roadRebuilds: `${roads.lastRebuilt} last, ${roads.totalRebuilt} total, ${roads.lastBuildMs.toFixed(1)} ms`,
      });
    }
  };
  mirror.subscribe((update) => {
    showMap();
    showRoads(update);
  });
  showMap();
  if (mirror.state) showRoads({ kind: "snapshot" });
  return view;
});
viewReady.catch((error: unknown) => {
  setViewReadout({ backend: `failed: ${String(error)}` });
});

/** Builds the camera rig and its input over `terrain`, and the readouts that follow it. */
function startCamera(view: View, canvas: HTMLCanvasElement, terrain: Terrain): CameraHooks {
  const rig = createCameraRig(view.camera, terrain, () => ({ width: canvas.clientWidth, height: canvas.clientHeight }));
  const controls = createCameraControls(canvas, rig, view.scene);
  const v = new Vector3();
  let lastSnap: Snap | null = null;
  const hooks: CameraHooks = {
    rig,
    controls,
    terrain,
    lastPick: undefined,
    project(x, y, z) {
      v.set(x, y, z).project(view.camera);
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    },
    snap: () => lastSnap,
  };
  /**
   * Metres one CSS pixel covers on the ground at `hit`: the mean of the
   * screen lengths of a metre east and a metre south, so a snap distance in
   * pixels feels the same at every zoom and tilt.
   */
  const metresPerPixel = (hit: GroundHit): number => {
    const o = hooks.project(hit.x, hit.y, hit.z);
    const e = hooks.project(hit.x + 1, hit.y, hit.z);
    const s = hooks.project(hit.x, hit.y, hit.z + 1);
    const pixels = (Math.hypot(e.x - o.x, e.y - o.y) + Math.hypot(s.x - o.x, s.y - o.y)) / 2;
    return pixels > 1e-6 ? 1 / pixels : 1;
  };
  const snapAt = (hit: GroundHit | null): Snap | null =>
    hit ? roadTool.snap(hit, { metresPerPixel: metresPerPixel(hit), free: controls.altHeld() }) : null;
  controls.onPick((hit) => {
    hooks.lastPick = hit;
    setViewReadout({ pick: metres(hit) });
    const snap = snapAt(hit);
    roadTool.click(snap ? { x: snap.x, z: snap.z } : hit);
  });
  controls.onRightClick(() => roadTool.cancel());
  const previews = createRoadPreviewLayer(view.scene, () => hooks.terrain);
  const marks = createSnapMarkLayer(view.scene, () => hooks.terrain);
  // The live preview, worked out again only when what it depends on changes.
  let mirrorVersion = 0;
  mirror.subscribe(() => mirrorVersion++);
  let previewKey = "";
  let preview: RoadPreview | null = null;
  const livePreview = (cursor: { x: number; z: number } | null): RoadPreview | null => {
    const ui = useUi.getState();
    const start = ui.roadStart;
    const end = cursor ? { x: snapToGrid(cursor.x), z: snapToGrid(cursor.z) } : null;
    const key =
      ui.tool === "road" && start && end
        ? `${start.x},${start.z},${end.x},${end.z},${ui.roadType},${mirrorVersion}`
        : "";
    if (key !== previewKey) {
      previewKey = key;
      preview = key === "" ? null : roadTool.preview(end);
    }
    return preview;
  };
  const shapeOf = (p: RoadPreview, look: PreviewShape["look"]): PreviewShape => ({
    ax: p.from.x,
    az: p.from.z,
    bx: p.to.x,
    bz: p.to.z,
    width: p.type.width,
    look,
    junctions: look === "refused" ? [] : p.junctions,
  });
  view.onBeforeFrame((seconds) => {
    controls.update(seconds);
    const p = view.camera.position;
    const band = rig.zoomBand();
    document.body.dataset["zoomBand"] = band;
    view.setZoomBand(band);
    const cursor = controls.cursor();
    const snap = snapAt(cursor);
    lastSnap = snap;
    document.body.dataset["snap"] = snap?.kind ?? "";
    document.body.dataset["snapSquare"] = String(snap?.square ?? false);
    const live = livePreview(snap);
    const shapes = useUi.getState().roadPending.map((p) => shapeOf(p.preview, "pending"));
    if (live) shapes.push(shapeOf(live, live.ok ? "ok" : "refused"));
    previews.show(shapes);
    const scale = cursor ? metresPerPixel(cursor) : 1;
    marks.show(snap ? snapMarks(snap, useUi.getState().roadStart, scale) : [], scale);
    const pointer = controls.pointer();
    setRoadHover(live && pointer ? { x: pointer.x, y: pointer.y, preview: live, snap } : null);
    setViewReadout({
      camPosition: `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} m`,
      camHeight: `${rig.heightAboveGround().toFixed(0)} m`,
      zoomBand: band,
      cursor: cursor ? metres(cursor) : "-",
    });
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
 * can compare the result with the hashes Node produces.
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

/**
 * Replays a command log from `seed` to `untilTick` in this browser's main
 * thread and hashes the result, so Playwright can check a replay fixture
 * gives the same hash here as in Node.
 */
function replayCheck(seed: number, log: LogEntry[], untilTick: number): { hash: string; logLength: number } {
  const state = replay(seed, log, untilTick);
  return { hash: hashState(state), logLength: state.log.length };
}

// For Playwright and the console. It only reads the mirror and sends
// commands, the same as the UI does.
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
      replayCheck: typeof replayCheck;
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
  replayCheck,
  view: viewReady,
  camera: cameraReady,
  renderStatus: () => status,
};
