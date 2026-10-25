/**
 * MODULE: voxel-world — terrain LAYOUT generator (module-internal).
 * Owner: voxel-world agent.
 *
 * Computes the per-tile terrain description from a seed: ground height, water flag, surface type,
 * natural decor kind + variant hash. Voxels are produced from this layout by terrain.ts.
 *
 * Pipeline (all deterministic; only IEEE-exact arithmetic + seeded noise/Rng):
 *  1. Water: one meandering river crossing the map edge to edge (a noise-displaced centre line with
 *     variable width 2–4 tiles, rasterised as a distance field over domain-warped tile centres)
 *     plus 0–2 lakes (warped, rotated ellipses; some threaded on the river). Morphological cleanup
 *     removes puddles, 1-tile tips and spikes. Constraints are validated (central plain + margin
 *     dry, starter-road row rules, ≥ 72 % land); a failed attempt is re-rolled with a new salt.
 *  2. Beaches: every land tile 4-adjacent to water (h = WATER_LEVEL + 1, SAND), plus sandy coast
 *     stretches along parts of the map edge where the island meets the ocean.
 *  3. Hills: a hill field (fBm + ridged noise × an edge mask from a warped superellipse distance),
 *     suppressed around the centre, along coasts and in a valley carrying the starter highway.
 *     A percentile threshold keeps ≈ 60 % of all tiles on the plain at exactly BASE_GROUND_HEIGHT;
 *     the rest becomes 2-voxel terraces up to MAX_GROUND_HEIGHT.
 *  4. Relaxation to |Δh| ≤ 2 between 4-neighbouring land tiles (lowering only), spike / pit /
 *     notch removal, relaxation again.
 *  5. Water beds from the distance to the shore (deeper away from land), in [MIN, WATER_LEVEL-1].
 *  6. Surface types (grass / sand / high grass / rock / snow) and decor placement.
 */
import { BASE_GROUND_HEIGHT, MAX_GROUND_HEIGHT, MIN_GROUND_HEIGHT, WATER_LEVEL } from '../types';
import { Rng, hash2, hashToUnit, mixSeed } from '../core/rng';
import { Simplex2, sampleSmoothField, smooth } from './noise';
import {
  DECOR_AUTUMN,
  DECOR_BIRCH,
  DECOR_BLOSSOM,
  DECOR_BUSH,
  DECOR_FLOWERS,
  DECOR_NONE,
  DECOR_OAK,
  DECOR_PINE,
} from './decor';

// ------------------------------------------------------------------ public layout description

/** Surface (top block family) of a tile. */
export const SURF_GRASS = 0;
export const SURF_SAND = 1;
export const SURF_WATER = 2;
/** Grass with rocky patches (h ≥ 27). */
export const SURF_HIGHGRASS = 3;
/** Rock with a little gravel / grass (h ≥ 30). */
export const SURF_ROCK = 4;
/** Snow cap with rock outcrops (h ≥ 34). */
export const SURF_SNOW = 5;

export const BEACH_HEIGHT = WATER_LEVEL + 1;
const PLAIN = BASE_GROUND_HEIGHT;
const HIGHGRASS_FROM = 27;
const ROCK_FROM = 30;
const SNOW_FROM = 34;

export interface TerrainLayout {
  /** Map edge in tiles. */
  readonly n: number;
  /** Ground height h per tile (bed height on water tiles). */
  readonly height: Uint8Array;
  /** 1 = water tile. */
  readonly water: Uint8Array;
  /** SURF_* per tile. */
  readonly surface: Uint8Array;
  /** DECOR_* per tile. */
  readonly decor: Uint8Array;
  /** Per-tile decor variant hash. */
  readonly decorHash: Uint32Array;
  /** Generation diagnostics (attempts used, river orientation …). */
  readonly info: LayoutInfo;
}

export interface LayoutInfo {
  waterAttempts: number;
  riverOrientation: 'ns-west' | 'ns-east' | 'ew-north' | 'ew-south' | 'none';
  lakes: number;
}

/**
 * Seeded noise fields shared by the layout (tile level) and the per-column surface shading in
 * terrain.ts (so dark grass sits under forests, etc.).
 */
export class TerrainNoise {
  readonly hills: Simplex2;
  readonly ridges: Simplex2;
  readonly warpA: Simplex2;
  readonly warpB: Simplex2;
  readonly coast: Simplex2;
  readonly river: Simplex2;
  readonly lake: Simplex2;
  readonly forest: Simplex2;
  readonly meadow: Simplex2;
  readonly special: Simplex2;
  readonly treeType: Simplex2;
  readonly grass: Simplex2;
  readonly rock: Simplex2;
  readonly bed: Simplex2;
  readonly massif: Simplex2;

