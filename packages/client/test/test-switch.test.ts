import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { frameSignature } from "../src/render/frame-signature";
import { cityFromWorkerName, loadsFileFromWorkerName, startFromWorkerName, workerName } from "../src/save/lock";
import { PLAYER_SETTINGS, TEST_SWITCH_KEY, readTestSwitch } from "../src/test-switch";

const storage = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: (key) => (key === TEST_SWITCH_KEY ? value : null) });

describe("the test switch (issue #226)", () => {
  it("is off for a player, whose storage has no key", () => {
    expect(readTestSwitch(null)).toEqual(PLAYER_SETTINGS);
    expect(readTestSwitch(storage(null))).toEqual({ cheapFrames: false, autosave: true });
  });

  it("reads what the test stored, and a player's setting for anything missing or unreadable", () => {
    expect(readTestSwitch(storage(JSON.stringify({ cheapFrames: true, autosave: false })))).toEqual({ cheapFrames: true, autosave: false });
    expect(readTestSwitch(storage(JSON.stringify({ cheapFrames: true })))).toEqual({ cheapFrames: true, autosave: true });
    expect(readTestSwitch(storage(JSON.stringify({ cheapFrames: "yes", autosave: 0 })))).toEqual(PLAYER_SETTINGS);
    expect(readTestSwitch(storage("not json"))).toEqual(PLAYER_SETTINGS);
    expect(readTestSwitch(storage("null"))).toEqual(PLAYER_SETTINGS);
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(readTestSwitch(throwing)).toEqual(PLAYER_SETTINGS);
  });

  it("carries autosave to the worker in its name, beside the tab's city and a file on its way", () => {
    expect(workerName("abc-123")).toBe(workerName("abc-123", false, true));
    expect(startFromWorkerName(workerName("abc-123", false, false))).toEqual({ cityId: "abc-123", loadsFile: false, autosave: false });
    expect(startFromWorkerName(workerName(null, false, false))).toEqual({ cityId: null, loadsFile: false, autosave: false });
    expect(startFromWorkerName(workerName("abc-123", true, false))).toEqual({ cityId: "abc-123", loadsFile: true, autosave: false });
    expect(startFromWorkerName(workerName(null, true, false))).toEqual({ cityId: null, loadsFile: true, autosave: false });
    expect(startFromWorkerName(workerName("abc-123"))).toEqual({ cityId: "abc-123", loadsFile: false, autosave: true });
    expect(startFromWorkerName(workerName(null))).toEqual({ cityId: null, loadsFile: false, autosave: true });
    expect(cityFromWorkerName(workerName("abc-123", true, false))).toBe("abc-123");
    expect(loadsFileFromWorkerName(workerName("abc-123", true, false))).toBe(true);
    expect(loadsFileFromWorkerName(workerName("abc-123", false, false))).toBe(false);
    // A name the page did not make asks for no city and no file, and saves as a player's worker does.
    expect(startFromWorkerName("something else")).toEqual({ cityId: null, loadsFile: false, autosave: true });
  });
});

describe("the frame signature", () => {
  function scene() {
    const root = new Scene();
    const camera = new PerspectiveCamera(45, 1.6, 10, 60_000);
    camera.position.set(0, 100, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const material = new MeshBasicNodeMaterial();
    const geometry = new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(geometry, material);
    const group = new Group();
    group.add(mesh);
    const instanced = new InstancedMesh(geometry, material, 4);
    instanced.count = 2;
    root.add(group, instanced);
    return { root, camera, mesh, group, instanced, material, geometry };
  }

  it("holds while nothing changes", () => {
    const s = scene();
    expect(frameSignature(s.root, s.camera)).toBe(frameSignature(s.root, s.camera));
  });

  it("changes with each thing a layer changes between frames", () => {
    const changes: [string, (s: ReturnType<typeof scene>) => void][] = [
      ["the camera moved", (s) => s.camera.position.set(0, 120, 100)],
      ["the camera zoomed", (s) => {
        s.camera.fov = 30;
        s.camera.updateProjectionMatrix();
      }],
      ["an object moved", (s) => s.mesh.position.set(5, 0, 0)],
      ["its parent moved", (s) => s.group.position.set(0, 3, 0)],
      ["an object was hidden", (s) => (s.mesh.visible = false)],
      ["an object was added", (s) => s.group.add(new Mesh(s.geometry, s.material))],
      ["an object was removed", (s) => s.group.remove(s.mesh)],
      ["a buffer was rewritten", (s) => {
        const position = s.geometry.getAttribute("position");
        position.needsUpdate = true;
      }],
      ["the draw range changed", (s) => s.geometry.setDrawRange(0, 6)],
      ["new geometry", (s) => (s.mesh.geometry = new BoxGeometry(2, 2, 2))],
      ["a material was marked for upload", (s) => (s.material.needsUpdate = true)],
      ["an instance count changed", (s) => (s.instanced.count = 3)],
      ["an instance was placed", (s) => {
        s.instanced.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
        s.instanced.instanceMatrix.needsUpdate = true;
      }],
      ["a fade stepped", (s) => (s.mesh.userData["fade"] = 0.5)],
      ["a group's fades stepped", (s) => (s.mesh.userData["fades"] = new Float32Array([1, 0.25]))],
    ];
    for (const [what, change] of changes) {
      const s = scene();
      const before = frameSignature(s.root, s.camera);
      change(s);
      s.camera.updateMatrixWorld();
      expect(frameSignature(s.root, s.camera), what).not.toBe(before);
    }
  });
});
