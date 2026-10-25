/**
 * MODULE: voxel-world — terrain LAYOUT generator (module-internal).
 * Owner: voxel-world agent.
 *
 * Computes the per-tile terrain description from a seed: ground height, water flag, surface type,
 * natural decor kind + variant hash. Voxels are produced from this layout by terrain.ts.
 *
 * Pipeline (all deterministic: seeded noise / Rng and IEEE-exact arithmetic only):
 *  0. Low-frequency fields (massif, coast, hill warp, hills + ridges, forest, meadow, tree type,
 *     special trees) are sampled on coarse lattices (LatticeField) and interpolated bilinearly to
 *     per-tile arrays.
 *  1. Water: one meandering river crossing the map edge to edge (a noise-displaced quadratic Bezier
 *     centre line with variable width 2–4 tiles, rasterised as a distance field over domain-warped
 *     tile centres) plus 0–2 lakes (warped, rotated ellipses; some threaded on the river).
 *     Morphological cleanup removes puddles, 1-tile tips, spikes and tiny islands. Constraints are
 *     validated (central plain + margin dry, starter-road row rules, ≥ 72 % land); a failed attempt
 *     is re-rolled with a new salt (later attempts use calmer rivers away from the starter row).
 *  2. Optional mountain corner (most maps): a broad massif in a map corner on the side away from
 *     the river, tall enough for rock and snow caps.
 *  3. Beaches: every land tile 4-adjacent to water (h = WATER_LEVEL + 1, SAND), plus sandy coast
 *     stretches along parts of the map edge where the island meets the ocean.
 *  4. Hills: a hill field (fBm + ridged noise × an edge mask from a warped superellipse distance ×
 *     massif regions), suppressed around the centre, along sandy coasts and in a valley carrying
 *     the starter highway. A percentile threshold keeps ≈ 60 % of all tiles on the plain at exactly
 *     BASE_GROUND_HEIGHT; the rest becomes 2-voxel terraces up to MAX_GROUND_HEIGHT.
 *  5. Relaxation to |Δh| ≤ 2 between 4-neighbouring land tiles (lowering only), spike / pit /
 *     notch removal on hills, relaxation again, then a last spike / pit pass over all land.
 *  6. Water beds from the distance to the shore (deeper away from land), in [MIN, WATER_LEVEL-1].
 *  7. Surface types (grass / sand / high grass / rock / snow) and decor placement.
 *
 * Cost: a few ms warm, well under 30 ms on a cold JIT (the Terrain constructor runs this before any
 * voxel exists, usually as the first terrain code of the session). A cold engine runs every loop in
 * its baseline tiers, where each call and each float temporary costs, so the passes avoid per-tile
 * helper calls, sample smooth fields on lattices, and restrict work to bounding boxes / worklists.
 */
import { BASE_GROUND_HEIGHT, MAX_GROUND_HEIGHT, MIN_GROUND_HEIGHT, WATER_LEVEL } from '../types';
import { Rng, hash2, hashToUnit, mixSeed } from '../core/rng';
import { LatticeField, Simplex2, smooth } from './noise';
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
/** Domain-warp amplitude of tile centres for river banks / lake shores (|noise| ≤ 1). */
const BANK_WARP = 0.42;
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
  /**
   * Forest density in [0, 1] at continuous tile coordinates (tile centre = t + 0.5). Shared with
   * the per-column grass shading in terrain.ts (darker grass under forests).
   */
  readonly forest: LatticeField;
  /** forest at every tile centre (index tx + n·tz), bit-identical to forest.at(tx + 0.5, tz + 0.5). */
  readonly forestTiles: Float32Array;
  /** Generation diagnostics (attempts used, river orientation …). */
  readonly info: LayoutInfo;
}

export interface LayoutInfo {
  waterAttempts: number;
  riverOrientation: 'ns-west' | 'ns-east' | 'ew-north' | 'ew-south' | 'none';
  lakes: number;
  /** Map corner holding a tall massif ('nw' | 'ne' | 'sw' | 'se'), or 'none'. */
  mountainCorner: 'nw' | 'ne' | 'sw' | 'se' | 'none';
}

/**
 * x offsets that separate the layout fields sharing TerrainNoise.field. Each field samples its own
 * x interval (at every octave: fBm scales the offset with the octave frequency) and no two
 * intervals overlap, so the fields are uncorrelated. Octave 1 / octave 2 x intervals (n = 64):
 * massif [211, 214] / [440, 445], coast [464, 468], hill warp [719, 726] / [1456, 1468],
 * hills [978, 983] / [1973, 1983], ridges [1232, 1236] / [2481, 2489], meadow [1489, 1499],
 * special [1748, 1754], tree type [2003, 2011], lake shores [2270, 2298], forest [2531, 2538] /
 * [5080, 5094], tile warp [2790, 2841], river [3301, 3324].
 */
const OFF_MASSIF = 211.37;
const OFF_COAST = 463.91;
const OFF_WARP = 719.13;
const OFF_HILLS = 977.59;
const OFF_RIDGE = 1231.77;
const OFF_MEADOW = 1489.29;
const OFF_SPECIAL = 1747.83;
const OFF_TYPE = 2003.41;
const OFF_LAKE = 2269.97;
const OFF_FOREST = 2531.13;
const OFF_TWARP = 2789.71;
const OFF_RIVER = 3301.37;
/** Offsets of the per-column fields on TerrainNoise.column (terrain.ts). */
export const OFF_GRASS = 101.13;
export const OFF_ROCK = 353.71;
export const OFF_BED = 607.39;

/** Seeded noise sources of a terrain (two permutation tables). */
export class TerrainNoise {
  /** Every layout field (massif, coast, hills, forest, river meanders, bank warp, …), see OFF_*. */
  readonly field: Simplex2;
  /** Per-voxel-column detail (terrain.ts): grass shades, rock outcrops, water beds. */
  readonly column: Simplex2;

