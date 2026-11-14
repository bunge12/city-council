// The zoning overlay on screen (issue M2-06): one mesh per 500 m chunk,
// built from the mirror by cell-geometry.ts. A chunk is rebuilt only when
// the mirror says a cell in it changed.
//
// The overlay is drawn only while it is on. Nothing is built until it is
// first turned on, and a chunk that changes while it is off is rebuilt when
// it comes back on, so a player who never opens it pays nothing.
//
// Zoom bands (PRD, "Zoom bands"): the street and district bands show each
// cell's lines; the city band shows flat colour with no lines, so an
// unzoned cell, which is only an outline, is not drawn there.
//
// The material is unlit: it takes no light, casts no shadow and takes none,
// so the colours are the same at every graphics preset and match the legend.
// The renderer reads the mirror; it never writes it.

import { attribute, cameraPosition, float, fwidth, max, min, mix, positionLocal, sRGBTransferEOTF, step, uniform, vec3, vec4 } from "three/tsl";
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, type Object3D } from "three/webgpu";
import { CHUNKS_PER_SIDE, type ChunkCellShapes } from "@city-council/sim";
import type { ZoomBand } from "../camera/zoom-band";
import { buildCellChunk, type CellArrays } from "./cell-geometry";
import { CELLS } from "./config";

/** Where the overlay reads cells from: the mirror's copy of state. */
export interface CellSource {
  /** The cells of one chunk with their corners, or null before the first snapshot. */
  shapes(chunk: number): ChunkCellShapes | null;
  /** The copy's zone and density arrays, or null before the first snapshot. */
  cells(): { zone: ArrayLike<number>; density: ArrayLike<number> } | null;
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
  /** Chunks rebuilt by the last change, and since the overlay was first built. */
  lastRebuilt: number;
  totalRebuilt: number;
  /** Milliseconds the last rebuild took. */
  lastBuildMs: number;
}

export interface CellLayer {
  /** Shows or hides the overlay. Showing it builds any chunk that changed while it was hidden. */
  setVisible(on: boolean): void;
  /** Every chunk may have changed, as after a snapshot. */
  reset(): void;
  /** The chunks a delta changed, as the mirror numbers them. */
  apply(chunks: readonly number[]): void;
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
  const colour = mix(rgb, rgb.mul(mix(float(1), float(CELLS.lineShade), zoned)), line);
  m.colorNode = vec4(colour, max(zoned, line));
  m.alphaTest = 0.5;
  m.side = DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return { material: m, lines };
}

function geometryOf(a: CellArrays): BufferGeometry | null {
  if (a.indices.length === 0) return null;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(a.positions, 3));
  g.setAttribute("cellFill", new BufferAttribute(a.fills, 4, true));
  g.setAttribute("cellCorner", new BufferAttribute(a.corners, 2, true));
  g.setIndex(new BufferAttribute(a.indices, 1));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += SHADER_REACH;
  return g;
}

interface ChunkMesh {
  mesh: Mesh;
  zoned: number;
  unzoned: number;
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
  let stats: CellStats = { visible: false, chunks: 0, zoned: 0, unzoned: 0, lastRebuilt: 0, totalRebuilt: 0, lastBuildMs: 0 };

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
    const arrays = buildCellChunk(shapes, cells.zone, cells.density, height);
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
    chunks[c] = { mesh, zoned: arrays.zoned, unzoned: arrays.unzoned };
  }

  /** Builds every dirty chunk, if the overlay is on. */
  function flush(): void {
    if (!root.visible || dirty.size === 0) return;
    const start = performance.now();
    const list = [...dirty].sort((a, b) => a - b);
    dirty.clear();
    for (const c of list) build(c);
    let n = 0;
    let zoned = 0;
    let unzoned = 0;
    for (const c of chunks) {
      if (!c) continue;
      n++;
      zoned += c.zoned;
      unzoned += c.unzoned;
    }
    stats = {
      visible: true,
      chunks: n,
      zoned,
      unzoned,
      lastRebuilt: list.length,
      totalRebuilt: stats.totalRebuilt + list.length,
      lastBuildMs: performance.now() - start,
    };
  }

  return {
    setVisible(on) {
      root.visible = on;
      stats = { ...stats, visible: on };
      flush();
    },
    reset() {
      for (let c = 0; c < chunks.length; c++) dirty.add(c);
      flush();
    },
    apply(changed) {
      for (const c of changed) dirty.add(c);
      flush();
    },
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
