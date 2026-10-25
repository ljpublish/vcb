/**
 * MODULE: buildings — shared drawing helpers for every generator in src/build (module-internal API).
 * Owner: buildings framework. Zone threads may ADD helpers here only via the framework owner; keep
 * zone-specific helpers in your own file.
 *
 * Conventions (same as buildingGen.ts):
 *  - Coordinates are stamp-local voxels. Layer y = 0 is the ground surface layer; structures start at y = 1.
 *  - Front faces +Z (z = S-1 is the street edge); the caller rotates afterwards.
 *  - Boxes are half-open [x0,x1)×[y0,y1)×[z0,z1). Everything is clipped to the stamp.
 *  - All randomness is from hashes of (x,y,z,seed) or an Rng seeded from spec.variant — never Math.random.
 */
import { hash2, hash3, hashToUnit } from '../core/rng';
import { B, type BlockId } from '../voxel/blocks';
import { MAX_STRUCTURE_HEIGHT, TILE_SIZE, type EmitterKind } from '../types';
import type { BuildingSpec, LocalEmitter } from './buildingGen';
import { StampBuilder } from './stamp';

/** Max stamp layers (ground layer + MAX_STRUCTURE_HEIGHT). */
export const STAMP_LAYERS = MAX_STRUCTURE_HEIGHT + 1;
/** Storey height in voxels (window row in the middle). */
export const FLOOR_H = 3;

/** Footprint edge in voxels for a spec (8 or 16). */
export function footprint(spec: BuildingSpec): number {
  return spec.size * TILE_SIZE;
}

/** Empty (all-KEEP) builder sized for `spec`, with the full height budget. */
export function newLot(spec: BuildingSpec): StampBuilder {
  const s = footprint(spec);
  return new StampBuilder(s, STAMP_LAYERS, s);
}

/** Paint the whole ground layer (y = 0). */
export function ground(b: StampBuilder, id: BlockId): void {
  b.fill(0, 0, 0, b.sx, 1, b.sz, id);
}

/** Deterministic 0..1 from voxel coords + seed. */
export function rand3(x: number, y: number, z: number, seed: number): number {
  return hashToUnit(hash3(x, y, z, seed));
}

export function rand2(x: number, z: number, seed: number): number {
  return hashToUnit(hash2(x, z, seed));
}

/** WINDOW_LIT with probability `lit`, else WINDOW (stable per window). */
export function windowBlock(x: number, y: number, z: number, seed: number, lit: number): BlockId {
  return rand3(x, y, z, seed) < lit ? B.WINDOW_LIT : B.WINDOW;
}

/** GLASS_LIT with probability `lit`, else `glass`. */
export function glassBlock(x: number, y: number, z: number, seed: number, lit: number, glass: BlockId): BlockId {
  return rand3(x, y, z, seed) < lit ? B.GLASS_LIT : glass;
}

export interface FacadeOpts {
  wall: BlockId;
  seed: number;
  /** Fraction of lit windows (R ≈ 0.5, C ≈ 0.6, I ≈ 0.3). */
  lit: number;
  /** Storey height (default FLOOR_H). Windows sit at row 1 of each storey (row 1–2 when tall). */
  floorH?: number;
  /** Window every `spacing` columns, skipping corners (default 2). */
  spacing?: number;
  /** 'window' = WINDOW/WINDOW_LIT, or a glass block id for glass windows. */
  glass?: BlockId;
  /** Two-voxel-tall windows. */
  tall?: boolean;
  /** Skip windows on these sides (bitmask: 1 = -Z back, 2 = +X, 4 = +Z front, 8 = -X). */
  skipSides?: number;
  /** First storey with windows (default 0). */
  firstFloor?: number;
}

/**
 * Solid box of `wall` with windows punched into all four outer faces.
 * Windows only on full storeys between y0 and y1.
 */
export function facadeBox(
  b: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: FacadeOpts,
): void {
  b.fill(x0, y0, z0, x1, y1, z1, o.wall);
  const fh = o.floorH ?? FLOOR_H;
  const sp = o.spacing ?? 2;
  const skip = o.skipSides ?? 0;
  const floors = Math.floor((y1 - y0) / fh);
  for (let f = o.firstFloor ?? 0; f < floors; f++) {
    const wy = y0 + f * fh + 1;
    const rows = o.tall && fh >= 3 ? 2 : 1;
    for (let r = 0; r < rows; r++) {
      const y = wy + r;
      if (y >= y1) break;
      // front/back (vary x)
      for (let x = x0 + 1; x < x1 - 1; x++) {
        if ((x - x0 - 1) % sp !== 0 && sp > 1) continue;
        if (!(skip & 4)) b.set(x, y, z1 - 1, pick(o, x, wy, z1, f));
        if (!(skip & 1)) b.set(x, y, z0, pick(o, x, wy, z0 - 1, f));
      }
      for (let z = z0 + 1; z < z1 - 1; z++) {
        if ((z - z0 - 1) % sp !== 0 && sp > 1) continue;
        if (!(skip & 2)) b.set(x1 - 1, y, z, pick(o, x1, wy, z, f));
        if (!(skip & 8)) b.set(x0, y, z, pick(o, x0 - 1, wy, z, f));
      }
    }
  }
}

