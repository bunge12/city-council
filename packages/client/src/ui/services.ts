// What the UI can ask of the rest of the page. main.ts builds it. Components
// read sim state through the mirror and change the city only by sending
// commands, which the sim validates (CLAUDE.md rule 2).

import type { CommandResult } from "@city-council/sim";
import type { SimMirror } from "../protocol/mirror";
import type { SaveStatus } from "../save/channel";
import type { SaveClient } from "../save/page";
import type { RoadToolController } from "../tools/road-tool";

/** What a download wrote, for the page and Playwright. */
export interface DownloadedCity {
  fileName: string;
  tick: number;
  /** `hashState` of the city in the file. */
  hash: string;
}

export interface AppServices {
  /** Read-only copy of sim state. */
  mirror: SimMirror;
  saves: SaveClient;
  /** Sends a command and records the sim's answer for the activity log. */
  sendCommand(type: string, payload?: unknown): Promise<CommandResult>;
  saveNow(): Promise<SaveStatus>;
  downloadCity(): Promise<DownloadedCity>;
  /** Imports a city file and reloads to open it, or reports why not. */
  importCityFile(file: File): Promise<void>;
  /** Starts a new city from `seed` and reloads to open it, or reports why not. */
  newCity(name: string, seed: number): Promise<void>;
  /** Reloads into saved city `id`, or reports why not. */
  openCity(id: string): Promise<void>;
  /** The road tool's input handling. Its state is in the UI store. */
  roadTool: RoadToolController;
}
