// The zoning overlay on screen (issue M2-06): one mesh per 500 m chunk,
// built from the mirror by cell-geometry.ts. A chunk is rebuilt only when
// the mirror says a cell in it changed.
//
// The overlay is drawn only while it is on. No chunk mesh is built until it
// is first turned on, and a chunk that changes while it is off is rebuilt
// when it comes back on. Chunks are built a few at a time, nearest the
// camera first, within a time budget per frame (`CELLS.buildBudgetMs`), so
// turning it on over a big city fills it in over frames instead of stopping
// the page. What the first chunk needs is ready by then (issue #163): the
// client's cell index and building index are built when the city loads
// (PRD, "Cells in the protocol"), the mirror builds the block index the lot
// marks need after each snapshot, and the shader is compiled at load
// (`precompile`). Each chunk looks up buildings and lot marks for its own
// cells only (issues #163 and #164).
//
// Zoom bands (PRD, "Zoom bands"): the street and district bands show each
// cell's lines; the city band shows flat colour with no lines, so an
// unzoned cell, which is only an outline, is not drawn there. Every chunk is
// in view from city height, so the city band has meshes of its own (issue
// #133): a quad per straight run of zoned cells of one colour
// (cell-geometry.ts, `buildCityCells`), made with the chunk's detailed mesh
// from the same read of the mirror, and the runs of `CELLS.cityGroup` ×
// `cityGroup` chunks joined into one mesh.
//
// Free zoned ground where no building type fits (issue M2-15) is hatched
// with diagonal stripes in the street and district bands. The marks come
// from the sim's `lotMarksInChunk` on the mirror, built with the chunk.
//
// The material is unlit: it takes no light, casts no shadow and takes none,
// so the colours are the same at every graphics preset and match the legend.
// The renderer reads the mirror; it never writes it.

import { attribute, cameraPosition, float, fract, fwidth, max, min, mix, positionLocal, sRGBTransferEOTF, step, vec3, vec4 } from "three/tsl";
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, type Object3D } from "three/webgpu";
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type ChunkCellShapes } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { buildCellChunk, buildCityCells, type CellArrays, type CityCellArrays } from "./cell-geometry";
import { CELLS } from "./config";

/** Where the overlay reads cells from: the mirror's copy of state. */
export interface CellSource {
  /** The cells of one chunk with their corners, or null before the first snapshot. */
  shapes(chunk: number): ChunkCellShapes | null;
  /** The copy's zone and density arrays, or null before the first snapshot. */
  cells(): { zone: ArrayLike<number>; density: ArrayLike<number> } | null;
  /** By the order of `shapes(chunk)`, the building on each cell or -1, or null for none at all. Cells with a building are not drawn. */
  built?(shapes: ChunkCellShapes): ArrayLike<number> | null;
  /** By the order of `shapes`, which `shapes(chunk)` just gave, 1 for a cell where no building type fits, hatched. Null for none. */
  marks?(chunk: number, shapes: ChunkCellShapes): ArrayLike<number> | null;
}

/** What the overlay reports, for the debug panel and tests. */
export interface CellStats {
  /** Whether the overlay is on. */
  visible: boolean;
  /** Chunks with a cell mesh. */
  chunks: number;
  /** Cells drawn filled, and as outlines only. */
  zoned: number;
  unzoned: number;
  /** Zoned cells hatched because no building type fits there. */
  marked: number;
  /** The city band's quads, each a run of zoned cells, and its meshes, each a group of chunks. */
  cityRuns: number;
  cityGroups: number;
  /** Chunks waiting to be built. */
  pending: number;
  /**
   * Chunks the last change rebuilt, counted from when chunks started
   * waiting until none were left, and every chunk built since the layer
   * was made. `lastBuildMs` is the time that last change took, summed over
   * the frames it was spread across.
   */
  lastRebuilt: number;
  totalRebuilt: number;
  lastBuildMs: number;
  /**
   * The time the first chunk the layer built spent on its lot marks, and
   * the first frame that built chunks spent on them (issue #164). Each pays
   * once for indexes the sim builds on first use, on the mirror: the cell
   * index on the first frame (issue #163), the block index on the first
   * lot marks.
   */
  firstMarksMs: number;
  firstFrameMs: number;
  /** The longest any later chunk's lot marks took, and any later frame spent building chunks. All four start again on `reset`. */
  slowestMarksMs: number;
  slowestFrameMs: number;
}

