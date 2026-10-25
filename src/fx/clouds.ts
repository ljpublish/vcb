/**
 * MODULE: atmosphere — drifting voxel clouds.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 * 18 chunky voxel clouds built from three seeded merged-box shapes (one InstancedMesh each, with
 * per-instance non-uniform scale and quarter-turn rotation for variety) at y ≈ 95–115. They drift
 * slowly with the wind in real time and wrap around a region larger than the map. They cast
 * no shadows (shadow-map cloud shadows were too dark and blocky), dissolve with an ordered dither
 * inside a radius around the camera that grows with camera height (so they never hide the city),
 * and are tinted by time of day (warm orange
 * at sunrise/sunset, blue-grey at night). Layout is deterministic from the seed.
 */
import * as THREE from 'three';
import { mixSeed, Rng } from '../core/rng';
import { clamp01, smoothstep } from '../core/util';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../types';
import { box, mergeBoxes, writeInstanceMatrix, type ColoredBox } from './voxelGeom';

const VARIANTS = 3;
const PER_VARIANT = 6;
const MARGIN = 420;
const MIN_X = -MARGIN;
const MIN_Z = -MARGIN;
const SPAN_X = WORLD_SIZE_X + 2 * MARGIN;
const SPAN_Z = WORLD_SIZE_Z + 2 * MARGIN;
const WIND_X = 2.2;
const WIND_Z = 0.8;

const DAY = new THREE.Color(0xffffff);
const SUNSET = new THREE.Color(0xffc49a);
const NIGHT = new THREE.Color(0x4a5676);

function cloudShape(rng: Rng): ColoredBox[] {
  const boxes: ColoredBox[] = [];
  const g = 4; // voxel grid of the cloud
  const q = (v: number): number => Math.round(v / g) * g;
  const coreW = q(rng.range(28, 44));
  const coreD = q(rng.range(20, 30));
  boxes.push(box(-coreW / 2, 0, -coreD / 2, coreW / 2, 6, coreD / 2, 0xffffff));
  const puffs = rng.int(4, 8);
  for (let i = 0; i < puffs; i++) {
    const w = q(rng.range(10, 24));
    const d = q(rng.range(10, 20));
    const cx = q(rng.range(-coreW / 2, coreW / 2));
    const cz = q(rng.range(-coreD / 2, coreD / 2));
    const y0 = rng.chance(0.3) ? -2 : 2;
    const h = q(rng.range(6, 12));
    boxes.push(box(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, 0xffffff));
  }
  // A small top bump.
  const tw = q(rng.range(8, 16));
  boxes.push(box(-tw / 2, 8, -tw / 2, tw / 2, 14, tw / 2, 0xffffff));
  return boxes;
}

export class CloudLayer {
  readonly object = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private readonly baseX = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly baseZ = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly y = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly sx = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly sy = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly sz = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly rot = new Float32Array(VARIANTS * PER_VARIANT);
  private readonly speedMul = new Float32Array(VARIANTS * PER_VARIANT);
  private offset = 0;
  private currentSeed = -1;
  private readonly tint = new THREE.Color();
  private readonly fadeUniform = { value: 50 };

