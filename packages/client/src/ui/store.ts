// UI state, in Zustand. Only what the page itself owns lives here: which
// panels are open, notes to the player and readouts from the renderer. Sim
// state is never copied in. Components read it from the SimMirror through
// `useSim` (hooks.ts) and change it only by sending commands.

import { create } from "zustand";
import type { BuildingGround, BuildingInfo, LandValue } from "@city-council/sim";
import type { StatRange } from "./stat-series";
import { DEFAULT_PRESET } from "../render/config";
import type { Occupants } from "./BuildingReadout";
import type { Preset, PresetSource } from "../render/presets";
import { DEFAULT_SOUND } from "../sound/config";
import type { SoundSettings } from "../sound/settings";
import { INITIAL_BLOCK_OVERLAY, type BlockOverlayState } from "../tools/block-overlay";
import { INITIAL_BULLDOZE_TOOL, type BulldozePreview, type BulldozeToolState } from "../tools/bulldoze-tool";
import { INITIAL_EDIT_TOOL, type EditPreview, type EditToolState } from "../tools/edit-tool";
import { INITIAL_GRID_TOOL, type GridToolState } from "../tools/grid-tool";
import { INITIAL_ROAD_TOOL, type RoadPreview, type RoadToolState } from "../tools/road-tool";
import { INITIAL_ROUTE_TOOL, type RouteToolState } from "../tools/route-tool";
import type { Snap } from "../tools/snap";
import { INITIAL_ZONE_TOOL, type ZonePreview, type ZoneToolState } from "../tools/zone-tool";
import { toggledOverlay, type OverlayEntry, type OverlayId } from "./overlays";
import { columnOrder, stacked, stackedForTool, type PanelId, type WindowId } from "./windows";

export interface UiState extends RoadToolState, GridToolState, EditToolState, BulldozeToolState, RouteToolState, BlockOverlayState, ZoneToolState {
  debugOpen: boolean;
  logOpen: boolean;
  menuOpen: boolean;
  /** The settings menu under the top bar's Settings button (issue #332). */
  settingsOpen: boolean;
  /** The windows open, oldest first, so Escape closes the newest (windows.ts). */
  windows: readonly WindowId[];
  /** The statistics panel (issue M3-16), the series on its graph and the game years the graph covers. */
  statsOpen: boolean;
  statsSeries: string;
  statsRange: StatRange;
  /** The sim's answer to the last command the page sent, such as "NoOp: ok". */
  lastCommand: string | null;
  /** Notes about city files and switching cities. Null when there is none. */
  fileNote: string | null;
  fileProblem: string | null;
  /** Shown when the browser will not promise to keep saved cities. */
  storageNote: string | null;
  /** The player chose "Not now" on the download reminder this visit. */
  reminderDismissed: boolean;
  /** A city switch or import is under way; the page reloads when it lands. */
  busy: boolean;
  /** Why the sim refused the last undo, until the next one is sent. */
  undoNote: string | null;
  /** The overlay on the map, one at a time (issue M3-18): zoning while the zone tool is on, one from `OVERLAYS`, or none. */
  overlay: OverlayId | null;
}

export const useUi = create<UiState>(() => ({
  debugOpen: false,
  logOpen: false,
  menuOpen: false,
  settingsOpen: false,
  windows: [],
  statsOpen: false,
  statsSeries: "population",
  statsRange: 10,
  lastCommand: null,
  fileNote: null,
  fileProblem: null,
  storageNote: null,
  reminderDismissed: false,
  busy: false,
  undoNote: null,
  overlay: null,
  ...INITIAL_ROAD_TOOL,
  ...INITIAL_GRID_TOOL,
  ...INITIAL_EDIT_TOOL,
  ...INITIAL_BULLDOZE_TOOL,
  ...INITIAL_ROUTE_TOOL,
  ...INITIAL_BLOCK_OVERLAY,
  ...INITIAL_ZONE_TOOL,
}));

/** Which flag in the store says each panel is open. */
const OPEN_FLAG = {
  settings: "settingsOpen",
  city: "menuOpen",
  stats: "statsOpen",
  log: "logOpen",
  debug: "debugOpen",
} as const satisfies Record<PanelId, keyof UiState>;

/** Opens or closes panel `id`, keeping the order Escape closes them in. */
export function setPanel(id: PanelId, open: boolean): void {
  useUi.setState((s) => (s[OPEN_FLAG[id]] === open ? {} : { [OPEN_FLAG[id]]: open, windows: stacked(s.windows, id, open) }));
}

export function togglePanel(id: PanelId): void {
  setPanel(id, !useUi.getState()[OPEN_FLAG[id]]);
}