export interface CellLayer {
  /** Shows or hides the overlay. A chunk that changed while it was hidden is built once it shows. */
  setVisible(on: boolean): void;
  /** Every chunk may have changed, as after a snapshot. Marks them all to build. */
  reset(): void;
  /** Marks the chunks a delta changed, as the mirror numbers them, to build. */
  apply(chunks: readonly number[]): void;
  /**
   * Called once a frame: builds waiting chunks, nearest the camera at
   * (x, z) first, for about `budgetMs`, so a big change spreads over
   * frames instead of stopping one.
   */
  update(camera: { x: number; z: number }, budgetMs: number): void;
  setBand(band: ZoomBand): void;
  stats(): CellStats;
  /**
   * Compiles the overlay's shaders with `compile`, the detailed one and the
   * city band's, each on a stand-in quad, so the first frame the overlay
   * shows does not build them (issue #163). The renderer caches programs by
   * their code, so the real chunks find them ready.
   */
  precompile(compile: (object: Object3D) => Promise<void>): Promise<void>;
  dispose(): void;
}

/** A cell's corners as `buildCellChunk` lays them out, for the stand-in quad `precompile` draws. */
const CORNER_UVS = [0, 0, 255, 0, 255, 255, 0, 255];

/** Furthest a vertex moves in the shader, in metres, so frustum culling allows for it. */
const SHADER_REACH = 20;

/** The overlay's material in the street and district bands, with each cell's lines. */
function overlayMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = "zoning cells";
  const distance = cameraPosition.distance(positionLocal);
  m.positionNode = positionLocal.add(vec3(0, distance.mul(CELLS.lift.perMetre).add(CELLS.lift.base), 0));
  const fill = attribute<"vec4">("cellFill", "vec4");
  const at = attribute<"vec2">("cellCorner", "vec2");
  // How far into the cell a line reaches, in cell units: a few pixels, but
  // never more than a share of a cell drawn only a few pixels wide.
  const reach = min(fwidth(at).mul(CELLS.linePx), float(CELLS.lineMaxShare));
  const edge = min(at, at.oneMinus());
  const line = max(step(edge.x, reach.x), step(edge.y, reach.y));
  // A zoned cell's lines are a darker shade of it. An unzoned cell is its outline alone.
  const zoned = fill.a;
  // The colours are sRGB bytes, as the config writes them. The renderer works in linear light.
  const rgb = sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb;
  const shaded = mix(rgb, rgb.mul(mix(float(1), float(CELLS.lineShade), zoned)), line);
  // Free ground no building fits on: diagonal stripes across the world, so neighbouring cells join up.
  const mark = attribute<"float">("cellMark", "float");
  const stripe = step(fract(positionLocal.x.add(positionLocal.z).div(CELLS.noLot.stripeMetres)), float(CELLS.noLot.stripeShare));
  const hatch = sRGBTransferEOTF(vec3(...hexRgb(CELLS.noLot.colour))) as unknown as typeof fill.rgb;
  const colour = mix(shaded, hatch, stripe.mul(mark).mul(line.oneMinus()));
  m.colorNode = vec4(colour, max(zoned, line));
  m.alphaTest = 0.5;
  m.side = DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

/** The overlay's material in the city band: flat colour, lifted as the detailed cells are. */
function cityMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = "zoning cells, city band";
  const distance = cameraPosition.distance(positionLocal);
  m.positionNode = positionLocal.add(vec3(0, distance.mul(CELLS.lift.perMetre).add(CELLS.lift.base), 0));
  const fill = attribute<"vec4">("cellFill", "vec4");
  m.colorNode = vec4(sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb, 1);
  m.side = DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

/** Chunks a side of a city band group, and groups a side of the map. */
const CITY_GROUP = CELLS.cityGroup;
const CITY_GROUPS_PER_SIDE = Math.ceil(CHUNKS_PER_SIDE / CITY_GROUP);