  constructor(parent: THREE.Object3D, seed: number) {
    this.object.name = 'clouds';
    parent.add(this.object);
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x000000, flatShading: true });
    const fade = this.fadeUniform;
    this.material.onBeforeCompile = (shader): void => {
      shader.uniforms.uCloudFade = fade;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          {
            vec4 cw = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
            cw = instanceMatrix * cw;
            #endif
            vCloudWorld = (modelMatrix * cw).xyz;
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;\nuniform float uCloudFade;')
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          {
            // Screen-door fade: clouds near the camera, and all clouds when looking down on them
            // from above, dissolve with an ordered 4x4 dither so they never hide the city.
            float near = smoothstep(uCloudFade, uCloudFade + 110.0, distance(vCloudWorld, cameraPosition));
            float vis = near;
            ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
            int idx = p.x + p.y * 4;
            float b = 0.0;
            if (idx == 0) b = 0.0; else if (idx == 1) b = 8.0; else if (idx == 2) b = 2.0; else if (idx == 3) b = 10.0;
            else if (idx == 4) b = 12.0; else if (idx == 5) b = 4.0; else if (idx == 6) b = 14.0; else if (idx == 7) b = 6.0;
            else if (idx == 8) b = 3.0; else if (idx == 9) b = 11.0; else if (idx == 10) b = 1.0; else if (idx == 11) b = 9.0;
            else if (idx == 12) b = 15.0; else if (idx == 13) b = 7.0; else if (idx == 14) b = 13.0; else b = 5.0;
            if (vis < (b + 0.5) / 16.0) discard;
          }`,
        );
    };
    this.build(seed);
  }

  get seed(): number {
    return this.currentSeed;
  }

  /** Rebuilds the layout from a new seed (no-op if unchanged). */
  setSeed(seed: number): void {
    if ((seed >>> 0) !== this.currentSeed) this.build(seed);
  }

  /** dt in real seconds; timeOfDay 0..1; nightFactor 0..1; cameraY fades clouds when seen from above. */
  update(dt: number, timeOfDay: number, nightFactor: number, cameraY = 0): void {
    if (Number.isFinite(dt) && dt > 0) this.offset += Math.min(dt, 0.25);
    const cy = Number.isFinite(cameraY) ? cameraY : 0;
    // Dissolve radius grows with camera height so clouds never sit between the camera and the city.
    this.fadeUniform.value = 50 + Math.max(0, cy - 50) * 1.6;
    const night = clamp01(Number.isFinite(nightFactor) ? nightFactor : 0);
    const t = Number.isFinite(timeOfDay) ? timeOfDay - Math.floor(timeOfDay) : 0.5;
    const golden = Math.max(1 - smoothstep(0.0, 0.06, Math.abs(t - 0.26)), 1 - smoothstep(0.0, 0.06, Math.abs(t - 0.74)));
    this.tint.copy(DAY).lerp(SUNSET, golden * (1 - night)).lerp(NIGHT, night);
    this.material.color.copy(this.tint);
    this.material.emissive.copy(this.tint).multiplyScalar(0.28 - 0.12 * night);

    let k = 0;
    for (let v = 0; v < this.meshes.length; v++) {
      const mesh = this.meshes[v];
      const arr = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < PER_VARIANT; i++, k++) {
        const m = this.speedMul[k];
        let x = (this.baseX[k] + this.offset * WIND_X * m) % SPAN_X;
        let z = (this.baseZ[k] + this.offset * WIND_Z * m) % SPAN_Z;
        if (x < 0) x += SPAN_X;
        if (z < 0) z += SPAN_Z;
        writeInstanceMatrix(arr, i, MIN_X + x, this.y[k], MIN_Z + z, this.rot[k], this.sx[k], this.sy[k], this.sz[k]);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.clearMeshes();
    this.material.dispose();
  }

  private clearMeshes(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes = [];
  }

  private build(seed: number): void {
    this.clearMeshes();
    this.currentSeed = seed >>> 0;
    const rng = new Rng(mixSeed(this.currentSeed, 0xc10d5));
    let k = 0;
    for (let v = 0; v < VARIANTS; v++) {
      const geom = mergeBoxes(cloudShape(rng));
      const mesh = new THREE.InstancedMesh(geom, this.material, PER_VARIANT);
      mesh.name = `clouds-${v}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false; // full-strength shadow-map blobs looked too dark; clouds stay decorative
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      for (let i = 0; i < PER_VARIANT; i++, k++) {
        this.baseX[k] = rng.range(0, SPAN_X);
        this.baseZ[k] = rng.range(0, SPAN_Z);
        this.y[k] = Math.round(rng.range(95, 115));
        const s = rng.range(0.8, 1.5);
        this.sx[k] = s * rng.range(0.85, 1.2);
        this.sy[k] = rng.range(0.8, 1.15);
        this.sz[k] = s * rng.range(0.85, 1.2);
        this.rot[k] = rng.int(0, 4) * (Math.PI / 2);
        this.speedMul[k] = rng.range(0.8, 1.25);
      }
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
    this.update(0, 0.5, 0);
  }
}
