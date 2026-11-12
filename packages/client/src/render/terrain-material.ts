// Terrain colour, in TSL so the same material compiles to WGSL on WebGPU and
// GLSL on the WebGL 2 fallback. Readable, not pretty: colour says height and
// steepness. The resource masks are not drawn here: as hard 0 or 1 patches
// they spotted the map. Forest shows as trees (decor.ts); fertile land and
// ore wait for a resources overlay.

import { attribute, clamp, float, vec3, mix, normalWorld, smoothstep, uniform } from "three/tsl";
import { Color, MeshLambertNodeMaterial } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { Terrain } from "@city-council/sim";

/** Vertex attribute holding the surface height a vertex belongs to. See `ChunkGeometry`. */
export const SURFACE_HEIGHT_ATTRIBUTE = "surfaceHeight";

/** Colours of the terrain, as hex. */
const PALETTE = {
  deep: 0x2f4f5f,
  wetSand: 0xb09a6a,
  sand: 0xd9cb9b,
  grass: 0x86a95c,
  upland: 0x8f9a6a,
  rock: 0x8a8078,
  snow: 0xf1f1ee,
};

/** Heights above the water surface, in metres, where colour bands change. */
const BANDS = {
  beachTop: 3,
  uplandFrom: 140,
  uplandTo: 280,
  snowFrom: 340,
  snowTo: 420,
  /** Water depth at which the bed reaches the deep colour. */
  deepAt: 25,
};

/** normal.y below which ground reads as rock. 0.85 is about 32 degrees. */
const ROCK_NORMAL_Y = { from: 0.78, to: 0.88 };

/** A palette colour as a vec3 node, so mixes stay one type. */
function rgb(hex: number): Node<"vec3"> {
  // Color converts from sRGB to the linear working space.
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** Builds the terrain material for a map. */
export function createTerrainMaterial(terrain: Terrain): MeshLambertNodeMaterial {
  const waterLevel = uniform(terrain.waterLevel);
  // Colour follows the surface height, not the fragment's own, so skirts
  // take the colour of the edge they hang from.
  const above = attribute<"float">(SURFACE_HEIGHT_ATTRIBUTE, "float").sub(waterLevel);
  const up = clamp(normalWorld.y, 0, 1);

  let land: Node<"vec3"> = rgb(PALETTE.grass);
  land = mix(land, rgb(PALETTE.upland), smoothstep(BANDS.uplandFrom, BANDS.uplandTo, above));
  land = mix(rgb(PALETTE.sand), land, smoothstep(0, BANDS.beachTop, above));
  const steep = float(1).sub(smoothstep(ROCK_NORMAL_Y.from, ROCK_NORMAL_Y.to, up));
  land = mix(land, rgb(PALETTE.rock), steep);
  land = mix(land, rgb(PALETTE.snow), smoothstep(BANDS.snowFrom, BANDS.snowTo, above).mul(up));

  const bed = mix(rgb(PALETTE.wetSand), rgb(PALETTE.deep), smoothstep(0, BANDS.deepAt, above.negate()));
  const underwater = float(1).sub(smoothstep(-0.5, 0, above));

  const material = new MeshLambertNodeMaterial();
  material.colorNode = mix(land, bed, underwater);
  material.name = "terrain";
  return material;
}
