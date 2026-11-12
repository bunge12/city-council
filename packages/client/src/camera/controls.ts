// Mouse and keyboard input for the camera rig, and the cursor marker on the
// ground under the pointer. No touch input in v1.
//
// Mouse: left drag pans (the ground under the cursor follows it), right or
// middle drag orbits, wheel zooms towards the cursor, a left click picks the
// ground and a right click without a drag is reported too, so a tool can
// use it to cancel. Keyboard: WASD or arrows pan, Q and E turn, R and F tilt, + and -
// zoom on the screen centre.

import { Mesh, MeshBasicNodeMaterial, RingGeometry, type Scene } from "three/webgpu";
import { CAMERA_SPEEDS, CLICK_SLOP, CURSOR_MARKER_SCALE } from "./config";
import type { GroundHit } from "./pick";
import type { CameraRig } from "./rig";

export interface CameraControls {
  /** Advances keyboard movement by `seconds` and moves the cursor marker. Call once per frame. */
  update(seconds: number): void;
  /** The ground under the pointer as of the last update, or null. */
  cursor(): GroundHit | null;
  /** The pointer over the canvas in CSS pixels, or null when it is elsewhere. */
  pointer(): { x: number; y: number } | null;
  /** Whether Alt is held: the road tool draws free-hand while it is. */
  altHeld(): boolean;
  /**
   * Called with the ground point of each click, or null for a click on sky.
   * A press that ends a drag is not a click.
   */
  onPick(listener: (hit: GroundHit | null) => void): void;
  /** Called for each right click that did not orbit the camera. */
  onRightClick(listener: () => void): void;
  dispose(): void;
}

type Drag = { kind: "pan" | "orbit"; button: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean };

const KEYS: Record<string, string> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  KeyQ: "turnLeft",
  KeyE: "turnRight",
  KeyR: "tiltUp",
  KeyF: "tiltDown",
  Equal: "zoomIn",
  NumpadAdd: "zoomIn",
  Minus: "zoomOut",
  NumpadSubtract: "zoomOut",
};

export function createCameraControls(canvas: HTMLCanvasElement, rig: CameraRig, scene: Scene): CameraControls {
  const held = new Set<string>();
  const pickListeners: ((hit: GroundHit | null) => void)[] = [];
  const rightClickListeners: (() => void)[] = [];
  let drag: Drag | null = null;
  /** Pointer position over the canvas, in CSS pixels, or null when it is elsewhere. */
  let pointer: { x: number; y: number } | null = null;
  let cursorHit: GroundHit | null = null;
  let alt = false;

  const marker = new Mesh(
    new RingGeometry(0.55, 1, 32).rotateX(-Math.PI / 2),
    new MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
  );
  marker.name = "cursor marker";
  // Drawn last and through the terrain, so a slope cannot hide it.
  marker.renderOrder = 10;
  marker.visible = false;
  scene.add(marker);

  function local(e: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "touch") return;
    const p = local(e);
    const kind = e.button === 0 && !e.shiftKey ? "pan" : e.button === 0 || e.button === 1 || e.button === 2 ? "orbit" : null;
    if (!kind) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { kind, button: e.button, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false };
    if (kind === "pan") rig.grab(p.x, p.y);
  }

  function onPointerMove(e: PointerEvent): void {
    const p = local(e);
    pointer = p;
    alt = e.altKey;
    if (!drag) return;
    if (Math.abs(p.x - drag.startX) > CLICK_SLOP || Math.abs(p.y - drag.startY) > CLICK_SLOP) drag.moved = true;
    if (drag.moved) {
      if (drag.kind === "pan") rig.dragTo(p.x, p.y);
      else rig.orbit(-(p.x - drag.lastX) * CAMERA_SPEEDS.dragYaw, (p.y - drag.lastY) * CAMERA_SPEEDS.dragPitch);
    }
    drag.lastX = p.x;
    drag.lastY = p.y;
  }

  function onPointerUp(e: PointerEvent): void {
    alt = e.altKey;
    if (!drag) return;
    const released = e.type === "pointerup";
    const wasClick = released && drag.kind === "pan" && !drag.moved;
    const wasRightClick = released && drag.kind === "orbit" && drag.button === 2 && !drag.moved;
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (wasClick) {
      const p = local(e);
      const hit = rig.pickGround(p.x, p.y);
      for (const l of pickListeners) l(hit);
    }
    if (wasRightClick) for (const l of rightClickListeners) l();
  }

  function onPointerLeave(): void {
    if (!drag) pointer = null;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Lines and pages to pixels, roughly, so every mouse zooms at a similar pace.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const p = local(e);
    rig.zoomAt(Math.exp(e.deltaY * scale * CAMERA_SPEEDS.wheelZoom), p.x, p.y);
  }

  function typing(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Alt") {
      alt = true;
      // Otherwise some browsers move focus to their menu bar on release.
      e.preventDefault();
      return;
    }
    const action = KEYS[e.code];
    if (!action || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    held.add(action);
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === "Alt") {
      alt = false;
      e.preventDefault();
      return;
    }
    const action = KEYS[e.code];
    if (action) held.delete(action);
  }

  function onBlur(): void {
    held.clear();
    alt = false;
  }

  const noMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", noMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  function update(seconds: number): void {
    // A long frame (a background tab) should not fling the camera.
    const dt = Math.min(seconds, 0.1);
    if (held.size > 0 && dt > 0) {
      const has = (a: string) => (held.has(a) ? 1 : 0);
      const fwd = has("forward") - has("back");
      const side = has("right") - has("left");
      if (fwd !== 0 || side !== 0) {
        // Forward is away from the camera, along the ground.
        const step = rig.pose.distance * CAMERA_SPEEDS.keyPan * dt;
        const { yaw } = rig.pose;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        rig.pan((fx * fwd - fz * side) * step, (fz * fwd + fx * side) * step);
      }
      const turn = has("turnRight") - has("turnLeft");
      const tilt = has("tiltUp") - has("tiltDown");
      if (turn !== 0 || tilt !== 0) rig.orbit(turn * CAMERA_SPEEDS.keyYaw * dt, tilt * CAMERA_SPEEDS.keyPitch * dt);
      const zoom = has("zoomOut") - has("zoomIn");
      if (zoom !== 0) {
        rig.zoomAt(Math.exp(zoom * CAMERA_SPEEDS.keyZoom * dt), canvas.clientWidth / 2, canvas.clientHeight / 2);
      }
    }

    // The camera may have moved under a still pointer, so pick every frame.
    cursorHit = pointer ? rig.pickGround(pointer.x, pointer.y) : null;
    if (cursorHit) {
      marker.position.set(cursorHit.x, cursorHit.y, cursorHit.z);
      marker.scale.setScalar(cursorHit.distance * CURSOR_MARKER_SCALE);
      marker.updateMatrix();
      marker.visible = true;
    } else {
      marker.visible = false;
    }
  }

  return {
    update,
    cursor: () => cursorHit,
    pointer: () => pointer,
    altHeld: () => alt,
    onPick: (l) => pickListeners.push(l),
    onRightClick: (l) => rightClickListeners.push(l),
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", noMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      scene.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    },
  };
}
