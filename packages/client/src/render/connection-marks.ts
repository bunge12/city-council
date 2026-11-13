// The outside connection marks on screen: one mesh, rebuilt only when a
// mark moves or its scale changes. Drawn through the terrain, so a
// connection behind a hill still shows where it is. Built from the mirror;
// the sim knows nothing of it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from "three/webgpu";
import type { Terrain } from "@city-council/sim";
import { CONNECTION_MARKS } from "./config";
import { buildConnectionMarks, connectionMarksKey, type ConnectionMark } from "./connection-marks-geometry";

export interface ConnectionMarkLayer {
  /** Shows `marks`, each at its own scale in metres per pixel. */
  show(marks: readonly ConnectionMark[], scales: readonly number[]): void;
  dispose(): void;
}

export function createConnectionMarkLayer(scene: Scene, terrain: () => Terrain): ConnectionMarkLayer {
  const material = new MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    opacity: CONNECTION_MARKS.opacity,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = "connection marks";
  // Over the roads (2) and the water, under the road preview (9).
  mesh.renderOrder = 8;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  let key = "";

  return {
    show(marks, scales) {
      const next = connectionMarksKey(marks, scales);
      if (next === key) return;
      key = next;
      mesh.geometry.dispose();
      const geometry = new BufferGeometry();
      if (marks.length > 0) {
        const arrays = buildConnectionMarks(terrain(), marks, scales);
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
