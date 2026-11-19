// The renderer: three.js WebGPURenderer with the WebGL 2 backend as the
// fallback, a fixed-daylight scene, the chunked terrain, the water plane,
// the roads, the decorative trees and grass, the zoning overlay and the
// buildings.
//
// The render loop runs on the browser's frame clock and never waits on the
// sim. It reads the mirror; it does not drive the sim.

import {
  BufferAttribute,
  BufferGeometry,
  Frustum,
  LOD,
  Matrix4,
  Mesh,
  MeshLambertNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector2,
  WebGPURenderer,
} from "three/webgpu";
import { heightAt, mapSize, type Terrain } from "@city-council/sim";
import { BUILDINGS, CELLS, FRAME_TIME_WINDOW, LOD_HYSTERESIS, MAX_PIXEL_RATIO, PRESET_BENCHMARK, TERRAIN_LODS } from "./config";
import type { Ray } from "../camera/pick";
import type { ZoomBand } from "../camera/zoom-band";
import { createBuildingLayer, type BuildingLayer, type BuildingSource, type BuildingStats } from "./building-meshes";
import { createCellLayer, type CellLayer, type CellSource, type CellStats } from "./cell-meshes";
import { createDecorLayer, type DecorLayer } from "./decor-meshes";
import { createLighting, skyColour, type LightingReport } from "./lighting";
import type { Preset } from "./presets";
import { neighbourhood, type RoadNet } from "./road-geometry";
import { NORTH_AMERICAN } from "../theme/north-american";
import { createRoadLayer, type RoadLayer, type RoadStats } from "./road-meshes";
import { buildChunk, chunkCentre, chunksPerSide, surfaceHeightAt } from "./terrain-chunks";
import { SURFACE_HEIGHT_ATTRIBUTE, createTerrainMaterial } from "./terrain-material";

export type Backend = "webgpu" | "webgl2";

