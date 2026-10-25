/**
 * MODULE: atmosphere — sky dome + day/night palette (module-internal API; the atmosphere agent may change it).
 * Owner: atmosphere agent.
 *
 * - samplePalette(t): keyframed palette (night → warm sunrise → day → warm sunset → dusk → night),
 *   smoothly interpolated. Colours are palette hex values used as-is (WYSIWYG pipeline, no
 *   sRGB↔linear conversion).
 * - sunDirection(t): normalized direction TO the sun (rises in the east (+X), sets in the west,
 *   culminates towards the south (+Z) at ~60°).
 * - nightFactorAt(t): smooth 0 (day) .. 1 (night).
 * - createSky(): inverted sphere with a cheap gradient shader (zenith/horizon/fog band), sun disc +
 *   glow, moon disc and twinkling stars at night. fog: false, depthWrite: false, renderOrder -1,
 *   frustumCulled false, follows the camera.
 */
import * as THREE from 'three';
import { clamp01, smoothstep } from '../core/util';
import { sharedUniforms } from './sharedUniforms';

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
  update(timeOfDay: number, sunDir: THREE.Vector3, cameraPos: THREE.Vector3, palette: SkyPalette, nightFactor: number): void;
  dispose(): void;
}

interface Key {
  t: number;
  zenith: number;
  horizon: number;
  fog: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
}

// sunI is the intensity of the single directional light (sun by day, moon by night).
const KEYS: readonly Key[] = [
  { t: 0.0, zenith: 0x070c22, horizon: 0x1a2748, fog: 0x16213c, sun: 0x8fa6d6, sunI: 0.65, hemiSky: 0x5a70b0, hemiGround: 0x2a2a3a, hemiI: 1.05 },
  { t: 0.15, zenith: 0x0b1230, horizon: 0x26305a, fog: 0x1e2848, sun: 0x8fa6d6, sunI: 0.6, hemiSky: 0x5a70b0, hemiGround: 0x2a2a3a, hemiI: 1.05 },
  { t: 0.215, zenith: 0x1f2a5e, horizon: 0x6a5a86, fog: 0x4c4670, sun: 0xa8a0c8, sunI: 0.35, hemiSky: 0x6a74a6, hemiGround: 0x2e2a36, hemiI: 0.95 },
  { t: 0.255, zenith: 0x4a6cb0, horizon: 0xf3a46e, fog: 0xd89c80, sun: 0xffb070, sunI: 1.25, hemiSky: 0xd8c0bc, hemiGround: 0x5e4c3e, hemiI: 0.95 },
  { t: 0.32, zenith: 0x5a98e0, horizon: 0xc6def0, fog: 0xaecbe4, sun: 0xfff0d8, sunI: 1.3, hemiSky: 0xdde8ff, hemiGround: 0x6b5a45, hemiI: 0.95 },
  { t: 0.5, zenith: 0x4c8ce0, horizon: 0xbfe0f7, fog: 0xa6cff0, sun: 0xffffff, sunI: 1.5, hemiSky: 0xe4f0ff, hemiGround: 0x6b5a45, hemiI: 1.0 },
  { t: 0.68, zenith: 0x5690dc, horizon: 0xcfe0ee, fog: 0xb6cce2, sun: 0xfff0d2, sunI: 1.32, hemiSky: 0xe0e8f8, hemiGround: 0x6b5a45, hemiI: 0.95 },
  { t: 0.745, zenith: 0x4a5ea2, horizon: 0xff9858, fog: 0xe2906c, sun: 0xff9050, sunI: 1.25, hemiSky: 0xdcb4aa, hemiGround: 0x5e483a, hemiI: 0.95 },
  { t: 0.785, zenith: 0x1f2558, horizon: 0x704c7c, fog: 0x4e406c, sun: 0xa8a0c8, sunI: 0.35, hemiSky: 0x68689a, hemiGround: 0x2e2836, hemiI: 0.95 },
  { t: 0.85, zenith: 0x0b1230, horizon: 0x26305a, fog: 0x1e2848, sun: 0x8fa6d6, sunI: 0.6, hemiSky: 0x5a70b0, hemiGround: 0x2a2a3a, hemiI: 1.05 },
  { t: 1.0, zenith: 0x070c22, horizon: 0x1a2748, fog: 0x16213c, sun: 0x8fa6d6, sunI: 0.65, hemiSky: 0x5a70b0, hemiGround: 0x2a2a3a, hemiI: 1.05 },
];

const ca = new THREE.Color();
const cb = new THREE.Color();

function mixHex(out: THREE.Color, a: number, b: number, f: number): void {
  ca.setHex(a);
  cb.setHex(b);
  out.copy(ca).lerp(cb, f);
}

function wrap01(t: number): number {
  if (!Number.isFinite(t)) return 0.3;
  const w = t - Math.floor(t);
  return w < 0 ? 0 : w >= 1 ? 0 : w;
}

