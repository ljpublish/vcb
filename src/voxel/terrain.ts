/**
 * MODULE: voxel-world — procedural terrain (per-tile heightmap, water, natural decor).
 * Owner: voxel-world agent. Implements ITerrain (src/types.ts).
 *
 * The constructor computes the per-tile layout (./terrainGen.ts: height, water flag, surface type,
 * decor kind/variant) plus the representative ground block of every tile — a few ms, so the sim,
 * camera and minimap can query the terrain before any voxel exists. All queries are O(1);
 * out-of-map tile queries clamp to the nearest edge tile.
 *
 * Terrain model (ARCHITECTURE.md §4):
 *  - Every tile is FLAT: all TILE_SIZE² columns share the ground height h (ground voxels
 *    y ∈ [0, h-1]; structures start at y = h). Hills are tile-sized 2-voxel terraces.
 *  - A large central plain at exactly BASE_GROUND_HEIGHT (≈ 60 % of the tiles; the central 16×16
 *    tiles always dry plain), terraced hills toward the map edges (|Δh| ≤ 2 between 4-neighbouring
 *    land tiles), one meandering river crossing the map edge to edge plus 0–2 lakes (≥ 72 % land),
 *    sandy beaches at h = WATER_LEVEL + 1 around all water and along parts of the map edge.
 *  - Starter road row (tz = mapTiles/2, tx ∈ [0, mapTiles/2]): tile (0, row) is land, no lake on
 *    that row, river crossings there are ≤ 4 tiles (→ the first road gets a bridge).
 *  - Voxel layering per column: y = 0 BEDROCK; STONE y ∈ [1, h-5]; DIRT y ∈ [h-4, h-2]; the top
 *    voxel y = h-1 is the ground block: grass shades in large low-frequency per-column patches
 *    (darker under forests and with altitude), SAND on beaches, ROCK / SNOW high up. Water tiles:
 *    SAND / GRAVEL / CLAY bed (per-column noise), WATER in y ∈ [h, WATER_LEVEL-1].
 *  - Decor (./decor.ts): at most one tree per tile, entirely inside the tile's 8×8 footprint.
 *
 * Voxel output: each tile's natural column stack is built in a reusable 8 × 128 × 8 buffer and
 * written with ONE world.applyStamp — the same code for generateInto() and restoreTile(), so a
 * restored tile is bit-identical to the generated one. The per-column top blocks (pure functions
 * of (x, z, seed)) are cached per tile on first use.
 */
import {
  MAP_TILES,
  TILE_SIZE,
  WATER_LEVEL,
  WORLD_HEIGHT,
  type ITerrain,
  type IVoxelWorld,
  type VoxelStamp,
} from '../types';
import { B, type BlockId } from './blocks';
import { DECOR_MAX_HEIGHT, decorKindName, writeDecor, type DecorKind } from './decor';
import type { LatticeField } from './noise';
import {
  OFF_BED,
  OFF_GRASS,
  OFF_ROCK,
  SURF_GRASS,
  SURF_HIGHGRASS,
  SURF_ROCK,
  SURF_SAND,
  SURF_SNOW,
  SURF_WATER,
  TerrainNoise,
  generateLayout,
  type LayoutInfo,
} from './terrainGen';

const T = TILE_SIZE;
/** Voxels per y-layer of a tile column buffer. */
const L = T * T;
const MIN_MAP_TILES = 16;
const MAX_MAP_TILES = 256;

export class Terrain implements ITerrain {
  readonly seed: number;
  readonly mapTiles: number;

  private readonly n: number;
  private readonly height: Uint8Array;
  private readonly water: Uint8Array;
  private readonly surface: Uint8Array;
  private readonly decor: Uint8Array;
  private readonly decorHash: Uint32Array;
  private readonly ground: Uint8Array;
  private readonly noise: TerrainNoise;
  /** Forest density field of the layout (darker grass under forests). */
  private readonly forest: LatticeField;
  private readonly layoutInfo: LayoutInfo;
  /** Cached per-column top blocks, 64 per tile (row-major x + 8*z), valid where topsReady = 1. */
  private readonly tops: Uint8Array;
  private readonly topsReady: Uint8Array;
  /** Reusable tile column buffer (index x + 8*(z + 8*y)) and its stamp view. */
  private readonly buf = new Uint8Array(L * WORLD_HEIGHT);
  private readonly stamp: VoxelStamp;

