// Buildings on screen (issues M2-12 and M2-13): every building in the
// mirror, in one of four forms by how far out the camera is (PRD, "Zoom
// bands"; building-lod.ts):
// - full: one instanced mesh per model, with the building's tint as data on
//   its instance. Only for chunks near the camera in the street band. A
//   chunk that leaves frees its instances.
// - simple: each building's model without its small parts and paving,
//   merged into one mesh per chunk and drawn with the full models' window
//   patterns and colours. Chunks within `BUILDINGS.simpleRadius` in the
//   street and district bands, beyond the full form's reach. A chunk that
//   leaves frees it.
// - box: a plain box per building in its wall and roof colours, one mesh per
//   chunk, in the simple form's vertex format and material. Chunks further
//   out in the street and district bands.
// - flat: a flat block on the ground per building, coloured by its zone and
//   density. The city band, where every chunk is in view, so the blocks of
//   `BUILDINGS.flatGroup` × `flatGroup` chunks share one mesh (issue #133),
//   built again when a building in any of them changes. Each chunk still
//   fades on its own: its vertices carry its slot in the group, and the
//   mesh carries a fade per slot.
// A chunk changing form fades from one to the next, dithered, so nothing
// pops.
//
// A model is one of a type's generator variants at one lot width, built by
// the theme (theme/). The sim's variant number picks the variant and the
// building's id picks its wall, roof and trim colours (building-tint.ts), so
// neither depends on this page. A model is built the first time a building
// needs it, since its simplified copy is what the simple form draws. A lot deeper or
// shallower than the model's, or bent on a curve, stretches the model back
// from the road; the shader takes the stretch out of the window pattern, so
// windows keep their rhythm.
//
// Buildings are filed by the 500 m chunk the mirror puts them in. Chunks
// waiting to be read are read nearest the camera first, within a time
// budget per frame, so a snapshot fills in from the camera outward and no
// frame stalls. Reading a chunk for a delta that only added or removed
// buildings places only those buildings: adding one in a full chunk touches
// one instance. A chunk whose roads changed is placed again whole, since its
// lots may have moved. A chunk's merged meshes are built again only when a
// building in it changed, and only once the form is drawn.
//
// The renderer reads the mirror; it never writes it.

import { attribute, clamp, dot, floor, fract, fwidth, max, mix, mod, positionGeometry, positionLocal, cameraPosition, screenCoordinate, select, smoothstep, sRGBTransferEOTF, step, uniform, varying, vec2, vec3, vec4 } from "three/tsl";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type Node,
  type Object3D,
} from "three/webgpu";
import { BUILDING_TYPES, CHUNKS_PER_SIDE, CHUNK_SIZE, ZONING_BALANCE, type BuildingInfo } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { SURFACE, simplify, type ModelArrays } from "../theme/model";
import type { Theme } from "../theme/theme";
import type { Ray } from "../camera/pick";
import { rayBoxDistance, type PickBox } from "./building-pick";
import { placeLot, type Placement } from "./building-place";
import {
  FLAT_GROUPS_PER_SIDE,
  FLAT_SLOTS,
  chunkDistance,
  draws,
  fadeOf,
  flatGroupOf,
  flatSlotOf,
  flatSlots,
  formFor,
  isNear,
  mergeBoxes,
  mergeFlats,
  mergeModels,
  KINDS,
  mergedRise,
  modelExtent,
  stepFade,
  type BuildingForm,
  type ChunkFade,
  type Extent,
  type MergedArrays,
  type MergedItem,
} from "./building-lod";
import { MASK_GRASS, MASK_SIDE, MASK_TREES } from "./road-geometry";
import { BUILDINGS, CELLS, CONSTRUCTION, ROADS } from "./config";
import { STYLES, lookFor, tintFor } from "./building-tint";
import { LONG_AGO, finishedAt, riseNode, rising, scaffoldGeometry, scaffoldMaterial, tickUniform, underConstruction } from "./construction";

/** Where the layer reads buildings from: the mirror's copy of state. */
export interface BuildingSource {
  /** Every building whose lot's centre is in the chunk, with its lot's corners. Empty before the first snapshot. */
  buildingsInChunk(chunk: number): BuildingInfo[];
  /** The chunk building `id`'s lot's centre is in, or -1 if there is no such building or lot. */
  buildingChunk(id: number): number;
}

/** What one form draws in the last frame: chunks, buildings and meshes, each mesh one draw call. */
export interface FormStats {
  chunks: number;
  buildings: number;
  meshes: number;
}

/** What the layer reports, for the debug panel and tests. */
export interface BuildingStats {
  /** Buildings the layer knows, in whatever form. */
  buildings: number;
  /** Models built. Each is one instanced mesh while a building near the camera uses it. */
  models: number;
  /** Chunks waiting to be read. */
  pending: number;
  /**
   * Instances written and chunks rebuilt by the last change, counted from
   * when chunks started waiting until none were left, and in all since the
   * layer was made. The writes of a frame that read chunks include the
   * instances its forms wrote, so a building that comes to a chunk with
   * none, written when that chunk is filled, is counted. A chunk is rebuilt when every building in it is placed
   * again, after a snapshot or a change of its roads; a delta that only
   * adds or removes buildings rebuilds none. `lastBuildMs` is the time the
   * last change took, summed over the frames it was spread across.
   */
  lastWrites: number;
  totalWrites: number;
  lastRebuilt: number;
  totalRebuilt: number;
  lastBuildMs: number;
  /** Merged meshes, simple buildings and flat blocks, built in the last frame that built any, and in all. */
  lastMerged: number;
  totalMerged: number;
  /** Bytes of geometry the merged meshes held now, by form: vertices and indices, which the GPU holds a copy of too. */
  mergedBytes: Record<Merged, number>;
  /** What each form drew in the last frame, counting only meshes in the camera's view. */
  forms: Record<BuildingForm, FormStats>;
  /** Chunks fading from one form to another, and chunks waiting for the form they want to be built. */
  fading: number;
  waiting: number;
  /**
   * Buildings under construction the layer knows, and those of them drawing
   * scaffolding: in full, near the camera in the street band. The
   * scaffolding is one instanced mesh, one draw call.
   */
  building: number;
  scaffolds: number;
}

/** Where the camera is, for the layer's frame work. */
export interface BuildingView {
  band: ZoomBand;
  /** Seconds since the last frame, for the fades. */
  seconds: number;
  /** The camera's view, to count what is drawn. Without it every mesh counts. */
  frustum?: Frustum;
  /**
   * The game tick on screen, for buildings under construction (issue 136,
   * construction.ts). Without it every building is drawn finished.
   */
  tick?: number;
}

export interface BuildingLayer {
  /** Every chunk may have changed, as after a snapshot. Rebuilds them all, nearest the camera first. */
  reset(): void;
  /** The roads of these chunks changed: every building in them is placed again. */
  rebuild(chunks: readonly number[]): void;
  /** Buildings came or went in these chunks: only those are written. */
  apply(chunks: readonly number[]): void;
  /**
   * These buildings came, went or changed, in chunks not known yet: the
   * chunks they are drawn in and the ones the mirror puts them in now are
   * brought up to date, as `apply` does, on the next update.
   */
  applyIds(ids: readonly number[]): void;
  /**
   * Called once a frame: reads waiting chunks, nearest the camera at (x, z)
   * first, then moves each chunk towards the form `view` wants for it, all
   * in about `budgetMs`. Without `view`, the street band with no fades.
   */
  update(camera: { x: number; z: number }, budgetMs: number, view?: BuildingView): void;
  /**
   * True when nothing is left to read and every chunk shows the form it
   * wanted at the last update, built from its buildings as they are now,
   * with no fade under way. The forms built ahead for a later zoom do not
   * count.
   */
  idle(): boolean;
  /**
   * The chunks a lot that a building came onto or left since the last call
   * reaches, with the ground round it kept clear of trees. A lot can reach
   * over a chunk line, so the zoning overlay and the decoration redraw these
   * as well as the lot's own chunk.
   */
  takeLotChunks(): number[];
  /**
   * Which cells of chunk `chunk`'s decoration mask (road-geometry.ts,
   * `roadMask`) a drawn building's lot covers, so no tree or tuft of grass
   * stands in a yard or through a roof. Null when no lot reaches the chunk.
   */
  lotMask(chunk: number): Uint8Array | null;
  /** The colours building `id` is drawn in, as sRGB hex, or null if it is not drawn. For tests. */
  tintOf(id: number): { wall: number; roof: number; trim: number } | null;
  /** The form chunk `chunk` shows whole, or null. For tests. */
  formOf(chunk: number): BuildingForm | null;
  /**
   * The building whose drawn box `ray` enters first, no further than
   * `limit` along it, or -1 (issue 116): the bulldozer's pick. The page
   * passes where the ray meets the ground, so a building behind a hill is
   * not picked. A chunk drawn as flat blocks is tested as its blocks, and
   * one not drawn yet is skipped.
   * See building-pick.ts.
   */
  pick(ray: Ray, limit?: number): number;
  /** Counts the times a chunk's shown form changed, so a pick made on the old form is known to be stale. */
  formVersion(): number;
  /** The middle of the top of building `id`'s box as drawn, in world metres, or null. Where the bulldozer's price tag stands. */
  topOf(id: number): { x: number; y: number; z: number } | null;
  stats(): BuildingStats;
  dispose(): void;
}

/** How far a building's box can reach past the chunk its lot's centre is in, metres: more than the deepest through-lot. */
const PICK_CHUNK_PAD = 150;
/** Lowest and highest a building's box can reach, metres, for the chunk test before the buildings'. */
const PICK_CHUNK_Y = { min: -200, max: 2000 };
/** A flat block's box, in its frame: the blocks lie on the ground. */
const FLAT_PICK_Y = { minY: -1, maxY: 1 };