/** Panel `id`'s place in the column under the top bar's buttons, as a CSS `order` (windows.ts). */
export function usePanelOrder(id: PanelId): number {
  return useUi((s) => columnOrder(s.windows, id));
}

export const toggleDebug = (): void => togglePanel("debug");
export const toggleLog = (): void => togglePanel("log");
export const toggleMenu = (): void => togglePanel("city");
export const toggleStats = (): void => togglePanel("stats");
export const toggleSettings = (): void => togglePanel("settings");

/** Turns overlay `id` on, putting away the one showing, or off again (overlays.ts, `toggledOverlay`). */
export function toggleOverlay(id: OverlayEntry["id"]): void {
  useUi.setState((s) => ({ overlay: toggledOverlay(s.overlay, id, s.tool) }));
}

// A tool and its menu is a window too: picking one puts it on top.
useUi.subscribe((s, prev) => {
  if (s.tool === prev.tool) return;
  const windows = stackedForTool(s.windows, s.tool, prev.tool);
  if (windows !== s.windows) useUi.setState({ windows });
});

/** Puts series `id` on the statistics panel's graph. */
export function setStatsSeries(id: string): void {
  useUi.setState({ statsSeries: id });
}

export function setStatsRange(range: StatRange): void {
  useUi.setState({ statsRange: range });
}

/** What the renderer and camera report, as text, for the debug panel. */
export interface ViewReadout {
  backend: string;
  frame: string;
  draws: string;
  camPosition: string;
  camHeight: string;
  zoomBand: string;
  cursor: string;
  pick: string;
  /** Road meshes drawn, and how many chunks the last road change rebuilt. */
  roads: string;
  roadRebuilds: string;
  /** Zoning cells drawn, and how many chunks the last cell change rebuilt. */
  cells: string;
  cellRebuilds: string;
  /** Buildings drawn, and what the last change of buildings wrote. */
  buildings: string;
  buildingUpdates: string;
  /** What each level of detail drew in the last frame: buildings and meshes, each mesh one draw call (issue M2-13). */
  buildingForms: string;
}

export const useViewReadout = create<ViewReadout>(() => ({
  backend: "starting",
  frame: "-",
  draws: "-",
  camPosition: "-",
  camHeight: "-",
  zoomBand: "-",
  cursor: "-",
  pick: "none",
  roads: "-",
  roadRebuilds: "-",
  cells: "-",
  cellRebuilds: "-",
  buildings: "-",
  buildingUpdates: "-",
  buildingForms: "-",
}));

/**
 * Updates readouts that changed. Called every frame, so it skips the store
 * when nothing did.
 */
export function setViewReadout(next: Partial<ViewReadout>): void {
  const current = useViewReadout.getState();
  for (const key of Object.keys(next) as (keyof ViewReadout)[]) {
    if (next[key] !== current[key]) {
      useViewReadout.setState(next);
      return;
    }
  }
}

/**
 * What the road tool shows next to the cursor: the pointer in CSS pixels
 * over the canvas and the preview there, or null when the tool shows
 * nothing. Updated every frame the pointer or the preview changes, so it is
 * its own store and only the readout re-renders.
 */
export interface RoadHover {
  x: number;
  y: number;
  preview: RoadPreview | null;
  /** Where the cursor snapped, for the angle in the readout. */
  snap?: Snap | null;
}

export const useRoadHover = create<{ hover: RoadHover | null }>(() => ({ hover: null }));

export function setRoadHover(hover: RoadHover | null): void {
  const current = useRoadHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.preview === hover.preview && sameSnap(current.snap, hover.snap)) return;
  useRoadHover.setState({ hover });
}

function sameSnap(a: Snap | null | undefined, b: Snap | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.x === b.x && a.z === b.z && a.angle === b.angle && a.square === b.square;
}

/**
 * What the bulldoze or upgrade tool shows next to the cursor: the pointer in
 * CSS pixels over the canvas and the edit under it, or null when it shows
 * nothing. Its own store, like the road readout's.
 */
export interface EditHover {
  x: number;
  y: number;
  preview: EditPreview;
}

export const useEditHover = create<{ hover: EditHover | null }>(() => ({ hover: null }));

export function setEditHover(hover: EditHover | null): void {
  const current = useEditHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.preview === hover.preview) return;
  useEditHover.setState({ hover });
}

/**
 * The bulldozer's price tag (issue 116): where it stands on screen, CSS
 * pixels over the canvas, above the target, and what it says. Null when the
 * tool shows nothing. Its own store, like the readouts beside the cursor.
 */
export interface BulldozeHover {
  x: number;
  y: number;
  preview: BulldozePreview;
}

