/**
 * MODULE: atmosphere — ambient life & effects root: traffic, smoke/steam/fountain particles, clouds.
 * Owner: atmosphere agent. Implements IEffects (src/types.ts).
 *
 * STUB: does nothing. Replace entirely.
 *
 * Intended:
 *  - Composes TrafficSystem (traffic.ts), ParticleSystem (particles.ts), CloudLayer (clouds.ts),
 *    all parented under deps.root (scene.fxRoot).
 *  - Listens to 'tiles:changed' → traffic.markNetworkDirty() (rebuild road graph lazily, ≤ 2×/s),
 *    'city:loaded' → reset().
 *  - Polls deps.structures.emittersVersion each frame; on change → particles.setEmitters(getEmitters()).
 *  - Time scale: cars and particles advance with the sim speed (city.getSpeed(): paused → cars stop,
 *    smoke keeps drifting slowly at 0.3×; fast speeds → cars ×1.5/×2, never more).
 *  - Night: deps.view.nightFactor → car headlights/taillights glow (emissive), smoke darker.
 *  - Distance/LOD: skip updating instances far outside the camera frustum when cheap to test.
 *  - enabled = false hides deps.root's fx objects and skips updates.
 * Budget: update() ≤ 1.5 ms per frame with 400 cars + 600 particles.
 */
import * as THREE from 'three';
import type { EffectsDeps, IEffects } from '../types';

export class Effects implements IEffects {
  enabled = true;
  private readonly deps: EffectsDeps;

  constructor(deps: EffectsDeps) {
    this.deps = deps;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    // TODO(atmosphere)
  }

  reset(): void {
    // TODO(atmosphere)
  }

  dispose(): void {
    // TODO(atmosphere)
  }
}
