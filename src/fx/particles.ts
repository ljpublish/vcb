/**
 * MODULE: atmosphere — smoke / steam / fountain particles from structure emitters.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 * One InstancedMesh of small cubes (voxel-style puffs, fits the art style; opaque, so no sorting).
 * Pool of ≤ 800 particles; spawn rate ∝ emitter.strength; puffs rise, grow, drift with a slowly
 * rotating wind and shrink away at the end of their 4–8 s life. smoke: grey (darker for industry),
 * steam: white & short-lived, fountain: small blue droplets arcing up and falling back.
 * Emitters far from the camera do not spawn (cheap distance culling).
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { clamp01 } from '../core/util';
import type { Emitter } from '../types';
import { box, mergeBoxes, writeInstanceMatrix } from './voxelGeom';

export const MAX_PARTICLES = 800;
const KIND_SMOKE = 0;
const KIND_STEAM = 1;
const KIND_FOUNTAIN = 2;
const SPAWN_DISTANCE = 650;

interface EmitterState {
  x: number;
  y: number;
  z: number;
  kind: number;
  strength: number;
  dark: boolean;
  acc: number;
}

export class ParticleSystem {
  readonly object = new THREE.Group();
  /** Optional: true if the emitter's building is industrial (darker smoke). */
  isIndustrial: ((buildingId: number) => boolean) | null = null;

  private readonly rng = new Rng(0x5a0e);
  private emitters: EmitterState[] = [];
  private count = 0;
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pz = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly vz = new Float32Array(MAX_PARTICLES);
  private readonly age = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly size0 = new Float32Array(MAX_PARTICLES);
  private readonly size1 = new Float32Array(MAX_PARTICLES);
  private readonly yaw = new Float32Array(MAX_PARTICLES);
  private readonly spin = new Float32Array(MAX_PARTICLES);
  private readonly kind = new Uint8Array(MAX_PARTICLES);
  private readonly floorY = new Float32Array(MAX_PARTICLES);
  private readonly cr = new Float32Array(MAX_PARTICLES);
  private readonly cg = new Float32Array(MAX_PARTICLES);
  private readonly cb = new Float32Array(MAX_PARTICLES);
  private windAngle = 0.6;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly camPos = new THREE.Vector3(256, 200, 256);

  constructor(parent: THREE.Object3D) {
    this.object.name = 'particles';
    parent.add(this.object);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const geom = mergeBoxes([box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0xffffff)]);
    this.mesh = new THREE.InstancedMesh(geom, this.material, MAX_PARTICLES);
    this.mesh.name = 'particle-puffs';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.object.add(this.mesh);
  }

  get particleCount(): number {
    return this.count;
  }

  /** Camera position used for distance culling of spawns. */
  setCamera(pos: THREE.Vector3): void {
    this.camPos.copy(pos);
  }

  setEmitters(emitters: readonly Emitter[]): void {
    const list: EmitterState[] = [];
    if (emitters) {
      for (const e of emitters) {
        if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.z)) continue;
        const kind = e.kind === 'steam' ? KIND_STEAM : e.kind === 'fountain' ? KIND_FOUNTAIN : KIND_SMOKE;
        let dark = false;
        if (kind === KIND_SMOKE && this.isIndustrial) {
          try {
            dark = this.isIndustrial(e.buildingId);
          } catch {
            dark = false;
          }
        }
        list.push({
          x: e.x,
          y: e.y,
          z: e.z,
          kind,
          strength: clamp01(Number.isFinite(e.strength) ? e.strength : 0.5),
          dark,
          acc: this.rng.next(),
        });
      }
    }
    this.emitters = list;
  }

  update(dt: number, timeScale: number, nightFactor: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    const ts = Number.isFinite(timeScale) ? Math.max(0, Math.min(3, timeScale)) : 1;
    const night = clamp01(Number.isFinite(nightFactor) ? nightFactor : 0);
    const sdt = Math.min(0.1, dt * ts);

    this.windAngle += dt * 0.025;
    const windX = Math.cos(this.windAngle) * 1.4;
    const windZ = Math.sin(this.windAngle) * 1.4;

    if (sdt > 0) {
      this.spawn(sdt, night);
      this.integrate(sdt, windX, windZ);
    }
    this.write();
  }

  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    for (const e of this.emitters) e.acc = this.rng.next();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }

  // ------------------------------------------------------------------ internals

  private spawn(dt: number, night: number): void {
    const cam = this.camPos;
    const maxD2 = SPAWN_DISTANCE * SPAWN_DISTANCE;
    for (const e of this.emitters) {
      const dx = e.x - cam.x;
      const dz = e.z - cam.z;
      const dy = e.y - cam.y;
      if (dx * dx + dy * dy + dz * dz > maxD2) continue;
      const rate = e.kind === KIND_SMOKE ? 3.2 : e.kind === KIND_STEAM ? 2.4 : 12;
      e.acc += dt * rate * (0.25 + 0.75 * e.strength);
      while (e.acc >= 1) {
        e.acc -= 1;
        if (this.count >= MAX_PARTICLES) {
          e.acc = 0;
          break;
        }
        this.emit(e, night);
      }
    }
  }

  private emit(e: EmitterState, night: number): void {
    const i = this.count++;
    const r = this.rng;
    this.px[i] = e.x + r.range(-0.3, 0.3);
    this.py[i] = e.y + r.range(0, 0.3);
    this.pz[i] = e.z + r.range(-0.3, 0.3);
    this.age[i] = 0;
    this.yaw[i] = r.range(0, Math.PI * 2);
    this.spin[i] = r.range(-0.6, 0.6);
    this.kind[i] = e.kind;
    this.floorY[i] = e.y - 0.5;
    let grey: number;
    if (e.kind === KIND_SMOKE) {
      this.vx[i] = r.range(-0.3, 0.3);
      this.vy[i] = r.range(1.6, 2.4);
      this.vz[i] = r.range(-0.3, 0.3);
      this.life[i] = r.range(4.5, 8);
      this.size0[i] = r.range(0.6, 0.9);
      this.size1[i] = r.range(2.0, 3.0) * (0.7 + 0.3 * e.strength);
      grey = (e.dark ? r.range(0.46, 0.56) : r.range(0.7, 0.82)) * (1 - 0.3 * night);
      this.cr[i] = grey;
      this.cg[i] = grey;
      this.cb[i] = grey * 1.02;
    } else if (e.kind === KIND_STEAM) {
      this.vx[i] = r.range(-0.2, 0.2);
      this.vy[i] = r.range(2.2, 3.0);
      this.vz[i] = r.range(-0.2, 0.2);
      this.life[i] = r.range(2.0, 3.2);
      this.size0[i] = r.range(0.45, 0.6);
      this.size1[i] = r.range(1.3, 1.8);
      grey = r.range(0.9, 0.97) * (1 - 0.15 * night);
      this.cr[i] = grey;
      this.cg[i] = grey;
      this.cb[i] = grey;
    } else {
      const a = r.range(0, Math.PI * 2);
      const h = r.range(0.4, 1.0);
      this.vx[i] = Math.cos(a) * h;
      this.vy[i] = r.range(5.5, 7);
      this.vz[i] = Math.sin(a) * h;
      this.life[i] = 2.2;
      this.size0[i] = r.range(0.28, 0.4);
      this.size1[i] = this.size0[i];
      this.cr[i] = 0.55;
      this.cg[i] = 0.78;
      this.cb[i] = 0.95;
    }
  }

  private integrate(dt: number, windX: number, windZ: number): void {
    for (let i = this.count - 1; i >= 0; i--) {
      const a = (this.age[i] += dt);
      const k = this.kind[i];
      if (k === KIND_FOUNTAIN) {
        this.vy[i] -= 12 * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        if (this.py[i] < this.floorY[i] || a >= this.life[i]) this.kill(i);
        continue;
      }
      if (a >= this.life[i]) {
        this.kill(i);
        continue;
      }
      // Rise slows down; wind takes over with height/age.
      const t = a / this.life[i];
      const w = Math.min(1, t * 2.2);
      this.vy[i] *= 1 - 0.22 * dt;
      this.px[i] += (this.vx[i] + windX * w) * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += (this.vz[i] + windZ * w) * dt;
      this.yaw[i] += this.spin[i] * dt;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last];
    this.py[i] = this.py[last];
    this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    this.yaw[i] = this.yaw[last];
    this.spin[i] = this.spin[last];
    this.kind[i] = this.kind[last];
    this.floorY[i] = this.floorY[last];
    this.cr[i] = this.cr[last];
    this.cg[i] = this.cg[last];
    this.cb[i] = this.cb[last];
  }

  private write(): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const col = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const t = this.age[i] / this.life[i];
      let s: number;
      if (this.kind[i] === KIND_FOUNTAIN) s = this.size0[i];
      else {
        const grow = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
        // Shrink away during the last 30 % of life (stands in for a fade).
        s = t > 0.7 ? grow * Math.max(0, 1 - (t - 0.7) / 0.3) : grow;
        if (t < 0.08) s *= t / 0.08;
      }
      writeInstanceMatrix(m, i, this.px[i], this.py[i], this.pz[i], this.yaw[i], s, s, s);
      // Lighten slightly as puffs dissipate.
      const lift = this.kind[i] === KIND_FOUNTAIN ? 0 : t * 0.12;
      col[i * 3] = Math.min(1, this.cr[i] + lift);
      col[i * 3 + 1] = Math.min(1, this.cg[i] + lift);
      col[i * 3 + 2] = Math.min(1, this.cb[i] + lift);
    }
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, this.count * 16);
      this.mesh.instanceColor!.needsUpdate = true;
      this.mesh.instanceColor!.clearUpdateRanges();
      this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
    }
  }
}
