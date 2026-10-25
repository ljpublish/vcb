/**
 * MODULE: buildings — VoxelStamp authoring helper (module-internal API).
 * Owner: buildings framework (shared by every generator in src/build).
 *
 * Convention used by all generators in src/build: author every structure with its FRONT facing +Z
 * (DIR_S), then rotate with rotateY() to the building's `facing`. Rotation is around the vertical
 * axis of the footprint centre (footprints are square, so sx === sz).
 *
 * Voxel mapping, source (x,z) → destination, S = sx:
 *   S: (x, z)   N: (S-1-x, S-1-z)   E: (z, S-1-x)   W: (S-1-z, x)
 * Continuous points (emitters, x,z ∈ [0,S]) use rotatePoint() with the same turns.
 */
import { STAMP_KEEP, type BlockId } from '../voxel/blocks';
import { DIR_E, DIR_N, DIR_W, type Dir, type VoxelStamp } from '../types';

export class StampBuilder {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly data: Uint8Array;

  /** New stamp filled with `fill` (default STAMP_KEEP = leave world untouched). */
  constructor(sx: number, sy: number, sz: number, fill: number = STAMP_KEEP) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.data = new Uint8Array(sx * sy * sz).fill(fill);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  /** Out-of-bounds writes are ignored. */
  set(x: number, y: number, z: number, id: BlockId): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[x + this.sx * (z + this.sz * y)] = id;
  }

  /** STAMP_KEEP when out of bounds. */
  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return STAMP_KEEP;
    return this.data[x + this.sx * (z + this.sz * y)];
  }

  /** Fill the half-open box [x0,x1)×[y0,y1)×[z0,z1) (clipped). */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
    const ax = Math.max(0, x0 | 0), bx = Math.min(this.sx, x1 | 0);
    const ay = Math.max(0, y0 | 0), by = Math.min(this.sy, y1 | 0);
    const az = Math.max(0, z0 | 0), bz = Math.min(this.sz, z1 | 0);
    if (ax >= bx || ay >= by || az >= bz) return;
    const sx = this.sx, sz = this.sz, d = this.data;
    for (let y = ay; y < by; y++) {
      for (let z = az; z < bz; z++) {
        const row = sx * (z + sz * y);
        d.fill(id, row + ax, row + bx);
      }
    }
  }

  /** Walls only (no top/bottom) of the half-open box. */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
    if (x1 - x0 <= 0 || z1 - z0 <= 0) return;
    this.fill(x0, y0, z0, x1, y1, z0 + 1, id);
    this.fill(x0, y0, z1 - 1, x1, y1, z1, id);
    this.fill(x0, y0, z0, x0 + 1, y1, z1, id);
    this.fill(x1 - 1, y0, z0, x1, y1, z1, id);
  }

  /** Replace every voxel equal to `from` with `to` inside the box (whole stamp when omitted). */
  replace(from: BlockId, to: BlockId): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i] === from) d[i] = to;
  }

  /** Returns a copy rotated by quarter turns so that an authored +Z front faces `facing`. */
  rotateY(facing: Dir): StampBuilder {
    const S = this.sx;
    const out = new StampBuilder(this.sx, this.sy, this.sz);
    if (facing !== DIR_N && facing !== DIR_E && facing !== DIR_W) {
      out.data.set(this.data);
      return out;
    }
    const src = this.data, dst = out.data;
    const layer = S * S;
    for (let y = 0; y < this.sy; y++) {
      const base = y * layer;
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const v = src[base + x + S * z];
          if (v === STAMP_KEEP) continue;
          let dx: number, dz: number;
          if (facing === DIR_N) { dx = S - 1 - x; dz = S - 1 - z; }
          else if (facing === DIR_E) { dx = z; dz = S - 1 - x; }
          else { dx = S - 1 - z; dz = x; }
          dst[base + dx + S * dz] = v;
        }
      }
    }
    return out;
  }

  /** Copy `other` into this stamp at offset (ox,oy,oz), skipping STAMP_KEEP voxels. */
  blit(other: StampBuilder, ox: number, oy: number, oz: number): void {
    for (let y = 0; y < other.sy; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= this.sy) continue;
      for (let z = 0; z < other.sz; z++) {
        const tz = z + oz;
        if (tz < 0 || tz >= this.sz) continue;
        for (let x = 0; x < other.sx; x++) {
          const tx = x + ox;
          if (tx < 0 || tx >= this.sx) continue;
          const v = other.data[x + other.sx * (z + other.sz * y)];
          if (v !== STAMP_KEEP) this.data[tx + this.sx * (tz + this.sz * ty)] = v;
        }
      }
    }
  }

  /** Highest y layer containing a non-KEEP voxel, +1 (0 if empty). */
  usedHeight(): number {
    const layer = this.sx * this.sz;
    for (let y = this.sy - 1; y >= 0; y--) {
      const base = y * layer;
      for (let i = 0; i < layer; i++) if (this.data[base + i] !== STAMP_KEEP) return y + 1;
    }
    return 0;
  }

  /** Final VoxelStamp, trimmed to usedHeight() (min 1 layer). Shares no memory with the builder. */
  toStamp(): VoxelStamp {
    const sy = Math.max(1, this.usedHeight());
    return { sx: this.sx, sy, sz: this.sz, data: this.data.slice(0, this.sx * this.sz * sy) };
  }
}

/** Rotate a continuous point (x,z ∈ [0,S]) the same way rotateY rotates voxels. */
export function rotatePoint(x: number, z: number, S: number, facing: Dir): [number, number] {
  if (facing === DIR_N) return [S - x, S - z];
  if (facing === DIR_E) return [z, S - x];
  if (facing === DIR_W) return [S - z, x];
  return [x, z];
}
