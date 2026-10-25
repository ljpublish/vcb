/**
 * MODULE: atmosphere — renderer, scene graph roots, lights, sky, fog, shadows, day/night.
 * Owner: atmosphere agent. Implements ISceneContext (src/types.ts) via createSceneContext().
 *
 *  - WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }), pixel ratio ≤ 2,
 *    outputColorSpace = THREE.LinearSRGBColorSpace (REQUIRED, see colorSetup.ts),
 *    toneMapping = NoToneMapping, shadowMap PCF (soft; PCFSoftShadowMap no longer exists in r186). Canvas appended to the container,
 *    tabIndex = 0, contextmenu suppressed. Resize via ResizeObserver + window resize.
 *  - PerspectiveCamera fov 48, near 0.5, far 2500 (the camera rig moves it).
 *  - Lights: HemisphereLight (sky/ground tint) + one DirectionalLight that is the sun by day and a
 *    dim bluish moon by night (never pitch black). Its 2048² orthographic shadow camera FOLLOWS
 *    `focus` each frame, snapped to shadow texel increments (no shimmering); half-extent
 *    clamp(distance × 0.8, 60, 280); bias / normalBias scale with the texel size.
 *  - Sky (sky.ts): gradient dome with sun, moon and stars. Fog (THREE.Fog) uses the palette fog
 *    colour (= the sky's horizon band) with distances that scale with the camera distance.
 *  - Ocean: a ring of four quads around the map rectangle (never over x,z ∈ [0,512], where the
 *    river water is transparent) at WATER_LEVEL − 0.12, with a subtle animated shimmer.
 *  - Day/night: timeOfDay 0..1 advances when autoTime (default on) with a ~8 min cycle; the clock
 *    runs faster at night so night is ≈ a quarter of the real cycle. Each update() writes
 *    sharedUniforms.uTime (+= dt), uNight (= nightFactor) and uSun (sun elevation 0..1).
 *  - shadowsEnabled toggles renderer.shadowMap.enabled + sun.castShadow and forces a material refresh.
 *  - Only this file assigns sharedUniforms values.
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/util';
import { WATER_LEVEL, WORLD_SIZE_X, WORLD_SIZE_Z, type ISceneContext } from '../types';
import { sharedUniforms } from './sharedUniforms';
import { createSky, nightFactorAt, samplePalette, sunDirection, type Sky, type SkyPalette } from './sky';

export function createSceneContext(container: HTMLElement): ISceneContext {
  return new SceneContext(container);
}

/** Real seconds per full day at nightFactor 0 (the clock runs NIGHT_SPEEDUP× faster at full night). */
const DAY_SECONDS = 560;
const NIGHT_SPEEDUP = 1.9;
const SHADOW_MAP_SIZE = 2048;
const LIGHT_DISTANCE = 600;
const OCEAN_Y = WATER_LEVEL - 0.12;
const OCEAN_MARGIN = 2600;