/** The city band group chunk `c` is drawn in. */
export function cityGroupOf(c: number): number {
  const ci = c % CHUNKS_PER_SIDE;
  const cj = (c - ci) / CHUNKS_PER_SIDE;
  return Math.floor(cj / CITY_GROUP) * CITY_GROUPS_PER_SIDE + Math.floor(ci / CITY_GROUP);
}

/** The chunks of city band group `g`. */
function chunksOfGroup(g: number): number[] {
  const gi = g % CITY_GROUPS_PER_SIDE;
  const gj = (g - gi) / CITY_GROUPS_PER_SIDE;
  const out: number[] = [];
  for (let cj = gj * CITY_GROUP; cj < Math.min(CHUNKS_PER_SIDE, (gj + 1) * CITY_GROUP); cj++) {
    for (let ci = gi * CITY_GROUP; ci < Math.min(CHUNKS_PER_SIDE, (gi + 1) * CITY_GROUP); ci++) out.push(cj * CHUNKS_PER_SIDE + ci);
  }
  return out;
}

/** Several chunks' city band runs as one geometry, or null for none. */
function cityGeometryOf(parts: readonly CityCellArrays[]): BufferGeometry | null {
  let runs = 0;
  for (const p of parts) runs += p.runs;
  if (runs === 0) return null;
  const positions = new Float32Array(runs * 12);
  const fills = new Uint8Array(runs * 16);
  const indices = runs * 4 > 0xffff ? new Uint32Array(runs * 6) : new Uint16Array(runs * 6);
  let v = 0;
  let i = 0;
  for (const p of parts) {
    positions.set(p.positions, v * 3);
    fills.set(p.fills, v * 4);
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = v + (p.indices[k] ?? 0);
    v += p.runs * 4;
    i += p.indices.length;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setAttribute("cellFill", new BufferAttribute(fills, 4, true));
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += SHADER_REACH;
  return g;
}

/** Chunk `c` and the up to eight chunks around it. */
export function withNeighbours(c: number): number[] {
  const ci = c % CHUNKS_PER_SIDE;
  const cj = (c - ci) / CHUNKS_PER_SIDE;
  const out: number[] = [];
  for (let j = Math.max(0, cj - 1); j <= Math.min(CHUNKS_PER_SIDE - 1, cj + 1); j++) {
    for (let i = Math.max(0, ci - 1); i <= Math.min(CHUNKS_PER_SIDE - 1, ci + 1); i++) out.push(j * CHUNKS_PER_SIDE + i);
  }
  return out;
}

/** An sRGB hex colour as r, g, b from 0 to 1. */
function hexRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function geometryOf(a: CellArrays): BufferGeometry | null {
  if (a.indices.length === 0) return null;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(a.positions, 3));
  g.setAttribute("cellFill", new BufferAttribute(a.fills, 4, true));
  g.setAttribute("cellCorner", new BufferAttribute(a.corners, 2, true));
  g.setAttribute("cellMark", new BufferAttribute(a.marks, 1));
  g.setIndex(new BufferAttribute(a.indices, 1));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += SHADER_REACH;
  return g;
}

interface ChunkMesh {
  mesh: Mesh;
  zoned: number;
  unzoned: number;
  marked: number;
}

