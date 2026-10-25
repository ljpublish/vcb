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
 * A SMOOTH 2D field over an n×n grid of cells, evaluated only on a coarse lattice and bilinearly
 * interpolated in between: lattice point (i, j) sits at continuous cell coordinates
 * (i·step + 0.5, j·step + 0.5), i.e. on cell centres (cell k spans [k, k+1)). Far cheaper than
 * evaluating low-frequency noise per cell (or per voxel), and still deterministic (plain
 * arithmetic on float32 samples).
 */
export class LatticeField {
  /** Grid edge in cells. */
  readonly n: number;
  /** Lattice points per axis (covers cell centres 0.5 … n - 0.5). */
  readonly m: number;
  readonly step: number;
  readonly data: Float32Array;
  private readonly inv: number;

  constructor(n: number, step: number, f: (x: number, z: number) => number) {
    const s = step >= 1 ? Math.floor(step) : 1;
    this.n = n >= 1 ? Math.floor(n) : 1;
    const m = Math.floor((this.n - 1) / s) + 2;
    this.m = m;
    this.step = s;
    this.inv = 1 / s;
    this.data = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) this.data[j * m + i] = f(i * s + 0.5, j * s + 0.5);
    }
  }

  /**
   * Bilinear value at continuous cell coordinates (cell centre = k + 0.5), clamped to the lattice,
   * rounded to float32 (exactly the values toCells() stores).
   */
  at(x: number, z: number): number {
    const top = this.m - 1;
    let u = (x - 0.5) * this.inv;
    let v = (z - 0.5) * this.inv;
    u = u > 0 ? (u < top ? u : top) : 0; // NaN → 0
    v = v > 0 ? (v < top ? v : top) : 0;
    let i = Math.floor(u);
    let j = Math.floor(v);
    if (i >= top) i = top - 1;
    if (j >= top) j = top - 1;
    const fu = u - i;
    const fv = v - j;
    const d = this.data;
    const r0 = j * this.m + i;
    const r1 = r0 + this.m;
    const a = d[r0] + (d[r0 + 1] - d[r0]) * fu;
    const b = d[r1] + (d[r1 + 1] - d[r1]) * fu;
    return Math.fround(a + (b - a) * fv);
  }

  /**
   * The field at every cell centre (row-major, index x + n·z): the values of at(x + 0.5, z + 0.5)
   * (bit-identical for power-of-two steps), computed separably — each lattice row is interpolated
   * along x once, then rows are blended along z. Writes into `out` when it is large enough.
   */
  toCells(out?: Float32Array): Float32Array {
    const n = this.n;
    const s = this.step;
    const m = this.m;
    const inv = this.inv;
    const d = this.data;
    const res = out !== undefined && out.length >= n * n ? out : new Float32Array(n * n);
    // rows[j·n + x] = lattice row j interpolated at cell x (doubles, exactly as in at()).
    const rows = new Float64Array(m * n);
    for (let x = 0, i = 0, k = 0; x < n; x++) {
      const fu = k * inv;
      for (let j = 0, r = i, o = x; j < m; j++, r += m, o += n) rows[o] = d[r] + (d[r + 1] - d[r]) * fu;
      if (++k === s) {
        k = 0;
        i++;
      }
    }
    for (let z = 0, j = 0, k = 0; z < n; z++) {
      const o = z * n;
      const r0 = j * n;
      if (k === 0) {
        for (let x = 0; x < n; x++) res[o + x] = rows[r0 + x];
      } else {
        const fv = k * inv;
        const r1 = r0 + n;
        for (let x = 0; x < n; x++) {
          const a = rows[r0 + x];
          res[o + x] = a + (rows[r1 + x] - a) * fv;
        }
      }
      if (++k === s) {
        k = 0;
        j++;
      }
    }
    return res;
  }
}

/** Hermite smoothstep of x between edge0 and edge1 (edge0 may exceed edge1 for a falling edge). */
export function smooth(edge0: number, edge1: number, x: number): number {
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
