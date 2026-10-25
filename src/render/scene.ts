/**
 * MODULE: atmosphere — renderer, scene graph roots, lights, sky, fog, shadows, day/night.
 * Owner: atmosphere agent. Implements ISceneContext (src/types.ts) via createSceneContext().
 *
 * STUB: minimal but functional (renderer + flat sky colour + hemisphere/sun lights, no shadows,
 * no day/night). Replace with the full implementation.
 *
 * Intended implementation:
 *  - WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }), pixel ratio ≤ 2,
 *    outputColorSpace = THREE.LinearSRGBColorSpace (REQUIRED, see colorSetup.ts),
 *    toneMapping = NoToneMapping, shadowMap PCFSoftShadowMap. Canvas appended to the container,
 *    tabIndex = 0, contextmenu suppressed. Resize via ResizeObserver/window resize.
 *  - PerspectiveCamera fov ~45–50, near 0.5, far ~2500 (the camera rig moves it).
 *  - Lights: HemisphereLight (sky/ground tint) + DirectionalLight sun with a 2048² (high: 4096²)
 *    orthographic shadow camera (±~140 voxels) that FOLLOWS `focus` each frame, snapped to shadow
 *    texel increments to avoid shimmering; bias/normalBias tuned for voxel faces (no acne, no
 *    peter-panning). Optional soft ambient fill.
 *  - Sky: gradient dome (sky.ts) or Scene.background colour, matched fog (THREE.Fog) so the map
 *    edge fades nicely. Distant clear colour = fog colour. Optionally a sea plane at
 *    WATER_LEVEL - 0.15 extending far beyond the map so the island sits in an ocean, or a soft
 *    shadow plane under the diorama — make the world edge look intentional.
 *  - Day/night: timeOfDay (0..1) advances when autoTime with a full cycle of ~8 real minutes
 *    (night ≈ 25% of the cycle, never pitch black: moonlit blue ambient). Sun direction, colours
 *    (warm sunrise/sunset), intensities, sky + fog colours interpolate over a keyframed palette.
 *    nightFactor = smooth 0..1. Each update() writes sharedUniforms.uTime (+= dt),
 *    sharedUniforms.uNight (= nightFactor) and sharedUniforms.uSun.
 *  - shadowsEnabled toggles renderer.shadowMap.enabled + sun.castShadow (and forces a material
 *    refresh if needed).
 *  - Only this file assigns sharedUniforms values.
 */
import * as THREE from 'three';
import { MAP_TILES, TILE_SIZE, type ISceneContext } from '../types';
import { sharedUniforms } from './sharedUniforms';

export function createSceneContext(container: HTMLElement): ISceneContext {
  return new SceneContext(container);
}

class SceneContext implements ISceneContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly worldRoot = new THREE.Group();
  readonly overlayRoot = new THREE.Group();
  readonly fxRoot = new THREE.Group();
  timeOfDay = 0.42;
  autoTime = false;
  private readonly container: HTMLElement;
  private readonly sun: THREE.DirectionalLight;
  private readonly onResize = (): void => this.resize();

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    const sky = new THREE.Color(0x9cc8ee);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 500, 1400);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 2500);
    const c = (MAP_TILES * TILE_SIZE) / 2;
    this.camera.position.set(c + 160, 180, c + 160);
    this.camera.lookAt(c, 12, c);

    this.scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x6b5a45, 1.0));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(c + 200, 400, c + 120);
    this.sun.target.position.set(c, 0, c);
    this.scene.add(this.sun, this.sun.target);

    this.worldRoot.name = 'worldRoot';
    this.overlayRoot.name = 'overlayRoot';
    this.fxRoot.name = 'fxRoot';
    this.scene.add(this.worldRoot, this.overlayRoot, this.fxRoot);

    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  get nightFactor(): number {
    return 0;
  }

  get shadowsEnabled(): boolean {
    return this.renderer.shadowMap.enabled;
  }

  set shadowsEnabled(on: boolean) {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
  }

  update(dt: number, focus: THREE.Vector3): void {
    sharedUniforms.uTime.value += dt;
    sharedUniforms.uNight.value = this.nightFactor;
    // TODO(atmosphere): day/night, shadow camera follow, sky.
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