export function createCellLayer(parent: Object3D, source: CellSource, height: (x: number, z: number) => number): CellLayer {
  const root = new Group();
  root.name = "zoning cells";
  root.visible = false;
  parent.add(root);
  /** The street and district bands' meshes, one per chunk, and the city band's, one per group of chunks. */
  const detail = new Group();
  detail.name = "zoning cells by chunk";
  const city = new Group();
  city.name = "zoning cells, city band";
  city.visible = false;
  root.add(detail, city);
  const material = overlayMaterial();
  const coarse = cityMaterial();
  const chunks: (ChunkMesh | null)[] = new Array<ChunkMesh | null>(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE).fill(null);
  /** Each chunk's city band runs, kept to join into its group's mesh. */
  const cityParts: (CityCellArrays | null)[] = new Array<CityCellArrays | null>(chunks.length).fill(null);
  const cityMeshes = new Map<number, Mesh>();
  /** Groups whose mesh is to be joined again from their chunks' runs. */
  const cityDirty = new Set<number>();
  /** Chunks that changed while the overlay was hidden, or every chunk before it was first built. */
  const dirty = new Set<number>(chunks.keys());
  let stats: CellStats = { visible: false, chunks: 0, zoned: 0, unzoned: 0, marked: 0, cityRuns: 0, cityGroups: 0, pending: dirty.size, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0, firstMarksMs: 0, firstFrameMs: 0, slowestMarksMs: 0, slowestFrameMs: 0 };

  function clear(c: number): void {
    if (cityParts[c]) cityDirty.add(cityGroupOf(c));
    cityParts[c] = null;
    const old = chunks[c];
    if (!old) return;
    old.mesh.removeFromParent();
    old.mesh.geometry.dispose();
    chunks[c] = null;
  }

  function clearGroup(g: number): void {
    const old = cityMeshes.get(g);
    if (!old) return;
    old.removeFromParent();
    old.geometry.dispose();
    cityMeshes.delete(g);
  }

  /** Joins a group's runs into its city band mesh again. */
  function buildGroup(g: number): void {
    clearGroup(g);
    const parts: CityCellArrays[] = [];
    for (const c of chunksOfGroup(g)) {
      const p = cityParts[c];
      if (p) parts.push(p);
    }
    const geometry = cityGeometryOf(parts);
    if (!geometry) return;
    const mesh = new Mesh(geometry, coarse);
    const gi = g % CITY_GROUPS_PER_SIDE;
    mesh.name = `city cells ${gi},${(g - gi) / CITY_GROUPS_PER_SIDE}`;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1.5;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData["runs"] = parts.reduce((n, p) => n + p.runs, 0);
    city.add(mesh);
    cityMeshes.set(g, mesh);
  }

  /** Whether no chunk has been built since the layer was made or reset, so the next chunk and frame are the first. */
  let firstMarks = true;
  let firstFrame = true;

  function build(c: number): void {
    clear(c);
    const shapes = source.shapes(c);
    const cells = source.cells();
    if (!shapes || !cells || shapes.slots.length === 0) return;
    const built = source.built?.(shapes) ?? null;
    const runs = buildCityCells(shapes, cells.zone, cells.density, height, built);
    if (runs.runs > 0) {
      cityParts[c] = runs;
      cityDirty.add(cityGroupOf(c));
    }
    const marksStart = performance.now();
    const marks = source.marks?.(c, shapes) ?? null;
    const marksMs = performance.now() - marksStart;
    if (firstMarks) stats = { ...stats, firstMarksMs: marksMs };
    else if (marksMs > stats.slowestMarksMs) stats = { ...stats, slowestMarksMs: marksMs };
    firstMarks = false;
    const arrays = buildCellChunk(shapes, cells.zone, cells.density, height, built, marks);
    const geometry = geometryOf(arrays);
    if (!geometry) return;
    const mesh = new Mesh(geometry, material);
    mesh.name = `cells ${c % CHUNKS_PER_SIDE},${Math.floor(c / CHUNKS_PER_SIDE)}`;
    mesh.matrixAutoUpdate = false;
    // Over the terrain and the water, under the roads, which draw at 2.
    mesh.renderOrder = 1.5;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    detail.add(mesh);
    chunks[c] = { mesh, zoned: arrays.zoned, unzoned: arrays.unzoned, marked: arrays.marked };
  }

  /** Chunks built since the dirty set was last empty, and the milliseconds they took. */
  let batch = 0;
  let batchMs = 0;

  function count(): Pick<CellStats, "chunks" | "zoned" | "unzoned" | "marked" | "cityRuns" | "cityGroups"> {
    let n = 0;
    let zoned = 0;
    let unzoned = 0;
    let marked = 0;
    for (const c of chunks) {
      if (!c) continue;
      n++;
      zoned += c.zoned;
      unzoned += c.unzoned;
      marked += c.marked;
    }
    let cityRuns = 0;
    for (const m of cityMeshes.values()) cityRuns += Number(m.userData["runs"] ?? 0);
    return { chunks: n, zoned, unzoned, marked, cityRuns, cityGroups: cityMeshes.size };
  }

  /**
   * True from when the overlay is turned on until the next frame. That frame
   * builds no chunk: it already holds the zone tool's first preview and its
   * panel, and a chunk on top took it to about 40 ms on the scale town
   * (issue #163).
   */
  let shown = false;

  /**
   * Builds dirty chunks, nearest the camera first, until `budgetMs` has
   * gone; at least one a frame, so the overlay always fills in, except on
   * the frame after it is turned on. Nothing while the overlay is off.
   */
  function update(camera: { x: number; z: number }, budgetMs: number): void {
    if (shown) {
      shown = false;
      return;
    }
    if (!root.visible || dirty.size === 0) return;
    const start = performance.now();
    const centre = (c: number) => {
      const ci = c % CHUNKS_PER_SIDE;
      const cj = (c - ci) / CHUNKS_PER_SIDE;
      return Math.hypot((ci + 0.5) * CHUNK_SIZE - camera.x, (cj + 0.5) * CHUNK_SIZE - camera.z);
    };
    const list = [...dirty].map((c) => ({ c, d: centre(c) })).sort((a, b) => a.d - b.d || a.c - b.c);
    let built = 0;
    for (const { c } of list) {
      if (built > 0 && performance.now() - start >= budgetMs) break;
      dirty.delete(c);
      build(c);
      built++;
    }
    // Joining a group's runs is cheap beside reading a chunk: every group a built chunk touched is joined again in the same frame, so the two bands never disagree.
    for (const g of cityDirty) buildGroup(g);
    cityDirty.clear();
    const frameMs = performance.now() - start;
    batch += built;
    batchMs += frameMs;
    const times = firstFrame ? { firstFrameMs: frameMs } : { slowestFrameMs: Math.max(stats.slowestFrameMs, frameMs) };
    firstFrame = false;
    stats = { ...stats, ...count(), ...times, pending: dirty.size, totalRebuilt: stats.totalRebuilt + built };
    if (dirty.size === 0) {
      stats = { ...stats, lastRebuilt: batch, lastBuildMs: batchMs };
      batch = 0;
      batchMs = 0;
    }
  }

  function markAll(): void {
    // A snapshot is a new copy of state, whose indexes are built again on first use.
    firstMarks = true;
    firstFrame = true;
    stats = { ...stats, firstMarksMs: 0, firstFrameMs: 0, slowestMarksMs: 0, slowestFrameMs: 0 };
    for (let c = 0; c < chunks.length; c++) dirty.add(c);
    stats = { ...stats, pending: dirty.size };
  }

  return {
    setVisible(on) {
      if (on && !root.visible) shown = true;
      root.visible = on;
      stats = { ...stats, visible: on };
    },
    reset: markAll,
    apply(changed) {
      // A lot mark follows from the ground a lot could take, which can cross
      // into the chunk next door, so the neighbours are drawn again too.
      for (const c of changed) for (const n of withNeighbours(c)) dirty.add(n);
      stats = { ...stats, pending: dirty.size };
    },
    update,
    setBand(band) {
      detail.visible = band !== "city";
      city.visible = band === "city";
    },
    stats: () => stats,
    async precompile(compile) {
      // One cell, with every attribute the chunks carry, in their formats.
      const geometry = geometryOf({
        positions: new Float32Array(12),
        fills: new Uint8Array(16),
        corners: Uint8Array.from(CORNER_UVS),
        marks: new Float32Array(4),
        indices: Uint16Array.of(0, 1, 2, 0, 2, 3),
        zoned: 0,
        unzoned: 1,
        marked: 0,
      });
      // And one city band run, for the coarse material.
      const run = cityGeometryOf([{ positions: new Float32Array(12), fills: new Uint8Array(16), indices: Uint32Array.of(0, 1, 2, 0, 2, 3), runs: 1, cells: 1 }]);
      const stands = [geometry && new Mesh(geometry, material), run && new Mesh(run, coarse)].flatMap((m) => m ?? []);
      try {
        for (const stand of stands) {
          stand.renderOrder = 1.5;
          stand.frustumCulled = false;
          await compile(stand);
        }
      } finally {
        geometry?.dispose();
        run?.dispose();
      }
    },
    dispose() {
      for (let c = 0; c < chunks.length; c++) clear(c);
      for (const g of [...cityMeshes.keys()]) clearGroup(g);
      root.removeFromParent();
      material.dispose();
      coarse.dispose();
    },
  };
}