/** What the render loop reports, for the debug readout. */
export interface FrameStats {
  /** Mean time between frames over the last window, in ms. */
  frameMs: number;
  /** Frames per second implied by `frameMs`. */
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface View {
  backend: Backend;
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /**
   * Places the camera at `position`, looking at `target`, both in world
   * metres. Raw: bypasses the camera rig and its limits. For tests.
   */
  setCamera(position: readonly [number, number, number], target: readonly [number, number, number]): void;
  /** Builds the terrain chunks and water for a map, replacing any already shown. */
  showTerrain(terrain: Terrain): void;
  /** Called before each frame is drawn, with the seconds since the last one. */
  onBeforeFrame(listener: (seconds: number) => void): void;
  /** Called after each frame with the latest stats. */
  onFrame(listener: (stats: FrameStats) => void): void;
  /** Chunks drawn at each level of detail in the last frame, nearest level first. */
  lodCounts(): number[];
  /** Trees and grass tufts drawn in the last frame. */
  decorCounts(): { trees: number; grass: number };
  /** Draws a road network from scratch, as after a snapshot. Call after `showTerrain`. */
  showRoads(net: RoadNet): void;
  /** Redraws what a delta's changed road rows touch. Returns the chunks rebuilt. */
  updateRoads(nodeIds: readonly number[], segIds: readonly number[]): number[];
  /** Shows the road layers for a zoom band, with the camera `height` metres over the ground. */
  setZoomBand(band: ZoomBand, height: number): void;
  roadStats(): RoadStats | null;
  /**
   * The zoning overlay (issue M2-06). `cellSource` is where it reads cells,
   * the mirror. Set it before `showTerrain`.
   */
  setCellSource(source: CellSource): void;
  /** Shows or hides the zoning overlay. */
  setCellsVisible(on: boolean): void;
  /** Redraws the cells of every chunk, as after a snapshot, over the next frames. */
  showCells(): void;
  /** Redraws the cells of the chunks a delta changed, over the next frames. */
  updateCells(chunks: readonly number[]): void;
  cellStats(): CellStats | null;
  /**
   * The buildings (issue M2-12). `source` is where they are read from, the
   * mirror. Set it before `showTerrain`.
   */
  setBuildingSource(source: BuildingSource): void;
  /** The chunk's buildings' form shown whole, or null. For tests. */
  buildingForm(chunk: number): "full" | "simple" | "box" | "flat" | null;
  /** Draws every building again, as after a snapshot, over the next frames. */
  showBuildings(): void;
  /**
   * Brings the buildings in line with a delta: every building in the chunks
   * whose roads changed is placed again, and in `changed` only the
   * buildings that came or went are written. `ids` are the buildings the
   * delta carried: the chunks they were drawn in and are in now are
   * brought up to date too, for a delta whose road change left the
   * mirror unable to say where they are.
   */
  updateBuildings(roadChunks: readonly number[], changed: readonly number[], ids: readonly number[]): void;
  buildingStats(): BuildingStats | null;
  /** The building whose drawn box the ray enters first, or -1 (issue 116). */
  pickBuilding(ray: Ray, limit?: number): number;
  /** Changes whenever a chunk's buildings change form, so a pick made before is stale. */
  buildingFormVersion(): number;
  /** The middle of the top of building `id` as drawn, or null. */
  buildingTop(id: number): { x: number; y: number; z: number } | null;
  /**
   * The game tick to draw buildings at, for those under construction (issue
   * 136). Null draws every building finished.
   */
  setGameTick(tick: number | null): void;
  /** The colours building `id` is drawn in, as sRGB hex, or null. For tests. */
  buildingTint(id: number): { wall: number; roof: number; trim: number } | null;
  /** Switches the lighting to a graphics preset once its shaders are compiled. */
  setPreset(preset: Preset): Promise<void>;
  /** The lighting on screen: its preset and its shadows. */
  lighting(): LightingReport;
  /**
   * The first-run benchmark: draws the current view into an offscreen
   * target, waits for the GPU, and returns the mean milliseconds per draw.
   * See PRESET_BENCHMARK.
   */
  benchmark(): Promise<number>;
  /**
   * Whether every build queue is empty: no chunk of buildings, cells or
   * decoration waits to be built and no building fade is under way. The
   * canvas carries it as `data-render-settled` after each frame.
   */
  settled(): boolean;
  /**
   * Only with `?flush`, for tests (issue #223): builds every pending
   * building, cell and decoration chunk now, with no budget, shows each
   * chunk's buildings in the form it wants without the fade, and draws
   * once. Players get the per-frame budget.
   */
  flush?: () => void;
}

/** Two decoration masks as one: a cell either masks is masked. */
function joinMasks(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (!a) return b;
  if (!b) return a;
  const out = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = (a[k] ?? 0) | (b[k] ?? 0);
  return out;
}

/** True when the page asks for the WebGL 2 backend with `?webgl`. */
export function wantsWebGL(search: string): boolean {
  return new URLSearchParams(search).has("webgl");
}

const WATER = 0x3a6f8f;

/** Rounds of building `View.flush` runs at most before it draws, settled or not. */
const FLUSH_ROUNDS = 8;

/** Test hooks a page asks for in its query: `?flush` adds `View.flush`. */
export function viewOptions(search: string): { flush: boolean } {
  return { flush: new URLSearchParams(search).has("flush") };
}

export async function createView(canvas: HTMLCanvasElement, forceWebGL: boolean, options: { flush: boolean } = { flush: false }): Promise<View> {
  const useWebGL = forceWebGL || !("gpu" in navigator);
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: useWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  await renderer.init();
  const backendObj = renderer.backend as { isWebGPUBackend?: boolean };
  const backend: Backend = backendObj.isWebGPUBackend === true ? "webgpu" : "webgl2";

  const scene = new Scene();
  scene.background = skyColour();

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 10, 60_000);

  // Fixed daylight: one sun and one ambient light, lit as the graphics
  // preset says. No day and night cycle in v1. Until a preset is set the
  // scene is lit as Low, so the first frame needs no shadow shaders.
  const lighting = createLighting(renderer, scene);