/** Instances a model's mesh has room for at first. It doubles when full. */
const FIRST_CAPACITY = 16;
const CELL = ZONING_BALANCE.cellSize;
const CHUNK_COUNT = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
/** Update ranges an attribute may carry in a frame before it is sent whole instead. */
const MAX_RANGES = 32;

/** A colour as one float: r * 65536 + g * 256 + b, exact in a float32. */
function packed(hex: number): number {
  return hex & 0xffffff;
}

/** sRGB bytes packed by `packed`, back as a linear colour. */
function unpack(p: Node<"float">) {
  const c = vec3(floor(p.div(65536)), mod(floor(p.div(256)), 256), mod(p, 256)).div(255);
  return sRGBTransferEOTF(c) as unknown as typeof c;
}

/** An sRGB hex colour as a linear vec3 uniform, as the renderer works in linear light. */
function linear(hex: number) {
  const c = new Color(hex);
  return uniform(new Vector3(c.r, c.g, c.b));
}

/** 1 where u is in [r.x, r.y] and v in [r.z, r.w], else 0. */
function insideRect(u: Node<"float">, v: Node<"float">, r: Node<"vec4">) {
  return step(r.x, u).mul(step(u, r.y)).mul(step(r.z, v)).mul(step(v, r.w));
}
/**
 * 1 where a pixel of a form with fade number `fade` (building-lod.ts,
 * `fadeOf`) is drawn and 0 where it is not, by a dither value fixed to the
 * pixel: a form fading in takes the pixels under its fade, and one fading
 * out the rest, so the two share the screen with no gap and no overlap.
 * Interleaved gradient noise, so the dither has no pattern to see.
 */
function kept(fade: Node<"float">) {
  const d = dither();
  return select(fade.lessThan(1.5), step(d, fade.sub(1e-4)), step(fade.sub(2), d));
}

