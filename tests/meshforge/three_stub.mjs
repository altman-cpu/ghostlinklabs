/* Minimal three.js stand-in for the headless viewer harness.
 * Implements only the API surface viewer.js touches, with real math where
 * it matters (normals, colors, indices are copied verbatim). */

export const SRGBColorSpace = 'srgb';
export const ACESFilmicToneMapping = 4;
export const DoubleSide = 2;

export class Vec3 {
  constructor(x = 1, y = 1, z = 1) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
}

export { Vec3 as Vector3 };
export class Color {
  constructor(hex = 0) { this.hex = hex; }
}

class BaseMaterial {
  constructor(opts = {}) { Object.assign(this, opts); this.uniforms = {}; this.onBeforeCompile = null; }
  dispose() {}
}
export class MeshStandardMaterial extends BaseMaterial {}
export class MeshBasicMaterial extends BaseMaterial {}
export class LineBasicMaterial extends BaseMaterial {}

export class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
}

export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(attr) { this.index = attr; return this; }
  setFromPoints(points) { this.points = points; return this; }
  computeBoundingSphere() { this.boundingSphere = { radius: 1 }; }
  dispose() { this.disposed = true; }
}

export class Object3D {
  constructor() { this.children = []; this.position = new Vec3(0, 0, 0); this.scale = new Vec3(1, 1, 1); this.userData = {}; this.visible = true; }
  add(...o) { this.children.push(...o); return this; }
  lookAt() {}
}

export class Group extends Object3D {}
export class Scene extends Object3D {}

export class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}

export class LineLoop extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}

export class Line extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}

export class CircleGeometry extends BufferGeometry {
  constructor(r = 1, seg = 32) { super(); this.r = r; this.seg = seg; }
}

export class PerspectiveCamera extends Object3D {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 1000) {
    super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
  }
  updateProjectionMatrix() {}
}

class Light extends Object3D { constructor(...a) { super(); this.args = a; } }
export class HemisphereLight extends Light {}
export class DirectionalLight extends Light {}
export class PointLight extends Light {}

export class WebGLRenderer {
  constructor(opts = {}) {
    this.opts = opts;
    this.domElement = opts.canvas;
    this.calls = [];
    this.info = { render: { calls: 0 } };
  }
  setPixelRatio() {}
  setSize() {}
  render(scene, camera) { this.calls.push({ scene, camera }); this.info.render.calls++; }
  dispose() {}
}

export const MathUtils = {
  degToRad: d => d * Math.PI / 180,
};
