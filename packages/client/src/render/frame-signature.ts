// A number that changes when what the next frame would draw changes, for the
// test switch's "draw only when something changed" (issue #226). It covers
// what the layers change between frames: objects added, removed, shown or
// hidden, moved, given new geometry or new instances, a buffer or material
// marked for upload, a fade stepped (`userData.fade` and `userData.fades`),
// and the camera. It does not cover uniform values: the view counts the
// construction tick itself, and a preset change marks the frame dirty.
//
// Client only, and only under the test switch: a player's page draws every
// frame.

import type { BufferAttribute, BufferGeometry, Camera, InterleavedBufferAttribute, Material, Object3D } from "three/webgpu";

const bits = new Float64Array(1);
const words = new Int32Array(bits.buffer);

/** FNV-1a over 32-bit words. */
class Hash {
  value = 0x811c9dc5;
  int(n: number): void {
    this.value = Math.imul(this.value ^ (n | 0), 0x01000193);
  }
  float(x: number): void {
    bits[0] = x;
    this.int(words[0] ?? 0);
    this.int(words[1] ?? 0);
  }
  floats(xs: ArrayLike<number>): void {
    for (let k = 0; k < xs.length; k++) this.float(xs[k] ?? 0);
  }
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;
const versionOf = (a: Attribute): number => ("isInterleavedBufferAttribute" in a && a.isInterleavedBufferAttribute ? a.data.version : (a as BufferAttribute).version);

function hashGeometry(h: Hash, g: BufferGeometry): void {
  h.int(g.id);
  for (const name in g.attributes) {
    const a = g.attributes[name];
    if (a) h.int(versionOf(a));
  }
  h.int(g.index?.version ?? -1);
  h.float(g.drawRange.start);
  h.float(g.drawRange.count);
}

function hashMaterial(h: Hash, m: Material): void {
  h.int(m.id);
  h.int(m.version);
  h.int(m.visible ? 1 : 0);
  h.float(m.opacity);
}

/** What a mesh, instanced mesh, line or points adds to an Object3D. */
interface Drawable {
  geometry?: BufferGeometry | undefined;
  material?: Material | Material[] | undefined;
  count?: number | undefined;
  instanceMatrix?: BufferAttribute | undefined;
  instanceColor?: BufferAttribute | null | undefined;
}

function hashObject(h: Hash, object: Object3D): void {
  const o = object as Object3D & Drawable;
  h.int(o.id);
  if (!o.visible) {
    h.int(0);
    return;
  }
  h.int(1);
  h.floats(o.matrixWorld.elements);
  if (o.geometry) hashGeometry(h, o.geometry);
  if (Array.isArray(o.material)) for (const m of o.material) hashMaterial(h, m);
  else if (o.material) hashMaterial(h, o.material);
  if (typeof o.count === "number") h.float(o.count);
  if (o.instanceMatrix) h.int(o.instanceMatrix.version);
  if (o.instanceColor) h.int(o.instanceColor.version);
  const fade: unknown = o.userData["fade"];
  if (typeof fade === "number") h.float(fade);
  const fades: unknown = o.userData["fades"];
  if (fades && typeof fades === "object" && "length" in fades) h.floats(fades as ArrayLike<number>);
  h.int(o.children.length);
  for (const child of o.children) hashObject(h, child);
}

/**
 * The signature of `root` as `camera` would draw it now. Brings world
 * matrices up to date first, as a render would, so a moved object counts.
 */
export function frameSignature(root: Object3D, camera: Camera): number {
  root.updateMatrixWorld();
  const h = new Hash();
  h.floats(camera.matrixWorld.elements);
  h.floats(camera.projectionMatrix.elements);
  hashObject(h, root);
  return h.value;
}
