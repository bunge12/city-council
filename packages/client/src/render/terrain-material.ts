// Terrain colour, in TSL so the same material compiles to WGSL on WebGPU and
// GLSL on the WebGL 2 fallback. Readable, not pretty: colour says height and
// steepness. Fertile land and ore are not drawn: as hard 0 or 1 patches they
// spotted the map, so they wait for a resources overlay. Forest shows as
// trees (decor.ts) near the camera, and further out, where trees are not
// drawn, as a canopy colour read from the forest mask through a filtered
// texture, so its edges are soft at every level of detail.

import { attribute, cameraPosition, clamp, float, vec2, vec3, mix, normalWorld, positionWorld, smoothstep, texture, uniform } from "three/tsl";
import { Color, DataTexture, LinearFilter, MeshLambertNodeMaterial, RedFormat, UnsignedByteType } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { Terrain } from "@city-council/sim";
import { DECOR } from "./config";

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

/** Samples each side of a texel the forest mask is averaged over, so a forest's outline is a curve and not 16 m steps. */
const FOREST_BLUR = 2;

/**
 * The forest mask as a one-channel texture, one texel per height sample.
 * Each texel is the share of forest in the (2 * FOREST_BLUR + 1) square
 * around its sample, and the texture filters linearly, so a forest's edge is
 * a smooth line rather than the staircase a 0 or 1 mask draws.
 */
export function forestTexture(terrain: Terrain): DataTexture {
  const n = terrain.samples;
  const r = FOREST_BLUR;
  // A box blur in two passes, rows then columns, clamped at the map edge.
  const rows = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += terrain.forest[j * n + Math.min(Math.max(i + d, 0), n - 1)] ?? 0;
      rows[j * n + i] = sum;
    }
  }
  const data = new Uint8Array(n * n);
  const cells = (2 * r + 1) * (2 * r + 1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += rows[Math.min(Math.max(j + d, 0), n - 1) * n + i] ?? 0;
      data[j * n + i] = Math.round((sum / cells) * 255);
    }
  }
  const t = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
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

  // The canopy stand-in: forest takes the canopy colour where its trees are
  // too far away to draw, fading in as they fade out.
  const canopy = DECOR.canopy;
  const far = smoothstep(canopy.fadeFrom, canopy.fadeTo, cameraPosition.distance(positionWorld));
  // Sample (i, j) sits at world (i * spacing, j * spacing), the centre of texel (i, j).
  const n = terrain.samples;
  const uv = vec2(positionWorld.x, positionWorld.z).div(terrain.spacing).add(0.5).div(n);
  const forestMap = forestTexture(terrain);
  // The blurred mask is a gentle ramp across the edge; this firms it up
  // again around the half-way line, where the mask's own edge was.
  const forest = smoothstep(0.3, 0.7, texture(forestMap, uv).r);
  land = mix(land, rgb(canopy.colour), forest.mul(far).mul(canopy.cover));

  const bed = mix(rgb(PALETTE.wetSand), rgb(PALETTE.deep), smoothstep(0, BANDS.deepAt, above.negate()));
  const underwater = float(1).sub(smoothstep(-0.5, 0, above));

  const material = new MeshLambertNodeMaterial();
  material.colorNode = mix(land, bed, underwater);
  material.name = "terrain";
  material.addEventListener("dispose", () => forestMap.dispose());
  return material;
}
