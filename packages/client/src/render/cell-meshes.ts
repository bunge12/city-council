// The zoning overlay on screen (issue M2-06): one mesh per 500 m chunk,
// built from the mirror by cell-geometry.ts. A chunk is rebuilt only when
// the mirror says a cell in it changed.
//
// The overlay is drawn only while it is on. Nothing is built until it is
// first turned on, and a chunk that changes while it is off is rebuilt when
// it comes back on, so a player who never opens it pays nothing. Chunks are
// built a few at a time, nearest the camera first, within a time budget per
// frame (`CELLS.buildBudgetMs`), so turning it on over a big city fills it
// in over frames instead of stopping the page. The first chunk still waits
// for the client's cell index, which the mirror builds on its first question
// about cells (PRD, "Cells in the protocol").
//
// Zoom bands (PRD, "Zoom bands"): the street and district bands show each
// cell's lines; the city band shows flat colour with no lines, so an
// unzoned cell, which is only an outline, is not drawn there.
//
// Free zoned ground where no building type fits (issue M2-15) is hatched
// with diagonal stripes in the street and district bands. The marks come
// from the sim's `lotMarksInChunk` on the mirror, built with the chunk.
//
// The material is unlit: it takes no light, casts no shadow and takes none,
// so the colours are the same at every graphics preset and match the legend.
// The renderer reads the mirror; it never writes it.

import { attribute, cameraPosition, float, fract, fwidth, max, min, mix, positionLocal, sRGBTransferEOTF, step, uniform, vec3, vec4 } from "three/tsl";
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, type Object3D } from "three/webgpu";
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type ChunkCellShapes } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { buildCellChunk, type CellArrays } from "./cell-geometry";
import { CELLS } from "./config";

/** Where the overlay reads cells from: the mirror's copy of state. */
export interface CellSource {
  /** The cells of one chunk with their corners, or null before the first snapshot. */
  shapes(chunk: number): ChunkCellShapes | null;
  /** The copy's zone and density arrays, or null before the first snapshot. */
  cells(): { zone: ArrayLike<number>; density: ArrayLike<number> } | null;
  /** By the same slots, the building on each cell or -1, or null for none at all. Cells with a building are not drawn. */
  built?(): ArrayLike<number> | null;
  /** By the order of `shapes(chunk)`, 1 for a cell where no building type fits, hatched. Null for none. */
  marks?(chunk: number): ArrayLike<number> | null;
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
  dispose(): void;
}

/** Furthest a vertex moves in the shader, in metres, so frustum culling allows for it. */
const SHADER_REACH = 20;

/** The overlay's material, and the uniform that is 1 where cells show their lines and 0 in the city band. */
function overlayMaterial() {
  const lines = uniform(1);
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
  const line = max(step(edge.x, reach.x), step(edge.y, reach.y)).mul(lines);
  // A zoned cell's lines are a darker shade of it. An unzoned cell is its outline alone.
  const zoned = fill.a;
  // The colours are sRGB bytes, as the config writes them. The renderer works in linear light.
  const rgb = sRGBTransferEOTF(fill.rgb) as unknown as typeof fill.rgb;
  const shaded = mix(rgb, rgb.mul(mix(float(1), float(CELLS.lineShade), zoned)), line);
  // Free ground no building fits on: diagonal stripes across the world, so neighbouring cells join up.
  const mark = attribute<"float">("cellMark", "float");
  const stripe = step(fract(positionLocal.x.add(positionLocal.z).div(CELLS.noLot.stripeMetres)), float(CELLS.noLot.stripeShare));
  const hatch = sRGBTransferEOTF(vec3(...hexRgb(CELLS.noLot.colour))) as unknown as typeof fill.rgb;
  const colour = mix(shaded, hatch, stripe.mul(mark).mul(lines).mul(line.oneMinus()));
  m.colorNode = vec4(colour, max(zoned, line));
  m.alphaTest = 0.5;
  m.side = DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return { material: m, lines };
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
  const { material, lines } = overlayMaterial();
  const chunks: (ChunkMesh | null)[] = new Array<ChunkMesh | null>(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE).fill(null);
  /** Chunks that changed while the overlay was hidden, or every chunk before it was first built. */
  const dirty = new Set<number>(chunks.keys());
  let stats: CellStats = { visible: false, chunks: 0, zoned: 0, unzoned: 0, marked: 0, pending: dirty.size, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0 };

  function clear(c: number): void {
    const old = chunks[c];
    if (!old) return;
    old.mesh.removeFromParent();
    old.mesh.geometry.dispose();
    chunks[c] = null;
  }

  function build(c: number): void {
    clear(c);
    const shapes = source.shapes(c);
    const cells = source.cells();
    if (!shapes || !cells || shapes.slots.length === 0) return;
    const arrays = buildCellChunk(shapes, cells.zone, cells.density, height, source.built?.() ?? null, source.marks?.(c) ?? null);
    const geometry = geometryOf(arrays);
    if (!geometry) return;
    const mesh = new Mesh(geometry, material);
    mesh.name = `cells ${c % CHUNKS_PER_SIDE},${Math.floor(c / CHUNKS_PER_SIDE)}`;
    mesh.matrixAutoUpdate = false;
    // Over the terrain and the water, under the roads, which draw at 2.
    mesh.renderOrder = 1.5;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
    chunks[c] = { mesh, zoned: arrays.zoned, unzoned: arrays.unzoned, marked: arrays.marked };
  }

  /** Chunks built since the dirty set was last empty, and the milliseconds they took. */
  let batch = 0;
  let batchMs = 0;

  function count(): Pick<CellStats, "chunks" | "zoned" | "unzoned" | "marked"> {
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
    return { chunks: n, zoned, unzoned, marked };
  }

  /**
   * Builds dirty chunks, nearest the camera first, until `budgetMs` has
   * gone; at least one a frame, so the overlay always fills in. Nothing
   * while the overlay is off.
   */
  function update(camera: { x: number; z: number }, budgetMs: number): void {
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
    batch += built;
    batchMs += performance.now() - start;
    stats = { ...stats, ...count(), pending: dirty.size, totalRebuilt: stats.totalRebuilt + built };
    if (dirty.size === 0) {
      stats = { ...stats, lastRebuilt: batch, lastBuildMs: batchMs };
      batch = 0;
      batchMs = 0;
    }
  }

  function markAll(): void {
    for (let c = 0; c < chunks.length; c++) dirty.add(c);
    stats = { ...stats, pending: dirty.size };
  }

  return {
    setVisible(on) {
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
      lines.value = band === "city" ? 0 : 1;
    },
    stats: () => stats,
    dispose() {
      for (let c = 0; c < chunks.length; c++) clear(c);
      root.removeFromParent();
      material.dispose();
    },
  };
}