  constructor(seed: number) {
    const s = seed >>> 0;
    this.field = new Simplex2(mixSeed(s, 0x01));
    this.column = new Simplex2(mixSeed(s, 0x0c));
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
  /** 1 = tile of the central plain [c0, c1)². */
  private readonly centre: Uint8Array;
  private readonly protect: Uint8Array;
  private readonly lakeBan: Uint8Array;
  private readonly surface: Uint8Array;
  private readonly decor: Uint8Array;
  private readonly decorHash: Uint32Array;
  // Per-tile smooth fields (bilinear from lattices).
  /** Mountain massif weight in [0, 1] (large regions where hills concentrate). */
  private readonly massifF: Float32Array;
  /** Sandy-coast weight in [0, 1]. */
  private readonly coastF: Float32Array;
  /** Domain warp of the hill mask, ≈ [-1, 1]. */
  private readonly warpF: Float32Array;
  /** Hill value: 0.55 · fBm + 0.45 · ridged, ≈ [0, 1]. */
  private readonly hillF: Float32Array;
  /** Forest density in [0, 1]. */
  private readonly forestF: Float32Array;
  /** Flower-meadow weight in [0, 1]. */
  private readonly meadowF: Float32Array;
  /** Special-tree regions (autumn > 0.6, blossom < -0.6), ≈ [-1, 1]. */
  private readonly specialF: Float32Array;
  /** Tree-type regions (birch where low), ≈ [-1, 1]. */
  private readonly typeF: Float32Array;
  /** Mountain-corner weight in [0, 1] (0 everywhere when the map has none). */
  private readonly cornerF: Float32Array;
  private readonly forest: LatticeField;
  /** Warped tile centres (for organic river banks / lake shores), computed on demand. */
  private readonly wx: Float32Array;
  private readonly wz: Float32Array;
  private readonly warpReady: Uint8Array;
  private readonly riverD: Float32Array;
  /** Scratch: tile lists / queues and labels / flags. */
  private readonly scratchI: Int32Array;
  private readonly scratchJ: Int32Array;
  private readonly flags: Uint8Array;
  /** River centre line samples (x, z pairs) and widths of the current attempt. */
  private path = new Float64Array(0);
  private widths = new Float64Array(0);
  private pathLen = 0;
  /** Bounding box [boxX0, boxX1] × [boxZ0, boxZ1] containing every water tile (empty: boxX1 < boxX0). */
  private boxX0 = 0;
  private boxX1 = -1;
  private boxZ0 = 0;
  private boxZ1 = -1;
  private info: LayoutInfo = { waterAttempts: 0, riverOrientation: 'none', lakes: 0, mountainCorner: 'none' };

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
    this.centre = new Uint8Array(c);
    this.protect = new Uint8Array(c);
    this.lakeBan = new Uint8Array(c);
    this.surface = new Uint8Array(c);
    this.decor = new Uint8Array(c);
    this.decorHash = new Uint32Array(c);
    this.cornerF = new Float32Array(c);
    this.wx = new Float32Array(c);
    this.wz = new Float32Array(c);
    this.warpReady = new Uint8Array(c);
    this.riverD = new Float32Array(c);
    this.scratchI = new Int32Array(c);
    this.scratchJ = new Int32Array(c);
    this.flags = new Uint8Array(c);

    // Smooth fields: ~10k noise samples on 2- and 4-tile lattices instead of per-tile fBm. The
    // scale factors keep 2-octave fBm / single-octave fields as spread out as 3- / 2-octave fBm.
    const f = tn.field;
    const massif = new LatticeField(n, 4, (x, z) => smooth(-0.2, 0.42, f.fbm(x / 26 + OFF_MASSIF, z / 26, 2)));
    this.massifF = massif.toCells();
    // Sandy coasts where there are no mountains.
    this.coastF = new LatticeField(
      n,
      4,
      (x, z) => smooth(0, 0.3, f.noise(x / 15 + OFF_COAST, z / 15 - OFF_COAST)) * (1 - 0.85 * massif.at(x, z)),
    ).toCells();
    this.warpF = new LatticeField(n, 4, (x, z) => f.fbm(x / 10 + OFF_WARP, z / 10 - OFF_WARP, 2)).toCells();
    this.hillF = new LatticeField(
      n,
      2,
      (x, z) => 0.55 * (0.5 + 0.44 * f.fbm(x / 12 + OFF_HILLS, z / 12, 2)) + 0.45 * f.ridged(x / 16 + OFF_RIDGE, z / 16, 2),
    ).toCells();
    this.forest = new LatticeField(n, 2, (x, z) => 0.5 + 0.44 * f.fbm(x / 9 + OFF_FOREST, z / 9, 2));
    this.forestF = this.forest.toCells();
    this.meadowF = new LatticeField(n, 2, (x, z) => 0.5 + 0.375 * f.noise(x / 6.5 + OFF_MEADOW, z / 6.5)).toCells();
    this.specialF = new LatticeField(n, 4, (x, z) => f.noise(x / 11 + OFF_SPECIAL, z / 11)).toCells();
    this.typeF = new LatticeField(n, 2, (x, z) => f.noise(x / 8 + OFF_TYPE, z / 8)).toCells();
  }

  build(): TerrainLayout {
    this.prepare();
    this.makeWater();
    this.chooseMountainCorner();
    this.makeBeaches();
    this.relax(this.scratchI, this.makeHills());
    // smoothHills() and fixSpikesAndPits() keep the terrain relaxed (see there): no second relax.
    this.fixSpikesAndPits(this.smoothHills());
    this.makeBeds();
    this.finalizeTiles();
    return {
      n: this.n,
      height: this.height,
      water: this.water,
      surface: this.surface,
      decor: this.decor,
      decorHash: this.decorHash,
      forest: this.forest,
      forestTiles: this.forestF,
      info: this.info,
    };
  }

  // ---------------------------------------------------------------- 0. masks

