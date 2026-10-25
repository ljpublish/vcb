/**
 * MODULE: buildings — VoxelStamp authoring helper (module-internal API; the buildings agent may change it).
 * Owner: buildings agent.
 *
 * STUB: storage + trivial accessors work; the drawing helpers are TODO.
 *
 * Convention used by all generators in src/build: author every structure with its FRONT facing +Z
 * (DIR_S), then rotate with rotateY() to the building's `facing`. Rotation is around the vertical
 * axis of the footprint centre (footprints are square, so sx === sz).
 */
import { STAMP_KEEP, type BlockId } from '../voxel/blocks';
import type { Dir, VoxelStamp } from '../types';

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
    // TODO(buildings)
  }

  /** Walls only (no top/bottom) of the half-open box. */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
    // TODO(buildings)
  }

  /** Returns a copy rotated by quarter turns so that an authored +Z front faces `facing`. */
  rotateY(facing: Dir): StampBuilder {
    // TODO(buildings)
    return this;
  }

  /** Copy `other` into this stamp at offset (ox,oy,oz), skipping STAMP_KEEP voxels. */
  blit(other: StampBuilder, ox: number, oy: number, oz: number): void {
    // TODO(buildings)
  }

  /** Highest y layer containing a non-KEEP voxel, +1 (0 if empty). */
  usedHeight(): number {
    // TODO(buildings)
    return this.sy;
  }

  /** Final VoxelStamp (may be trimmed to usedHeight()). */
  toStamp(): VoxelStamp {
    return { sx: this.sx, sy: this.sy, sz: this.sz, data: this.data };
  }
}
