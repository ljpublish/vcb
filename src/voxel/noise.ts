/**
 * MODULE: voxel-world — seeded noise helpers (module-internal API; the voxel-world agent may change it).
 * Owner: voxel-world agent.
 *
 * 2D simplex noise (Gustavson's formulation) with a permutation table shuffled by the seeded
 * mulberry32 `Rng` from src/core/rng.ts, plus fBm, ridged multifractal and domain-warp helpers.
 *
 * Determinism: the terrain is regenerated from its seed on every load (possibly in another
 * browser), so these functions use only IEEE-exact operations (+ − × ÷, Math.floor, Math.sqrt for
 * constants) — no Math.sin/cos/exp/pow, whose last bits may differ between JS engines.
 * Everything here is pure and allocation-free per call.
 */
import { Rng, mixSeed } from '../core/rng';

/** Seeded 2D noise function, output roughly in [-1, 1]. */
export type Noise2D = (x: number, y: number) => number;

/** Mutable 2D vector used as an output parameter (avoids allocations in hot loops). */
export interface Vec2 {
  x: number;
  y: number;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const G2x2m1 = 2 * G2 - 1;

/** Gustavson's 12 gradients, projected to 2D. */
const GRAD_X = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GRAD_Y = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);

/** Per-octave coordinate offsets so that octaves do not all vanish at the origin. */
const OCTAVE_OFFSET_X = new Float64Array([0, 17.31, -41.57, 73.13, -11.83, 29.71, -61.27, 93.41]);
const OCTAVE_OFFSET_Y = new Float64Array([0, -23.89, 37.19, -53.77, 89.03, -7.61, 47.39, -83.21]);
const MAX_OCTAVES = OCTAVE_OFFSET_X.length;

/** Seeded 2D simplex noise. */
export class Simplex2 {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(mixSeed(seed >>> 0, 0x5eed51));
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Simplex noise at (x, y), in about [-1, 1] (|n| rarely exceeds 0.9). */
  noise(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 + G2x2m1;
    const y2 = y0 + G2x2m1;
    const ii = i & 255;
    const jj = j & 255;
    const perm = this.perm;
    const pm = this.permMod12;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GRAD_X[g] * x0 + GRAD_Y[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GRAD_X[g] * x1 + GRAD_Y[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GRAD_X[g] * x2 + GRAD_Y[g] * y2);
    }
    return 70 * n;
  }

  /** Fractal Brownian motion, normalised by the amplitude sum: roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    const oct = octaves < 1 ? 1 : octaves > MAX_OCTAVES ? MAX_OCTAVES : octaves | 0;
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      sum += amp * this.noise(x * f + OCTAVE_OFFSET_X[o], y * f + OCTAVE_OFFSET_Y[o]);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal: sharp crests where the base noise crosses zero, in [0, 1].
   * Each octave is (1 - |n|)², weighted by the previous octave (classic Musgrave ridges).
   */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    const oct = octaves < 1 ? 1 : octaves > MAX_OCTAVES ? MAX_OCTAVES : octaves | 0;
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    let weight = 1;
    for (let o = 0; o < oct; o++) {
      let r = 1 - Math.abs(this.noise(x * f + OCTAVE_OFFSET_X[o], y * f + OCTAVE_OFFSET_Y[o]));
      r *= r;
      const w = r * weight;
      sum += amp * w;
      norm += amp;
      weight = r < 0 ? 0 : r > 1 ? 1 : r;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** 1D slice of the noise along x on a fixed lane (different lanes are independent). */
  noise1(x: number, lane: number): number {
    return this.noise(x, lane * 7.31 + 0.5);
  }
}

/** Create a seeded 2D simplex noise function (closure over a Simplex2). */
export function createNoise2D(seed: number): Noise2D {
  const s = new Simplex2(seed);
  return (x: number, y: number): number => s.noise(x, y);
}

/** Fractal Brownian motion of `noise`, normalised to roughly [-1, 1]. */
export function fbm2(noise: Noise2D | Simplex2, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  if (noise instanceof Simplex2) return noise.fbm(x, y, octaves, lacunarity, gain);
  const oct = octaves < 1 ? 1 : octaves > MAX_OCTAVES ? MAX_OCTAVES : octaves | 0;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    sum += amp * noise(x * f + OCTAVE_OFFSET_X[o], y * f + OCTAVE_OFFSET_Y[o]);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal (sharp ridges, good for rivers / mountain crests), roughly [0, 1]. */
export function ridged2(noise: Noise2D | Simplex2, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  if (noise instanceof Simplex2) return noise.ridged(x, y, octaves, lacunarity, gain);
  const oct = octaves < 1 ? 1 : octaves > MAX_OCTAVES ? MAX_OCTAVES : octaves | 0;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let weight = 1;
  for (let o = 0; o < oct; o++) {
    let r = 1 - Math.abs(noise(x * f + OCTAVE_OFFSET_X[o], y * f + OCTAVE_OFFSET_Y[o]));
    r *= r;
    sum += amp * r * weight;
    norm += amp;
    weight = r < 0 ? 0 : r > 1 ? 1 : r;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Domain warp: out = (x, y) + amp · (nx(x·freq, y·freq), ny(x·freq, y·freq)).
 * Feeding warped coordinates into another noise / distance function bends straight features
 * (river banks, coastlines, plain boundaries) into natural curves. Returns `out`.
 */
export function warp2(nx: Simplex2, ny: Simplex2, x: number, y: number, freq: number, amp: number, out: Vec2): Vec2 {
  const fx = x * freq;
  const fy = y * freq;
  out.x = x + amp * nx.noise(fx, fy);
  out.y = y + amp * ny.noise(fx + 31.7, fy - 47.3);
  return out;
}

/**
 * Fills out[z*n + x] (an n×n grid of cells) with a SMOOTH field f evaluated only on a coarse
 * lattice — every `step` cells, at cell centres (k*step + 0.5) — and bilinearly interpolated in
 * between. Much cheaper than evaluating low-frequency noise per cell, and still deterministic
 * (plain arithmetic). Returns `out`.
 */
export function sampleSmoothField(n: number, step: number, out: Float32Array, f: (x: number, z: number) => number): Float32Array {
  const m = Math.floor((n - 1) / step) + 2;
  const lattice = new Float32Array(m * m);
  for (let gz = 0; gz < m; gz++) {
    for (let gx = 0; gx < m; gx++) lattice[gz * m + gx] = f(gx * step + 0.5, gz * step + 0.5);
  }
  const inv = 1 / step;
  for (let z = 0; z < n; z++) {
    const fz = z * inv;
    const kz = Math.floor(fz);
    const v = fz - kz;
    const r0 = kz * m;
    const r1 = r0 + m;
    for (let x = 0; x < n; x++) {
      const fx = x * inv;
      const kx = Math.floor(fx);
      const u = fx - kx;
      const a = lattice[r0 + kx] + (lattice[r0 + kx + 1] - lattice[r0 + kx]) * u;
      const b = lattice[r1 + kx] + (lattice[r1 + kx + 1] - lattice[r1 + kx]) * u;
      out[z * n + x] = a + (b - a) * v;
    }
  }
  return out;
}

/** Hermite smoothstep of x between edge0 and edge1 (edge0 may exceed edge1 for a falling edge). */
export function smooth(edge0: number, edge1: number, x: number): number {
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
