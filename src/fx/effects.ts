/**
 * MODULE: atmosphere — ambient life & effects root: traffic, smoke/steam/fountain particles, clouds.
 * Owner: atmosphere agent. Implements IEffects (src/types.ts).
 *
 *  - Composes TrafficSystem (traffic.ts), ParticleSystem (particles.ts), CloudLayer (clouds.ts),
 *    all parented under deps.root (scene.fxRoot).
 *  - 'tiles:changed' → traffic.markNetworkDirty() (graph rebuilt lazily, ≤ 2×/s);
 *    'city:loaded' → reset().
 *  - Polls deps.structures.emittersVersion each frame; on change → particles.setEmitters(getEmitters()).
 *  - Time scale from city.getSpeed(): paused → cars frozen, smoke drifts at 0.3×; 1 → 1×; 2 → 1.5×;
 *    3 → 2×.
 *  - Night: deps.view.nightFactor → headlights/taillights glow, darker smoke, tinted clouds.
 *  - enabled = false hides deps.root and skips updates.
 * Budget: update() ≤ 1.5 ms per frame with 400 cars + 600 particles.
 */
import * as THREE from 'three';
import { ZoneType, type EffectsDeps, type IEffects } from '../types';
import { CloudLayer } from './clouds';
import { ParticleSystem } from './particles';
import { TrafficSystem } from './traffic';

const SPEED_SCALE = [0, 1, 1.5, 2];

export class Effects implements IEffects {
  enabled = true;
  private readonly deps: EffectsDeps;
  private readonly traffic: TrafficSystem;
  private readonly particles: ParticleSystem;
  private readonly clouds: CloudLayer;
  private readonly unsubs: Array<() => void> = [];
  private emittersVersion = -1;
  private disposed = false;

  constructor(deps: EffectsDeps) {
    this.deps = deps;
    const root = deps.root;
    this.traffic = new TrafficSystem(root, deps.city, deps.terrain);
    this.particles = new ParticleSystem(root);
    this.particles.isIndustrial = (id: number): boolean => deps.city.getBuilding(id)?.zone === ZoneType.Industrial;
    this.clouds = new CloudLayer(root, safeSeed(deps.city.seed));
    this.unsubs.push(
      deps.bus.on('tiles:changed', () => this.traffic.markNetworkDirty()),
      deps.bus.on('city:loaded', () => this.reset()),
    );
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    const root = this.deps.root;
    if (!this.enabled) {
      root.visible = false;
      return;
    }
    root.visible = true;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;

    let speed = 1;
    try {
      speed = this.deps.city.getSpeed();
    } catch {
      speed = 1;
    }
    const carScale = SPEED_SCALE[speed] ?? 1;
    const fxScale = speed === 0 ? 0.3 : carScale;
    const night = this.deps.view.nightFactor;

    const version = this.deps.structures.emittersVersion;
    if (version !== this.emittersVersion) {
      this.emittersVersion = version;
      this.particles.setEmitters(this.deps.structures.getEmitters());
    }

    if (camera) this.particles.setCamera(camera.position);
    this.traffic.update(step, carScale, night);
    this.particles.update(step, fxScale, night);
    this.clouds.update(step, this.deps.view.timeOfDay, night, camera ? camera.position.y : 0);
  }

  reset(): void {
    if (this.disposed) return;
    this.traffic.reset();
    this.particles.reset();
    this.emittersVersion = -1;
    this.clouds.setSeed(safeSeed(this.deps.city.seed));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.traffic.dispose();
    this.particles.dispose();
    this.clouds.dispose();
  }

  /** Debug counters (cars, particles). */
  getStats(): { cars: number; particles: number } {
    return { cars: this.traffic.carCount, particles: this.particles.particleCount };
  }
}

function safeSeed(seed: unknown): number {
  return typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : 0;
}