function pick(o: FacadeOpts, x: number, y: number, z: number, _f: number): BlockId {
  return o.glass !== undefined ? glassBlock(x, y, z, o.seed, o.lit, o.glass) : windowBlock(x, y, z, o.seed, o.lit);
}

/**
 * Continuous horizontal glass bands (offices): solid box of `frame`, every storey gets a band of
 * glass rows 1..fh-1 on all faces except at the corner columns.
 */
export function bandedBox(
  b: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  frame: BlockId, glass: BlockId, seed: number, lit: number, floorH = FLOOR_H,
): void {
  b.fill(x0, y0, z0, x1, y1, z1, frame);
  for (let y = y0; y < y1; y++) {
    const r = (y - y0) % floorH;
    if (r === 0) continue;
    const f = Math.floor((y - y0) / floorH);
    for (let x = x0 + 1; x < x1 - 1; x++) {
      b.set(x, y, z1 - 1, glassBlock(x >> 1, f, 1, seed, lit, glass));
      b.set(x, y, z0, glassBlock(x >> 1, f, 2, seed, lit, glass));
    }
    for (let z = z0 + 1; z < z1 - 1; z++) {
      b.set(x1 - 1, y, z, glassBlock(z >> 1, f, 3, seed, lit, glass));
      b.set(x0, y, z, glassBlock(z >> 1, f, 4, seed, lit, glass));
    }
  }
}

/** Curtain wall: glass on all faces with `mullion` columns every `step` voxels and at corners. */
export function curtainBox(
  b: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  mullion: BlockId, glass: BlockId, seed: number, lit: number, step = 3,
): void {
  b.fill(x0, y0, z0, x1, y1, z1, mullion);
  for (let y = y0; y < y1; y++) {
    const f = Math.floor((y - y0) / FLOOR_H);
    for (let x = x0 + 1; x < x1 - 1; x++) {
      if ((x - x0) % step === 0) continue;
      const cell = Math.floor((x - x0) / step);
      b.set(x, y, z1 - 1, glassBlock(cell, f, 1, seed, lit, glass));
      b.set(x, y, z0, glassBlock(cell, f, 2, seed, lit, glass));
    }
    for (let z = z0 + 1; z < z1 - 1; z++) {
      if ((z - z0) % step === 0) continue;
      const cell = Math.floor((z - z0) / step);
      b.set(x1 - 1, y, z, glassBlock(cell, f, 3, seed, lit, glass));
      b.set(x0, y, z, glassBlock(cell, f, 4, seed, lit, glass));
    }
  }
}

/**
 * Stepped gable roof over [x0,x1)×[z0,z1) starting at layer y. Ridge runs along X when alongX,
 * else along Z. `overhang` extends the roof by that many voxels beyond the walls (clipped).
 * Gable-end triangles are filled with `wall`. Returns the layer above the ridge.
 */
export function gableRoof(
  b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number,
  roof: BlockId, wall: BlockId, alongX = true, overhang = 1,
): number {
  let k = 0;
  if (alongX) {
    const a0 = z0 - overhang, a1 = z1 + overhang;
    for (; a0 + k < a1 - k; k++) {
      b.fill(x0, y + k, a0 + k, x1, y + k + 1, a1 - k, roof);
      if (k > 0 && a0 + k + 1 < a1 - k - 1) {
        b.fill(x0, y + k - 1, a0 + k, x0 + 1, y + k, a1 - k, wall);
        b.fill(x1 - 1, y + k - 1, a0 + k, x1, y + k, a1 - k, wall);
      }
    }
  } else {
    const a0 = x0 - overhang, a1 = x1 + overhang;
    for (; a0 + k < a1 - k; k++) {
      b.fill(a0 + k, y + k, z0, a1 - k, y + k + 1, z1, roof);
      if (k > 0 && a0 + k + 1 < a1 - k - 1) {
        b.fill(a0 + k, y + k - 1, z0, a1 - k, y + k, z0 + 1, wall);
        b.fill(a0 + k, y + k - 1, z1 - 1, a1 - k, y + k, z1, wall);
      }
    }
  }
  return y + k;
}

/** Stepped hip roof (shrinks on all four sides). Returns the layer above the top. */
export function hipRoof(
  b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, roof: BlockId, overhang = 1,
): number {
  let ax = x0 - overhang, bx = x1 + overhang, az = z0 - overhang, bz = z1 + overhang;
  let k = 0;
  while (ax < bx && az < bz) {
    b.fill(ax, y + k, az, bx, y + k + 1, bz, roof);
    ax++; bx--; az++; bz--; k++;
    if (bx - ax <= 0 || bz - az <= 0) break;
  }
  return y + k;
}

/** Flat roof slab at layer y with an optional 1-voxel parapet ring at y+1. */
export function flatRoof(
  b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number,
  roof: BlockId = B.ROOF_FLAT, parapet?: BlockId,
): void {
  b.fill(x0, y, z0, x1, y + 1, z1, roof);
  if (parapet !== undefined) b.walls(x0, y + 1, z0, x1, y + 2, z1, parapet);
}