  let terrainRoot: {
    terrain: Terrain;
    lods: LOD[];
    decor: DecorLayer;
    roads: RoadLayer;
    cells: CellLayer | null;
    buildings: BuildingLayer | null;
    dispose: () => void;
  } | null = null;
  let band: ZoomBand = "city";
  let height = Infinity;
  let cellSource: CellSource | null = null;
  let buildingSource: BuildingSource | null = null;
  let cellsVisible = false;

  function showTerrain(terrain: Terrain): void {
    terrainRoot?.dispose();
    const material = createTerrainMaterial(terrain);
    const per = chunksPerSide(terrain);
    const lods: LOD[] = [];
    const geometries: BufferGeometry[] = [];
    for (let cj = 0; cj < per; cj++) {
      for (let ci = 0; ci < per; ci++) {
        const lod = new LOD();
        const c = chunkCentre(ci, cj);
        lod.position.set(c.x, 0, c.z);
        lod.name = `chunk ${ci},${cj}`;
        for (const level of TERRAIN_LODS) {
          const g = buildChunk(terrain, ci, cj, level.segments);
          const geometry = new BufferGeometry();
          geometry.setAttribute("position", new BufferAttribute(g.positions, 3));
          geometry.setAttribute("normal", new BufferAttribute(g.normals, 3));
          geometry.setAttribute(SURFACE_HEIGHT_ATTRIBUTE, new BufferAttribute(g.surfaceHeights, 1));
          geometry.setIndex(new BufferAttribute(g.indices, 1));
          geometry.computeBoundingSphere();
          geometries.push(geometry);
          const mesh = new Mesh(geometry, material);
          // Terrain takes shadows but casts none: it would shade itself in stripes.
          mesh.receiveShadow = true;
          // The LOD sits at the chunk centre so its distance test works; the
          // mesh undoes that offset. c + (-c) is exactly 0, so every chunk's
          // world matrix is exactly the identity (see terrain-chunks.ts).
          mesh.position.set(-c.x, 0, -c.z);
          mesh.updateMatrix();
          mesh.matrixAutoUpdate = false;
          lod.addLevel(mesh, level.from, LOD_HYSTERESIS);
        }
        lod.updateMatrix();
        lod.matrixAutoUpdate = false;
        lods.push(lod);
        scene.add(lod);
      }
    }

    const size = mapSize(terrain);
    const waterGeometry = new PlaneGeometry(size, size);
    waterGeometry.rotateX(-Math.PI / 2);
    const waterMaterial = new MeshLambertNodeMaterial({ color: WATER, transparent: true, opacity: 0.82 });
    waterMaterial.depthWrite = false;
    const water = new Mesh(waterGeometry, waterMaterial);
    water.name = "water";
    water.position.set(size / 2, terrain.waterLevel, size / 2);
    // Drawn after the terrain so the bed shows through.
    water.renderOrder = 1;
    scene.add(water);

    const roads = createRoadLayer(terrain, scene);
    roads.setBand(band, height);
    // Trees and grass keep off roads and off the lots of buildings drawn.
    let buildingsLayer: BuildingLayer | null = null;
    const decor = createDecorLayer(terrain, scene, (chunk) => joinMasks(roads.decorMask(chunk), buildingsLayer?.lotMask(chunk) ?? null));
    const cells = cellSource ? createCellLayer(scene, cellSource, (x, z) => heightAt(terrain, x, z)) : null;
    cells?.setBand(band);
    cells?.setVisible(cellsVisible);
    // The overlay is hidden until the zone tool opens; its shader is compiled now, so that frame does not build it (issue #163).
    void cells?.precompile((o) => renderer.compileAsync(o, camera, scene)).catch(() => undefined);
    // Buildings stand on the ground as the nearest terrain draws it, so it never comes up through a wall.
    const buildings = buildingSource ? createBuildingLayer(scene, buildingSource, NORTH_AMERICAN, (x, z) => surfaceHeightAt(terrain, x, z, TERRAIN_LODS[0]?.segments ?? 32)) : null;
    buildingsLayer = buildings;

    terrainRoot = {
      terrain,
      lods,
      decor,
      roads,
      cells,
      buildings,
      dispose() {
        buildings?.dispose();
        cells?.dispose();
        decor.dispose();
        roads.dispose();
        for (const lod of lods) scene.remove(lod);
        scene.remove(water);
        for (const g of geometries) g.dispose();
        waterGeometry.dispose();
        material.dispose();
        waterMaterial.dispose();
      },
    };
  }