  private prepare(): void {
    const n = this.n;
    for (let tz = this.c0; tz < this.c1; tz++) this.centre.fill(1, tz * n + this.c0, tz * n + this.c1);
    // Water may not touch the central plain: protect it plus a 1-tile margin (so even its beaches
    // stay outside), and the region-connection tile of the starter road.
    for (let tz = Math.max(0, this.c0 - 1); tz < Math.min(n, this.c1 + 1); tz++) {
      this.protect.fill(1, tz * n + Math.max(0, this.c0 - 1), tz * n + Math.min(n, this.c1 + 1));
    }
    this.protect[this.row * n] = 1;
    // Lakes never touch the starter road corridor.
    for (let tz = Math.max(0, this.row - 2); tz <= Math.min(n - 1, this.row + 2); tz++) {
      this.lakeBan.fill(1, tz * n, tz * n + Math.min(n, this.rowEnd + 3));
    }
  }

  /** Warped tile centre (irregular banks and shores), computed on demand. */
  private warp(t: number): void {
    const tx = t % this.n;
    const x = tx + 0.5;
    const z = (t - tx) / this.n + 0.5;
    const f = this.tn.field;
    const fx = x / 3.3 + OFF_TWARP;
    const fz = z / 3.3;
    this.wx[t] = x + BANK_WARP * f.noise(fx, fz);
    this.wz[t] = z + BANK_WARP * f.noise(fx + 31.7, fz - 47.3);
    this.warpReady[t] = 1;
  }

  /** Extends the water bounding box to tile (tx, tz). */
  private growBox(tx: number, tz: number): void {
    if (tx < this.boxX0) this.boxX0 = tx;
    if (tx > this.boxX1) this.boxX1 = tx;
    if (tz < this.boxZ0) this.boxZ0 = tz;
    if (tz > this.boxZ1) this.boxZ1 = tz;
  }

  // ---------------------------------------------------------------- 1. water

  private makeWater(): void {
    const MAX_ATTEMPTS = 12;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      this.water.fill(0);
      this.boxX0 = this.n;
      this.boxX1 = -1;
      this.boxZ0 = this.n;
      this.boxZ1 = -1;
      const rng = new Rng(mixSeed(this.seed, 0x7a7e2 + attempt * 0x9e3779b1));
      // Later attempts use calmer rivers that avoid the starter row.
      const orientation = this.carveRiver(rng, attempt >= 8);
      const lakes = this.carveLakes(rng, attempt >= 10 ? 0 : 2);
      this.cleanupWater();
      if (this.waterValid()) {
        this.info = { waterAttempts: attempt + 1, riverOrientation: orientation, lakes, mountainCorner: 'none' };
        return;
      }
    }
    // Fallback (never observed in tests): a dry map is always valid.
    this.water.fill(0);
    this.boxX1 = -1;
    this.pathLen = 0;
    this.info = { waterAttempts: MAX_ATTEMPTS, riverOrientation: 'none', lakes: 0, mountainCorner: 'none' };
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
    const rn = this.tn.field;
    const roadZ = this.row + 0.5;

    // ~1.5 samples per tile along the river (segments ≤ ~0.8 tiles: finer than the raster).
    const samples = ((3 * (n + 8)) >> 1) + 1;
    if (this.path.length < samples * 2) this.path = new Float64Array(samples * 2);
    if (this.widths.length < samples) this.widths = new Float64Array(samples);
    const path = this.path;
    const widths = this.widths;
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
        let m = amp1 * rn.noise(arc / len1 + OFF_RIVER, lane1) + amp2 * rn.noise(arc / len2 + OFF_RIVER, lane2);
        if (crossesRoad) m *= 0.3 + 0.7 * smooth(1.5, 8, Math.abs(A - roadZ));
        // Normal of (dL, dA) is (dA, -dL)/|t|: lateral component dA/|t|, along component -dL/|t|.
        const lat = L + (m * dA) / tl;
        const alg = A - (m * dL) / tl;
        if (alg > -1 && alg < n + 1) {
          if (lat < lo) lo = lat;
          if (lat > hi) hi = lat;
        }
        let w = 2.2 + 1.75 * clamp01(0.5 + 0.75 * rn.noise(arc / 15 + OFF_RIVER, lane3));
        // Narrower where it crosses the starter road (bridge ≤ 4 tiles).
        if (crossesRoad && Math.abs(alg - roadZ) < 7) w = Math.min(w, 2.8);
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