/** Vertical cylinder centred at continuous (cx,cz) with radius r over layers [y0,y1). */
export function cylinder(
  b: StampBuilder, cx: number, cz: number, r: number, y0: number, y1: number, id: BlockId,
): void {
  const r2 = r * r;
  const xa = Math.floor(cx - r), xb = Math.ceil(cx + r);
  const za = Math.floor(cz - r), zb = Math.ceil(cz + r);
  for (let z = za; z < zb; z++) {
    for (let x = xa; x < xb; x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      if (dx * dx + dz * dz <= r2) b.fill(x, y0, z, x + 1, y1, z + 1, id);
    }
  }
}

/**
 * Small deciduous tree with its trunk at (x, z), base at layer y (usually 1). Uses 3×3 canopy
 * (5×5 when big), so keep it ≥1 (≥2) voxel from the footprint edge. Returns the canopy top layer.
 */
export function tree(b: StampBuilder, x: number, y: number, z: number, seed: number, big = false): number {
  const h = rand2(x, z, seed);
  const trunk = big ? 3 + (h > 0.5 ? 1 : 0) : 2 + (h > 0.6 ? 1 : 0);
  const leaves = h < 0.15 ? B.LEAVES_AUTUMN : h < 0.25 ? B.LEAVES_PINK : h < 0.6 ? B.LEAVES : h < 0.8 ? B.LEAVES_DARK : B.LEAVES_LIGHT;
  b.fill(x, y, z, x + 1, y + trunk, z + 1, B.WOOD);
  const cy = y + trunk;
  const r = big ? 2 : 1;
  b.fill(x - r, cy, z - r, x + r + 1, cy + 2, z + r + 1, leaves);
  if (big) {
    // round the corners
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      b.set(x + dx, cy, z + dz, B.AIR);
      b.set(x + dx, cy + 1, z + dz, B.AIR);
    }
  }
  b.fill(x - (r - 1), cy + 2, z - (r - 1), x + r, cy + 3, z + r, leaves);
  return cy + 3;
}

/** Pine / conifer with trunk at (x,z). */
export function pine(b: StampBuilder, x: number, y: number, z: number, height = 5): void {
  b.fill(x, y, z, x + 1, y + 1, z + 1, B.WOOD);
  for (let k = 1; k < height; k++) {
    const r = k < height - 2 ? 1 : 0;
    b.fill(x - r, y + k, z - r, x + r + 1, y + k + 1, z + r + 1, B.PINE);
  }
}

const FLOWERS: readonly BlockId[] = [B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE];

/** Flower bed on layer y over [x0,x1)×[z0,z1) (sits on the ground layer when y = 1). */
export function flowerBed(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, seed: number): void {
  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const r = rand2(x, z, seed);
      b.set(x, y, z, r < 0.25 ? B.BUSH : FLOWERS[Math.floor(r * 97) % FLOWERS.length]);
    }
  }
}

/** Fence or hedge line on layer y along [x0,x1)×[z0,z1), leaving a gap at x = gapX (or z = gapZ). */
export function fenceLine(
  b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, id: BlockId, gapX = -1, gapZ = -1,
): void {
  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      if (x === gapX || z === gapZ) continue;
      b.set(x, y, z, id);
    }
  }
}

/** Rooftop clutter on a flat roof whose walkable layer is y: AC units, vents, optional antenna. */
export function roofClutter(
  b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, seed: number, count = 2,
): void {
  for (let i = 0; i < count; i++) {
    const rx = x0 + 1 + Math.floor(rand3(i, 1, 7, seed) * Math.max(1, x1 - x0 - 2));
    const rz = z0 + 1 + Math.floor(rand3(i, 2, 7, seed) * Math.max(1, z1 - z0 - 2));
    b.set(rx, y, rz, B.AC_UNIT);
  }
}

/** Antenna mast of `height` with a red beacon on top (top = y + height). Returns the beacon layer. */
export function antenna(b: StampBuilder, x: number, y: number, z: number, height: number, beacon = true): number {
  b.fill(x, y, z, x + 1, y + height, z + 1, B.ANTENNA);
  if (beacon) b.set(x, y + height, z, B.BEACON_RED);
  return y + height;
}

/** Push an emitter (stamp-local continuous coords; x,z ∈ [0,S]). */
export function emit(out: LocalEmitter[], x: number, y: number, z: number, kind: EmitterKind, strength: number): void {
  out.push({ x, y, z, kind, strength: Math.max(0, Math.min(1, strength)) });
}

/** Columns-of-interest helper: true if column (x,z) holds a non-KEEP, non-AIR voxel at layer ≥ yMin. */
export function columnBuilt(b: StampBuilder, x: number, z: number, yMin: number): boolean {
  for (let y = yMin; y < b.sy; y++) {
    const v = b.get(x, y, z);
    if (v !== 255 && v !== B.AIR) return true;
  }
  return false;
}
