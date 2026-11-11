import { ZOOM_BANDS } from "./config";

/** What the camera's height says about how much detail to draw. See the PRD, "Zoom bands". */
export type ZoomBand = "street" | "district" | "city";

/** The zoom band for a camera `height` metres above the ground below it. */
export function zoomBand(height: number, bands: { streetBelow: number; districtBelow: number } = ZOOM_BANDS): ZoomBand {
  if (height < bands.streetBelow) return "street";
  if (height < bands.districtBelow) return "district";
  return "city";
}