  function setCamera(position: readonly [number, number, number], target: readonly [number, number, number]): void {
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
  }

  function resize(): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  let gameTick: number | null = null;
  const before: ((seconds: number) => void)[] = [];
  const listeners: ((stats: FrameStats) => void)[] = [];
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const gaps = new Float64Array(FRAME_TIME_WINDOW);
  let gapCount = 0;
  let gapSum = 0;
  let last = -1;
  /**
   * One frame's building work: buildings, then the decoration and cells
   * their lots touched, each within its budget. `flush` builds everything
   * pending with no budget and ends any fade at once.
   */
  function build(seconds: number, flush: boolean): void {
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem);
    const view = { band, seconds: flush ? Infinity : seconds, frustum, ...(gameTick !== null ? { tick: gameTick } : {}), ...(flush ? { noAhead: true } : {}) };
    terrainRoot?.buildings?.update(camera.position, flush ? Infinity : BUILDINGS.buildBudgetMs, view);
    // Cells under a lot that reaches over a chunk line are in a chunk the delta did not name.
    const lots = terrainRoot?.buildings?.takeLotChunks() ?? [];
    if (lots.length > 0) {
      terrainRoot?.cells?.apply(lots);
      terrainRoot?.decor.refresh(lots);
    }
    // After the refresh, so a chunk whose lots or roads changed this frame is built again before it is drawn (issue 141).
    terrainRoot?.decor.update(camera.position, flush ? Infinity : undefined);
    terrainRoot?.cells?.update(camera.position, flush ? Infinity : CELLS.buildBudgetMs);
  }

  /** Whether every build queue is empty: buildings, their forms and fades, the decoration in range, and the overlay's cells while it is shown. */
  function settled(): boolean {
    const root = terrainRoot;
    if (!root) return false;
    if (root.buildings && !root.buildings.idle()) return false;
    if (root.decor.pending() > 0) return false;
    const cells = root.cells?.stats();
    return !cells?.visible || cells.pending === 0;
  }

  function draw(): FrameStats {
    const shown = terrainRoot?.terrain;
    lighting.update(camera, shown ? (x, z) => heightAt(shown, x, z) : null);
    renderer.render(scene, camera);
    canvas.dataset["renderSettled"] = String(settled());
    const frames = Math.min(gapCount, FRAME_TIME_WINDOW);
    const frameMs = frames > 0 ? gapSum / frames : 0;
    return {
      frameMs,
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    };
  }

  renderer.setAnimationLoop((time: number) => {
    const seconds = last >= 0 ? (time - last) / 1000 : 0;
    for (const b of before) b(seconds);
    build(seconds, false);
    if (last >= 0) {
      const slot = gapCount % FRAME_TIME_WINDOW;
      gapSum += time - last - (gaps[slot] ?? 0);
      gaps[slot] = time - last;
      gapCount++;
    }
    last = time;
    const stats = draw();
    for (const l of listeners) l(stats);
  });

  /**
   * Builds every pending chunk now, ends every fade, and draws once (issue
   * #223). A fade that ends can start another, and a lot built can mark
   * decoration and cells, so it builds again until nothing is left, a few
   * rounds at most. The frame clock does not see it.
   */
  function flush(): void {
    for (const b of before) b(0);
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      build(0, true);
      if (settled()) break;
    }
    const stats = draw();
    for (const l of listeners) l(stats);
  }

  return {
    backend,
    renderer,
    scene,
    camera,
    setCamera,
    showTerrain,
    onBeforeFrame: (b) => before.push(b),
    onFrame: (l) => listeners.push(l),
    lodCounts() {
      const counts = TERRAIN_LODS.map(() => 0);
      for (const lod of terrainRoot?.lods ?? []) {
        const level = lod.getCurrentLevel();
        counts[level] = (counts[level] ?? 0) + 1;
      }
      return counts;
    },
    decorCounts: () => terrainRoot?.decor.counts() ?? { trees: 0, grass: 0 },
    showRoads(net) {
      if (!terrainRoot) return;
      terrainRoot.roads.show(net);
      // Every chunk: one that had roads before this snapshot may have none now.
      terrainRoot.decor.refresh(terrainRoot.lods.map((_, chunk) => chunk));
    },
    updateRoads(nodeIds, segIds) {
      if (!terrainRoot) return [];
      const rebuilt = terrainRoot.roads.apply(nodeIds, segIds);
      terrainRoot.decor.refresh(new Set(rebuilt.flatMap(neighbourhood)));
      return rebuilt;
    },
    setZoomBand(next, nextHeight) {
      band = next;
      height = nextHeight;
      terrainRoot?.roads.setBand(next, nextHeight);
      terrainRoot?.cells?.setBand(next);
    },
    roadStats: () => terrainRoot?.roads.stats() ?? null,
    setCellSource(source) {
      cellSource = source;
    },
    setCellsVisible(on) {
      cellsVisible = on;
      terrainRoot?.cells?.setVisible(on);
    },
    showCells: () => terrainRoot?.cells?.reset(),
    updateCells: (chunks) => terrainRoot?.cells?.apply(chunks),
    cellStats: () => terrainRoot?.cells?.stats() ?? null,
    setBuildingSource(source) {
      buildingSource = source;
    },
    showBuildings: () => terrainRoot?.buildings?.reset(),
    updateBuildings(roadChunks, changed, ids) {
      const layer = terrainRoot?.buildings;
      if (!layer) return;
      layer.rebuild(roadChunks);
      // A lot whose centre is over a chunk line from a changed road can lose its building to it, or move.
      layer.apply([...new Set([...changed, ...roadChunks.flatMap(neighbourhood)])]);
      // With roads in the same delta the mirror cannot name the chunks of the buildings it carried.
      if (roadChunks.length > 0 || changed.length === 0) layer.applyIds(ids);
    },
    buildingStats: () => terrainRoot?.buildings?.stats() ?? null,
    setGameTick(tick) {
      gameTick = tick;
    },
    buildingForm: (chunk) => terrainRoot?.buildings?.formOf(chunk) ?? null,
    buildingTint: (id) => terrainRoot?.buildings?.tintOf(id) ?? null,
    pickBuilding: (ray, limit) => terrainRoot?.buildings?.pick(ray, limit) ?? -1,
    buildingFormVersion: () => terrainRoot?.buildings?.formVersion() ?? 0,
    buildingTop: (id) => terrainRoot?.buildings?.topOf(id) ?? null,
    setPreset: (preset) => lighting.setPreset(preset),
    lighting: () => lighting.report(),
    settled,
    ...(options.flush ? { flush } : {}),
    async benchmark() {
      const size = renderer.getDrawingBufferSize(new Vector2());
      const target = new RenderTarget(Math.max(1, size.x), Math.max(1, size.y));
      const draw = () => {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
      };
      // Waits for the GPU: reading a pixel back finishes once every draw before it has.
      const finish = () => renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
      try {
        for (let k = 0; k < PRESET_BENCHMARK.warmup; k++) draw();
        await finish();
        const start = performance.now();
        for (let k = 0; k < PRESET_BENCHMARK.renders; k++) draw();
        await finish();
        return (performance.now() - start) / PRESET_BENCHMARK.renders;
      } finally {
        target.dispose();
      }
    },
  };
}
