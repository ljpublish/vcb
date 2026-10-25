/**
 * MODULE: atmosphere — sky dome + day/night palette (module-internal API; the atmosphere agent may change it).
 * Owner: atmosphere agent.
 *
 * STUB. Intended: a large inverted sphere (or screen-space gradient) with a cheap shader mixing
 * horizon/zenith colours, a sun disc / glow, and stars at night; fog: false, depthWrite: false,
 * renderOrder -1, follows the camera position. Plus a keyframed palette sampled by time of day.
 */
import * as THREE from 'three';

export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
}

export interface Sky {
  readonly object: THREE.Object3D;
  /** timeOfDay 0..1, sunDir = normalized direction TO the sun. */
  update(timeOfDay: number, sunDir: THREE.Vector3, cameraPos: THREE.Vector3): void;
  dispose(): void;
}

/** Palette for a time of day (0 = midnight, 0.5 = noon). */
export function samplePalette(timeOfDay: number, out?: SkyPalette): SkyPalette {
  // TODO(atmosphere)
  const p = out ?? {
    zenith: new THREE.Color(0x6aa6e8),
    horizon: new THREE.Color(0xbfe0f7),
    fog: new THREE.Color(0x9cc8ee),
    sunColor: new THREE.Color(0xffffff),
    sunIntensity: 1.4,
    hemiSky: new THREE.Color(0xe4f0ff),
    hemiGround: new THREE.Color(0x6b5a45),
    hemiIntensity: 1,
  };
  return p;
}

export function createSky(): Sky {
  // TODO(atmosphere)
  const object = new THREE.Group();
  return {
    object,
    update(): void {},
    dispose(): void {},
  };
}
