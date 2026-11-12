// UI state, in Zustand. Only what the page itself owns lives here: which
// panels are open, notes to the player and readouts from the renderer. Sim
// state is never copied in. Components read it from the SimMirror through
// `useSim` (hooks.ts) and change it only by sending commands.

import { create } from "zustand";
import { INITIAL_ROAD_TOOL, type RoadPreview, type RoadToolState } from "../tools/road-tool";

export interface UiState extends RoadToolState {
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
  ...INITIAL_ROAD_TOOL,
}));

export function toggleDebug(): void {
  useUi.setState((s) => ({ debugOpen: !s.debugOpen }));
}

export function toggleLog(): void {
  useUi.setState((s) => ({ logOpen: !s.logOpen }));
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
}

export const useRoadHover = create<{ hover: RoadHover | null }>(() => ({ hover: null }));

export function setRoadHover(hover: RoadHover | null): void {
  const current = useRoadHover.getState().hover;
  if (current === hover) return;
  if (current && hover && current.x === hover.x && current.y === hover.y && current.preview === hover.preview) return;
  useRoadHover.setState({ hover });
}
