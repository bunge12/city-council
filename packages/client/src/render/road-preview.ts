// The road tool's previews on screen: one mesh, rebuilt only when the
// shapes change. Drawn after the roads and through the terrain, below the
// cursor marker. Built from the tool's state; the sim knows nothing of it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from "three/webgpu";
import type { Terrain } from "@city-council/sim";
import { ROAD_PREVIEW } from "./config";
import { buildPreviewGeometry, previewKey, type PreviewShape } from "./road-preview-geometry";

export interface RoadPreviewLayer {
  show(shapes: readonly PreviewShape[]): void;
  dispose(): void;
}

export function createRoadPreviewLayer(scene: Scene, terrain: () => Terrain): RoadPreviewLayer {
  const material = new MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    opacity: ROAD_PREVIEW.opacity,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = "road preview";
  mesh.renderOrder = 9;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  let key = "";

  return {
    show(shapes) {
      const next = previewKey(shapes);
      if (next === key) return;
      key = next;
      mesh.geometry.dispose();
      const geometry = new BufferGeometry();
      if (shapes.length > 0) {
        const arrays = buildPreviewGeometry(terrain(), shapes);
        geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
        geometry.setAttribute("color", new BufferAttribute(arrays.colours, 3));
        geometry.setIndex(new BufferAttribute(arrays.indices, 1));
      }
      mesh.geometry = geometry;
      mesh.visible = shapes.length > 0;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
