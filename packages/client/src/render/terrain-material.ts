// Terrain colour, in TSL so the same material compiles to WGSL on WebGPU and
// GLSL on the WebGL 2 fallback. Readable, not pretty: colour says height,
// steepness and what grows or lies there.

import { attribute, clamp, float, vec3, mix, normalWorld, positionWorld, smoothstep, texture, uniform, vec2 } from "three/tsl";
import { Color, DataTexture, LinearFilter, MeshLambertNodeMaterial, RGBAFormat, UnsignedByteType } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { Terrain } from "@city-council/sim";
import { resourceTexels } from "./terrain-chunks";

/** Vertex attribute holding the surface height a vertex belongs to. See `ChunkGeometry`. */
export const SURFACE_HEIGHT_ATTRIBUTE = "surfaceHeight";

/** Colours of the terrain, as hex. */
const PALETTE = {
  deep: 0x2f4f5f,
  wetSand: 0xb09a6a,
  sand: 0xd9cb9b,
  grass: 0x86a95c,
  fertile: 0xc4bb62,
  forest: 0x3f6a3a,
  upland: 0x8f9a6a,
  rock: 0x8a8078,
  ore: 0xa0603e,
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

/** Builds the resource-mask texture and the terrain material that reads it. */
export function createTerrainMaterial(terrain: Terrain): MeshLambertNodeMaterial {
  const n = terrain.samples;
  const masks = new DataTexture(resourceTexels(terrain), n, n, RGBAFormat, UnsignedByteType);
  masks.magFilter = LinearFilter;
  masks.minFilter = LinearFilter;
  masks.generateMipmaps = false;
  masks.flipY = false;
  masks.needsUpdate = true;

  const waterLevel = uniform(terrain.waterLevel);
  const spacing = float(terrain.spacing);
  const samples = float(n);

  // Sample (i, j) sits at x = i * spacing, so its texel centre is (i + 0.5) / n.
  const uv = vec2(positionWorld.x, positionWorld.z).div(spacing).add(0.5).div(samples);
  const mask = texture(masks, uv);
  // Colour follows the surface height, not the fragment's own, so skirts
  // take the colour of the edge they hang from.
  const above = attribute<"float">(SURFACE_HEIGHT_ATTRIBUTE, "float").sub(waterLevel);
  const up = clamp(normalWorld.y, 0, 1);

  let land: Node<"vec3"> = rgb(PALETTE.grass);
  land = mix(land, rgb(PALETTE.fertile), mask.r);
  land = mix(land, rgb(PALETTE.forest), mask.g);
  land = mix(land, rgb(PALETTE.upland), smoothstep(BANDS.uplandFrom, BANDS.uplandTo, above));
  land = mix(rgb(PALETTE.sand), land, smoothstep(0, BANDS.beachTop, above));
  const steep = float(1).sub(smoothstep(ROCK_NORMAL_Y.from, ROCK_NORMAL_Y.to, up));
  land = mix(land, rgb(PALETTE.rock), steep);
  land = mix(land, rgb(PALETTE.ore), mask.b.mul(0.75));
  land = mix(land, rgb(PALETTE.snow), smoothstep(BANDS.snowFrom, BANDS.snowTo, above).mul(up));

  const bed = mix(rgb(PALETTE.wetSand), rgb(PALETTE.deep), smoothstep(0, BANDS.deepAt, above.negate()));
  const underwater = float(1).sub(smoothstep(-0.5, 0, above));

  const material = new MeshLambertNodeMaterial();
  material.colorNode = mix(land, bed, underwater);
  material.name = "terrain";
  material.addEventListener("dispose", () => masks.dispose());
  return material;
}
