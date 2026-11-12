// The road tool's snap markers on screen: one mesh, rebuilt only when the
// marks or the zoom change. Drawn through the terrain, over the road preview
// and under the cursor ring. Built from the tool's snap; the sim knows
// nothing of it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from "three/webgpu";
import type { Terrain } from "@city-council/sim";
import { SNAP_MARKS } from "./config";
import { buildSnapMarks, snapMarksKey, type SnapMark } from "./snap-marks-geometry";

export interface SnapMarkLayer {
  show(marks: readonly SnapMark[], metresPerPixel: number): void;
  dispose(): void;
}

export function createSnapMarkLayer(scene: Scene, terrain: () => Terrain): SnapMarkLayer {
  const material = new MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    opacity: SNAP_MARKS.opacity,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = "snap marks";
  // Over the road preview (9), under the cursor marker (10).
  mesh.renderOrder = 9.5;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  let key = "";

  return {
    show(marks, metresPerPixel) {
      const next = snapMarksKey(marks, metresPerPixel);
      if (next === key) return;
      key = next;
      mesh.geometry.dispose();
      const geometry = new BufferGeometry();
      if (marks.length > 0) {
        const arrays = buildSnapMarks(terrain(), marks, metresPerPixel);
        geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
        geometry.setAttribute("color", new BufferAttribute(arrays.colours, 3));
        geometry.setIndex(new BufferAttribute(arrays.indices, 1));
      }
      mesh.geometry = geometry;
      mesh.visible = marks.length > 0;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
