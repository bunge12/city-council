// Geometry for the road tool's previews: a flat strip as wide as the road
// type, laid on the ground with a cross-section at most every
// `ROADS.sampleStep` metres like the real roads, and a disc where the road
// would meet another. No three.js here, so it can be tested in Node.

import { heightAt, type Terrain } from "@city-council/sim";
import { ROADS, ROAD_PREVIEW } from "./config";
import { linearRgb, stations } from "./road-geometry";

/** How a preview is drawn: buildable, refused, or sent and waiting for the sim. */
export type PreviewLook = "ok" | "refused" | "pending";

export interface PreviewShape {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Kerb to kerb, metres. */
  width: number;
  look: PreviewLook;
  /** Where the road would meet another road. */
  junctions: readonly { x: number; z: number }[];
}

export interface PreviewArrays {
  positions: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
}

/** A stable text key for a list of shapes, so the mesh rebuilds only when one changes. */
export function previewKey(shapes: readonly PreviewShape[]): string {
  return shapes
    .map((s) => `${s.ax},${s.az},${s.bx},${s.bz},${s.width},${s.look};${s.junctions.map((j) => `${j.x},${j.z}`).join(";")}`)
    .join("|");
}

export function buildPreviewGeometry(terrain: Terrain, shapes: readonly PreviewShape[]): PreviewArrays {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const lift = ROAD_PREVIEW.lift;
  const vertex = (x: number, z: number, rgb: readonly [number, number, number], extra = 0): number => {
    positions.push(x, heightAt(terrain, x, z) + lift + extra, z);
    colours.push(rgb[0], rgb[1], rgb[2]);
    return positions.length / 3 - 1;
  };

  for (const shape of shapes) {
    const rgb = linearRgb(ROAD_PREVIEW.colours[shape.look]);
    const dx = shape.bx - shape.ax;
    const dz = shape.bz - shape.az;
    const length = Math.hypot(dx, dz);
    if (length > 0) {
      const ux = dx / length;
      const uz = dz / length;
      // Left of the direction of travel, in plan.
      const half = shape.width / 2;
      const lx = uz * half;
      const lz = -ux * half;
      let previous: [number, number] | null = null;
      for (const t of stations(shape.ax, shape.az, ux, uz, 0, length, ROADS.sampleStep)) {
        const cx = shape.ax + ux * t;
        const cz = shape.az + uz * t;
        const left = vertex(cx + lx, cz + lz, rgb);
        const right = vertex(cx - lx, cz - lz, rgb);
        if (previous) indices.push(previous[0], previous[1], left, previous[1], right, left);
        previous = [left, right];
      }
    }
    const marker = linearRgb(ROAD_PREVIEW.colours.junction);
    const radius = shape.width * ROAD_PREVIEW.junctionScale;
    for (const j of shape.junctions) disc(j.x, j.z, radius, marker);
  }

  function disc(x: number, z: number, radius: number, rgb: readonly [number, number, number]): void {
    const sides = ROAD_PREVIEW.junctionSides;
    // A little higher than the strip, so the marker reads over it.
    const centre = vertex(x, z, rgb, ROAD_PREVIEW.junctionLift);
    const first = positions.length / 3;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      vertex(x + Math.cos(a) * radius, z + Math.sin(a) * radius, rgb, ROAD_PREVIEW.junctionLift);
    }
    for (let k = 0; k < sides; k++) indices.push(centre, first + ((k + 1) % sides), first + k);
  }

  return {
    positions: new Float32Array(positions),
    colours: new Float32Array(colours),
    indices: new Uint32Array(indices),
  };
}
