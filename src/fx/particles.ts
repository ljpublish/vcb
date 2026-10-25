/**
 * MODULE: atmosphere — smoke / steam / fountain particles from structure emitters.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 * STUB.
 *
 * Intended: one THREE.Points (custom ShaderMaterial or PointsMaterial with a procedurally drawn
 * CanvasTexture soft circle — no asset files) or an InstancedMesh of small cubes (voxel-style puffs,
 * fits the art style well). Pool of ≤ 800 particles; spawn rate ∝ emitter.strength; puffs rise,
 * grow, drift with a slowly rotating wind, fade out over 4–8 s. smoke: grey (darker for industry),
 * steam: white & short-lived, fountain: small blue droplets arcing up and falling back.
 */
import * as THREE from 'three';
import type { Emitter } from '../types';

export class ParticleSystem {
  readonly object = new THREE.Group();

  constructor(parent: THREE.Object3D) {
    parent.add(this.object);
  }

  setEmitters(emitters: readonly Emitter[]): void {
    // TODO(atmosphere)
  }

  update(dt: number, timeScale: number, nightFactor: number): void {
    // TODO(atmosphere)
  }

  reset(): void {
    // TODO(atmosphere)
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}
