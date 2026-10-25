/**
 * MODULE: atmosphere — tiny helper that merges axis-aligned coloured boxes into one BufferGeometry
 * (position + normal + color, non-indexed). Used for voxel cars, puffs and clouds.
 * Owner: atmosphere agent. Module-internal.
 */
import * as THREE from 'three';

export interface ColoredBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  color: number;
}

export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color = 0xffffff): ColoredBox {
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    z0: Math.min(z0, z1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
    z1: Math.max(z0, z1),
    color,
  };
}

// For each face: normal, then 4 corners as (x?1:0, y?1:0, z?1:0) in CCW order seen from outside.
const FACES: ReadonlyArray<{ n: readonly [number, number, number]; c: ReadonlyArray<readonly [number, number, number]> }> = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * Merges boxes into a geometry. `shade` darkens side/bottom faces slightly (baked, stylised AO-ish
 * look that survives flat lighting at night).
 */
export function mergeBoxes(boxes: readonly ColoredBox[], shade = true): THREE.BufferGeometry {
  const vCount = boxes.length * 36;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const c = new THREE.Color();
  let o = 0;
  for (const b of boxes) {
    c.setHex(b.color);
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const k = !shade ? 1 : f === 2 ? 1 : f === 3 ? 0.7 : f < 2 ? 0.9 : 0.84;
      const order = [0, 1, 2, 0, 2, 3];
      for (const idx of order) {
        const corner = face.c[idx];
        pos[o * 3] = corner[0] ? b.x1 : b.x0;
        pos[o * 3 + 1] = corner[1] ? b.y1 : b.y0;
        pos[o * 3 + 2] = corner[2] ? b.z1 : b.z0;
        nor[o * 3] = face.n[0];
        nor[o * 3 + 1] = face.n[1];
        nor[o * 3 + 2] = face.n[2];
        col[o * 3] = c.r * k;
        col[o * 3 + 1] = c.g * k;
        col[o * 3 + 2] = c.b * k;
        o++;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Writes a TRS matrix (rotation about +Y only, uniform-or-not scale) column-major into `arr` at
 * instance `i`. No allocations.
 */
export function writeInstanceMatrix(
  arr: Float32Array | number[],
  i: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const o = i * 16;
  arr[o] = c * sx;
  arr[o + 1] = 0;
  arr[o + 2] = -s * sx;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = sy;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = s * sz;
  arr[o + 9] = 0;
  arr[o + 10] = c * sz;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}