/** Palette for a time of day (0 = midnight, 0.5 = noon). */
export function samplePalette(timeOfDay: number, out?: SkyPalette): SkyPalette {
  const p: SkyPalette = out ?? {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    sunColor: new THREE.Color(),
    sunIntensity: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
  };
  const t = wrap01(timeOfDay);
  let i = 0;
  while (i < KEYS.length - 2 && t >= KEYS[i + 1].t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = smoothstep(0, 1, (t - a.t) / (b.t - a.t));
  mixHex(p.zenith, a.zenith, b.zenith, f);
  mixHex(p.horizon, a.horizon, b.horizon, f);
  mixHex(p.fog, a.fog, b.fog, f);
  mixHex(p.sunColor, a.sun, b.sun, f);
  mixHex(p.hemiSky, a.hemiSky, b.hemiSky, f);
  mixHex(p.hemiGround, a.hemiGround, b.hemiGround, f);
  p.sunIntensity = a.sunI + (b.sunI - a.sunI) * f;
  p.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * f;
  return p;
}

/** Normalized direction TO the sun. Below the horizon (y < 0) at night. */
export function sunDirection(timeOfDay: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (wrap01(timeOfDay) - 0.25) * Math.PI * 2;
  // East (+X) at sunrise, west at sunset, tilted towards the south (+Z).
  return out.set(Math.cos(a), Math.sin(a) * 0.86, 0.5).normalize();
}

/**
 * 0 (day) .. 1 (night). Full night between 0.86 and 0.14, long blue twilights around sunrise
 * (0.25) and sunset (0.75). Combined with a faster clock at night (scene.ts) real-time night is
 * roughly a quarter of the cycle.
 */
export function nightFactorAt(timeOfDay: number): number {
  const t = wrap01(timeOfDay);
  if (t < 0.5) return 1 - smoothstep(0.15, 0.265, t);
  return smoothstep(0.735, 0.85, t);
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNightF;
uniform float uTimeS;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // Gradient: fog band at the horizon → horizon colour → zenith.
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, uFog, 1.0 - smoothstep(0.0, 0.10, h));
  if (h < 0.0) col = uFog;

  // Sun: disc + two-lobe glow, fades below the horizon.
  float sd = dot(d, uSunDir);
  float sunVis = smoothstep(-0.12, 0.03, uSunDir.y);
  float disc = smoothstep(0.9975, 0.9988, sd);
  float glow = pow(max(sd, 0.0), 48.0) * 0.45 + pow(max(sd, 0.0), 6.0) * 0.18;
  col += uSunColor * (disc * 1.2 + glow) * sunVis * step(-0.02, h);

  // Moon (opposite the sun), a soft disc.
  vec3 moonDir = normalize(vec3(-uSunDir.x, -uSunDir.y, uSunDir.z));
  float md = dot(d, moonDir);
  float moon = smoothstep(0.9986, 0.9993, md);
  float moonGlow = pow(max(md, 0.0), 120.0) * 0.25;
  col += vec3(0.85, 0.9, 1.0) * (moon * 0.9 + moonGlow) * uNightF * step(0.0, h);

  // Stars: hashed cells on the direction, twinkling.
  if (uNightF > 0.01 && h > 0.0) {
    vec3 p = d * 170.0;
    vec3 cell = floor(p);
    float r = hash13(cell);
    if (r > 0.985) {
      vec3 jitter = vec3(hash13(cell + 7.1), hash13(cell + 13.7), hash13(cell + 29.3));
      float dist = length(p - cell - 0.25 - jitter * 0.5);
      float size = 0.10 + 0.14 * hash13(cell + 3.3);
      float s = 1.0 - smoothstep(size * 0.4, size, dist);
      float tw = 0.65 + 0.35 * sin(uTimeS * (1.5 + 3.0 * r) + r * 80.0);
      col += vec3(0.95, 0.96, 1.0) * s * tw * uNightF * smoothstep(0.0, 0.25, h) * (r - 0.985) * 66.0;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSky(): Sky {
  const geometry = new THREE.SphereGeometry(1, 32, 16);
  const uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFog: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uNightF: { value: 0 },
    uTimeS: sharedUniforms.uTime,
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.scale.setScalar(2000);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;

  return {
    object: mesh,
    update(_timeOfDay: number, sunDir: THREE.Vector3, cameraPos: THREE.Vector3, palette: SkyPalette, nightFactor: number): void {
      mesh.position.copy(cameraPos);
      uniforms.uZenith.value.copy(palette.zenith);
      uniforms.uHorizon.value.copy(palette.horizon);
      uniforms.uFog.value.copy(palette.fog);
      // The light colour at night is moonlight; the visible sun disc keeps a warm tone.
      uniforms.uSunColor.value.copy(palette.sunColor);
      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uNightF.value = clamp01(nightFactor);
    },
    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