    // Rasterise: squared normalised distance (distance / half-width)² to the polyline over warped
    // tile centres; water where it is < 1.
    const d = this.riverD;
    d.fill(1e9);
    const wx = this.wx;
    const wz = this.wz;
    let rx0 = n;
    let rx1 = -1;
    let rz0 = n;
    let rz1 = -1;
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
      // Tiles whose centre is within (half-width + maximal bank warp) of the segment, per axis:
      // nothing farther can get within one half-width of it.
      const reach = (w0 > w1 ? w0 : w1) * 0.5 + BANK_WARP;
      const tx0 = Math.max(0, Math.ceil((ax < bx ? ax : bx) - reach - 0.5));
      const tx1 = Math.min(n - 1, Math.floor((ax > bx ? ax : bx) + reach - 0.5));
      const tz0 = Math.max(0, Math.ceil((az < bz ? az : bz) - reach - 0.5));
      const tz1 = Math.min(n - 1, Math.floor((az > bz ? az : bz) + reach - 0.5));
      if (tx0 > tx1 || tz0 > tz1) continue; // segment outside the map
      if (tx0 < rx0) rx0 = tx0;
      if (tx1 > rx1) rx1 = tx1;
      if (tz0 < rz0) rz0 = tz0;
      if (tz1 > rz1) rz1 = tz1;
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0, t = tz * n + tx0; tx <= tx1; tx++, t++) {
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
    for (let tz = rz0; tz <= rz1; tz++) {
      for (let tx = rx0, t = tz * n + rx0; tx <= rx1; tx++, t++) {
        if (d[t] < 1 && !this.protect[t]) {
          this.water[t] = 1;
          this.growBox(tx, tz);
        }
      }
    }
    return orient === 0 ? 'ns-west' : orient === 1 ? 'ns-east' : orient === 2 ? 'ew-north' : 'ew-south';
  }

  /** Carves 0..maxLakes lakes (some threaded on the river). Returns how many were placed. */
  private carveLakes(rng: Rng, maxLakes: number): number {
    const n = this.n;
    const f = this.tn.field;
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
          for (let tx = tx0, t = tz * n + tx0; tx <= tx1; tx++, t++) {
            if (this.warpReady[t] === 0) this.warp(t);
            const dx = this.wx[t] - cx;
            const dz = this.wz[t] - cz;
            const p = (dx * ux + dz * uz) / r;
            const q = (-dx * uz + dz * ux) / r2;
            const lim = 1 + 0.22 * f.noise(tx / 2.3 + OFF_LAKE, tz / 2.3);
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
        this.growBox(tx0, tz0);
        this.growBox(tx1, tz1);
        placed++;
        break;
      }
    }
    return placed;
  }

  private cleanupWater(): void {
    const n = this.n;
    const n1 = n - 1;
    const w = this.water;
    // Only the water's bounding box: drying only affects water tiles and flooding needs ≥ 3 water
    // neighbours, so nothing outside the box can ever change.
    const x0 = this.boxX0;
    const x1 = this.boxX1;
    const z0 = this.boxZ0;
    const z1 = this.boxZ1;
    if (x1 < x0) return;
    const roadStart = this.row * n;
    for (let iter = 0; iter < 10; iter++) {
      let changed = false;
      // Puddles and 1-tile tips: water with < 2 water neighbours dries up.
      for (let tz = z0; tz <= z1; tz++) {
        for (let tx = x0, t = tz * n + x0; tx <= x1; tx++, t++) {
          if (!w[t]) continue;
          const k = (tx > 0 ? w[t - 1] : 0) + (tx < n1 ? w[t + 1] : 0) + (tz > 0 ? w[t - n] : 0) + (tz < n1 ? w[t + n] : 0);
          if (k < 2) {
            w[t] = 0;
            changed = true;
          }
        }
      }
      // Spikes / tiny bays: land with ≥ 3 water neighbours floods.
      for (let tz = z0; tz <= z1; tz++) {
        for (let tx = x0, t = tz * n + x0; tx <= x1; tx++, t++) {
          if (w[t] || this.protect[t] || t === roadStart) continue;
          const k = (tx > 0 ? w[t - 1] : 0) + (tx < n1 ? w[t + 1] : 0) + (tz > 0 ? w[t - n] : 0) + (tz < n1 ? w[t + n] : 0);
          if (k >= 3) {
            w[t] = 1;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    this.removeSmallComponents(1, 10, x0, x1, z0, z1);
    this.removeSmallComponents(0, 6, x0, x1, z0, z1);
  }

  /**
   * Flood-fills the 4-connected components of tiles with water === value inside the box
   * [x0, x1] × [z0, z1] (which contains all water). Water components smaller than minSize dry up;
   * land components smaller than minSize that are enclosed by water (they touch neither the box
   * border nor the map edge) are flooded, except protected tiles.
   */
  private removeSmallComponents(value: number, minSize: number, x0: number, x1: number, z0: number, z1: number): void {
    const n = this.n;
    const w = this.water;
    const seen = this.flags;
    const q = this.scratchI;
    for (let tz = z0; tz <= z1; tz++) seen.fill(0, tz * n + x0, tz * n + x1 + 1);
    for (let sz = z0; sz <= z1; sz++) {
      for (let s = sz * n + x0, e = sz * n + x1; s <= e; s++) {
        if (w[s] !== value || seen[s]) continue;
        let head = 0;
        let tail = 0;
        let open = false;
        q[tail++] = s;
        seen[s] = 1;
        while (head < tail) {
          const t = q[head++];
          const tx = t % n;
          const tz = (t - tx) / n;
          if (tx === x0 || tx === x1 || tz === z0 || tz === z1) open = true;
          if (tx > x0 && w[t - 1] === value && !seen[t - 1]) {
            seen[t - 1] = 1;
            q[tail++] = t - 1;
          }
          if (tx < x1 && w[t + 1] === value && !seen[t + 1]) {
            seen[t + 1] = 1;
            q[tail++] = t + 1;
          }
          if (tz > z0 && w[t - n] === value && !seen[t - n]) {
            seen[t - n] = 1;
            q[tail++] = t - n;
          }
          if (tz < z1 && w[t + n] === value && !seen[t + n]) {
            seen[t + n] = 1;
            q[tail++] = t + n;
          }
        }
        if (tail >= minSize) continue;
        if (value === 1) {
          for (let i = 0; i < tail; i++) w[q[i]] = 0;
        } else if (!open) {
          // Every land tile outside the box connects to the map edge through land, so a component
          // touching the box border is not enclosed; one that does not touch it is complete here.
          for (let i = 0; i < tail; i++) if (!this.protect[q[i]]) w[q[i]] = 1;
        }
      }
    }
  }

  private waterValid(): boolean {
    const n = this.n;
    let waterCount = 0;
    for (let tz = this.boxZ0; tz <= this.boxZ1; tz++) {
      for (let t = tz * n + this.boxX0, e = tz * n + this.boxX1; t <= e; t++) {
        if (!this.water[t]) continue;
        waterCount++;
        if (this.protect[t]) return false;
      }
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
    return runs <= 2;
  }

  // ---------------------------------------------------------------- 2. mountain corner

  /**
   * Most maps get one tall massif in a map corner on the side away from the river (so the river
   * does not cut it): it rises to rock and snow caps, and its stretch of map edge has no sandy
   * coast (the mountain meets the ocean as a cliff).
   */
  private chooseMountainCorner(): void {
    const rng = new Rng(mixSeed(this.seed, 0x3c0a2));
    if (!rng.chance(0.7)) return;
    const n = this.n;
    const o = this.info.riverOrientation;
    // Corner sides: x (0 = west, 1 = east), z (0 = north, 1 = south).
    let cxSide: number;
    let czSide: number;
    if (o === 'ns-west' || o === 'ns-east') {
      cxSide = o === 'ns-west' ? 1 : 0;
      czSide = rng.int(0, 2);
    } else if (o === 'ew-north' || o === 'ew-south') {
      czSide = o === 'ew-north' ? 1 : 0;
      cxSide = rng.int(0, 2);
    } else {
      cxSide = rng.int(0, 2);
      czSide = rng.int(0, 2);
    }
    const px = cxSide * n;
    const pz = czSide * n;
    const r0 = n * 0.08; // full strength within ~5 tiles of the corner
    const r1 = n * 0.29; // fades out ~18 tiles away
    const reach = Math.min(n, Math.ceil(r1));
    const xa = cxSide === 0 ? 0 : n - reach;
    const za = czSide === 0 ? 0 : n - reach;
    for (let tz = za; tz < za + reach; tz++) {
      for (let tx = xa; tx < xa + reach; tx++) {
        const dx = tx + 0.5 - px;
        const dz = tz + 0.5 - pz;
        const k = smooth(r1, r0, Math.sqrt(dx * dx + dz * dz));
        if (k <= 0) continue;
        const t = tz * n + tx;
        this.cornerF[t] = k;
        this.coastF[t] *= 1 - k;
      }
    }
    this.info.mountainCorner = czSide === 0 ? (cxSide === 0 ? 'nw' : 'ne') : cxSide === 0 ? 'sw' : 'se';
  }

  // ---------------------------------------------------------------- 3. beaches

  private makeBeaches(): void {
    const n = this.n;
    const n1 = n - 1;
    const w = this.water;
    const beach = this.beach;
    const h = this.height;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0, t = tz * n; tx < n; tx++, t++) {
        if (w[t]) {
          h[t] = MIN_GROUND_HEIGHT; // beds come later
        } else if ((tx > 0 && w[t - 1]) || (tx < n1 && w[t + 1]) || (tz > 0 && w[t - n]) || (tz < n1 && w[t + n])) {
          beach[t] = 1;
          h[t] = BEACH_HEIGHT;
        } else h[t] = PLAIN;
      }
    }
    // Sandy coast stretches along the map edge (the island meets the ocean ring there): edge
    // tiles where the coast field is strong, then a second row behind the strongest stretches.
    const roadStart = this.row * n;
    for (let i = 0; i < 4 * (n - 1); i++) {
      const t = this.perimeter(i, 0);
      if (w[t] || (this.protect[t] && t !== roadStart)) continue;
      if (this.coastF[t] > 0.5) {
        beach[t] = 1;
        h[t] = BEACH_HEIGHT;
      }
    }
    for (let i = 0; i < 4 * (n - 3); i++) {
      const t = this.perimeter(i, 1);
      if (w[t] || this.protect[t] || beach[t] || this.coastF[t] <= 0.85) continue;
      // Only behind a beach edge tile (the outward neighbour).
      const tx = t % n;
      const tz = (t - tx) / n;
      const ox = tx === 1 ? t - 1 : tx === n - 2 ? t + 1 : -1;
      const oz = tz === 1 ? t - n : tz === n - 2 ? t + n : -1;
      if ((ox >= 0 && beach[ox]) || (oz >= 0 && beach[oz])) {
        beach[t] = 1;
        h[t] = BEACH_HEIGHT;
      }
    }
  }

  /** i-th tile (0 ≤ i < 4·(n - 2·ring - 1)) of the square ring at distance `ring` from the map edge. */
  private perimeter(i: number, ring: number): number {
    const n = this.n;
    const side = n - 2 * ring - 1;
    const s = (i / side) | 0;
    const k = i - s * side;
    const lo = ring;
    const hi = n - 1 - ring;
    if (s === 0) return lo * n + lo + k; // north row, west → east
    if (s === 1) return (lo + k) * n + hi; // east column, north → south
    if (s === 2) return hi * n + hi - k; // south row, east → west
    return (hi - k) * n + lo; // west column, south → north
  }

  // ---------------------------------------------------------------- 4. hills

  /**
   * Raises the hill tiles and writes them (raster order) to scratchI; returns their number.
   */
  private makeHills(): number {
    const n = this.n;
    const count = this.count;
    const c0 = this.c0;
    const c1 = this.c1;
    const R = new Float32Array(count);
    const elig = this.scratchJ;
    const rng = new Rng(mixSeed(this.seed, 0x4111));
    const cornerAmp = this.info.mountainCorner === 'none' ? 0 : rng.range(0.55, 0.85);
    // Separable factors, tabulated per row / column / integer distance.
    const p4 = new Float64Array(n); // ((k + 0.5) / n · 2 − 1)⁴ (superellipse distance from the centre)
    const ring = new Float64Array(n); // plain ring around the centre: smooth(2, 7, distance to the square)
    const shore = new Float64Array(n); // low coasts: smooth(10, 2, distance to the map edge)
    const valley = new Float64Array(n); // starter-highway valley: smooth(1, 5, |tz − row|)
    for (let k = 0; k < n; k++) {
      const u = ((k + 0.5) / n) * 2 - 1;
      p4[k] = u * u * u * u;
      ring[k] = smooth(2, 7, k);
      shore[k] = smooth(10, 2, k);
      valley[k] = smooth(1, 5, k);
    }
    let plainCount = 0;
    let eligible = 0;
    for (let tz = 0; tz < n; tz++) {
      const dz = tz < c0 ? c0 - tz : tz >= c1 ? tz - c1 + 1 : 0;
      const ez = tz < n - 1 - tz ? tz : n - 1 - tz;
      const vz = valley[tz > this.row ? tz - this.row : this.row - tz];
      for (let tx = 0, t = tz * n; tx < n; tx++, t++) {
        if (this.water[t] || this.beach[t]) continue;
        plainCount++;
        if (this.centre[t]) continue;
        // Hills grow toward the map edge: smooth(0.42, 0.92, warped superellipse distance).
        let a = (Math.sqrt(Math.sqrt(p4[tx] + p4[tz])) + 0.17 * this.warpF[t] - 0.42) * 2;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        const mask = a * a * (3 - 2 * a);
        const corner = this.cornerF[t];
        if (mask <= 0 && corner <= 0) continue;
        // Mountains concentrate in massif regions; elsewhere only low hills.
        const m = this.massifF[t];
        let r = mask * (0.22 + 0.78 * (m > corner ? m : corner)) * this.hillF[t] + cornerAmp * corner;
        // Keep a ring of plain around the centre.
        const dx = tx < c0 ? c0 - tx : tx >= c1 ? tx - c1 + 1 : 0;
        r *= ring[dx > dz ? dx : dz];
        // Low coasts where the edge has beaches.
        const ex = tx < n - 1 - tx ? tx : n - 1 - tx;
        r *= 1 - this.coastF[t] * shore[ex < ez ? ex : ez];
        // A valley carrying the starter highway in from the west edge.
        if (tx < c0) r *= vz;
        if (r > 0.02) {
          R[t] = r;
          elig[eligible++] = t;
        }
      }
    }
    const target = Math.ceil(count * 0.6);
    const budget = Math.min(plainCount - target, Math.floor(count * 0.34), eligible);
    if (budget <= 0) return 0;
    // Threshold = the budget-th largest hill value among eligible tiles.
    const vals = new Float32Array(eligible);
    for (let i = 0; i < eligible; i++) vals[i] = R[elig[i]];
    vals.sort();
    const thr = vals[eligible - budget];
    const rMax = vals[eligible - 1];
    // Highest raw terrace: 8..11 steps of 2 voxels (11..12 with a mountain corner). The concave
    // (square-root) mapping lifts most of a hill region to high raw levels; relax() then carves it
    // into 1-tile-wide terraces that follow the region's outline, so large massifs reach rock /
    // snow heights and small hills stay low.
    const levels = cornerAmp > 0 ? 11 + rng.int(0, 2) : 8 + rng.int(0, 4);
    const span = Math.max(1e-6, rMax - thr);
    const hills = this.scratchI;
    let m = 0;
    for (let i = 0; i < eligible; i++) {
      const t = elig[i];
      const r = R[t];
      if (r < thr) continue;
      let lvl = 1 + Math.floor(levels * Math.sqrt((r - thr) / span));
      if (lvl > levels) lvl = levels;
      this.height[t] = Math.min(MAX_GROUND_HEIGHT, PLAIN + 2 * lvl);
      hills[m++] = t;
    }
    return m;
  }

  // ---------------------------------------------------------------- 5. relaxation & cleanup

  /**
   * Lowers the hill tiles hills[0, m) until |Δh| ≤ 2 between all 4-neighbouring land tiles, keeping
   * the terrace parity PLAIN + 2k (next to a beach, h = 11, a hill drops to the plain). Only hill
   * tiles can ever be lowered (every land tile is ≥ BEACH_HEIGHT), so in terrace levels
   * k = (h - PLAIN) / 2 the result is the largest fixpoint of
   *   k(t) = min(k0(t), min over land neighbours u of k(u) + 1)   (beach: k = -1, plain: k = 0),
   * i.e. a multi-source shortest-path problem with unit steps: solved by a bucket queue that
   * settles each tile once, in increasing level order (same result as iterated relaxation sweeps).
   */
  private relax(hills: Int32Array, m: number): void {
    if (m === 0) return;
    const n = this.n;
    const n1 = n - 1;
    const count = this.count;
    const h = this.height;
    const w = this.water;
    const key = this.flags; // level per hill tile, 255 = not a hill tile
    key.fill(255);
    let maxKey = 0;
    for (let i = 0; i < m; i++) {
      const t = hills[i];
      const k = (h[t] - PLAIN) >> 1;
      key[t] = k;
      if (k > maxKey) maxKey = k;
    }
    // Initial levels: constraints from non-hill land neighbours (beach → 0, plain → 1).
    const start = new Int32Array(maxKey + 2);
    for (let i = 0; i < m; i++) {
      const t = hills[i];
      const tx = t % n;
      let k = key[t];
      for (let d = 0; d < 4; d++) {
        const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
        if (u < 0 || u >= count || w[u] || key[u] !== 255) continue;
        const c = (h[u] - 10) >> 1; // h = 11 → 0, h = 12 → 1
        if (c < k) k = c;
      }
      key[t] = k;
      start[k + 1]++;
    }
    // Counting sort by initial level into q[0, m); tiles whose level drops later are appended to
    // q[m, 2m) level by level (each at most once: a level only ever drops to current + 1).
    for (let b = 0; b <= maxKey; b++) start[b + 1] += start[b];
    const q = this.scratchJ;
    const fill = start.slice();
    for (let i = 0; i < m; i++) {
      const t = hills[i];
      q[fill[key[t]]++] = t;
    }
    let pqHead = m;
    let pqTail = m;
    for (let b = 0; b <= maxKey; b++) {
      const levelEnd = pqTail;
      for (let pass = 0; pass < 2; pass++) {
        const i1 = pass === 0 ? start[b + 1] : levelEnd;
        for (let i = pass === 0 ? start[b] : pqHead; i < i1; i++) {
          const t = q[i];
          if (key[t] !== b) continue; // settled earlier at a lower level
          const tx = t % n;
          for (let d = 0; d < 4; d++) {
            const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
            if (u < 0 || u >= count) continue;
            const ku = key[u];
            if (ku !== 255 && ku > b + 1) {
              key[u] = b + 1;
              q[pqTail++] = u;
            }
          }
        }
      }
      pqHead = levelEnd;
    }
    for (let i = 0; i < m; i++) {
      const t = hills[i];
      h[t] = PLAIN + 2 * key[t];
    }
  }

  /**
   * Removes 1-tile spikes, pits and terrace notches (3 neighbours agree on another height) on
   * non-beach land outside the centre, with a worklist: every candidate once, then the neighbours
   * of each changed tile again. The terrain stays relaxed: a spike drops to its highest land
   * neighbour and a pit rises to its lowest (all neighbours were within 2 of it, so they are within
   * 2 of the new height), a notch takes the height H all four neighbours are within 2 of, and the
   * terrace parity is kept (new heights are neighbour heights; a tile only drops to 11 when all its
   * land neighbours are beaches, and then becomes a beach itself).
   */
  private smoothHills(): boolean {
    const n = this.n;
    const n1 = n - 1;
    const count = this.count;
    const h = this.height;
    const w = this.water;
    const queue = this.scratchJ;
    const inQ = this.flags;
    inQ.fill(0);
    let qh = 0;
    let qt = 0;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0, t = tz * n; tx < n; tx++, t++) {
        if (w[t] || this.beach[t] || this.centre[t]) continue;
        const hill =
          h[t] > PLAIN ||
          (tx > 0 && h[t - 1] > PLAIN) ||
          (tx < n1 && h[t + 1] > PLAIN) ||
          (tz > 0 && h[t - n] > PLAIN) ||
          (tz < n1 && h[t + n] > PLAIN);
        if (hill) {
          queue[qt++] = t;
          inQ[t] = 1;
        }
      }
    }
    let size = qt;
    let budget = 8 * qt + 64;
    let nb0 = 0;
    let nb1 = 0;
    let nb2 = 0;
    let nb3 = 0;
    while (size > 0 && budget-- > 0) {
      const t = queue[qh];
      qh = qh + 1 === count ? 0 : qh + 1;
      size--;
      inQ[t] = 0;
      const tx = t % n;
      let k = 0;
      let mx = 0;
      let mn = 255;
      for (let d = 0; d < 4; d++) {
        const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
        if (u < 0 || u >= count || w[u]) continue;
        const v = h[u];
        if (k === 0) nb0 = v;
        else if (k === 1) nb1 = v;
        else if (k === 2) nb2 = v;
        else nb3 = v;
        k++;
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      if (k < 2) continue;
      const cur = h[t];
      let next = cur;
      if (cur > mx) next = mx; // spike
      else if (cur < mn) next = mn; // pit
      else if (k === 4) {
        // Notch / bump on a terrace edge: 3 neighbours agree on another height H (and all four are
        // within 2 of H, so the change keeps the terrain relaxed).
        for (let i = 0; i < 2; i++) {
          const H = i === 0 ? nb0 : nb1;
          if (H === cur) continue;
          const same = (nb0 === H ? 1 : 0) + (nb1 === H ? 1 : 0) + (nb2 === H ? 1 : 0) + (nb3 === H ? 1 : 0);
          if (same >= 3 && Math.abs(nb0 - H) <= 2 && Math.abs(nb1 - H) <= 2 && Math.abs(nb2 - H) <= 2 && Math.abs(nb3 - H) <= 2) {
            next = H;
            break;
          }
        }
      }
      if (next === cur) continue;
      if (next < PLAIN) {
        // Only possible when every land neighbour is a beach: become sand as well.
        next = BEACH_HEIGHT;
        this.beach[t] = 1;
      }
      h[t] = next;
      for (let d = 0; d < 4; d++) {
        const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
        if (u < 0 || u >= count || inQ[u] || w[u] || this.beach[u] || this.centre[u]) continue;
        queue[qt] = u;
        qt = qt + 1 === count ? 0 : qt + 1;
        size++;
        inQ[u] = 1;
      }
    }
    return size === 0;
  }

  /**
   * Last land pass, over ALL land outside the central plain (beaches and plain tiles at the map
   * edge included): a tile strictly higher than all of its (≥ 2) in-map land neighbours is lowered
   * to the highest of them; a tile strictly lower than all of them and not touching water is raised
   * to the lowest. Neighbours are within 2 of the tile (relaxed), so the result stays relaxed.
   * Worklist: every candidate once, then the neighbours of each changed tile. Heights ≤ BEACH_HEIGHT
   * become beach, others not. After a converged smoothHills() (`hillsSettled`), non-beach tiles away
   * from beaches are neither spikes nor pits, so the candidates are the beaches and their land
   * neighbours; otherwise all land outside the centre.
   */
  private fixSpikesAndPits(hillsSettled: boolean): void {
    const n = this.n;
    const n1 = n - 1;
    const count = this.count;
    const h = this.height;
    const w = this.water;
    const queue = this.scratchJ;
    const inQ = this.flags;
    inQ.fill(0);
    let qh = 0;
    let qt = 0;
    const beach = this.beach;
    for (let t = 0; t < count; t++) {
      if (w[t] || this.centre[t]) continue;
      if (hillsSettled && !beach[t]) {
        const tx = t % n;
        const nearBeach = (tx > 0 && beach[t - 1]) || (tx < n1 && beach[t + 1]) || (t >= n && beach[t - n]) || (t < count - n && beach[t + n]);
        if (!nearBeach) continue;
      }
      queue[qt++] = t;
      inQ[t] = 1;
    }
    let size = qt;
    if (qt === count) qt = 0;
    let budget = 4 * count;
    while (size > 0 && budget-- > 0) {
      const t = queue[qh];
      qh = qh + 1 === count ? 0 : qh + 1;
      size--;
      inQ[t] = 0;
      const tx = t % n;
      let k = 0;
      let mx = 0;
      let mn = 255;
      let wet = false;
      for (let d = 0; d < 4; d++) {
        const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
        if (u < 0 || u >= count) continue;
        if (w[u]) {
          wet = true;
          continue;
        }
        k++;
        if (h[u] > mx) mx = h[u];
        if (h[u] < mn) mn = h[u];
      }
      if (k < 2) continue;
      const cur = h[t];
      let next = cur;
      if (cur > mx) next = mx;
      else if (cur < mn && !wet) next = mn;
      if (next === cur) continue;
      if (next <= BEACH_HEIGHT) {
        h[t] = BEACH_HEIGHT;
        this.beach[t] = 1;
      } else {
        h[t] = next;
        this.beach[t] = 0;
      }
      for (let d = 0; d < 4; d++) {
        const u = d === 0 ? (tx > 0 ? t - 1 : -1) : d === 1 ? (tx < n1 ? t + 1 : -1) : d === 2 ? t - n : t + n;
        if (u < 0 || u >= count || inQ[u] || w[u] || this.centre[u]) continue;
        queue[qt] = u;
        qt = qt + 1 === count ? 0 : qt + 1;
        size++;
        inQ[u] = 1;
      }
    }
  }

  // ---------------------------------------------------------------- 6. water beds

  private makeBeds(): void {
    const n = this.n;
    const w = this.water;
    const dist = this.scratchJ;
    const queue = this.scratchI;
    dist.fill(0);
    let qh = 0;
    let qt = 0;
    // All water lies in its bounding box.
    for (let tz = this.boxZ0; tz <= this.boxZ1; tz++) {
      for (let tx = this.boxX0, t = tz * n + tx; tx <= this.boxX1; tx++, t++) {
        if (!w[t]) continue;
        const shore = (tx > 0 && !w[t - 1]) || (tx < n - 1 && !w[t + 1]) || (t >= n && !w[t - n]) || (t < this.count - n && !w[t + n]);
        if (shore) {
          dist[t] = 1;
          queue[qt++] = t;
        }
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
    for (let tz = this.boxZ0; tz <= this.boxZ1; tz++) {
      for (let tx = this.boxX0, t = tz * n + tx; tx <= this.boxX1; tx++, t++) {
        if (!w[t]) continue;
        const d = dist[t] === 0 ? 6 : dist[t];
        const jitter = d >= 2 ? hash2(tx, tz, salt) & 1 : 0;
        let bed = WATER_LEVEL - 1 - d - jitter; // d=1 → 8, d=2 → 7/6, d=3 → 6/5, …
        if (bed < MIN_GROUND_HEIGHT) bed = MIN_GROUND_HEIGHT;
        if (bed > WATER_LEVEL - 1) bed = WATER_LEVEL - 1;
        this.height[t] = bed;
      }
    }
  }

  // ---------------------------------------------------------------- 7. surfaces & decor

  /**
   * One last pass over all tiles: re-asserts the hard land rules (central plain, beach height,
   * nothing below the plain), assigns the surface types and places the natural decor.
   */
  private finalizeTiles(): void {
    const n = this.n;
    const h = this.height;
    const salt = mixSeed(this.seed, 0xdec0);
    const salt2 = salt ^ 0x5bd1e995;
    const hashSalt = mixSeed(this.seed, 0xdec1);
    const d0 = this.d0;
    const d1 = this.d1;
    for (let tz = 0; tz < n; tz++) {
      const dz = tz < d0 ? d0 - tz : tz >= d1 ? tz - d1 + 1 : 0;
      for (let tx = 0, t = tz * n; tx < n; tx++, t++) {
        if (this.water[t]) {
          this.surface[t] = SURF_WATER;
          continue;
        }
        if (this.centre[t]) {
          h[t] = PLAIN;
          this.beach[t] = 0;
        } else if (this.beach[t]) {
          h[t] = BEACH_HEIGHT;
          this.surface[t] = SURF_SAND;
          continue; // no decor on beaches
        } else if (h[t] < PLAIN) h[t] = PLAIN;
        const v = h[t];
        const surf = v >= SNOW_FROM ? SURF_SNOW : v >= ROCK_FROM ? SURF_ROCK : v >= HIGHGRASS_FROM ? SURF_HIGHGRASS : SURF_GRASS;
        this.surface[t] = surf;

        // ---- decor
        const dx = tx < d0 ? d0 - tx : tx >= d1 ? tx - d1 + 1 : 0;
        if (dx === 0 && dz === 0) continue; // central no-decor square
        const r = hashToUnit(hash2(tx, tz, salt));
        const r2 = hashToUnit(hash2(tz, tx, salt2));
        const F = this.forestF[t];
        const M = this.meadowF[t];
        const S = this.specialF[t];
        const typ = this.typeF[t];
        let kind = DECOR_NONE;
        if (v > PLAIN) {
          // Hills: dense, clustered forests with clearings; conifers take over with altitude.
          const elev = clamp01((v - PLAIN) / 22);
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
          const open = smooth(0, 6, dx > dz ? dx : dz);
          const dens = (0.035 + 0.5 * smooth(0.56, 0.8, F)) * open;
          if (r < dens) {
            if (S > 0.6) kind = DECOR_AUTUMN;
            else if (S < -0.62) kind = DECOR_BLOSSOM;
            else if (r2 < 0.12) kind = DECOR_PINE;
            else kind = typ < -0.25 || r2 > 0.82 ? DECOR_BIRCH : DECOR_OAK;
          } else if (r < dens + (0.008 + 0.075 * smooth(0.44, 0.66, F)) * open) kind = DECOR_BUSH;
          else if (r2 < 0.62 * smooth(0.55, 0.8, M)) kind = DECOR_FLOWERS;
        }
        if (kind !== DECOR_NONE) {
          this.decor[t] = kind;
          this.decorHash[t] = hash2(tx, tz, hashSalt);
        }
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
