/**
 * MODULE: atmosphere — drifting voxel clouds.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 * STUB.
 *
 * Intended: 12–24 chunky voxel clouds (merged boxes, white, slightly transparent or opaque with
 * flat shading) at y ≈ 95–115, drifting slowly with the wind across and beyond the map, wrapping
 * around; optionally casting shadows (castShadow on, receiveShadow off) for moving cloud shadows.
 * Tinted by time of day (orange at sunset, dark blue-grey at night).
 */
import * as THREE from 'three';

export class CloudLayer {
  readonly object = new THREE.Group();

  constructor(parent: THREE.Object3D, seed: number) {
    parent.add(this.object);
  }

  update(dt: number, nightFactor: number): void {
    // TODO(atmosphere)
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}
