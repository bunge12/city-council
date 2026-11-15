// What a theme is (PRD, "Art direction"): a pack of building models and the
// palettes they are tinted from, kept apart from the sim. The renderer asks
// a theme for a model by the building's type and the model number its
// variant picks, and for the colours its id picks. The theme is the only
// place that knows where a model came from: the North American one builds
// every model in code (north-american/), and an authored model could stand
// in for any one of them without the renderer knowing.

import type { ModelArrays } from "./model";

/** The colours a building type's buildings are tinted from, as sRGB hex. */
export interface Palette {
  wall: readonly number[];
  roof: readonly number[];
  trim: readonly number[];
}

export interface Theme {
  /** A name for the debug panel. */
  name: string;
  /** How many models a type has. The sim's variant number picks one of them. Every type has at least one. */
  modelCount(typeId: string): number;
  /**
   * Model `model` of a type for a lot `widthCells` cells along the road and
   * `depthCells` cells deep, built at that size in metres, with the origin
   * at the middle of the lot and the front at +z (model.ts). The renderer
   * builds one for every width a type comes in and stretches it to a lot's
   * depth, so `depthCells` is the type's usual depth, `modelDepth`.
   */
  model(typeId: string, model: number, widthCells: number, depthCells: number): ModelArrays;
  /** The depth in cells a type's models are built at. */
  modelDepth(typeId: string): number;
  palette(typeId: string): Palette;
  /** Colours no building tints: glass and paving. */
  fixed: { glass: number; paving: number };
}