export const useBulldozeHover = create<{ hover: BulldozeHover | null }>(() => ({ hover: null }));

export function setBulldozeHover(hover: BulldozeHover | null): void {
  const current = useBulldozeHover.getState().hover;
  if (current === hover) return;
  if (current && hover && Math.round(current.x) === Math.round(hover.x) && Math.round(current.y) === Math.round(hover.y) && current.preview === hover.preview) return;
  useBulldozeHover.setState({ hover });
}

/**
 * What the zone tool shows next to the cursor: the pointer in CSS pixels
 * over the canvas and what a click would paint there, or null when it shows
 * nothing. Its own store, like the road readout's.
 */
export interface ZoneHoverReadout {
  x: number;
  y: number;
  preview: ZonePreview;
  /** Why no building type fits on the free ground under the pointer, when the overlay marks it there (issue M2-15). */
  lotNote?: string | null;
}

export const useZoneHover = create<{ hover: ZoneHoverReadout | null }>(() => ({ hover: null }));

export function setZoneHover(hover: ZoneHoverReadout | null): void {
  const current = useZoneHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.preview === hover.preview && current.lotNote === hover.lotNote) return;
  useZoneHover.setState({ hover });
}

/**
 * The building under the pointer while no tool is on (issue M2-15): the
 * pointer in CSS pixels over the canvas and the building, or null when
 * there is none. Its own store, like the road readout's. The bulldozer's
 * price tag (issue 116) shows the same lines.
 */
export interface BuildingHover {
  x: number;
  y: number;
  building: BuildingInfo;
  /** Who is in it, from the mirror (issue M3-17). */
  occupants: Occupants;
  /** How its ground is zoned against what it was built under (M3-14), or null when not known. */
  ground: BuildingGround | null;
}

export const useBuildingHover = create<{ hover: BuildingHover | null }>(() => ({ hover: null }));

export function setBuildingHover(hover: BuildingHover | null): void {
  const current = useBuildingHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.building === hover.building && current.occupants === hover.occupants && current.ground === hover.ground) return;
  useBuildingHover.setState({ hover });
}

/**
 * The land under the pointer while the land value overlay is on (issue
 * M3-18): the pointer in CSS pixels over the canvas, the cell's value and
 * its parts, and the type of road the cell fronts. Its own store, like the
 * road readout's.
 */
export interface LandValueHover {
  x: number;
  y: number;
  value: LandValue;
  roadType: number;
}

export const useLandValueHover = create<{ hover: LandValueHover | null }>(() => ({ hover: null }));

export function setLandValueHover(hover: LandValueHover | null): void {
  const current = useLandValueHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.value === hover.value) return;
  useLandValueHover.setState({ hover });
}

/** A block's area label on screen: CSS pixels over the canvas. */
export interface BlockLabel {
  id: number;
  x: number;
  y: number;
  area: number;
}

/**
 * Where the block overlay's area labels sit on screen, worked out each frame
 * the camera or the blocks change. Its own store, like the readouts beside
 * the cursor, so only the labels re-render.
 */
export const useBlockLabels = create<{ labels: readonly BlockLabel[] }>(() => ({ labels: [] }));

export function setBlockLabels(labels: readonly BlockLabel[]): void {
  const current = useBlockLabels.getState().labels;
  if (current.length === labels.length && current.every((l, i) => sameLabel(l, labels[i]))) return;
  useBlockLabels.setState({ labels });
}

function sameLabel(a: BlockLabel, b: BlockLabel | undefined): boolean {
  return !!b && a.id === b.id && a.area === b.area && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

/**
 * The graphics preset. Kept per browser by main.ts, never in sim state. The
 * player's choice and the benchmark's set `wanted`; the renderer moves
 * `shown` to it once the shaders it needs are compiled.
 */
export interface GraphicsState {
  wanted: Preset;
  /** The preset on screen, or null before the first frame with terrain. */
  shown: Preset | null;
  source: PresetSource;
  /**
   * The first-run benchmark: `ms` per draw and the preset it picked, from
   * this visit or the one it ran on. `running` while it runs.
   */
  benchmark: { state: "none" | "running" | "done"; ms: number | null; backend: string | null; thisVisit: boolean };
}

export const useGraphics = create<GraphicsState>(() => ({
  wanted: DEFAULT_PRESET,
  shown: null,
  source: "benchmark",
  benchmark: { state: "none", ms: null, backend: null, thisVisit: false },
}));

/** The sound settings, kept per browser by main.ts, never in sim state. */
export const useSound = create<SoundSettings>(() => ({ ...DEFAULT_SOUND }));