  constructor(seed: number, mapTiles: number = MAP_TILES) {
    this.seed = seed >>> 0;
    const n = Number.isInteger(mapTiles) && mapTiles >= MIN_MAP_TILES && mapTiles <= MAX_MAP_TILES ? mapTiles : MAP_TILES;
    this.mapTiles = n;
    this.n = n;
    this.noise = new TerrainNoise(this.seed);
    const layout = generateLayout(this.seed, n, this.noise);
    this.height = layout.height;
    this.water = layout.water;
    this.surface = layout.surface;
    this.decor = layout.decor;
    this.decorHash = layout.decorHash;
    this.forest = layout.forest;
    this.layoutInfo = layout.info;
    this.tops = new Uint8Array(n * n * L);
    this.topsReady = new Uint8Array(n * n);
    // Representative ground block = the top block of the tile's centre column (whose forest
    // sample is exactly the tile-centre value).
    this.ground = new Uint8Array(n * n);
    const forestTiles = layout.forestTiles;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0, t = tz * n; tx < n; tx++, t++) {
        this.ground[t] = this.columnTopAt(tx * T + (T >> 1), tz * T + (T >> 1), this.surface[t], this.height[t], forestTiles[t]);
      }
    }
    this.stamp = { sx: T, sy: 0, sz: T, data: this.buf };
  }

  // ------------------------------------------------------------------ TerrainReader

  getTileHeight(tx: number, tz: number): number {
    return this.height[this.index(tx, tz)];
  }

  getSurfaceHeight(tx: number, tz: number): number {
    const h = this.height[this.index(tx, tz)];
    return h > WATER_LEVEL ? h : WATER_LEVEL;
  }

  isWater(tx: number, tz: number): boolean {
    return this.water[this.index(tx, tz)] === 1;
  }

  hasNaturalDecor(tx: number, tz: number): boolean {
    return this.decor[this.index(tx, tz)] !== 0;
  }

  getGroundBlock(tx: number, tz: number): BlockId {
    return this.ground[this.index(tx, tz)];
  }

  // ------------------------------------------------------------------ extras (debug / tests)

  /** Natural decor kind of a tile (clamped like the other queries). */
  getDecorKind(tx: number, tz: number): DecorKind {
    return decorKindName(this.decor[this.index(tx, tz)]);
  }

  /** Generation diagnostics. */
  getLayoutInfo(): Readonly<LayoutInfo> {
    return this.layoutInfo;
  }

  // ------------------------------------------------------------------ ITerrain

  generateInto(world: IVoxelWorld): void {
    if (!world) return;
    const n = this.n;
    const stamp = this.stamp;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        stamp.sy = this.buildTile(tx, tz, true);
        world.applyStamp(stamp, tx * T, 0, tz * T);
      }
    }
  }

  restoreTile(world: IVoxelWorld, tx: number, tz: number, withDecor: boolean): void {
    if (!world) return;
    const n = this.n;
    if (!(tx >= 0 && tz >= 0 && tx < n && tz < n)) return;
    tx = Math.floor(tx);
    tz = Math.floor(tz);
    const top = this.buildTile(tx, tz, withDecor === true);
    const stamp = this.stamp;
    stamp.sy = top;
    const x0 = tx * T;
    const z0 = tz * T;
    world.applyStamp(stamp, x0, 0, z0);
    world.fillBox(x0, top, z0, x0 + T, world.sizeY, z0 + T, B.AIR);
  }

  // ------------------------------------------------------------------ internals

  /** Clamped tile index (NaN → 0). */
  private index(tx: number, tz: number): number {
    const n = this.n;
    const x = tx >= 0 ? (tx < n ? tx | 0 : n - 1) : 0;
    const z = tz >= 0 ? (tz < n ? tz | 0 : n - 1) : 0;
    return z * n + x;
  }

  /**
   * Fills the column buffer with tile (tx,tz)'s natural voxels for y ∈ [0, top) and returns top:
   * ground layers, the per-column top block, water up to WATER_LEVEL-1 on water tiles, and (when
   * withDecor) the tile's decor with the AIR around it.
   */
  private buildTile(tx: number, tz: number, withDecor: boolean): number {
    const t = tz * this.n + tx;
    const h = this.height[t];
    const buf = this.buf;
    buf.fill(B.BEDROCK, 0, L);
    const stoneEnd = h - 4 > 1 ? h - 4 : 1; // STONE y ∈ [1, h-5]
    if (stoneEnd > 1) buf.fill(B.STONE, L, stoneEnd * L);
    const dirtEnd = h - 1 > stoneEnd ? h - 1 : stoneEnd; // DIRT y ∈ [h-4, h-2]
    if (dirtEnd > stoneEnd) buf.fill(B.DIRT, stoneEnd * L, dirtEnd * L);
    if (this.topsReady[t] === 0) this.computeTops(t);
    const src = t * L;
    const dst = (h - 1) * L;
    const tops = this.tops;
    for (let i = 0; i < L; i++) buf[dst + i] = tops[src + i];
    if (this.water[t] === 1) {
      buf.fill(B.WATER, h * L, WATER_LEVEL * L);
      return WATER_LEVEL;
    }
    const kind = this.decor[t];
    if (!withDecor || kind === 0) return h;
    const yEnd = Math.min(WORLD_HEIGHT, h + DECOR_MAX_HEIGHT);
    buf.fill(B.AIR, h * L, yEnd * L);
    const snowy = this.surface[t] === SURF_SNOW || this.surface[t] === SURF_ROCK;
    return writeDecor(buf, kind, h, this.decorHash[t], snowy);
  }

  private computeTops(t: number): void {
    const n = this.n;
    const tx = t % n;
    const tz = (t - tx) / n;
    const surf = this.surface[t];
    const h = this.height[t];
    const base = t * L;
    const x0 = tx * T;
    const z0 = tz * T;
    for (let lz = 0; lz < T; lz++) {
      for (let lx = 0; lx < T; lx++) this.tops[base + lx + T * lz] = this.columnTop(x0 + lx, z0 + lz, surf, h);
    }
    this.topsReady[t] = 1;
  }

  /** Natural top block of voxel column (x, z) on a tile with surface `surf` and height h. */
  private columnTop(x: number, z: number, surf: number, h: number): BlockId {
    // Forest density sampled at the column's low corner: the centre column of a tile samples the
    // tile centre exactly.
    const forest = surf === SURF_GRASS || surf === SURF_HIGHGRASS ? this.forest.at(x / T, z / T) : 0;
    return this.columnTopAt(x, z, surf, h, forest);
  }

  /** columnTop with the column's forest density given. */
  private columnTopAt(x: number, z: number, surf: number, h: number, forest: number): BlockId {
    const tn = this.noise;
    switch (surf) {
      case SURF_SAND:
        return B.SAND;
      case SURF_WATER: {
        const v = tn.column.fbm(x / 13 + OFF_BED, z / 13 - OFF_BED, 2);
        if (h >= WATER_LEVEL - 2) return v > 0.42 ? B.GRAVEL : B.SAND; // shallows: mostly sand
        return v > 0.18 ? B.GRAVEL : v < -0.3 ? B.CLAY : B.SAND;
      }
      case SURF_SNOW:
        return tn.column.fbm(x / 7 + OFF_ROCK, z / 7 - OFF_ROCK, 2) > 0.48 ? B.ROCK : B.SNOW;
      case SURF_ROCK: {
        const v = tn.column.fbm(x / 9 + OFF_ROCK, z / 9 - OFF_ROCK, 2);
        return v < -0.42 ? B.GRASS_DARK : v > 0.5 ? B.GRAVEL : B.ROCK;
      }
      case SURF_HIGHGRASS:
        if (tn.column.fbm(x / 9 + OFF_ROCK, z / 9 - OFF_ROCK, 2) > 0.12) return B.ROCK;
        return this.grassShade(x, z, h, forest);
      default:
        return this.grassShade(x, z, h, forest);
    }
  }

  /** Large low-frequency grass patches; darker under forests (density `forest`) and with altitude. */
  private grassShade(x: number, z: number, h: number, forest: number): BlockId {
    let g = 0.9 * this.noise.column.fbm(x / 46 + OFF_GRASS, z / 46 + OFF_GRASS, 2);
    g -= 0.85 * (forest - 0.5);
    g -= (h - 12) * 0.03;
    return g < -0.3 ? B.GRASS_DARK : g > 0.36 ? B.GRASS_LIGHT : B.GRASS;
  }
}
