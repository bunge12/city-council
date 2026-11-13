import {
  bridgeDeckLevel,
  connectionEnd,
  createState,
  deserialize,
  fnv1a64,
  generateTerrain,
  hashState,
  hashTerrain,
  heightAt,
  replay,
  snapToGrid,
  type Block,
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
import { startPose } from "./camera/start-pose";
import { createView, wantsWebGL, type View } from "./render/view";
import { createRoadPreviewLayer } from "./render/road-preview";
import type { PreviewShape } from "./render/road-preview-geometry";
import { createConnectionMarkLayer } from "./render/connection-marks";
import { connectionMarks } from "./render/connection-marks-geometry";
import type { RoadNet } from "./render/road-geometry";
import { createSnapMarkLayer } from "./render/snap-marks";
import { snapMarks } from "./render/snap-marks-geometry";
import { BlockOverlayController, blockLabelPoint, blockShapes } from "./tools/block-overlay";
import { EditToolController, editShapes, type EditPreview } from "./tools/edit-tool";
import { dragSamples, pickSegment } from "./tools/pick-segment";
import { RoadToolController, type RoadPreview } from "./tools/road-tool";
import { RouteToolController, routeShapes } from "./tools/route-tool";
import type { Snap } from "./tools/snap";
import { mountUi } from "./ui/App";
import { offsetCells } from "./ui/RoadReadout";
import type { AppServices, DownloadedCity } from "./ui/services";
import { setBlockLabels, setEditHover, setRoadHover, setViewReadout, useUi, type BlockLabel } from "./ui/store";

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

// A refusal's reason is about the history as it stood. Once the history
// changes, as when the player builds again, it no longer applies.
let undoHistory: unknown = null;
mirror.subscribe(() => {
  const history = mirror.state?.undo ?? null;
  if (history === undoHistory) return;
  undoHistory = history;
  if (useUi.getState().undoNote !== null) useUi.setState({ undoNote: null });
});

/** Takes back this player's newest road change, and keeps the reason if the sim refuses. */
async function undo(): Promise<CommandResult> {
  useUi.setState({ undoNote: null });
  const result = await sendCommand("Undo");
  if (!result.ok) useUi.setState({ undoNote: result.reason });
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

const editTool = new EditToolController({
  get: () => useUi.getState(),
  set: (patch) => useUi.setState(patch),
  world: () => (mirror.state && shownTerrain ? { net: mirror.state.roads, terrain: shownTerrain } : null),
  send: (type, payload) => sendCommand(type, payload),
});
mirror.subscribe((update) => editTool.mirrorUpdated(update));

const routeTool = new RouteToolController({
  get: () => useUi.getState(),
  set: (patch) => useUi.setState(patch),
  net: () => mirror.state?.roads ?? null,
});
const blockOverlay = new BlockOverlayController({
  get: () => useUi.getState(),
  set: (patch) => useUi.setState(patch),
  net: () => mirror.state?.roads ?? null,
});
// Only a change to the roads can change a route or a block.
mirror.subscribe((update) => {
  if (update.kind === "snapshot" || update.roadSegs.length > 0 || update.roadNodes.length > 0) {
    routeTool.refresh();
    blockOverlay.refresh();
  }
});

const services: AppServices = {
  mirror,
  saves,
  sendCommand,
  undo,
  saveNow,
  downloadCity,
  importCityFile,
  newCity,
  openCity,
  roadTool,
  editTool,
  routeTool,
  blockOverlay,
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
  /** The road segment the bulldoze or upgrade tool would pick at screen point (sx, sy), or NONE (-1). */
  pickSegmentAt(sx: number, sy: number): number;
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
    // Start looking at the first outside connection, where the player builds from.
    const start = startPose(terrain, state.roads, state.connections);
    hooks.rig.setPose(start.position, start.target);
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
    pickSegmentAt: (sx, sy) => segmentAt({ x: sx, y: sy }),
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
  /** The road segment under screen point `p` for the bulldoze and upgrade tools, or NONE. `prefer` wins while `p` is on it. */
  function segmentAt(p: { x: number; y: number }, prefer = -1): number {
    const net = mirror.state?.roads;
    if (!net) return -1;
    const ground = rig.pickGround(p.x, p.y);
    const deckY = bridgeDeckLevel(hooks.terrain.waterLevel);
    const deck = rig.pickLevel(p.x, p.y, deckY);
    const at = ground ?? (deck ? { ...deck, y: deckY, distance: 0 } : null);
    if (!at) return -1;
    return pickSegment(net, hooks.terrain, {
      pointer: p,
      ground,
      deck,
      metresPerPixel: metresPerPixel(at),
      project: hooks.project,
    }, undefined, prefer);
  }
  controls.onPick((hit) => {
    hooks.lastPick = hit;
    setViewReadout({ pick: metres(hit) });
    if (routeTool.active()) {
      routeTool.click(hit);
      return;
    }
    if (editTool.active()) {
      const pointer = controls.pointer();
      editTool.click(pointer ? segmentAt(pointer) : -1);
      return;
    }
    const snap = snapAt(hit);
    roadTool.click(snap ? { x: snap.x, z: snap.z } : hit);
  });
  controls.onRightClick(() => {
    const pointer = controls.pointer();
    if (editTool.active() && pointer && editTool.rightClick(segmentAt(pointer))) return;
    roadTool.cancel();
  });
  controls.setToolDrag({
    active: () => editTool.active() !== null,
    start: () => editTool.dragStart(),
    move: (from, to) => {
      for (const p of dragSamples(from, to)) {
        // The segment the drag took last wins while the pointer is on it, so a drag along a road skips the roads crossing it.
        const drag = useUi.getState().editDrag;
        editTool.dragOver(segmentAt(p, drag?.[drag.length - 1] ?? -1));
      }
    },
    end: () => editTool.dragEnd(),
    cancel: () => editTool.dragCancel(),
  });
  controls.onDoubleClick(() => roadTool.finish());
  const previews = createRoadPreviewLayer(view.scene, () => hooks.terrain);
  const marks = createSnapMarkLayer(view.scene, () => hooks.terrain);
  const connectionLayer = createConnectionMarkLayer(view.scene, () => hooks.terrain);
  /** Metres one CSS pixel covers on the ground at (x, z). */
  const scaleAt = (x: number, z: number): number => metresPerPixel({ x, y: heightAt(hooks.terrain, x, z), z, distance: 0 });
  // The live preview, worked out again only when what it depends on changes.
  let mirrorVersion = 0;
  mirror.subscribe(() => mirrorVersion++);
  let previewKey = "";
  let preview: RoadPreview | null = null;
  const livePreview = (cursor: { x: number; z: number } | null): RoadPreview | null => {
    const ui = useUi.getState();
    const start = ui.roadStart;
    const control = ui.roadControl;
    const end = cursor ? { x: snapToGrid(cursor.x), z: snapToGrid(cursor.z) } : null;
    const key =
      ui.tool === "road" && start && end
        ? `${start.x},${start.z},${control ? `${control.x},${control.z}` : "-"},${end.x},${end.z},${ui.roadType},${ui.roadMode},${mirrorVersion}`
        : "";
    if (key !== previewKey) {
      previewKey = key;
      preview = key === "" ? null : roadTool.preview(end);
    }
    return preview;
  };
  // The edit under the pointer, worked out again only when what it depends on changes.
  let editKey = "";
  let edit: EditPreview | null = null;
  const liveEdit = (seg: number): EditPreview | null => {
    const ui = useUi.getState();
    const key = editTool.active() ? `${ui.tool},${seg},${ui.editDrag?.join(";") ?? "-"},${ui.roadType},${mirrorVersion}` : "";
    if (key !== editKey) {
      editKey = key;
      edit = key === "" ? null : editTool.preview(seg);
    }
    return edit;
  };
  const shapeOf = (p: RoadPreview, look: PreviewShape["look"]): PreviewShape => ({
    ax: p.from.x,
    az: p.from.z,
    bx: p.to.x,
    bz: p.to.z,
    control: p.control,
    width: p.type.width,
    look,
    junctions: look === "refused" ? [] : p.junctions,
    bridges: look === "refused" ? [] : p.bridges.map((b) => ({ ax: b.from.x, az: b.from.z, bx: b.to.x, bz: b.to.z, control: b.control })),
  });
  // The block overlay's outlines and label points change only with the blocks.
  let outlinesFor: readonly Block[] | null = null;
  let outlines: PreviewShape[] = [];
  let labelPoints: { id: number; x: number; y: number; z: number; area: number }[] = [];
  const blockOutlines = (net: RoadNet, blocks: readonly Block[]): PreviewShape[] => {
    if (blocks !== outlinesFor) {
      outlinesFor = blocks;
      outlines = blockShapes(net, blocks);
      labelPoints = blocks.map((b) => {
        const p = blockLabelPoint(net, b);
        return { id: b.id, x: p.x, y: Math.max(heightAt(hooks.terrain, p.x, p.z), hooks.terrain.waterLevel), z: p.z, area: b.area };
      });
    }
    return outlines;
  };
  /** Each block's label on screen, leaving out those behind the camera or off the canvas. */
  const blockLabels = (net: RoadNet, blocks: readonly Block[]): BlockLabel[] => {
    blockOutlines(net, blocks);
    const out: BlockLabel[] = [];
    for (const p of labelPoints) {
      v.set(p.x, p.y, p.z).project(view.camera);
      if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
      out.push({ id: p.id, x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight, area: p.area });
    }
    return out;
  };
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
    // The bulldoze and upgrade tools: edits in flight, then the one under the pointer.
    const pointerNow = controls.pointer();
    const picked = editTool.active() && pointerNow ? segmentAt(pointerNow) : -1;
    document.body.dataset["pickedSegment"] = String(picked);
    const editNow = liveEdit(picked);
    const net = mirror.state?.roads;
    if (net) {
      for (const p of useUi.getState().editPending) shapes.push(...editShapes(net, p.preview, "pending"));
      if (editNow) {
        const look = !editNow.ok ? "refused" : editNow.kind === "bulldoze" ? "bulldoze" : "ok";
        shapes.push(...editShapes(net, editNow, look));
      }
    }
    setEditHover(editNow && pointerNow ? { x: pointerNow.x, y: pointerNow.y, preview: editNow } : null);
    // The debug route tool's route, under nothing else the tools draw.
    const route = useUi.getState().routeResult;
    if (net && route?.ok) shapes.unshift(...routeShapes(net, route.route));
    // The debug block overlay's outlines, under the route.
    const shownBlocks = useUi.getState().blocks;
    if (net && shownBlocks) shapes.unshift(...blockOutlines(net, shownBlocks));
    setBlockLabels(net && shownBlocks ? blockLabels(net, shownBlocks) : []);
    previews.show(shapes);
    const scale = cursor ? metresPerPixel(cursor) : 1;
    const ui = useUi.getState();
    const shown = snap && !routeTool.active() ? snapMarks(snap, roadTool.anchor(), scale) : [];
    // The route tool's points, as rings.
    for (const point of [ui.routeFrom, ui.routeTo]) if (point) shown.push({ shape: "ring", x: point.x, z: point.z, look: "node" });
    // Before a curve's control point is set, a line from the start shows the direction it will leave in.
    if (snap && ui.roadMode === "curved" && ui.roadStart && !ui.roadControl && snap.kind !== "tangent") {
      shown.push({ shape: "line", ax: ui.roadStart.x, az: ui.roadStart.z, bx: snap.x, bz: snap.z, look: "angle" });
    }
    // Once it is set, lines from the start to the control point and on to the cursor show the curve's frame.
    if (snap && ui.roadStart && ui.roadControl) {
      const c = ui.roadControl;
      shown.push({ shape: "line", ax: ui.roadStart.x, az: ui.roadStart.z, bx: c.x, bz: c.z, look: "angle" });
      shown.push({ shape: "line", ax: c.x, az: c.z, bx: snap.x, bz: snap.z, look: "angle" });
    }
    marks.show(shown, scale);
    // The outside connections, marked at every zoom.
    const state = mirror.state;
    const connections = state ? connectionMarks(state.roads, state.connections, scaleAt) : [];
    connectionLayer.show(connections, connections.map((m) => scaleAt(m.edgeX, m.edgeZ)));
    document.body.dataset["connectionMarks"] = String(connections.length);
    const pointer = controls.pointer();
    // Before the first click there is no road to read out, but a parallel offset still shows its gap.
    const shownSnap = snap && !routeTool.active() ? snap : null;
    setRoadHover(pointer && (live || offsetCells(shownSnap) !== null) ? { x: pointer.x, y: pointer.y, preview: live, snap: shownSnap } : null);
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

/**
 * Where a new city from `seed` puts its outside connections, worked out in
 * this browser's main thread, so Playwright can compare them with the
 * places Node gives.
 */
function connectionsCheck(seed: number): { x: number; z: number; innerX: number; innerZ: number }[] {
  const { roads, connections } = createState(seed);
  return Array.from(connections, (edge) => {
    const inner = connectionEnd(roads, edge);
    return { x: roads.nodeX[edge] ?? NaN, z: roads.nodeZ[edge] ?? NaN, innerX: roads.nodeX[inner] ?? NaN, innerZ: roads.nodeZ[inner] ?? NaN };
  });
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
      connectionsCheck: typeof connectionsCheck;
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
  connectionsCheck,
  view: viewReady,
  camera: cameraReady,
  renderStatus: () => status,
};
