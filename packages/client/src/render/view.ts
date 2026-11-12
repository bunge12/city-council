// The renderer: three.js WebGPURenderer with the WebGL 2 backend as the
// fallback, a fixed-daylight scene, the chunked terrain, the water plane,
// the roads and the decorative trees and grass.
//
// The render loop runs on the browser's frame clock and never waits on the
// sim. It reads the mirror; it does not drive the sim.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  LOD,
  Mesh,
  MeshLambertNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import { mapSize, type Terrain } from "@city-council/sim";
import { FRAME_TIME_WINDOW, LOD_HYSTERESIS, MAX_PIXEL_RATIO, TERRAIN_LODS } from "./config";
import type { ZoomBand } from "../camera/zoom-band";
import { createDecorLayer, type DecorLayer } from "./decor-meshes";
import { neighbourhood, type RoadNet } from "./road-geometry";
import { createRoadLayer, type RoadLayer, type RoadStats } from "./road-meshes";
import { buildChunk, chunkCentre, chunksPerSide } from "./terrain-chunks";
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
  /** Shows the road layers for a zoom band. */
  setZoomBand(band: ZoomBand): void;
  roadStats(): RoadStats | null;
}

/** True when the page asks for the WebGL 2 backend with `?webgl`. */
export function wantsWebGL(search: string): boolean {
  return new URLSearchParams(search).has("webgl");
}

const SKY = 0xb7cfe0;
const WATER = 0x3a6f8f;
/** The sun's fixed direction, from the scene towards the light. */
const SUN: readonly [number, number, number] = [0.55, 0.55, 0.3];

export async function createView(canvas: HTMLCanvasElement, forceWebGL: boolean): Promise<View> {
  const useWebGL = forceWebGL || !("gpu" in navigator);
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: useWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  await renderer.init();
  const backendObj = renderer.backend as { isWebGPUBackend?: boolean };
  const backend: Backend = backendObj.isWebGPUBackend === true ? "webgpu" : "webgl2";

  const scene = new Scene();
  scene.background = new Color(SKY);

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 10, 60_000);

  // Fixed daylight: one sun and a sky fill. No day and night cycle in v1.
  const sun = new DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(...SUN);
  scene.add(sun);
  scene.add(new HemisphereLight(0xdfeaf5, 0x5a5040, 1.1));

  let terrainRoot: { lods: LOD[]; decor: DecorLayer; roads: RoadLayer; dispose: () => void } | null = null;
  let band: ZoomBand = "city";

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
    roads.setBand(band);
    const decor = createDecorLayer(terrain, scene, (chunk) => roads.decorMask(chunk));

    terrainRoot = {
      lods,
      decor,
      roads,
      dispose() {
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

  const before: ((seconds: number) => void)[] = [];
  const listeners: ((stats: FrameStats) => void)[] = [];
  const gaps = new Float64Array(FRAME_TIME_WINDOW);
  let gapCount = 0;
  let gapSum = 0;
  let last = -1;
  renderer.setAnimationLoop((time: number) => {
    const seconds = last >= 0 ? (time - last) / 1000 : 0;
    for (const b of before) b(seconds);
    terrainRoot?.decor.update(camera.position);
    renderer.render(scene, camera);
    if (last >= 0) {
      const slot = gapCount % FRAME_TIME_WINDOW;
      gapSum += time - last - (gaps[slot] ?? 0);
      gaps[slot] = time - last;
      gapCount++;
    }
    last = time;
    const frames = Math.min(gapCount, FRAME_TIME_WINDOW);
    const frameMs = frames > 0 ? gapSum / frames : 0;
    const stats: FrameStats = {
      frameMs,
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    };
    for (const l of listeners) l(stats);
  });

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
    setZoomBand(next) {
      band = next;
      terrainRoot?.roads.setBand(next);
    },
    roadStats: () => terrainRoot?.roads.stats() ?? null,
  };
}