/** The pixel's dither value in [0, 1), fixed to the pixel. */
function dither() {
  return fract(fract(dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/** A pane's place in its window bay, as u0, u1, v0, v1 in the bay, for each of the four window styles. */
type Rects = readonly [readonly number[], readonly number[], readonly number[], readonly number[]];

/**
 * The panes of each `FACADE` in its four styles (issue #137). Windows:
 * square, tall and narrow, wide, and in pairs, drawn on the bay folded in
 * two. Storefronts: tall panes, panes under a band of wall, panes in
 * deeper frames, and all glass. Curtain walls: a grid, bands of wall at
 * each floor, deep fins, and thin frames. Ribbons: deep, tall, narrow and
 * low. Doors have one shape.
 */
const PANES: Record<"windows" | "storefront" | "curtain" | "doors" | "bands", Rects> = {
  windows: [
    [0.27, 0.73, 0.32, 0.8],
    [0.35, 0.65, 0.2, 0.84],
    [0.14, 0.86, 0.36, 0.76],
    [0.2, 0.8, 0.3, 0.8],
  ],
  storefront: [
    [0.05, 0.95, 0.06, 0.78],
    [0.05, 0.95, 0.06, 0.6],
    [0.1, 0.9, 0.06, 0.72],
    [0.04, 0.96, 0.06, 0.82],
  ],
  curtain: [
    [0.05, 0.95, 0.05, 0.95],
    [0.04, 0.96, 0.3, 0.97],
    [0.14, 0.86, 0.02, 0.98],
    [0.03, 0.97, 0.03, 0.97],
  ],
  doors: [
    [0.1, 0.9, 0, 0.82],
    [0.1, 0.9, 0, 0.82],
    [0.1, 0.9, 0, 0.82],
    [0.1, 0.9, 0, 0.82],
  ],
  bands: [
    [0.02, 0.98, 0.34, 0.8],
    [0.02, 0.98, 0.28, 0.86],
    [0.05, 0.95, 0.38, 0.78],
    [0.02, 0.98, 0.3, 0.72],
  ],
};

/** One of four values by `style`, 0 to 3. */
function byStyle(style: Node<"float">, rects: Rects): Node<"vec4"> {
  const [a, b, c, d] = rects.map((r) => vec4(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0)) as unknown as [Node<"vec4">, Node<"vec4">, Node<"vec4">, Node<"vec4">];
  return select(style.lessThan(0.5), a, select(style.lessThan(1.5), b, select(style.lessThan(2.5), c, d)));
}

/**
 * A number in [0, 1) from a window's place, by multiplies and fractions
 * alone: a hash through `sin` bands into visible swirls where GPUs round
 * it. Drawn and never stored, so it may still differ a little from one GPU
 * to the next.
 */
function hash2(p: Node<"vec2">) {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const b = a.add(dot(a, a.yzx.add(33.33)));
  return fract(b.x.add(b.y).mul(b.z));
}

/** The glass colours a pattern needs, linear. */
interface GlassColours {
  /** One per seed in turn. */
  tints: Node<"vec3">[];
  sky: Node<"vec3">;
  blinds: Node<"vec3">;
}

function glassColours(theme: Theme): GlassColours {
  const tints = theme.fixed.glassTints.length > 0 ? theme.fixed.glassTints : [theme.fixed.glass];
  return { tints: tints.map(linear), sky: linear(theme.fixed.sky), blinds: linear(theme.fixed.blinds) };
}

/**
 * A wall's colour with its pattern drawn on, and the light its glass
 * reflects: `kind` is the vertex's `FACADE`, `along` where it is along the
 * wall in windows with the lot's stretch taken out, `up` how high in
 * floors, and `look` the building's look (building-tint.ts, `lookFor`).
 * Loading and garage doors are a darker shade of the wall; every other
 * opening is glass.
 *
 * Glass is drawn so it never reads as asphalt (issue #137): each building's
 * windows take one of the theme's glass tints, each pane a little lighter
 * or darker than the next, lighter again towards its top where it reflects
 * the sky, and a few panes with a blind part way down. The reflection is
 * emitted, not lit, so windows on a wall in shadow still show.
 */
function patterned(colour: Node<"vec3">, glass: GlassColours, kind: Node<"float">, along: Node<"float">, up: Node<"float">, look: Node<"float">) {
  // Whole numbers first: the look reaches the fragment a hair either side
  // of its value, and a floor on it then flips from pixel to pixel.
  const whole = floor(look.add(0.5));
  const seed = floor(whole.add(0.5).div(STYLES));
  const style = whole.sub(seed.mul(STYLES));
  const bay = along.add(0.5);
  // Paired windows are the window bay folded in two.
  const u = fract(select(kind.lessThan(1.5).and(style.greaterThan(2.5)), bay.mul(2), bay));
  const v = fract(up);
  const rect = select(
    kind.lessThan(1.5),
    byStyle(style, PANES.windows),
    select(kind.lessThan(2.5), byStyle(style, PANES.storefront), select(kind.lessThan(3.5), byStyle(style, PANES.curtain), select(kind.lessThan(4.5), byStyle(style, PANES.doors), byStyle(style, PANES.bands)))),
  );
  // Where a window bay or a floor comes to less than a couple of pixels, the
  // panes fade to the share of the wall they cover, so a far facade has no
  // moiré.
  const blur = smoothstep(0.25, 0.6, max(fwidth(select(kind.lessThan(1.5).and(style.greaterThan(2.5)), bay.mul(2), bay)), fwidth(up)));
  const cover = rect.y.sub(rect.x).mul(rect.w.sub(rect.z));
  const pane = select(kind.lessThan(0.5), 0, mix(insideRect(u, v, rect), cover, blur));
  // Each pane's shade, and whether it has a blind, from where it is and the building's seed.
  const cell = vec2(floor(bay), floor(up)).add(vec2(seed.mul(17.3), seed.mul(5.9)));
  const shade = hash2(cell);
  const blind = hash2(cell.add(vec2(41.7, 13.1)));
  // How far up the pane, 0 at its sill and 1 at its head.
  const high = clamp(v.sub(rect.z).div(rect.w.sub(rect.z)), 0, 1);
  let tint = glass.tints[0] as Node<"vec3">;
  const pick = seed.sub(floor(seed.add(0.5).div(glass.tints.length)).mul(glass.tints.length));
  for (let k = 1; k < glass.tints.length; k++) tint = select(pick.greaterThan(k - 0.5), glass.tints[k] as Node<"vec3">, tint);
  const lit = tint.mul(shade.mul(BUILDINGS.glass.variation).add(1 - BUILDINGS.glass.variation / 2));
  const reflected = mix(lit, glass.sky, high.mul(high).mul(BUILDINGS.glass.skyMix));
  // Fewer blinds behind a glass wall, where a pane is a whole storey.
  const share = select(kind.greaterThan(2.5).and(kind.lessThan(3.5)), BUILDINGS.glass.blindShare / 3, BUILDINGS.glass.blindShare);
  const drawn = step(share.oneMinus(), blind).mul(step(fract(blind.mul(7)).mul(0.5).add(0.3), high.oneMinus()).oneMinus());
  const paneColour = mix(reflected, glass.blinds, drawn.mul(0.85));
  const door = kind.greaterThan(3.5).and(kind.lessThan(4.5));
  const opening = select(door, colour.mul(0.6), paneColour);
  const glassy = select(door, 0, pane);
  return {
    colour: mix(colour, opening, pane),
    emissive: glass.sky.mul(glassy.mul(drawn.oneMinus()).mul(high.mul(0.6).add(0.4)).mul(BUILDINGS.glass.reflection)),
  };
}

/**
 * The buildings' material: lit like the terrain and the trees, so it takes
 * the preset's sun, fill and shadows (lighting.ts). Each surface takes its
 * colour from the instance's tints or the theme, and walls draw their
 * pattern from the vertex's place on the facade (theme/model.ts).
 */
function buildingMaterial(theme: Theme, tick: Node<"float">): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial();
  m.name = "buildings";
  const surface = attribute<"float">("buildingSurface", "float");
  const facade = attribute<"vec4">("buildingFacade", "vec4");
  // The wall, roof and trim colours, packed, and the building's look.
  const tint = attribute<"vec4">("buildingTint", "vec4");
  const stretch = attribute<"vec2">("buildingScale", "vec2");
  const fade = varying(attribute<"float">("buildingFade", "float"));
  // When the building was built, how tall its model is above the ground, and where the bottom of its foundations is, for its construction (construction.ts).
  const built = attribute<"vec3">("buildingBuilt", "vec3");
  const rise = rising(tick, built.x, built.y, positionGeometry.y.sub(built.z));
  const glass = linear(theme.fixed.glass);
  const pave = linear(theme.fixed.paving);
  // Unpacked per vertex: the packed number is exact there, and the same at
  // every vertex of an instance, so the colours reach the fragments whole.
  const wall = varying(unpack(tint.x));
  const roof = varying(unpack(tint.y));
  const trim = varying(unpack(tint.z));
  const colour = select(surface.lessThan(0.5), wall, select(surface.lessThan(1.5), roof, select(surface.lessThan(2.5), trim, select(surface.lessThan(3.5), glass, pave))));
  // Windows along the wall, in the lot's metres: the stretch of this instance along the wall's axis is taken out.
  const along = facade.x.mul(select(facade.z.lessThan(0.5), stretch.x, stretch.y));
  const pattern = patterned(colour, glassColours(theme), facade.w, along, facade.y, tint.w);
  m.colorNode = pattern.colour;
  m.emissiveNode = pattern.emissive;
  // After the instance's matrix, which turns about y only, so down is down.
  m.positionNode = positionLocal.sub(vec3(0, rise.sink, 0));
  // A mask and not an opacity: three.js reads it in the shadow pass too, so a fading form's shadow fades with it.
  m.maskNode = kept(fade).greaterThan(0.5).and(rise.keep);
  return m;
}

/** A merged mesh's fade, read from the mesh drawn: each chunk's mesh carries its own in `userData.fade`. */
function objectFade() {
  return uniform(1).onObjectUpdate(({ object }) => {
    const f = (object as Object3D | null)?.userData["fade"];
    return typeof f === "number" ? f : 1;
  });
}

/**
 * A group of flat blocks' fade, per vertex: the fade of the chunk in the
 * vertex's slot, from the fades the mesh drawn carries in `userData.fades`.
 */
function slotFade(slot: Node<"float">): Node<"float"> {
  const at = (k: number) =>
    uniform(1).onObjectUpdate(({ object }) => {
      const f = ((object as Object3D | null)?.userData["fades"] as ArrayLike<number> | undefined)?.[k];
      return typeof f === "number" ? f : 1;
    });
  let f: Node<"float"> = at(FLAT_SLOTS - 1);
  for (let k = FLAT_SLOTS - 2; k >= 0; k--) f = select(slot.lessThan(k + 0.5), at(k), f);
  return f;
}

/**
 * The simple form's material: lit as the full models are, each vertex in
 * its surface's colour, with the same window pattern drawn from where it is
 * on its facade (building-lod.ts, `mergeModels`).
 */
function simpleMaterial(theme: Theme, tick: Node<"float"> | null): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial();
  m.name = tick ? "rising simple buildings" : "simple buildings";
  const fill = attribute<"vec4">("mergedColour", "vec4");
  const facade = attribute<"vec2">("mergedFacade", "vec2");
  const colour = sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb;
  // The alpha byte holds the facade's kind and the building's look (building-lod.ts, `mergeModels`).
  const packedKind = floor(fill.a.mul(255).add(0.5));
  const look = floor(packedKind.add(0.5).div(KINDS));
  const pattern = patterned(colour, glassColours(theme), packedKind.sub(look.mul(KINDS)), facade.x, facade.y, look);
  m.colorNode = pattern.colour;
  m.emissiveNode = pattern.emissive;
  const shown = kept(objectFade()).greaterThan(0.5);
  if (!tick) {
    m.maskNode = shown;
    return m;
  }
  // A chunk with a building under construction (issue 136): each vertex's builtAt, its building's height and its own height in its model.
  const r = attribute<"vec3">("mergedRise", "vec3");
  const rise = rising(tick, r.x, r.y, r.z);
  m.positionNode = positionLocal.sub(vec3(0, rise.sink, 0));
  m.maskNode = shown.and(rise.keep);
  return m;
}

/**
 * The flat form's material: unlit like the zoning overlay, so a block's
 * colour is its zone's in the legend at every preset, and lifted in the
 * shader as the overlay's cells are, a little higher so a block lies over
 * them.
 */
function flatMaterial(tick: Node<"float"> | null): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = tick ? "rising building blocks" : "building blocks";
  const fill = attribute<"vec4">("mergedColour", "vec4");
  const distance = cameraPosition.distance(positionLocal);
  m.positionNode = positionLocal.add(vec3(0, distance.mul(BUILDINGS.flatLift.perMetre).add(BUILDINGS.flatLift.base), 0));
  m.colorNode = vec4(sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb, 1);
  const shown = kept(varying(slotFade(attribute<"float">("mergedSlot", "float")))).greaterThan(0.5);
  // A block has no height to rise by: one under construction dithers in over the stage its building rises in.
  m.maskNode = tick ? shown.and(dither().lessThan(varying(riseNode(tick, attribute<"vec3">("mergedRise", "vec3").x)).sub(1e-4))) : shown;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

/** A model's geometry, its simplified copy and its extent, and the instanced mesh drawing the buildings near the camera that use it. */
interface Model {
  key: string;
  arrays: ModelArrays;
  simple: ModelArrays;
  extent: Extent;
  /** Null while no building near the camera uses the model. */
  mesh: InstancedMesh | null;
  tints: InstancedBufferAttribute | null;
  scales: InstancedBufferAttribute | null;
  fades: InstancedBufferAttribute | null;
  builts: InstancedBufferAttribute | null;
  /** The building drawn by each instance. */
  ids: Int32Array;
  count: number;
}

/** The scaffolding of the buildings under construction drawn in full: one instanced mesh, and the building each instance stands round. */
interface Scaffolds {
  mesh: InstancedMesh;
  sizes: InstancedBufferAttribute;
  builts: InstancedBufferAttribute;
  fades: InstancedBufferAttribute;
  ids: Int32Array;
  count: number;
}

/** A building the layer knows. */
interface Placed {
  id: number;
  model: Model;
  /** Its instance in `model`'s mesh, or -1 while its chunk is not drawn in full. */
  slot: number;
  chunk: number;
  /** What the building is: its model and the row fields that decide where and how it is drawn. */
  sig: string;
  /** Chunks its lot, and the ground round it kept clear of trees, reach. */
  lotChunks: number[];
  /** Its lot's corners, as the mirror gave them. */
  corners: number[];
  tint: { wall: number; roof: number; trim: number };
  /** Its look: the shape of its windows and the shade of its glass. */
  look: number;
  place: Placement;
  /** The model's stretch along the road and back from it. */
  sx: number;
  sz: number;
  /** Its zone and density's colour, for the flat form. */
  flat: number;
  /** The tick the sim built it on. */
  builtAt: number;
  /** Its instance in the scaffolding's mesh, or -1. */
  scaffold: number;
}

/** A chunk's forms. */
interface Chunk {
  ids: Set<number>;
  fade: ChunkFade;
  /** Whether it is held within the full form's reach, and within the simple form's. */
  near: boolean;
  mid: boolean;
  /** Whether every building in it has an instance. */
  full: boolean;
  /** The fade number its instances were last written with. */
  fullFade: number;
  /** Each form merged per chunk: its mesh, whether it has been built, and whether a building changed since. */
  mesh: Record<PerChunk, Mesh | null>;
  built: Record<PerChunk, boolean>;
  stale: Record<PerChunk, boolean>;
  /**
   * For a merged mesh built with a building under construction in it, the
   * tick the last of them finishes on, else 0. The mesh is built again then,
   * without the construction attribute.
   */
  rising: Record<PerChunk, number>;
  /** The group its flat blocks are drawn in, and its slot there. */
  group: FlatGroup;
  slot: number;
}

/**
 * The flat blocks of a group of chunks, in one mesh: as a chunk's merged
 * forms, whether it has been built, whether a building in any of its
 * chunks changed since, and the tick its last building under construction
 * finishes on. `fades` is each slot's fade, which the material reads.
 */
interface FlatGroup {
  id: number;
  chunks: Set<number>;
  mesh: Mesh | null;
  built: boolean;
  stale: boolean;
  rising: number;
  fades: Float32Array;
}

/** The merged forms, and those merged per chunk. Flat blocks are merged per group of chunks. */
type Merged = "simple" | "box" | "flat";
type PerChunk = "simple" | "box";
const MERGED: readonly Merged[] = ["simple", "box", "flat"];
const PER_CHUNK: readonly PerChunk[] = ["simple", "box"];
const MERGED_NAMES: Record<Merged, string> = { simple: "simple buildings", box: "building boxes", flat: "building blocks" };

function sameCorners(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Whether (x, z) is inside the convex quadrilateral `q`, corners in order either way round. */
function inQuad(q: readonly number[], x: number, z: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[k * 2] ?? 0;
    const az = q[k * 2 + 1] ?? 0;
    const bx = q[((k + 1) % 4) * 2] ?? 0;
    const bz = q[((k + 1) % 4) * 2 + 1] ?? 0;
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function chunkOf(x: number, z: number): number {
  const ci = Math.min(CHUNKS_PER_SIDE - 1, Math.max(0, Math.floor(x / CHUNK_SIZE)));
  const cj = Math.min(CHUNKS_PER_SIDE - 1, Math.max(0, Math.floor(z / CHUNK_SIZE)));
  return cj * CHUNKS_PER_SIDE + ci;
}

/** The chunks a lot reaches, with the ground round it kept clear of trees. */
function cornerChunks(corners: ArrayLike<number>): number[] {
  // Every chunk under the lot's box, widened by the trees' reach, so a turned lot or one over a chunk's corner misses none.
  const reach = treeReach();
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let k = 0; k < 4; k++) {
    const x = corners[k * 2] ?? 0;
    const z = corners[k * 2 + 1] ?? 0;
    [minX, maxX, minZ, maxZ] = [Math.min(minX, x), Math.max(maxX, x), Math.min(minZ, z), Math.max(maxZ, z)];
  }
  const a = chunkOf(minX - reach, minZ - reach);
  const b = chunkOf(maxX + reach, maxZ + reach);
  const out: number[] = [];
  for (let cj = Math.floor(a / CHUNKS_PER_SIDE); cj <= Math.floor(b / CHUNKS_PER_SIDE); cj++) {
    for (let ci = a % CHUNKS_PER_SIDE; ci <= b % CHUNKS_PER_SIDE; ci++) out.push(cj * CHUNKS_PER_SIDE + ci);
  }
  return out;
}

/** Metres round a lot whose decoration mask cells are kept clear of trees: the clearance, and half a cell's diagonal, as a cell is clear when any point of it could be within the clearance. */
function treeReach(): number {
  return BUILDINGS.treeClearance + (ROADS.maskCell * Math.SQRT2) / 2;
}

/** The square of the distance from (x, z) to the edges of the quadrilateral `q`. */
function edgeDistance2(q: readonly number[], x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const ax = q[k * 2] ?? 0;
    const az = q[k * 2 + 1] ?? 0;
    const ex = (q[((k + 1) % 4) * 2] ?? 0) - ax;
    const ez = (q[((k + 1) % 4) * 2 + 1] ?? 0) - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    const dx = x - ax - ex * t;
    const dz = z - az - ez * t;
    best = Math.min(best, dx * dx + dz * dz);
  }
  return best;
}

/** The flat form's colour for a building type: its zone's at its density, as the overlay draws them. */
function flatColour(type: number): number {
  const t = BUILDING_TYPES[type];
  const shades = t ? CELLS.zones[t.zone] : undefined;
  return shades?.[(t?.density ?? 1) - 1] ?? CELLS.unzoned;
}

function zeroStats(): Record<BuildingForm, FormStats> {
  return { full: { chunks: 0, buildings: 0, meshes: 0 }, simple: { chunks: 0, buildings: 0, meshes: 0 }, box: { chunks: 0, buildings: 0, meshes: 0 }, flat: { chunks: 0, buildings: 0, meshes: 0 } };
}

export function createBuildingLayer(parent: Object3D, source: BuildingSource, theme: Theme, height: (x: number, z: number) => number): BuildingLayer {
  const root = new Group();
  root.name = "buildings";
  parent.add(root);
  /** The game tick on screen, and the uniform the construction shaders read it from (construction.ts). */
  const tick = tickUniform();
  let now = tick.value;
  const material = buildingMaterial(theme, tick);
  const simples = simpleMaterial(theme, null);
  const risingSimples = simpleMaterial(theme, tick);
  const flats = flatMaterial(null);
  const risingFlats = flatMaterial(tick);
  const scaffolding = scaffoldMaterial(tick, kept);
  const models = new Map<string, Model>();
  const placed = new Map<number, Placed>();
  /** Drawn buildings by the chunks their lots' corners are in. */
  const byLotChunk = new Map<number, Set<number>>();
  /** Each chunk's decoration mask as `lotMask` last made it, until a lot comes into the chunk or leaves it. The decoration asks twice per change. */
  const lotMasks = new Map<number, Uint8Array | null>();
  const chunks = new Map<number, Chunk>();
  const groups = new Map<number, FlatGroup>();
  /** Chunks waiting, and whether each is to be rebuilt or only brought up to date. */
  const dirty = new Map<number, "rebuild" | "apply">();
  let lotChunks = new Set<number>();
  /** Buildings whose chunks are to be found at the next update. */
  let pendingIds = new Set<number>();
  let stats: BuildingStats = {
    buildings: 0,
    models: 0,
    pending: 0,
    lastWrites: 0,
    totalWrites: 0,
    lastRebuilt: 0,
    totalRebuilt: 0,
    lastBuildMs: 0,
    lastMerged: 0,
    totalMerged: 0,
    mergedBytes: { simple: 0, box: 0, flat: 0 },
    forms: zeroStats(),
    fading: 0,
    waiting: 0,
    building: 0,
    scaffolds: 0,
  };
  /** Buildings under construction, checked each frame until they finish. Every building drawing scaffolding is one. */
  const young = new Set<Placed>();
  /** Instances written since the layer was made, and by the reads since chunks started waiting. */
  let writes = 0;
  let batchWrites = 0;
  let batchRebuilt = 0;
  let batchMs = 0;
  let merged = 0;
  let formChanges = 0;
  /** One box reused for every test, so a pick allocates nothing per building. */
  const probe: PickBox = { extent: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }, x: 0, y: 0, z: 0, angle: 0, sx: 1, sz: 1 };
  const mergedBytes: Record<Merged, number> = { simple: 0, box: 0, flat: 0 };

  // Stand-ins drawn from the first frame: a single triangle of each
  // material, scaled to nothing. Every model shares one material and its
  // attributes, and every merged chunk one of the other two, so the shaders
  // all buildings need are compiled with the first frame, and again by the
  // lighting before a switch to shadows (lighting.ts), not on the frame the
  // first building or merged chunk arrives.
  const warmArrays: ModelArrays = {
    positions: new Float32Array(9),
    normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0),
    surfaces: new Float32Array(3),
    facades: new Float32Array(12),
    indices: Uint16Array.of(0, 1, 2),
  };
  const warm = meshFor("warm-up", warmArrays, 1);
  warm.mesh.setMatrixAt(0, new Matrix4().makeScale(0, 0, 0));
  warm.mesh.count = 1;
  root.add(warm.mesh);
  const warmMerged: MergedArrays = {
    positions: new Float32Array(9),
    normals: Int8Array.of(0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0),
    colours: new Uint8Array(12),
    facades: new Float32Array(6),
    indices: Uint16Array.of(0, 1, 2),
    centre: [0, 0, 0],
    radius: 0,
  };
  const warmSimple = mergedMesh("warm-up simple buildings", warmMerged, "simple");
  const warmSlots = new Float32Array(3);
  const warmFlat = mergedMesh("warm-up blocks", { ...warmMerged, normals: null, facades: null, slots: warmSlots }, "flat");
  const warmRise = new Float32Array(9);
  const warmRisingSimple = mergedMesh("warm-up rising simple buildings", { ...warmMerged, rise: warmRise }, "simple");
  const warmRisingFlat = mergedMesh("warm-up rising blocks", { ...warmMerged, normals: null, facades: null, rise: warmRise, slots: warmSlots }, "flat");
  const warmScaffold = scaffoldMeshFor(1);
  warmScaffold.mesh.name = "warm-up scaffolding";
  warmScaffold.mesh.setMatrixAt(0, new Matrix4().makeScale(0, 0, 0));
  warmScaffold.mesh.count = 1;
  root.add(warmScaffold.mesh);
  for (const m of [warmSimple, warmFlat, warmRisingSimple, warmRisingFlat]) {
    m.frustumCulled = false;
    root.add(m);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const size = new Vector3();
  const sphere = new Sphere();

  function geometryFor(arrays: ModelArrays, tints: InstancedBufferAttribute, scales: InstancedBufferAttribute, fades: InstancedBufferAttribute, builts: InstancedBufferAttribute): BufferGeometry {
    // Attributes of its own around the model's arrays, so disposing an
    // outgrown mesh's geometry frees nothing a newer one uses.
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(arrays.positions, 3));
    g.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
    g.setAttribute("buildingSurface", new BufferAttribute(arrays.surfaces, 1));
    g.setAttribute("buildingFacade", new BufferAttribute(arrays.facades, 4));
    g.setAttribute("buildingTint", tints);
    g.setAttribute("buildingScale", scales);
    g.setAttribute("buildingFade", fades);
    g.setAttribute("buildingBuilt", builts);
    g.setIndex(new BufferAttribute(arrays.indices, 1));
    return g;
  }

  function meshFor(key: string, arrays: ModelArrays, capacity: number): { mesh: InstancedMesh; tints: InstancedBufferAttribute; scales: InstancedBufferAttribute; fades: InstancedBufferAttribute; builts: InstancedBufferAttribute } {
    const tints = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
    const scales = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    const fades = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(DynamicDrawUsage);
    const builts = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(LONG_AGO), 3).setUsage(DynamicDrawUsage);
    const mesh = new InstancedMesh(geometryFor(arrays, tints, scales, fades, builts), material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = `buildings ${key}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The instances spread over the chunks near the camera: one bounding sphere would cull little.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return { mesh, tints, scales, fades, builts };
  }

  /** The scaffolding's mesh, with room for `capacity` buildings: one instance of the four walls each (construction.ts). */
  function scaffoldMeshFor(capacity: number): Scaffolds {
    const g = scaffoldGeometry();
    const sizes = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    const builts = new InstancedBufferAttribute(new Float32Array(capacity).fill(LONG_AGO), 1).setUsage(DynamicDrawUsage);
    const fades = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(DynamicDrawUsage);
    g.setAttribute("scaffoldSize", sizes);
    g.setAttribute("scaffoldBuilt", builts);
    g.setAttribute("scaffoldFade", fades);
    const mesh = new InstancedMesh(g, scaffolding, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = "scaffolding";
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return { mesh, sizes, builts, fades, ids: new Int32Array(capacity).fill(-1), count: 0 };
  }

  function mergedMesh(name: string, a: MergedArrays & { rise?: Float32Array | null; slots?: Float32Array }, form: Merged): Mesh {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(a.positions, 3));
    if (a.normals) g.setAttribute("normal", new BufferAttribute(a.normals, 4, true));
    g.setAttribute("mergedColour", new BufferAttribute(a.colours, 4, true));
    if (a.facades) g.setAttribute("mergedFacade", new BufferAttribute(a.facades, 2));
    if (a.rise) g.setAttribute("mergedRise", new BufferAttribute(a.rise, 3));
    if (a.slots) g.setAttribute("mergedSlot", new BufferAttribute(a.slots, 1));
    g.setIndex(new BufferAttribute(a.indices, 1));
    // The flat form is lifted in the shader: the sphere allows for it.
    g.boundingSphere = new Sphere(new Vector3(...a.centre), a.radius + (form === "flat" ? 40 : 0));
    // Simple buildings and boxes share one vertex format and one material.
    // A chunk with a building under construction draws with the rising materials until the last of them is finished.
    const mesh = new Mesh(g, form === "flat" ? (a.rise ? risingFlats : flats) : a.rise ? risingSimples : simples);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.userData["fade"] = 1;
    if (form !== "flat") {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else {
      // Nothing in the city band casts a shadow. Over the cells, which draw at 1.5, and under the roads at 2.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 1.6;
    }
    return mesh;
  }

  function modelFor(info: BuildingInfo): Model {
    const type = BUILDING_TYPES[info.type];
    const typeId = type?.id ?? "";
    const model = info.variant % theme.modelCount(typeId);
    const key = `${typeId}/${model}/${info.width}`;
    let m = models.get(key);
    if (m) return m;
    const arrays = theme.model(typeId, model, info.width, theme.modelDepth(typeId));
    m = { key, arrays, simple: simplify(arrays, BUILDINGS.simplify), extent: modelExtent(arrays.positions, arrays.surfaces, SURFACE.paving), mesh: null, tints: null, scales: null, fades: null, builts: null, ids: new Int32Array(0), count: 0 };
    models.set(key, m);
    return m;
  }

  /** Makes a model's mesh, or doubles its room for instances: a new mesh with the old one's instances copied over. */
  function grow(m: Model): void {
    const capacity = Math.max(FIRST_CAPACITY, m.ids.length * 2);
    const next = meshFor(m.key, m.arrays, capacity);
    const ids = new Int32Array(capacity).fill(-1);
    if (m.mesh && m.tints && m.scales && m.fades && m.builts) {
      next.mesh.instanceMatrix.array.set(m.mesh.instanceMatrix.array);
      next.tints.array.set(m.tints.array);
      next.scales.array.set(m.scales.array);
      next.fades.array.set(m.fades.array);
      next.builts.array.set(m.builts.array);
      ids.set(m.ids);
      m.mesh.removeFromParent();
      m.mesh.geometry.dispose();
      m.mesh.dispose();
    }
    next.mesh.count = m.count;
    root.add(next.mesh);
    m.mesh = next.mesh;
    m.tints = next.tints;
    m.scales = next.scales;
    m.fades = next.fades;
    m.builts = next.builts;
    m.ids = ids;
  }

  /** Frees a model's mesh once no building near the camera uses it. The model's arrays are kept. */
  function shrink(m: Model): void {
    if (m.count > 0 || !m.mesh) return;
    m.mesh.removeFromParent();
    m.mesh.geometry.dispose();
    m.mesh.dispose();
    m.mesh = null;
    m.tints = null;
    m.scales = null;
    m.fades = null;
    m.builts = null;
    m.ids = new Int32Array(0);
  }

  /**
   * Attributes sent whole this frame. Each update range is one upload, so
   * an attribute with more than `MAX_RANGES` of them in a frame, as when a
   * chunk is drawn in full or fades, goes up in one.
   */
  const whole = new Set<BufferAttribute>();
  function dirtyRange(a: BufferAttribute, start: number, count: number): void {
    a.needsUpdate = true;
    if (whole.has(a)) return;
    if (a.updateRanges.length >= MAX_RANGES) {
      a.clearUpdateRanges();
      whole.add(a);
      return;
    }
    a.addUpdateRange(start, count);
  }

  function touched(m: Model, slot: number): void {
    if (!m.mesh || !m.tints || !m.scales || !m.fades || !m.builts) return;
    dirtyRange(m.mesh.instanceMatrix, slot * 16, 16);
    dirtyRange(m.tints, slot * 4, 4);
    dirtyRange(m.scales, slot * 2, 2);
    dirtyRange(m.fades, slot, 1);
    dirtyRange(m.builts, slot * 3, 3);
    writes++;
  }

  function write(p: Placed): void {
    const m = p.model;
    if (!m.mesh || !m.tints || !m.scales || !m.fades || !m.builts || p.slot < 0) return;
    position.set(p.place.x, p.place.y, p.place.z);
    turn.setFromAxisAngle(up, p.place.angle);
    size.set(p.sx, 1, p.sz);
    matrix.compose(position, turn, size);
    m.mesh.setMatrixAt(p.slot, matrix);
    m.tints.setXYZW(p.slot, packed(p.tint.wall), packed(p.tint.roof), packed(p.tint.trim), p.look);
    m.scales.setXY(p.slot, p.sx, p.sz);
    m.fades.setX(p.slot, chunkAt(p.chunk).fullFade);
    m.builts.setXYZ(p.slot, p.builtAt, m.extent.maxY, m.extent.minY);
    touched(m, p.slot);
    if (p.scaffold >= 0) writeScaffold(p);
  }

  /** Gives a building an instance in its model's mesh. */
  function addInstance(p: Placed): void {
    const m = p.model;
    if (!m.mesh || m.count === m.ids.length) grow(m);
    p.slot = m.count++;
    if (m.mesh) m.mesh.count = m.count;
    m.ids[p.slot] = p.id;
    write(p);
    // Drawn in full while under construction: scaffolding round it.
    if (p.scaffold < 0 && underConstruction(p.builtAt, now)) addScaffold(p);
  }

  /** Takes a building's instance away: the last instance moves into the gap. */
  function removeInstance(p: Placed): void {
    const m = p.model;
    removeScaffold(p);
    if (p.slot < 0 || !m.mesh || !m.tints || !m.scales || !m.fades || !m.builts) {
      p.slot = -1;
      return;
    }
    const last = m.count - 1;
    if (p.slot !== last) {
      const moved = m.ids[last] ?? -1;
      m.mesh.instanceMatrix.array.copyWithin(p.slot * 16, last * 16, last * 16 + 16);
      m.tints.array.copyWithin(p.slot * 4, last * 4, last * 4 + 4);
      m.scales.array.copyWithin(p.slot * 2, last * 2, last * 2 + 2);
      m.fades.array.copyWithin(p.slot, last, last + 1);
      m.builts.array.copyWithin(p.slot * 3, last * 3, last * 3 + 3);
      m.ids[p.slot] = moved;
      const other = placed.get(moved);
      if (other) other.slot = p.slot;
      touched(m, p.slot);
    }
    m.ids[last] = -1;
    m.count = last;
    m.mesh.count = last;
    p.slot = -1;
    shrink(m);
  }

  let scaffolds = scaffoldMeshFor(FIRST_CAPACITY);
  root.add(scaffolds.mesh);

  /** Writes building `p`'s scaffolding: a box round its model, from the ground under its lot to a little over its roof. */
  function writeScaffold(p: Placed): void {
    const e = p.model.extent;
    const c = Math.cos(p.place.angle);
    const s = Math.sin(p.place.angle);
    const cx = ((e.minX + e.maxX) / 2) * p.sx;
    const cz = ((e.minZ + e.maxZ) / 2) * p.sz;
    const base = Math.min(0, e.minY);
    const w = (e.maxX - e.minX) * p.sx + 2 * CONSTRUCTION.margin;
    const h = e.maxY - base + CONSTRUCTION.over;
    const d = (e.maxZ - e.minZ) * p.sz + 2 * CONSTRUCTION.margin;
    position.set(p.place.x + cx * c + cz * s, p.place.y + base, p.place.z - cx * s + cz * c);
    turn.setFromAxisAngle(up, p.place.angle);
    size.set(w, h, d);
    matrix.compose(position, turn, size);
    const k = p.scaffold;
    scaffolds.mesh.setMatrixAt(k, matrix);
    scaffolds.sizes.setXYZ(k, w, h, d);
    scaffolds.builts.setX(k, p.builtAt);
    scaffolds.fades.setX(k, chunkAt(p.chunk).fullFade);
    touchScaffold(k);
  }

  function touchScaffold(k: number): void {
    dirtyRange(scaffolds.mesh.instanceMatrix, k * 16, 16);
    dirtyRange(scaffolds.sizes, k * 3, 3);
    dirtyRange(scaffolds.builts, k, 1);
    dirtyRange(scaffolds.fades, k, 1);
  }

  function addScaffold(p: Placed): void {
    if (scaffolds.count === scaffolds.ids.length) {
      const next = scaffoldMeshFor(scaffolds.ids.length * 2);
      next.mesh.instanceMatrix.array.set(scaffolds.mesh.instanceMatrix.array);
      next.sizes.array.set(scaffolds.sizes.array);
      next.builts.array.set(scaffolds.builts.array);
      next.fades.array.set(scaffolds.fades.array);
      next.ids.set(scaffolds.ids);
      next.count = scaffolds.count;
      next.mesh.count = scaffolds.count;
      scaffolds.mesh.removeFromParent();
      scaffolds.mesh.geometry.dispose();
      scaffolds.mesh.dispose();
      scaffolds = next;
      root.add(scaffolds.mesh);
    }
    p.scaffold = scaffolds.count++;
    scaffolds.mesh.count = scaffolds.count;
    scaffolds.ids[p.scaffold] = p.id;
    // Checked each frame, so the scaffolding comes away when it finishes, however the building came to be under construction.
    young.add(p);
    writeScaffold(p);
  }

  /** Takes building `p`'s scaffolding away: the last one moves into the gap. */
  function removeScaffold(p: Placed): void {
    if (p.scaffold < 0) return;
    const k = p.scaffold;
    const last = scaffolds.count - 1;
    if (k !== last) {
      const moved = scaffolds.ids[last] ?? -1;
      scaffolds.mesh.instanceMatrix.array.copyWithin(k * 16, last * 16, last * 16 + 16);
      scaffolds.sizes.array.copyWithin(k * 3, last * 3, last * 3 + 3);
      scaffolds.builts.array.copyWithin(k, last, last + 1);
      scaffolds.fades.array.copyWithin(k, last, last + 1);
      scaffolds.ids[k] = moved;
      const other = placed.get(moved);
      if (other) other.scaffold = k;
      touchScaffold(k);
    }
    scaffolds.ids[last] = -1;
    scaffolds.count = last;
    scaffolds.mesh.count = last;
    p.scaffold = -1;
  }

  /** Lets go of buildings whose construction finished: their scaffolding comes away, and they are no longer checked. */
  function finishConstruction(): void {
    for (const p of young) {
      if (underConstruction(p.builtAt, now)) continue;
      removeScaffold(p);
      young.delete(p);
    }
  }

  function groupAt(g: number): FlatGroup {
    let group = groups.get(g);
    if (!group) {
      group = { id: g, chunks: new Set(), mesh: null, built: false, stale: false, rising: 0, fades: new Float32Array(FLAT_SLOTS) };
      groups.set(g, group);
    }
    return group;
  }

  function chunkAt(c: number): Chunk {
    let ch = chunks.get(c);
    if (!ch) {
      const group = groupAt(flatGroupOf(c));
      group.chunks.add(c);
      ch = {
        ids: new Set(),
        fade: { shown: null, next: null, t: 0 },
        near: false,
        mid: false,
        full: false,
        fullFade: 0,
        mesh: { simple: null, box: null },
        built: { simple: false, box: false },
        stale: { simple: false, box: false },
        rising: { simple: 0, box: 0 },
        group,
        slot: flatSlotOf(c),
      };
      chunks.set(c, ch);
    }
    return ch;
  }

  /** A building in chunk `c` came, went or moved: its merged forms are out of date. */
  function staleChunk(c: number): void {
    const ch = chunkAt(c);
    for (const form of PER_CHUNK) ch.stale[form] = true;
    ch.group.stale = true;
  }

  /** Whether a chunk's merged form has been built, and whether a building changed since: for flat blocks, its group's. */
  function builtOf(ch: Chunk, form: Merged): boolean {
    return form === "flat" ? ch.group.built : ch.built[form];
  }
  function staleOf(ch: Chunk, form: Merged): boolean {
    return form === "flat" ? ch.group.stale : ch.stale[form];
  }

  /** Brings a building's instance in line with its chunk: one while the chunk is drawn in full, none otherwise. */
  function syncInstance(p: Placed): void {
    const want = chunkAt(p.chunk).full;
    if (p.slot >= 0 && !want) removeInstance(p);
    if (want && p.slot < 0) addInstance(p);
    else if (want) write(p);
  }

  /** Files a lot by its corners' chunks, and notes them for the overlay and the decoration. */
  function fileLot(id: number, list: readonly number[]): void {
    for (const c of list) {
      lotChunks.add(c);
      lotMasks.delete(c);
      let set = byLotChunk.get(c);
      if (!set) byLotChunk.set(c, (set = new Set()));
      set.add(id);
    }
  }

  function unfileLot(id: number, list: readonly number[]): void {
    for (const c of list) {
      lotChunks.add(c);
      lotMasks.delete(c);
      byLotChunk.get(c)?.delete(id);
    }
  }

  function remove(id: number): void {
    const p = placed.get(id);
    if (!p) return;
    removeInstance(p);
    young.delete(p);
    chunkAt(p.chunk).ids.delete(id);
    staleChunk(p.chunk);
    unfileLot(id, p.lotChunks);
    placed.delete(id);
  }

  function placeInfo(info: BuildingInfo, place: Placement): { sx: number; sz: number } {
    const typeId = BUILDING_TYPES[info.type]?.id ?? "";
    return { sx: place.width / (info.width * CELL), sz: place.depth / (theme.modelDepth(typeId) * CELL) };
  }

  function add(info: BuildingInfo, place: Placement, sig: string, chunk: number): void {
    const model = modelFor(info);
    const typeId = BUILDING_TYPES[info.type]?.id ?? "";
    const tint = tintFor(info.id, theme.palette(typeId));
    const corners = info.corners ? [...info.corners] : [];
    const lots = cornerChunks(corners);
    fileLot(info.id, lots);
    const p: Placed = { id: info.id, model, slot: -1, chunk, sig, lotChunks: lots, corners, tint, look: lookFor(info.id), place, ...placeInfo(info, place), flat: flatColour(info.type), builtAt: info.builtAt, scaffold: -1 };
    placed.set(info.id, p);
    if (underConstruction(p.builtAt, now)) young.add(p);
    chunkAt(chunk).ids.add(info.id);
    staleChunk(chunk);
    syncInstance(p);
  }

  /** Brings the buildings of chunk `c` in line with the mirror. */
  function read(c: number, mode: "rebuild" | "apply"): void {
    const infos = source.buildingsInChunk(c);
    const seen = new Set<number>();
    for (const info of infos) {
      if (!info.corners) continue;
      seen.add(info.id);
      const sig = `${info.type}/${info.variant}/${info.width}/${info.depth}/${info.builtAt}`;
      const p = placed.get(info.id);
      if (p && p.sig === sig && mode === "apply" && p.chunk === c && sameCorners(p.corners, info.corners)) continue;
      const place = placeLot(info.corners, height);
      if (p && p.sig === sig) {
        // The same building: placed again in its own instance, on its lot as it is now.
        p.place = place;
        Object.assign(p, placeInfo(info, place));
        staleChunk(p.chunk);
        if (p.chunk !== c) {
          chunkAt(p.chunk).ids.delete(info.id);
          p.chunk = c;
          chunkAt(c).ids.add(info.id);
          staleChunk(c);
        }
        if (!sameCorners(p.corners, info.corners)) {
          unfileLot(info.id, p.lotChunks);
          p.corners = [...info.corners];
          p.lotChunks = cornerChunks(p.corners);
          fileLot(info.id, p.lotChunks);
        }
        syncInstance(p);
        continue;
      }
      if (p) remove(info.id);
      add(info, place, sig, c);
    }
    for (const id of [...(chunks.get(c)?.ids ?? [])]) if (!seen.has(id)) remove(id);
    if (mode === "rebuild") batchRebuilt++;
  }

  function mark(list: Iterable<number>, mode: "rebuild" | "apply"): void {
    for (const c of list) if (mode === "rebuild" || !dirty.has(c)) dirty.set(c, mode);
    stats = { ...stats, pending: dirty.size };
  }

  /** Writes building `p`'s box as drawn into `box`, for picking: its model's, or its flat block's when its chunk shows blocks. */
  function setPickBox(box: PickBox, p: Placed, flat: boolean): PickBox {
    const m = p.model.extent;
    const e = box.extent;
    e.minX = m.minX;
    e.maxX = m.maxX;
    e.minZ = m.minZ;
    e.maxZ = m.maxZ;
    e.minY = flat ? FLAT_PICK_Y.minY : m.minY;
    e.maxY = flat ? FLAT_PICK_Y.maxY : m.maxY;
    box.x = p.place.x;
    box.y = p.place.y;
    box.z = p.place.z;
    box.angle = p.place.angle;
    box.sx = p.sx;
    box.sz = p.sz;
    return box;
  }

  function itemsOf(ch: Chunk): MergedItem[] {
    const items: MergedItem[] = [];
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (!p) continue;
      items.push({
        model: p.model.simple,
        extent: p.model.extent,
        x: p.place.x,
        y: p.place.y,
        z: p.place.z,
        angle: p.place.angle,
        sx: p.sx,
        sz: p.sz,
        wall: p.tint.wall,
        roof: p.tint.roof,
        trim: p.tint.trim,
        look: p.look,
        flat: p.flat,
        built: p.builtAt,
        height: p.model.extent.maxY,
      });
    }
    return items;
  }

  /** Frees a chunk's merged mesh for `form`: it is built again before it is drawn. */
  function dropMerged(ch: Chunk, form: PerChunk): void {
    ch.built[form] = false;
    ch.rising[form] = 0;
    const mesh = ch.mesh[form];
    if (!mesh) return;
    mergedBytes[form] -= Number(mesh.userData["bytes"] ?? 0);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    ch.mesh[form] = null;
  }

  /** Frees a group's mesh of flat blocks. */
  function dropGroup(group: FlatGroup): void {
    group.built = false;
    group.rising = 0;
    const mesh = group.mesh;
    if (!mesh) return;
    mergedBytes.flat -= Number(mesh.userData["bytes"] ?? 0);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    group.mesh = null;
  }

  /** Whether any chunk of a group draws flat blocks. */
  function groupDrawn(group: FlatGroup): boolean {
    for (const f of group.fades) if (f > 0) return true;
    return false;
  }

  /** Builds a group's mesh of flat blocks from the buildings of its chunks as they are now. */
  function buildGroup(group: FlatGroup): void {
    dropGroup(group);
    const items: MergedItem[] = [];
    const runs: { slot: number; count: number }[] = [];
    for (const c of [...group.chunks].sort((a, b) => a - b)) {
      const ch = chunks.get(c);
      if (!ch) continue;
      const own = itemsOf(ch);
      for (const item of own) items.push(item);
      runs.push({ slot: ch.slot, count: own.length });
    }
    if (items.length > 0) {
      const arrays = mergeFlats(items);
      const slots = flatSlots(runs);
      let until = 0;
      for (const item of items) if (underConstruction(item.built ?? LONG_AGO, now)) until = Math.max(until, finishedAt(item.built ?? LONG_AGO));
      const rise = until > 0 ? mergedRise(items, arrays.positions, "flat") : null;
      group.rising = until;
      const gi = group.id % FLAT_GROUPS_PER_SIDE;
      const gj = (group.id - gi) / FLAT_GROUPS_PER_SIDE;
      const mesh = mergedMesh(`${MERGED_NAMES.flat} ${gi},${gj}`, { ...arrays, rise, slots }, "flat");
      const bytes = arrays.positions.byteLength + arrays.colours.byteLength + arrays.indices.byteLength + slots.byteLength + (rise?.byteLength ?? 0);
      mesh.userData["bytes"] = bytes;
      mesh.userData["fades"] = group.fades;
      mergedBytes.flat += bytes;
      mesh.visible = groupDrawn(group);
      root.add(mesh);
      group.mesh = mesh;
    }
    group.built = true;
    group.stale = false;
    merged++;
  }

  /** Builds a chunk's merged mesh for `form` from its buildings as they are now: for flat blocks, its group's. */
  function buildMerged(c: number, ch: Chunk, form: Merged): void {
    if (form === "flat") {
      buildGroup(ch.group);
      return;
    }
    dropMerged(ch, form);
    const items = itemsOf(ch);
    if (items.length > 0) {
      const ci = c % CHUNKS_PER_SIDE;
      const cj = (c - ci) / CHUNKS_PER_SIDE;
      const arrays = form === "simple" ? mergeModels(items, theme.fixed) : mergeBoxes(items);
      // Only a chunk with a building under construction carries the attribute it rises by, so a finished city costs nothing more.
      let until = 0;
      for (const item of items) if (underConstruction(item.built ?? LONG_AGO, now)) until = Math.max(until, finishedAt(item.built ?? LONG_AGO));
      const rise = until > 0 ? mergedRise(items, arrays.positions, form) : null;
      ch.rising[form] = until;
      const mesh = mergedMesh(`${MERGED_NAMES[form]} ${ci},${cj}`, { ...arrays, rise }, form);
      const bytes = arrays.positions.byteLength + (arrays.normals?.byteLength ?? 0) + arrays.colours.byteLength + (arrays.facades?.byteLength ?? 0) + arrays.indices.byteLength + (rise?.byteLength ?? 0);
      mesh.userData["bytes"] = bytes;
      mergedBytes[form] += bytes;
      mesh.visible = draws(ch.fade, form);
      mesh.userData["fade"] = fadeOf(ch.fade, form);
      root.add(mesh);
      ch.mesh[form] = mesh;
    }
    ch.built[form] = true;
    ch.stale[form] = false;
    merged++;
  }

  /**
   * Whether a chunk keeps a merged form it is not drawing: the simple form
   * only within its reach, boxes only beyond it, so the simple form's
   * memory grows with the radius and not the city. Boxes, about 600 bytes a
   * building, and flat blocks, smaller, grow with the city, as the boxes
   * did when they were the only far form.
   */
  function keeps(ch: Chunk, form: Merged): boolean {
    if (form === "simple") return ch.mid;
    if (form === "box") return !ch.mid;
    return true;
  }

  /** Whether a merged form needs building for a chunk: never built, or a building changed since. A group built this frame for another of its chunks does not. */
  function unbuilt(ch: Chunk, form: Merged): boolean {
    return !builtOf(ch, form) || staleOf(ch, form);
  }

  /** Gives every building in a chunk an instance, so it can be drawn in full. */
  function fill(ch: Chunk): void {
    ch.full = true;
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (p && p.slot < 0) addInstance(p);
    }
  }

  /** Takes every instance of a chunk away: its full form is freed. */
  function free(ch: Chunk): void {
    ch.full = false;
    for (const id of ch.ids) {
      const p = placed.get(id);
      if (p) removeInstance(p);
    }
  }

  /**
   * Whether a chunk can draw `form` now. A merged form that a building
   * changed since it was built is not ready to fade in, though one already
   * drawn stays drawn until it is built again.
   */
  function ready(ch: Chunk, form: BuildingForm): boolean {
    if (form === "full") return ch.full;
    return builtOf(ch, form) && (!staleOf(ch, form) || draws(ch.fade, form));
  }

  /** Writes a chunk's fade into its merged meshes and, when it changed, into its instances. */
  function showFade(ch: Chunk): void {
    for (const form of PER_CHUNK) {
      const mesh = ch.mesh[form];
      if (!mesh) continue;
      mesh.visible = draws(ch.fade, form);
      mesh.userData["fade"] = fadeOf(ch.fade, form);
    }
    // The group's mesh is shown while any of its chunks draws it: see `forms`.
    ch.group.fades[ch.slot] = fadeOf(ch.fade, "flat");
    const f = fadeOf(ch.fade, "full");
    if (f === ch.fullFade) return;
    ch.fullFade = f;
    for (const id of ch.ids) {
      const p = placed.get(id);
      const m = p?.model;
      if (!p || !m?.fades || p.slot < 0) continue;
      m.fades.setX(p.slot, f);
      dirtyRange(m.fades, p.slot, 1);
      if (p.scaffold >= 0) {
        scaffolds.fades.setX(p.scaffold, f);
        dirtyRange(scaffolds.fades, p.scaffold, 1);
      }
    }
  }

  /** Chunks whose wanted form the last update left to build, for want of budget. */
  let queued = 0;

  /** One step of the forms, after the reads: what each chunk wants, what that needs built, and the fades. */
  function forms(camera: { x: number; z: number }, view: BuildingView, start: number, budgetMs: number): void {
    const needs: { c: number; ch: Chunk; d: number; form: BuildingForm }[] = [];
    for (const [c, ch] of chunks) {
      if (ch.ids.size === 0) {
        // Every building gone: nothing left to draw or fade. Its blocks leave its group's mesh at once, and the group is built again without them.
        free(ch);
        for (const form of PER_CHUNK) dropMerged(ch, form);
        ch.group.fades[ch.slot] = 0;
        ch.group.stale = true;
        ch.group.chunks.delete(c);
        if (ch.group.chunks.size === 0) {
          dropGroup(ch.group);
          groups.delete(ch.group.id);
        }
        chunks.delete(c);
        continue;
      }
      // A drawn merged mesh whose buildings have all finished is built again, plain. One not drawn keeps
      // the rising material, which draws them finished, until something else builds it again.
      for (const form of PER_CHUNK) {
        if (ch.rising[form] > 0 && now >= ch.rising[form]) {
          ch.rising[form] = 0;
          if (draws(ch.fade, form)) ch.stale[form] = true;
        }
      }
      ch.near = isNear(c, camera.x, camera.z, ch.near, BUILDINGS.fullRadius, BUILDINGS.fullHysteresis);
      ch.mid = isNear(c, camera.x, camera.z, ch.mid, BUILDINGS.simpleRadius, BUILDINGS.simpleHysteresis);
      const want = formFor(view.band, ch.near, ch.mid);
      const d = chunkDistance(c, camera.x, camera.z);
      if (!ready(ch, want)) needs.push({ c, ch, d, form: want });
      else if (want !== "full" && staleOf(ch, want)) needs.push({ c, ch, d, form: want });
    }
    for (const group of groups.values()) {
      if (group.rising > 0 && now >= group.rising) {
        group.rising = 0;
        if (groupDrawn(group)) group.stale = true;
      }
    }
    needs.sort((a, b) => a.d - b.d || a.c - b.c);
    let done = 0;
    queued = 0;
    for (const n of needs) {
      if (n.form !== "full" && !unbuilt(n.ch, n.form)) continue;
      // Left for a later frame: a stale form still drawn counts as ready, so neither `fading` nor `waiting` sees it.
      if (done > 0 && performance.now() - start >= budgetMs) {
        queued++;
        continue;
      }
      if (n.form === "full") fill(n.ch);
      else buildMerged(n.c, n.ch, n.form);
      done++;
    }
    let fading = 0;
    let waiting = 0;
    for (const ch of chunks.values()) {
      const want = formFor(view.band, ch.near, ch.mid);
      const shownBefore = ch.fade.shown;
      const { released } = stepFade(ch.fade, want, (form) => ready(ch, form), view.seconds, BUILDINGS.fadeSeconds);
      // A chunk filled for a fade that never started, because another was under way and then the camera left, is freed too.
      if (ch.full && !draws(ch.fade, "full") && (released === "full" || want !== "full")) free(ch);
      // A merged form the chunk no longer keeps is freed once it is not drawn.
      for (const form of PER_CHUNK) if (ch.built[form] && !keeps(ch, form) && !draws(ch.fade, form)) dropMerged(ch, form);
      showFade(ch);
      if (ch.fade.shown !== shownBefore) formChanges++;
      if (ch.fade.next !== null) fading++;
      else if (ch.fade.shown !== want) waiting++;
    }
    for (const group of groups.values()) if (group.mesh) group.mesh.visible = groupDrawn(group);
    // With time left, the merged forms a chunk keeps but does not draw are built ahead, or again if a building changed, nearest first, so a zoom finds them ready.
    if (performance.now() - start < budgetMs) {
      const ahead: { c: number; ch: Chunk; d: number; form: Merged }[] = [];
      for (const [c, ch] of chunks) {
        const d = chunkDistance(c, camera.x, camera.z);
        // The city band draws neither simple buildings nor boxes: they are built when a zoom in wants them, not ahead.
        for (const form of MERGED) if ((form === "flat" || view.band !== "city") && keeps(ch, form) && unbuilt(ch, form)) ahead.push({ c, ch, d, form });
      }
      ahead.sort((a, b) => a.d - b.d || a.c - b.c || (a.form < b.form ? -1 : 1));
      for (const a of ahead) {
        if (!unbuilt(a.ch, a.form)) continue;
        if (performance.now() - start >= budgetMs) break;
        buildMerged(a.c, a.ch, a.form);
      }
    }
    stats = { ...stats, fading, waiting };
  }

  /** What each form drew, counting meshes in the camera's view. */
  function count(frustum: Frustum | undefined): Record<BuildingForm, FormStats> {
    const out = zeroStats();
    for (const m of models.values()) {
      if (!m.mesh || m.count === 0) continue;
      out.full.meshes++;
      out.full.buildings += m.count;
    }
    const inView = (mesh: Mesh | null): boolean => {
      if (!mesh?.visible) return false;
      const bs = mesh.geometry.boundingSphere;
      return !frustum || !bs || frustum.intersectsSphere(sphere.copy(bs));
    };
    for (const ch of chunks.values()) {
      if (draws(ch.fade, "full")) out.full.chunks++;
      for (const form of PER_CHUNK) {
        if (!inView(ch.mesh[form])) continue;
        out[form].chunks++;
        out[form].meshes++;
        out[form].buildings += ch.ids.size;
      }
      if (draws(ch.fade, "flat") && inView(ch.group.mesh)) {
        out.flat.chunks++;
        out.flat.buildings += ch.ids.size;
      }
    }
    for (const group of groups.values()) if (inView(group.mesh)) out.flat.meshes++;
    return out;
  }

  return {
    reset() {
      mark(
        Array.from({ length: CHUNK_COUNT }, (_, c) => c),
        "rebuild",
      );
    },
    rebuild: (list) => mark(list, "rebuild"),
    apply: (list) => mark(list, "apply"),
    applyIds(ids) {
      for (const id of ids) pendingIds.add(id);
    },
    update(camera, budgetMs, view = { band: "street", seconds: Infinity }) {
      now = view.tick ?? 1e9;
      tick.value = now;
      if (pendingIds.size > 0) {
        const ids = pendingIds;
        pendingIds = new Set();
        const list: number[] = [];
        for (const id of ids) {
          const p = placed.get(id);
          if (p) list.push(p.chunk);
          const now = source.buildingChunk(id);
          if (now >= 0) list.push(now);
        }
        mark(list, "apply");
      }
      whole.clear();
      const start = performance.now();
      const writesBefore = writes;
      const mergedBefore = merged;
      const wasDirty = dirty.size > 0;
      if (wasDirty) {
        const distance = (c: number) => {
          const ci = c % CHUNKS_PER_SIDE;
          const cj = (c - ci) / CHUNKS_PER_SIDE;
          return Math.hypot((ci + 0.5) * CHUNK_SIZE - camera.x, (cj + 0.5) * CHUNK_SIZE - camera.z);
        };
        const list = [...dirty.keys()].map((c) => ({ c, d: distance(c) })).sort((a, b) => a.d - b.d || a.c - b.c);
        let done = 0;
        for (const { c } of list) {
          if (done > 0 && performance.now() - start >= budgetMs) break;
          const mode = dirty.get(c) ?? "apply";
          dirty.delete(c);
          read(c, mode);
          done++;
        }
      }
      if (wasDirty) batchMs += performance.now() - start;
      forms(camera, view, start, budgetMs);
      // A building that comes to a chunk with none is written when the forms fill that chunk, after the reads, so the writes count until here.
      if (wasDirty) batchWrites += writes - writesBefore;
      finishConstruction();
      stats = {
        ...stats,
        buildings: placed.size,
        models: models.size,
        pending: dirty.size,
        totalWrites: writes,
        lastMerged: merged > mergedBefore ? merged - mergedBefore : stats.lastMerged,
        totalMerged: merged,
        mergedBytes: { ...mergedBytes },
        forms: count(view.frustum),
        building: young.size,
        scaffolds: scaffolds.count,
      };
      if (dirty.size === 0 && wasDirty) {
        stats = { ...stats, lastWrites: batchWrites, lastRebuilt: batchRebuilt, totalRebuilt: stats.totalRebuilt + batchRebuilt, lastBuildMs: batchMs };
        batchWrites = 0;
        batchRebuilt = 0;
        batchMs = 0;
      }
    },
    idle: () => dirty.size === 0 && pendingIds.size === 0 && queued === 0 && stats.fading === 0 && stats.waiting === 0,
    takeLotChunks() {
      const out = [...lotChunks];
      lotChunks = new Set();
      return out;
    },
    lotMask(chunk) {
      const kept = lotMasks.get(chunk);
      if (kept !== undefined) return kept;
      const ids = byLotChunk.get(chunk);
      if (!ids || ids.size === 0) {
        lotMasks.set(chunk, null);
        return null;
      }
      const cell = ROADS.maskCell;
      const ci = chunk % CHUNKS_PER_SIDE;
      const cj = (chunk - ci) / CHUNKS_PER_SIDE;
      const x0 = ci * CHUNK_SIZE;
      const z0 = cj * CHUNK_SIZE;
      const mask = new Uint8Array(MASK_SIDE * MASK_SIDE);
      // Grass stays off the lot, and trees off the ground round it too, so no crown reaches a wall (issue #137).
      const reach = treeReach();
      const reach2 = reach * reach;
      for (const id of ids) {
        const q = placed.get(id)?.corners;
        if (!q || q.length < 8) continue;
        const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
        const zs = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
        const i0 = Math.max(0, Math.floor((Math.min(...xs) - reach - x0) / cell));
        const i1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(...xs) + reach - x0) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(...zs) - reach - z0) / cell));
        const j1 = Math.min(MASK_SIDE - 1, Math.floor((Math.max(...zs) + reach - z0) / cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = x0 + (i + 0.5) * cell;
            const z = z0 + (j + 0.5) * cell;
            const m = j * MASK_SIDE + i;
            if (inQuad(q, x, z)) mask[m] = MASK_TREES | MASK_GRASS;
            else if ((mask[m] ?? 0) === 0 && edgeDistance2(q, x, z) <= reach2) mask[m] = MASK_TREES;
          }
        }
      }
      lotMasks.set(chunk, mask);
      return mask;
    },
    tintOf: (id) => placed.get(id)?.tint ?? null,
    formOf: (chunk) => chunks.get(chunk)?.fade.shown ?? null,
    pick(ray, limit = Infinity) {
      let best = -1;
      let bestT = limit;
      for (const [c, ch] of chunks) {
        if (ch.ids.size === 0 || ch.fade.shown === null) continue;
        const ci = c % CHUNKS_PER_SIDE;
        const cj = Math.floor(c / CHUNKS_PER_SIDE);
        const e = probe.extent;
        e.minX = ci * CHUNK_SIZE - PICK_CHUNK_PAD;
        e.maxX = (ci + 1) * CHUNK_SIZE + PICK_CHUNK_PAD;
        e.minY = PICK_CHUNK_Y.min;
        e.maxY = PICK_CHUNK_Y.max;
        e.minZ = cj * CHUNK_SIZE - PICK_CHUNK_PAD;
        e.maxZ = (cj + 1) * CHUNK_SIZE + PICK_CHUNK_PAD;
        probe.x = probe.y = probe.z = probe.angle = 0;
        probe.sx = probe.sz = 1;
        if (rayBoxDistance(ray, probe, bestT) === null) continue;
        const flat = ch.fade.shown === "flat";
        for (const id of ch.ids) {
          const p = placed.get(id);
          if (!p) continue;
          setPickBox(probe, p, flat);
          const t = rayBoxDistance(ray, probe, bestT);
          if (t !== null && (t < bestT || (t === bestT && id < best))) {
            best = id;
            bestT = t;
          }
        }
      }
      return best;
    },
    formVersion: () => formChanges,
    topOf(id) {
      const p = placed.get(id);
      if (!p) return null;
      const flat = chunks.get(p.chunk)?.fade.shown === "flat";
      const box = setPickBox({ extent: { ...p.model.extent }, x: 0, y: 0, z: 0, angle: 0, sx: 1, sz: 1 }, p, flat);
      const e = box.extent;
      const lx = ((e.minX + e.maxX) / 2) * box.sx;
      const lz = ((e.minZ + e.maxZ) / 2) * box.sz;
      const c = Math.cos(box.angle);
      const s = Math.sin(box.angle);
      return { x: box.x + lx * c + lz * s, y: box.y + e.maxY, z: box.z - lx * s + lz * c };
    },
    stats: () => stats,
    dispose() {
      for (const m of [warm.mesh, warmSimple, warmFlat, warmRisingSimple, warmRisingFlat, warmScaffold.mesh, scaffolds.mesh]) {
        m.geometry.dispose();
        if (m instanceof InstancedMesh) m.dispose();
      }
      for (const m of models.values()) {
        m.mesh?.geometry.dispose();
        m.mesh?.dispose();
      }
      for (const ch of chunks.values()) {
        for (const form of PER_CHUNK) dropMerged(ch, form);
      }
      for (const group of groups.values()) dropGroup(group);
      root.removeFromParent();
      material.dispose();
      simples.dispose();
      flats.dispose();
      risingSimples.dispose();
      risingFlats.dispose();
      scaffolding.dispose();
    },
  };
}