  constructor(seed: number) {
    const s = seed >>> 0;
    this.hills = new Simplex2(mixSeed(s, 0x01));
    this.ridges = new Simplex2(mixSeed(s, 0x02));
    this.warpA = new Simplex2(mixSeed(s, 0x03));
    this.warpB = new Simplex2(mixSeed(s, 0x04));
    this.coast = new Simplex2(mixSeed(s, 0x05));
    this.river = new Simplex2(mixSeed(s, 0x06));
    this.lake = new Simplex2(mixSeed(s, 0x07));
    this.forest = new Simplex2(mixSeed(s, 0x08));
    this.meadow = new Simplex2(mixSeed(s, 0x09));
    this.special = new Simplex2(mixSeed(s, 0x0a));
    this.treeType = new Simplex2(mixSeed(s, 0x0b));
    this.grass = new Simplex2(mixSeed(s, 0x0c));
    this.rock = new Simplex2(mixSeed(s, 0x0d));
    this.bed = new Simplex2(mixSeed(s, 0x0e));
    this.massif = new Simplex2(mixSeed(s, 0x0f));
  }

  /** Forest density in [0, 1] at continuous tile coordinates (tile centre = tx + 0.5). */
  forestAt(xt: number, zt: number): number {
    return 0.5 + 0.5 * this.forest.fbm(xt / 9, zt / 9, 3);
  }

  /** Cheaper 2-octave forest field for per-column shading. */
  forestCheap(xt: number, zt: number): number {
    return 0.5 + 0.5 * this.forest.fbm(xt / 9, zt / 9, 2);
  }
}

/** Builds the layout. n = map edge in tiles (64 in the game; ≥ 16). */
export function generateLayout(seed: number, n: number, noise: TerrainNoise): TerrainLayout {
  return new LayoutBuilder(seed >>> 0, n, noise).build();
}

// ------------------------------------------------------------------ builder

type RiverOrientation = LayoutInfo['riverOrientation'];

class LayoutBuilder {
  private readonly seed: number;
  private readonly n: number;
  private readonly count: number;
  private readonly tn: TerrainNoise;
  /** Central always-plain square [c0, c1)². */
  private readonly c0: number;
  private readonly c1: number;
  /** Central no-decor square [d0, d1)². */
  private readonly d0: number;
  private readonly d1: number;
  /** Starter road: row `row`, tiles tx ∈ [0, rowEnd]. */
  private readonly row: number;
  private readonly rowEnd: number;

  private readonly height: Uint8Array;
  private readonly water: Uint8Array;
  private readonly beach: Uint8Array;
  private readonly protect: Uint8Array;
  private readonly lakeBan: Uint8Array;
  private readonly surface: Uint8Array;
  private readonly decor: Uint8Array;
  private readonly decorHash: Uint32Array;
  private readonly coastF: Float32Array;
  /** Mountain massif weight in [0, 1] (large regions where hills concentrate). */
  private readonly massifF: Float32Array;
  /** Low-frequency fields sampled on coarse lattices (see sampleSmoothField). */
  private readonly hillWarp: Float32Array;
  private readonly specialF: Float32Array;
  private readonly typeF: Float32Array;
  /** Warped tile centres (for organic river banks / lake shores). */
  private readonly wx: Float32Array;
  private readonly wz: Float32Array;
  private readonly warpReady: Uint8Array;
  private readonly riverD: Float32Array;
  private readonly scratchI: Int32Array;
  private readonly scratchJ: Int32Array;
  /** River centre line samples (x, z pairs) of the current attempt. */
  private path = new Float64Array(0);
  private pathLen = 0;
  private info: LayoutInfo = { waterAttempts: 0, riverOrientation: 'none', lakes: 0 };

  constructor(seed: number, n: number, tn: TerrainNoise) {
    this.seed = seed;
    this.n = n;
    this.count = n * n;
    this.tn = tn;
    const mid = n >> 1;
    this.c0 = mid - 8;
    this.c1 = mid + 8;
    this.d0 = mid - 6;
    this.d1 = mid + 6;
    this.row = mid;
    this.rowEnd = mid;
    const c = this.count;
    this.height = new Uint8Array(c);
    this.water = new Uint8Array(c);
    this.beach = new Uint8Array(c);
    this.protect = new Uint8Array(c);
    this.lakeBan = new Uint8Array(c);
    this.surface = new Uint8Array(c);
    this.decor = new Uint8Array(c);
    this.decorHash = new Uint32Array(c);
    this.coastF = new Float32Array(c);
    this.massifF = new Float32Array(c);
    this.hillWarp = new Float32Array(c);
    this.specialF = new Float32Array(c);
    this.typeF = new Float32Array(c);
    this.wx = new Float32Array(c);
    this.wz = new Float32Array(c);
    this.warpReady = new Uint8Array(c);
    this.riverD = new Float32Array(c);
    this.scratchI = new Int32Array(c);
    this.scratchJ = new Int32Array(c);
  }

  build(): TerrainLayout {
    const T: number[] = [performance.now()];
    this.prepare(); T.push(performance.now());
    this.makeWater(); T.push(performance.now());
    this.makeBeaches(); T.push(performance.now());
    this.makeHills(); T.push(performance.now());
    this.relax(); T.push(performance.now());
    this.smoothHills(); T.push(performance.now());
    this.relax(); T.push(performance.now());
    this.finalizeLand();
    this.makeBeds();
    this.makeSurfaces(); T.push(performance.now());
    this.placeDecor(); T.push(performance.now());
    (globalThis as any).__layoutTimes = T.slice(1).map((v, i) => +(v - T[i]).toFixed(2));
    return {
      n: this.n,
      height: this.height,
      water: this.water,
      surface: this.surface,
      decor: this.decor,
      decorHash: this.decorHash,
      info: this.info,
    };
  }

