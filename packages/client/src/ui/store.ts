// UI state, in Zustand. Only what the page itself owns lives here: which
// panels are open, notes to the player and readouts from the renderer. Sim
// state is never copied in. Components read it from the SimMirror through
// `useSim` (hooks.ts) and change it only by sending commands.

import { create } from "zustand";
import { DEFAULT_PRESET } from "../render/config";
import type { Preset, PresetSource } from "../render/presets";
import { INITIAL_BLOCK_OVERLAY, type BlockOverlayState } from "../tools/block-overlay";
import { INITIAL_EDIT_TOOL, type EditPreview, type EditToolState } from "../tools/edit-tool";
import { INITIAL_GRID_TOOL, type GridToolState } from "../tools/grid-tool";
import { INITIAL_ROAD_TOOL, type RoadPreview, type RoadToolState } from "../tools/road-tool";
import { INITIAL_ROUTE_TOOL, type RouteToolState } from "../tools/route-tool";
import type { Snap } from "../tools/snap";

export interface UiState extends RoadToolState, GridToolState, EditToolState, RouteToolState, BlockOverlayState {
  debugOpen: boolean;
  logOpen: boolean;
  menuOpen: boolean;
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
  /** Whether the zoning overlay is on (issue M2-06). The zone tool turns it on from issue M2-07. */
  zoningOverlay: boolean;
}

export const useUi = create<UiState>(() => ({
  debugOpen: false,
  logOpen: false,
  menuOpen: false,
  lastCommand: null,
  fileNote: null,
  fileProblem: null,
  storageNote: null,
  reminderDismissed: false,
  busy: false,
  undoNote: null,
  zoningOverlay: false,
  ...INITIAL_ROAD_TOOL,
  ...INITIAL_GRID_TOOL,
  ...INITIAL_EDIT_TOOL,
  ...INITIAL_ROUTE_TOOL,
  ...INITIAL_BLOCK_OVERLAY,
}));

export function toggleDebug(): void {
  useUi.setState((s) => ({ debugOpen: !s.debugOpen }));
}

export function toggleLog(): void {
  useUi.setState((s) => ({ logOpen: !s.logOpen }));
}

export function toggleZoningOverlay(): void {
  useUi.setState((s) => ({ zoningOverlay: !s.zoningOverlay }));
}

export function toggleMenu(): void {
  useUi.setState((s) => ({ menuOpen: !s.menuOpen }));
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