class SceneContext implements ISceneContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly worldRoot = new THREE.Group();
  readonly overlayRoot = new THREE.Group();
  readonly fxRoot = new THREE.Group();
  timeOfDay = 0.3;
  autoTime = true;

  private readonly container: HTMLElement;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private readonly sky: Sky;
  private readonly ocean: THREE.Mesh;
  private readonly oceanMaterial: THREE.MeshLambertMaterial;
  private readonly palette: SkyPalette = samplePalette(0.3);
  private readonly background = new THREE.Color();
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly snapped = new THREE.Vector3();
  private readonly lastFocus = new THREE.Vector3(WORLD_SIZE_X / 2, 12, WORLD_SIZE_Z / 2);
  private night = 0;
  private shadowHalf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private readonly onResize = (): void => this.resize();
  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap was removed; PCF is soft now (shadow.radius)
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.style.display = 'block';
    this.canvas.style.outline = 'none';
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = this.background;
    this.fog = new THREE.Fog(0x9cc8ee, 500, 1400);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 2500);
    const cx = WORLD_SIZE_X / 2;
    const cz = WORLD_SIZE_Z / 2;
    this.camera.position.set(cx + 160, 180, cz + 160);
    this.camera.lookAt(cx, 12, cz);

    // Lights.
    this.hemi = new THREE.HemisphereLight(0xe4f0ff, 0x6b5a45, 1.0);
    this.hemi.name = 'hemi';
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.radius = 2;
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = LIGHT_DISTANCE * 2;
    this.setShadowExtent(140);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // Sky dome.
    this.sky = createSky();
    this.scene.add(this.sky.object);

    // Ocean ring.
    this.oceanMaterial = new THREE.MeshLambertMaterial({ color: 0x2f78c0 });
    this.oceanMaterial.onBeforeCompile = (shader): void => {
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uSun = sharedUniforms.uSun;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOceanPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOceanPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOceanPos;\nuniform float uTime;\nuniform float uSun;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec2 q = vOceanPos.xz;
            float w = sin(q.x * 0.045 + uTime * 0.7) * sin(q.y * 0.038 - uTime * 0.55)
                    + 0.5 * sin((q.x + q.y) * 0.11 + uTime * 1.3);
            float edge = clamp(max(max(-q.x, q.x - ${WORLD_SIZE_X.toFixed(1)}), max(-q.y, q.y - ${WORLD_SIZE_Z.toFixed(1)})) / 24.0, 0.0, 1.0);
            diffuseColor.rgb *= 0.95 + 0.05 * w;
            diffuseColor.rgb = mix(diffuseColor.rgb * 1.12 + vec3(0.02, 0.04, 0.04), diffuseColor.rgb, edge);
            diffuseColor.rgb += vec3(0.05) * uSun * max(w - 0.9, 0.0);
          }`,
        );
    };
    this.ocean = new THREE.Mesh(buildOceanGeometry(), this.oceanMaterial);
    this.ocean.name = 'ocean';
    this.ocean.receiveShadow = false;
    this.ocean.castShadow = false;
    this.ocean.frustumCulled = false;
    this.scene.add(this.ocean);

    this.worldRoot.name = 'worldRoot';
    this.overlayRoot.name = 'overlayRoot';
    this.fxRoot.name = 'fxRoot';
    this.scene.add(this.worldRoot, this.overlayRoot, this.fxRoot);

    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.applyTimeOfDay(this.camera.position.distanceTo(this.lastFocus));
  }

  get nightFactor(): number {
    return this.night;
  }

  get shadowsEnabled(): boolean {
    return this.renderer.shadowMap.enabled;
  }

  set shadowsEnabled(on: boolean) {
    const v = !!on;
    if (v === this.renderer.shadowMap.enabled && v === this.sun.castShadow) return;
    this.renderer.shadowMap.enabled = v;
    this.sun.castShadow = v;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
      else m.needsUpdate = true;
    });
  }

  update(dt: number, focus: THREE.Vector3): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y) && Number.isFinite(focus.z)) {
      this.lastFocus.copy(focus);
    }
    if (!Number.isFinite(this.timeOfDay)) this.timeOfDay = 0.3;
    if (this.autoTime && step > 0) {
      const rate = (1 + (NIGHT_SPEEDUP - 1) * this.night) / DAY_SECONDS;
      this.timeOfDay += step * rate;
    }
    this.timeOfDay -= Math.floor(this.timeOfDay);

    const dist = this.camera.position.distanceTo(this.lastFocus);
    this.applyTimeOfDay(Number.isFinite(dist) ? dist : 300);

    sharedUniforms.uTime.value += step;
    sharedUniforms.uNight.value = this.night;
    sharedUniforms.uSun.value = clamp01(this.sunDir.y / 0.86);
  }

  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(this.container.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight || window.innerHeight));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sky.dispose();
    this.ocean.removeFromParent();
    this.ocean.geometry.dispose();
    this.oceanMaterial.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------ internals

  private applyTimeOfDay(dist: number): void {
    const t = this.timeOfDay;
    const p = samplePalette(t, this.palette);
    this.night = nightFactorAt(t);
    sunDirection(t, this.sunDir);

    // Light direction: sun by day, moon (mirrored across the horizon) by night; elevation is lifted so
    // shadows never become absurdly long; intensity dips briefly around the hand-over.
    const s = this.sunDir;
    if (s.y >= 0) this.lightDir.copy(s);
    else this.lightDir.set(-s.x, -s.y, s.z);
    if (this.lightDir.y < 0.3) {
      this.lightDir.y = 0.3;
    }
    this.lightDir.normalize();
    const handover = clamp01(Math.abs(s.y) / 0.07);
    this.sun.color.copy(p.sunColor);
    this.sun.intensity = p.sunIntensity * (0.25 + 0.75 * handover);

    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;

    this.fog.color.copy(p.fog);
    this.background.copy(p.fog);
    this.fog.near = dist * 0.9 + 180;
    this.fog.far = dist * 2.4 + 900;

    this.sky.update(t, s, this.camera.position, p, this.night);

    this.updateShadowCamera(dist);
  }

  private setShadowExtent(half: number): void {
    if (half === this.shadowHalf) return;
    this.shadowHalf = half;
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.updateProjectionMatrix();
    const texel = (2 * half) / SHADOW_MAP_SIZE;
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.normalBias = 0.04 + texel * 0.9;
  }

  /** Centres the orthographic shadow box on the focus, snapped to whole shadow texels in light space. */
  private updateShadowCamera(dist: number): void {
    // Quantise the extent so zooming does not continuously resize texels.
    const half = Math.round(clamp(dist * 0.8, 60, 280) / 10) * 10;
    this.setShadowExtent(half);
    const texel = (2 * half) / SHADOW_MAP_SIZE;

    const L = this.lightDir;
    const fwd = this.tmpFwd.copy(L).negate();
    const right = this.tmpRight.set(0, 1, 0).cross(L);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this.tmpUp.copy(L).cross(right).normalize();

    const f = this.lastFocus;
    const a = Math.round(f.dot(right) / texel) * texel;
    const b = Math.round(f.dot(up) / texel) * texel;
    const c = f.dot(fwd);
    this.snapped.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(fwd, c);

    this.sun.target.position.copy(this.snapped);
    this.sun.position.copy(this.snapped).addScaledVector(L, LIGHT_DISTANCE);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}

/** Four non-overlapping quads forming a ring around the map rectangle [0,W]×[0,D]. */
function buildOceanGeometry(): THREE.BufferGeometry {
  const W = WORLD_SIZE_X;
  const D = WORLD_SIZE_Z;
  const M = OCEAN_MARGIN;
  const y = OCEAN_Y;
  // [x0, z0, x1, z1]
  const rects: ReadonlyArray<readonly [number, number, number, number]> = [
    [-M, -M, W + M, 0], // north
    [-M, D, W + M, D + M], // south
    [-M, 0, 0, D], // west
    [W, 0, W + M, D], // east
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  for (const [x0, z0, x1, z1] of rects) {
    // Two CCW triangles seen from above (+Y).
    pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    for (let i = 0; i < 6; i++) nor.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}