  // ---------------------------------------------------------------- helpers

  private inCentre(tx: number, tz: number): boolean {
    return tx >= this.c0 && tx < this.c1 && tz >= this.c0 && tz < this.c1;
  }

  private edgeDist(tx: number, tz: number): number {
    const n1 = this.n - 1;
    return Math.min(tx, tz, n1 - tx, n1 - tz);
  }

  /** Number of in-map 4-neighbours of t that are water. */
  private waterNeighbours(t: number): number {
    const n = this.n;
    const tx = t % n;
    const w = this.water;
    let k = 0;
    if (tx > 0 && w[t - 1]) k++;
    if (tx < n - 1 && w[t + 1]) k++;
    if (t >= n && w[t - n]) k++;
    if (t < this.count - n && w[t + n]) k++;
    return k;
  }

  private prepare(): void {
    const n = this.n;
    const tn = this.tn;
    // Smooth low-frequency fields on coarse lattices (cheap, deterministic).
    sampleSmoothField(n, 4, this.massifF, (x, z) => tn.massif.fbm(x / 26, z / 26, 2));
    sampleSmoothField(n, 2, this.coastF, (x, z) => tn.coast.noise(x / 15, z / 15));
    sampleSmoothField(n, 2, this.hillWarp, (x, z) => tn.warpA.fbm(x / 10 + 3.1, z / 10 - 5.3, 2));
    sampleSmoothField(n, 2, this.specialF, (x, z) => tn.special.noise(x / 11, z / 11));
    sampleSmoothField(n, 2, this.typeF, (x, z) => tn.treeType.noise(x / 8, z / 8));
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        // Water may not touch the central plain: protect it plus a 1-tile margin (so even its
        // beaches stay outside), and the region-connection tile of the starter road.
        if (tx >= this.c0 - 1 && tx < this.c1 + 1 && tz >= this.c0 - 1 && tz < this.c1 + 1) this.protect[t] = 1;
        if (tx === 0 && tz === this.row) this.protect[t] = 1;
        // Lakes never touch the starter road corridor.
        if (tx <= this.rowEnd + 2 && Math.abs(tz - this.row) <= 2) this.lakeBan[t] = 1;
        const m = smooth(-0.2, 0.42, this.massifF[t]);
        this.massifF[t] = m;
        // Sandy coasts where there are no mountains.
        this.coastF[t] = smooth(0.0, 0.3, this.coastF[t]) * (1 - 0.85 * m);
      }
    }
  }

  /** Warped tile centre (irregular banks and shores), computed on demand. */
  private warp(t: number): void {
    const n = this.n;
    const tx = t % n;
    const tz = (t - tx) / n;
    this.wx[t] = tx + 0.5 + 0.42 * this.tn.warpA.noise(tx / 3.3, tz / 3.3);
    this.wz[t] = tz + 0.5 + 0.42 * this.tn.warpB.noise(tx / 3.3 + 19.1, tz / 3.3 - 7.7);
    this.warpReady[t] = 1;
  }

  // ---------------------------------------------------------------- 1. water

  private makeWater(): void {
    const MAX_ATTEMPTS = 12;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      this.water.fill(0);
      const rng = new Rng(mixSeed(this.seed, 0x7a7e2 + attempt * 0x9e3779b1));
      // Later attempts use calmer rivers that avoid the starter row.
      const orientation = this.carveRiver(rng, attempt >= 8);
      const lakes = this.carveLakes(rng, attempt >= 10 ? 0 : 2);
      this.cleanupWater();
      if (this.waterValid()) {
        this.info = { waterAttempts: attempt + 1, riverOrientation: orientation, lakes };
        return;
      }
    }
    // Fallback (never observed in tests): a dry map is always valid.
    this.water.fill(0);
    this.info = { waterAttempts: MAX_ATTEMPTS, riverOrientation: 'none', lakes: 0 };
  }

  /**
   * Carves the river into `water` and records its centre line. Returns the orientation.
   *
   * The centre line is a quadratic Bezier from beyond one map edge to beyond the opposite edge
   * (bowing through a control point), displaced perpendicular to itself by two octaves of 1D noise
   * (meanders). The meander amplitude is reduced until the whole line stays inside its band, so the
   * river never needs the protected centre. Near the starter road the meanders taper off so the
   * crossing is short and nearly perpendicular.
   */
  private carveRiver(rng: Rng, calm: boolean): RiverOrientation {
    const n = this.n;
    const orient = calm ? 2 + rng.int(0, 2) : rng.weighted([0.34, 0.22, 0.22, 0.22]);
    const ns = orient <= 1;
    const far = orient === 1 || orient === 3;
    // Lateral band (distance from the near map edge) the centre line must stay in.
    const bandLo = 3.2;
    const bandHi = this.c0 - 1 - 2.6; // water (half-width ≤ 2 + bank warp) stays off the margin
    const a = rng.range(n * 0.13, n * 0.27);
    const b = rng.range(n * 0.13, n * 0.27);
    const c = rng.range(n * 0.09, n * 0.27);
    let amp1 = calm ? rng.range(1.5, 2.6) : rng.range(3.2, 5.6);
    const len1 = rng.range(14, 24);
    let amp2 = rng.range(0.5, 1.3);
    const len2 = rng.range(4.5, 7.5);
    const lane1 = rng.range(0, 64);
    const lane2 = rng.range(64, 128);
    const lane3 = rng.range(128, 192);
    const crossesRoad = orient === 0;
    const rn = this.tn.river;

    const samples = 4 * (n + 8) + 1;
    if (this.path.length < samples * 2) this.path = new Float64Array(samples * 2);
    const widths = this.scratchWidths(samples);
    const path = this.path;
    // Bezier in (lateral, along) coordinates: lateral = distance from the near edge.
    const s0 = -4;
    const s1 = n + 4;
    for (let tries = 0; tries < 6; tries++) {
      let lo = Infinity;
      let hi = -Infinity;
      let arc = 0;
      let px = 0;
      let pz = 0;
      for (let k = 0; k < samples; k++) {
        const u = k / (samples - 1);
        const iu = 1 - u;
        // Position and tangent of the Bezier (lateral L, along A).
        const L = iu * iu * a + 2 * iu * u * c + u * u * b;
        const A = s0 + (s1 - s0) * u;
        const dL = 2 * iu * (c - a) + 2 * u * (b - c);
        const dA = s1 - s0;
        const tl = Math.sqrt(dL * dL + dA * dA);
        if (k > 0) {
          const ex = L - px;
          const ez = A - pz;
          arc += Math.sqrt(ex * ex + ez * ez);
        }
        px = L;
        pz = A;
        let m = amp1 * rn.noise(arc / len1, lane1) + amp2 * rn.noise(arc / len2, lane2);
        if (crossesRoad) m *= 0.3 + 0.7 * smooth(1.5, 8, Math.abs(A - (this.row + 0.5)));
        // Normal of (dL, dA) is (dA, -dL)/|t|: lateral component dA/|t|, along component -dL/|t|.
        const lat = L + (m * dA) / tl;
        const alg = A - (m * dL) / tl;
        if (alg > -1 && alg < n + 1) {
          if (lat < lo) lo = lat;
          if (lat > hi) hi = lat;
        }
        let w = 2.2 + 1.75 * clamp01(0.5 + 0.75 * rn.noise(arc / 15, lane3));
        // Narrower where it crosses the starter road (bridge ≤ 4 tiles).
        if (crossesRoad && Math.abs(alg - (this.row + 0.5)) < 7) w = Math.min(w, 2.8);
        const x = far ? n - lat : lat;
        path[k * 2] = ns ? x : alg;
        path[k * 2 + 1] = ns ? alg : x;
        widths[k] = w;
      }
      if (lo >= bandLo && hi <= bandHi) break;
      amp1 *= 0.72;
      amp2 *= 0.8;
    }
    this.pathLen = samples;

    // Rasterise: normalised distance (distance / half-width) to the polyline, over warped centres.
    const d = this.riverD;
    d.fill(1e9);
    const wx = this.wx;
    const wz = this.wz;
    for (let k = 0; k + 1 < samples; k++) {
      const ax = path[k * 2];
      const az = path[k * 2 + 1];
      const bx = path[k * 2 + 2];
      const bz = path[k * 2 + 3];
      const w0 = widths[k];
      const w1 = widths[k + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2s = ex * ex + ez * ez;
      const pad = Math.max(w0, w1) * 0.5 + 1;
      const tx0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
      const tx1 = Math.min(n - 1, Math.floor(Math.max(ax, bx) + pad));
      const tz0 = Math.max(0, Math.floor(Math.min(az, bz) - pad));
      const tz1 = Math.min(n - 1, Math.floor(Math.max(az, bz) + pad));
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const t = tz * n + tx;
          if (this.warpReady[t] === 0) this.warp(t);
          const qx = wx[t] - ax;
          const qz = wz[t] - az;
          let u = len2s > 0 ? (qx * ex + qz * ez) / len2s : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = qx - u * ex;
          const dz = qz - u * ez;
          const half = 0.5 * (w0 + (w1 - w0) * u);
          const dd = (dx * dx + dz * dz) / (half * half);
          if (dd < d[t]) d[t] = dd;
        }
      }
    }
    for (let t = 0; t < this.count; t++) if (d[t] < 1 && !this.protect[t]) this.water[t] = 1;
    return orient === 0 ? 'ns-west' : orient === 1 ? 'ns-east' : orient === 2 ? 'ew-north' : 'ew-south';
  }

  private widthBuf = new Float64Array(0);
  private scratchWidths(samples: number): Float64Array {
    if (this.widthBuf.length < samples) this.widthBuf = new Float64Array(samples);
    return this.widthBuf;
  }

  /** Carves 0..maxLakes lakes (some threaded on the river). Returns how many were placed. */
  private carveLakes(rng: Rng, maxLakes: number): number {
    const n = this.n;
    const wanted = Math.min(maxLakes, rng.weighted([0.3, 0.48, 0.22]));
    const list = this.scratchI;
    let placed = 0;
    for (let k = 0; k < wanted; k++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        let cx: number;
        let cz: number;
        if (this.pathLen > 0 && rng.chance(0.55)) {
          const i = rng.int(Math.floor(this.pathLen * 0.18), Math.floor(this.pathLen * 0.82));
          cx = this.path[i * 2] + rng.range(-1.5, 1.5);
          cz = this.path[i * 2 + 1] + rng.range(-1.5, 1.5);
        } else {
          cx = rng.range(4, n - 4);
          cz = rng.range(4, n - 4);
        }
        const r = rng.range(2.6, 4.9);
        const asp = rng.range(0.6, 1.0);
        let ux = rng.range(-1, 1);
        let uz = rng.range(-1, 1);
        const ul = Math.sqrt(ux * ux + uz * uz);
        if (ul < 1e-3) {
          ux = 1;
          uz = 0;
        } else {
          ux /= ul;
          uz /= ul;
        }
        const r2 = r * asp;
        const tx0 = Math.max(0, Math.floor(cx - r - 2));
        const tx1 = Math.min(n - 1, Math.ceil(cx + r + 2));
        const tz0 = Math.max(0, Math.floor(cz - r - 2));
        const tz1 = Math.min(n - 1, Math.ceil(cz + r + 2));
        let m = 0;
        let ok = true;
        for (let tz = tz0; tz <= tz1 && ok; tz++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            const t = tz * n + tx;
            if (this.warpReady[t] === 0) this.warp(t);
            const dx = this.wx[t] - cx;
            const dz = this.wz[t] - cz;
            const p = (dx * ux + dz * uz) / r;
            const q = (-dx * uz + dz * ux) / r2;
            const lim = 1 + 0.22 * this.tn.lake.noise(tx / 2.3, tz / 2.3);
            if (p * p + q * q >= lim) continue;
            // A lake (or its beach) must stay off the central plain and the starter-road corridor.
            if (this.protect[t] || this.lakeBan[t]) {
              ok = false;
              break;
            }
            list[m++] = t;
          }
        }
        if (!ok || m < 8) continue;
        for (let i = 0; i < m; i++) this.water[list[i]] = 1;
        placed++;
        break;
      }
    }
    return placed;
  }

  private cleanupWater(): void {
    const w = this.water;
    const roadStart = this.row * this.n;
    for (let iter = 0; iter < 10; iter++) {
      let changed = false;
      // Puddles and 1-tile tips: water with < 2 water neighbours dries up.
      for (let t = 0; t < this.count; t++) {
        if (w[t] && this.waterNeighbours(t) < 2) {
          w[t] = 0;
          changed = true;
        }
      }
      // Spikes / tiny islands: land with ≥ 3 water neighbours floods.
      for (let t = 0; t < this.count; t++) {
        if (!w[t] && !this.protect[t] && t !== roadStart && this.waterNeighbours(t) >= 3) {
          w[t] = 1;
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.removeSmallComponents(1, 10, 0);
    this.removeSmallComponents(0, 6, 1);
  }

  /**
   * Flood-fills 4-connected components of tiles with water === value; components smaller than
   * minSize are set to `replace` (protected tiles never become water).
   */
  private removeSmallComponents(value: number, minSize: number, replace: number): void {
    const n = this.n;
    const w = this.water;
    const label = this.scratchJ;
    label.fill(0);
    const stack = this.scratchI;
    let comp = 0;
    for (let s = 0; s < this.count; s++) {
      if (w[s] !== value || label[s] !== 0) continue;
      comp++;
      let sp = 0;
      let size = 0;
      stack[sp++] = s;
      label[s] = comp;
      // First pass: measure (stack holds the component when done, in visit order).
      const members: number[] = [];
      while (sp > 0) {
        const t = stack[--sp];
        members.push(t);
        size++;
        const tx = t % n;
        if (tx > 0 && w[t - 1] === value && label[t - 1] === 0) {
          label[t - 1] = comp;
          stack[sp++] = t - 1;
        }
        if (tx < n - 1 && w[t + 1] === value && label[t + 1] === 0) {
          label[t + 1] = comp;
          stack[sp++] = t + 1;
        }
        if (t >= n && w[t - n] === value && label[t - n] === 0) {
          label[t - n] = comp;
          stack[sp++] = t - n;
        }
        if (t < this.count - n && w[t + n] === value && label[t + n] === 0) {
          label[t + n] = comp;
          stack[sp++] = t + n;
        }
      }
      if (size < minSize) {
        // Land components touching the map edge are coast, keep them.
        if (value === 0 && members.some((t) => this.edgeDist(t % n, (t / n) | 0) === 0)) continue;
        for (const t of members) if (replace === 0 || !this.protect[t]) w[t] = replace;
      }
    }
  }

  private waterValid(): boolean {
    const n = this.n;
    let waterCount = 0;
    for (let t = 0; t < this.count; t++) {
      if (!this.water[t]) continue;
      waterCount++;
      if (this.protect[t]) return false;
    }
    if (waterCount > this.count * 0.28) return false;
    if (waterCount < n) return false; // the river must really cross the map
    // Starter road row: tile (0,row) is land; water only in short crossings (≤ 4 tiles, ≤ 2 runs).
    const base = this.row * n;
    if (this.water[base]) return false;
    let run = 0;
    let runs = 0;
    for (let tx = 0; tx <= this.rowEnd; tx++) {
      if (this.water[base + tx]) {
        if (run === 0) runs++;
        run++;
        if (run > 4) return false;
      } else run = 0;
    }
    if (runs > 2) return false;
    return true;
  }

  // ---------------------------------------------------------------- 2. beaches

  private makeBeaches(): void {
    const n = this.n;
    for (let t = 0; t < this.count; t++) {
      if (!this.water[t] && this.waterNeighbours(t) > 0) this.beach[t] = 1;
    }
    // Sandy coast stretches along the map edge (the island meets the ocean ring there).
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        if (this.water[t] || this.protect[t] && !(tx === 0 && tz === this.row)) continue;
        const ed = this.edgeDist(tx, tz);
        if (ed === 0 && this.coastF[t] > 0.5) this.beach[t] = 1;
      }
    }
    for (let tz = 1; tz < n - 1; tz++) {
      for (let tx = 1; tx < n - 1; tx++) {
        const t = tz * n + tx;
        if (this.water[t] || this.protect[t] || this.beach[t]) continue;
        if (this.edgeDist(tx, tz) !== 1 || this.coastF[t] <= 0.85) continue;
        // Second beach row only behind a beach edge tile.
        const ox = tx === 1 ? t - 1 : tx === n - 2 ? t + 1 : -1;
        const oz = tz === 1 ? t - n : tz === n - 2 ? t + n : -1;
        if ((ox >= 0 && this.beach[ox]) || (oz >= 0 && this.beach[oz])) this.beach[t] = 1;
      }
    }
    for (let t = 0; t < this.count; t++) {
      if (this.water[t]) this.height[t] = MIN_GROUND_HEIGHT; // beds come later
      else this.height[t] = this.beach[t] ? BEACH_HEIGHT : PLAIN;
    }
  }

  // ---------------------------------------------------------------- 3. hills

  private makeHills(): void {
    const n = this.n;
    const tn = this.tn;
    const rng = new Rng(mixSeed(this.seed, 0x4111));
    const R = new Float32Array(this.count);
    let plainCount = 0;
    let eligible = 0;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        if (this.water[t] || this.beach[t]) continue;
        plainCount++;
        if (this.inCentre(tx, tz)) continue;
        const u = ((tx + 0.5) / n) * 2 - 1;
        const v = ((tz + 0.5) / n) * 2 - 1;
        let d = Math.sqrt(Math.sqrt(u * u * u * u + v * v * v * v));
        d += 0.17 * this.hillWarp[t];
        const mask = smooth(0.42, 0.92, d);
        if (mask <= 0) continue;
        // Mountains concentrate in massif regions; elsewhere only low hills.
        const massif = 0.22 + 0.78 * this.massifF[t];
        const base = 0.5 + 0.5 * tn.hills.fbm(tx / 12, tz / 12, 3);
        const ridge = tn.ridges.ridged(tx / 16, tz / 16, 2);
        let r = mask * massif * (0.55 * base + 0.45 * ridge);
        // Keep a ring of plain around the centre.
        const cd = Math.max(this.c0 - tx, tx - (this.c1 - 1), this.c0 - tz, tz - (this.c1 - 1), 0);
        r *= smooth(2, 7, cd);
        // Low coasts where the edge has beaches.
        r *= 1 - this.coastF[t] * smooth(10, 2, this.edgeDist(tx, tz));
        // A valley carrying the starter highway in from the west edge.
        if (tx < this.c0) r *= smooth(1, 5, Math.abs(tz - this.row));
        R[t] = r;
        if (r > 0.02) eligible++;
      }
    }
    const target = Math.ceil(this.count * 0.6);
    const budget = Math.min(plainCount - target, Math.floor(this.count * 0.34), eligible);
    if (budget <= 0) return;
    // Threshold = the budget-th largest hill value among eligible tiles.
    const vals = new Float32Array(eligible);
    let k = 0;
    for (let t = 0; t < this.count; t++) if (R[t] > 0.02) vals[k++] = R[t];
    vals.sort();
    const thr = vals[eligible - budget];
    const rMax = vals[eligible - 1];
    // Highest raw terrace: 8..12 steps of 2 voxels. The concave (square-root) mapping lifts most of
    // a hill region to high raw levels; relax() then carves it into 1-tile-wide terraces that follow
    // the region's outline, so large massifs reach rock / snow heights and small hills stay low.
    const levels = 8 + rng.int(0, 5);
    const span = Math.max(1e-6, rMax - thr);
    for (let t = 0; t < this.count; t++) {
      const r = R[t];
      if (!(r > 0.02) || r < thr) continue;
      let lvl = 1 + Math.floor(levels * Math.sqrt((r - thr) / span));
      if (lvl > levels) lvl = levels;
      this.height[t] = Math.min(MAX_GROUND_HEIGHT, PLAIN + 2 * lvl);
    }
  }

  // ---------------------------------------------------------------- 4. relaxation & cleanup

  /**
   * Lowers land tiles until |Δh| ≤ 2 between all 4-neighbouring land tiles. Only tiles above the
   * plain can ever be lowered (every land tile is ≥ BEACH_HEIGHT), so the forward/backward sweeps
   * run over that list only (kept in raster order).
   */
  private relax(): void {
    const n = this.n;
    const h = this.height;
    const w = this.water;
    const list = this.scratchI;
    let m = 0;
    for (let t = 0; t < this.count; t++) if (!w[t] && h[t] > PLAIN) list[m++] = t;
    if (m === 0) return;
    const last = this.count - n;
    for (let iter = 0; iter < 200; iter++) {
      let changed = false;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < m; i++) {
          const t = list[pass === 0 ? i : m - 1 - i];
          const tx = t % n;
          let v = h[t];
          if (tx > 0 && !w[t - 1] && h[t - 1] + 2 < v) v = h[t - 1] + 2;
          if (tx < n - 1 && !w[t + 1] && h[t + 1] + 2 < v) v = h[t + 1] + 2;
          if (t >= n && !w[t - n] && h[t - n] + 2 < v) v = h[t - n] + 2;
          if (t < last && !w[t + n] && h[t + n] + 2 < v) v = h[t + n] + 2;
          // Keep the terrace parity (PLAIN + 2k): next to a beach (11) a hill drops to the plain.
          v -= (v - PLAIN) & 1;
          if (v < h[t]) {
            h[t] = v;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }

  /** Removes 1-tile spikes, pits and terrace notches (mode filter) on non-beach land. */
  private smoothHills(): void {
    const n = this.n;
    const h = this.height;
    const w = this.water;
    const nb = [0, 0, 0, 0];
    // Candidates: non-beach land outside the centre that is a hill or touches one.
    const list = this.scratchJ;
    let m = 0;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        if (w[t] || this.beach[t] || this.inCentre(tx, tz)) continue;
        const hill =
          h[t] > PLAIN ||
          (tx > 0 && h[t - 1] > PLAIN) ||
          (tx < n - 1 && h[t + 1] > PLAIN) ||
          (tz > 0 && h[t - n] > PLAIN) ||
          (tz < n - 1 && h[t + n] > PLAIN);
        if (hill) list[m++] = t;
      }
    }
    for (let iter = 0; iter < 8; iter++) {
      let changed = false;
      for (let li = 0; li < m; li++) {
        const t = list[li];
        const tx = t % n;
        const tz = (t - tx) / n;
        let k = 0;
        if (tx > 0 && !w[t - 1]) nb[k++] = h[t - 1];
        if (tx < n - 1 && !w[t + 1]) nb[k++] = h[t + 1];
        if (tz > 0 && !w[t - n]) nb[k++] = h[t - n];
        if (tz < n - 1 && !w[t + n]) nb[k++] = h[t + n];
        if (k === 0) continue;
        let mx = nb[0];
        let mn = nb[0];
        for (let i = 1; i < k; i++) {
          if (nb[i] > mx) mx = nb[i];
          if (nb[i] < mn) mn = nb[i];
        }
        const cur = h[t];
        let next = cur;
        if (k >= 2 && cur > mx) next = mx; // spike
        else if (k >= 2 && cur < mn) next = mn; // pit
        else if (k === 4) {
          // Notch / bump on a terrace edge: 3 neighbours agree on another height.
          for (let i = 0; i < 2; i++) {
            const H = nb[i];
            if (H === cur) continue;
            let same = 0;
            let ok = true;
            for (let j = 0; j < 4; j++) {
              if (nb[j] === H) same++;
              else if (Math.abs(nb[j] - H) > 2) ok = false;
            }
            if (same >= 3 && ok) {
              next = H;
              break;
            }
          }
        }
        if (next !== cur) {
          if (next < PLAIN) {
            // Only possible when every land neighbour is a beach: become sand as well.
            next = BEACH_HEIGHT;
            this.beach[t] = 1;
          }
          h[t] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  /** Re-asserts the hard rules after all land passes. */
  private finalizeLand(): void {
    const n = this.n;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        if (this.water[t]) continue;
        if (this.inCentre(tx, tz)) {
          this.height[t] = PLAIN;
          this.beach[t] = 0;
        } else if (this.beach[t]) this.height[t] = BEACH_HEIGHT;
        else if (this.height[t] < PLAIN) this.height[t] = PLAIN;
      }
    }
  }

  // ---------------------------------------------------------------- 5. water beds

  private makeBeds(): void {
    const n = this.n;
    const w = this.water;
    const dist = this.scratchJ;
    const queue = this.scratchI;
    dist.fill(0);
    let qh = 0;
    let qt = 0;
    for (let t = 0; t < this.count; t++) {
      if (!w[t]) continue;
      const tx = t % n;
      const shore = (tx > 0 && !w[t - 1]) || (tx < n - 1 && !w[t + 1]) || (t >= n && !w[t - n]) || (t < this.count - n && !w[t + n]);
      if (shore) {
        dist[t] = 1;
        queue[qt++] = t;
      }
    }
    while (qh < qt) {
      const t = queue[qh++];
      const tx = t % n;
      const d = dist[t] + 1;
      if (tx > 0 && w[t - 1] && dist[t - 1] === 0) {
        dist[t - 1] = d;
        queue[qt++] = t - 1;
      }
      if (tx < n - 1 && w[t + 1] && dist[t + 1] === 0) {
        dist[t + 1] = d;
        queue[qt++] = t + 1;
      }
      if (t >= n && w[t - n] && dist[t - n] === 0) {
        dist[t - n] = d;
        queue[qt++] = t - n;
      }
      if (t < this.count - n && w[t + n] && dist[t + n] === 0) {
        dist[t + n] = d;
        queue[qt++] = t + n;
      }
    }
    const salt = mixSeed(this.seed, 0xbed);
    for (let t = 0; t < this.count; t++) {
      if (!w[t]) continue;
      const d = dist[t] === 0 ? 6 : dist[t];
      const jitter = d >= 2 ? hash2(t % n, (t / n) | 0, salt) & 1 : 0;
      let bed = WATER_LEVEL - 1 - d - jitter; // d=1 → 8, d=2 → 7/6, d=3 → 6/5, …
      if (bed < MIN_GROUND_HEIGHT) bed = MIN_GROUND_HEIGHT;
      if (bed > WATER_LEVEL - 1) bed = WATER_LEVEL - 1;
      this.height[t] = bed;
    }
  }

  // ---------------------------------------------------------------- 6. surfaces & decor

  private makeSurfaces(): void {
    for (let t = 0; t < this.count; t++) {
      const h = this.height[t];
      let s = SURF_GRASS;
      if (this.water[t]) s = SURF_WATER;
      else if (this.beach[t]) s = SURF_SAND;
      else if (h >= SNOW_FROM) s = SURF_SNOW;
      else if (h >= ROCK_FROM) s = SURF_ROCK;
      else if (h >= HIGHGRASS_FROM) s = SURF_HIGHGRASS;
      this.surface[t] = s;
    }
  }

  private placeDecor(): void {
    const n = this.n;
    const tn = this.tn;
    const salt = mixSeed(this.seed, 0xdec0);
    const hashSalt = mixSeed(this.seed, 0xdec1);
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const t = tz * n + tx;
        this.decorHash[t] = hash2(tx, tz, hashSalt);
        const surf = this.surface[t];
        if (surf === SURF_WATER || surf === SURF_SAND) continue;
        if (tx >= this.d0 && tx < this.d1 && tz >= this.d0 && tz < this.d1) continue;
        const hv = hash2(tx, tz, salt);
        const r = hashToUnit(hv);
        const r2 = hashToUnit(hash2(tz, tx, salt ^ 0x5bd1e995));
        const xc = tx + 0.5;
        const zc = tz + 0.5;
        const F = tn.forestAt(xc, zc);
        const M = 0.5 + 0.5 * tn.meadow.fbm(xc / 6.5, zc / 6.5, 2);
        const S = this.specialF[t];
        const typ = this.typeF[t];
        const h = this.height[t];
        const elev = clamp01((h - PLAIN) / 22);
        let kind = DECOR_NONE;
        if (h > PLAIN) {
          // Hills: dense, clustered forests with clearings; conifers take over with altitude.
          let dens = 0.16 + 0.8 * smooth(0.34, 0.58, F + 0.2 * elev);
          if (surf === SURF_SNOW) dens *= 0.3;
          else if (surf === SURF_ROCK) dens *= 0.45;
          else if (surf === SURF_HIGHGRASS) dens *= 0.8;
          if (r < dens) {
            const conifer = elev * 2.1 + 0.5 * typ + 0.35 * (r2 - 0.5);
            if (conifer > 0.5) kind = DECOR_PINE;
            else if (elev < 0.32 && S > 0.6) kind = DECOR_AUTUMN;
            else if (elev < 0.25 && S < -0.66) kind = DECOR_BLOSSOM;
            else kind = typ < -0.3 ? DECOR_BIRCH : DECOR_OAK;
          } else if (r < dens + 0.09) kind = DECOR_BUSH;
          else if (elev < 0.4 && M > 0.66 && r2 < 0.45) kind = DECOR_FLOWERS;
        } else {
          // Plain: sparse trees and groves, flower meadows; opens up towards the centre.
          const cd = Math.max(this.d0 - tx, tx - (this.d1 - 1), this.d0 - tz, tz - (this.d1 - 1), 0);
          const open = smooth(0, 6, cd);
          const dens = (0.035 + 0.5 * smooth(0.56, 0.8, F)) * open;
          if (r < dens) {
            if (S > 0.6) kind = DECOR_AUTUMN;
            else if (S < -0.62) kind = DECOR_BLOSSOM;
            else if (r2 < 0.12) kind = DECOR_PINE;
            else kind = typ < -0.25 || r2 > 0.82 ? DECOR_BIRCH : DECOR_OAK;
          } else if (r < dens + (0.008 + 0.075 * smooth(0.44, 0.66, F)) * open) kind = DECOR_BUSH;
          else if (r2 < 0.62 * smooth(0.55, 0.8, M)) kind = DECOR_FLOWERS;
        }
        this.decor[t] = kind;
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
