/**
 * MODULE: voxel-world — chunked voxel storage.
 * Owner: voxel-world agent. Implements IVoxelWorld (src/types.ts).
 *
 * Design:
 *  - Storage: one `Uint8Array(CHUNK_VOLUME) | null` per chunk in a flat array indexed by chunkKey()
 *    (src/core/coords.ts): key = (cy*16 + cz)*16 + cx. null = all AIR (lazy allocation; AIR writes
 *    never allocate). A per-chunk non-air voxel count (Int32Array) makes isChunkEmpty() O(1); a
 *    chunk whose count drops to 0 is released (its zeroed array goes to a small reuse pool).
 *    Voxel index inside a chunk: lx + 32*(lz + 32*ly) = lx | lz << 5 | ly << 10.
 *  - getBlock/setBlock: bounds check → chunk lookup via shifts/masks. setBlock writes (and dirties)
 *    only when the value actually changes; `id &= 255`; STAMP_KEEP (255) is never stored.
 *  - Dirty tracking: a voxel change marks its own chunk dirty AND each neighbour chunk whose padded
 *    34³ border contains the voxel (local 0 or 31 on an axis → the neighbour across that face, plus
 *    edge/corner neighbours: up to 7), because the mesher needs the border for face culling + AO.
 *    markChunkDirty bumps the chunk's version (Uint32Array) and adds the key to the dirty set
 *    (a flag array + insertion-ordered key list = a Set without hashing). takeDirtyChunks() returns
 *    the keys and clears the set.
 *  - fillBox/applyStamp: clipped to the world, processed chunk by chunk with direct typed-array
 *    access. Per touched chunk the bounding box of the CHANGED voxels is tracked; the chunk plus the
 *    neighbours that box touches are dirty-marked once per operation (each dirty chunk's version is
 *    bumped once per call). `revision` increases by one per call that changed anything.
 *  - extractPadded: fills the 34³ padded buffer row by row from the up to 27 chunk arrays involved;
 *    outside the world: y < 0 → B.BEDROCK, everything else outside → AIR. No allocations.
 *  - getColumnTop: scans down from the highest allocated chunk of the column.
 *  - clear(): marks every previously non-empty chunk dirty, then drops all chunk arrays.
 *
 * Semantics are identical to the naive reference implementation (/home/claude/vcb-skeleton), except
 * that bulk operations may dirty-mark a few extra chunks diagonal to a changed region (the product of
 * the per-axis neighbour sets of the changed bounding box) and bump `revision` once per call.
 *
 * Performance targets: setBlock ≥ 20M/s; extractPadded ≤ 0.3 ms; fillBox of 8×116×8 ≤ 0.2 ms;
 * full-map terrain write (512×512×~14) ≤ 150 ms.
 */
import {
  CHUNK_COUNT,
  CHUNK_VOLUME,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  WORLD_HEIGHT,
  WORLD_SIZE_X,
  WORLD_SIZE_Z,
  type IVoxelWorld,
  type VoxelStamp,
} from '../types';
import { B, STAMP_KEEP, type BlockId } from './blocks';

// These shifts/masks are hard-wired (CHUNK_SIZE = 32, CHUNKS_X = CHUNKS_Z = 16); the asserts below
// keep them honest if the frozen constants ever change.
const AIR = 0;
const KEEP = STAMP_KEEP;
const BEDROCK = B.BEDROCK;
const SX = WORLD_SIZE_X;
const SY = WORLD_HEIGHT;
const SZ = WORLD_SIZE_Z;
const CX_MAX = CHUNKS_X - 1;
const CY_MAX = CHUNKS_Y - 1;
const CZ_MAX = CHUNKS_Z - 1;
/** Padded edge (34) and plane (34²). */
const P = 34;
const PP = P * P;
/** Max released chunk arrays kept for reuse (16 MB). */
const POOL_MAX = 512;

if (CHUNK_VOLUME !== 32768 || CHUNKS_X !== 16 || CHUNKS_Z !== 16) {
  throw new Error('VoxelWorld: chunk layout constants changed; update the shifts in src/voxel/world.ts');
}

export class VoxelWorld implements IVoxelWorld {
  readonly sizeX = WORLD_SIZE_X;
  readonly sizeY = WORLD_HEIGHT;
  readonly sizeZ = WORLD_SIZE_Z;
  readonly chunksX = CHUNKS_X;
  readonly chunksY = CHUNKS_Y;
  readonly chunksZ = CHUNKS_Z;

  /** Chunk arrays by key; null = all AIR. Built with push() so the array stays PACKED. */
  private readonly chunks: (Uint8Array | null)[] = [];
  /** Non-AIR voxels per chunk. */
  private readonly counts = new Int32Array(CHUNK_COUNT);
  private readonly versions = new Uint32Array(CHUNK_COUNT);
  /** Dirty set: membership flags + keys in insertion order. */
  private readonly dirtyFlags = new Uint8Array(CHUNK_COUNT);
  private readonly dirtyList = new Int32Array(CHUNK_COUNT);
  private dirtyCount = 0;
  /** Per-operation dedupe of dirty marks (a chunk's version is bumped once per bulk call). */
  private readonly opMark = new Uint32Array(CHUNK_COUNT);
  private opId = 0;
  /** Released arrays: `clean` are known all-zero, `stale` (from clear()) need zeroing on reuse. */
  private readonly cleanPool: Uint8Array[] = [];
  private readonly stalePool: Uint8Array[] = [];
  /** extractPadded scratch: the 3×3×3 chunk neighbourhood, index (dy+1)*9 + (dz+1)*3 + (dx+1). */
  private readonly nb: (Uint8Array | null)[] = [];
  private _revision = 0;

  constructor() {
    for (let i = 0; i < CHUNK_COUNT; i++) this.chunks.push(null);
    for (let i = 0; i < 27; i++) this.nb.push(null);
  }

  get revision(): number {
    return this._revision;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
  }

  getBlock(x: number, y: number, z: number): BlockId {
    if (!(x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ)) return AIR;
    const c = this.chunks[(((y >> 5) << 4) + (z >> 5)) * 16 + (x >> 5)];
    return c === null ? AIR : c[(x & 31) | ((z & 31) << 5) | ((y & 31) << 10)];
  }

  setBlock(x: number, y: number, z: number, id: BlockId): void {
    if (!(x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ)) return;
    id &= 255;
    if (id === KEEP) return;
    const cx = x >> 5;
    const cy = y >> 5;
    const cz = z >> 5;
    const key = ((cy << 4) + cz) * 16 + cx;
    let c = this.chunks[key];
    if (c === null) {
      if (id === AIR) return;
      c = this.alloc(key);
    }
    const lx = x & 31;
    const ly = y & 31;
    const lz = z & 31;
    const i = lx | (lz << 5) | (ly << 10);
    const old = c[i];
    if (old === id) return;
    c[i] = id;
    if (old === AIR) this.counts[key]++;
    else if (id === AIR && --this.counts[key] === 0) this.release(key);
    this._revision++;
    if (lx !== 0 && lx !== 31 && ly !== 0 && ly !== 31 && lz !== 0 && lz !== 31) {
      this.markKey(key);
      return;
    }
    // Border voxel: own chunk + the neighbours across the touched faces/edges/corners.
    const dx0 = lx === 0 && cx > 0 ? -1 : 0;
    const dx1 = lx === 31 && cx < CX_MAX ? 1 : 0;
    const dy0 = ly === 0 && cy > 0 ? -1 : 0;
    const dy1 = ly === 31 && cy < CY_MAX ? 1 : 0;
    const dz0 = lz === 0 && cz > 0 ? -1 : 0;
    const dz1 = lz === 31 && cz < CZ_MAX ? 1 : 0;
    for (let dy = dy0; dy <= dy1; dy++) {
      for (let dz = dz0; dz <= dz1; dz++) {
        const row = (((cy + dy) << 4) + cz + dz) * 16 + cx;
        for (let dx = dx0; dx <= dx1; dx++) this.markKey(row + dx);
      }
    }
  }

  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
    id &= 255;
    if (id === KEEP) return;
    // Clip exactly like the reference loop `for (x = max(0, x0); x < min(size, x1); x++)` writing
    // voxel floor(x) (identical for integer input). Math.max/min propagate NaN → empty box.
    let ax = Math.max(0, x0);
    let ay = Math.max(0, y0);
    let az = Math.max(0, z0);
    const ex = Math.min(SX, x1);
    const ey = Math.min(SY, y1);
    const ez = Math.min(SZ, z1);
    if (!(ax < ex && ay < ey && az < ez)) return;
    const nx = Math.ceil(ex - ax);
    const ny = Math.ceil(ey - ay);
    const nz = Math.ceil(ez - az);
    ax = Math.floor(ax);
    ay = Math.floor(ay);
    az = Math.floor(az);
    const bx = Math.min(SX, ax + nx);
    const by = Math.min(SY, ay + ny);
    const bz = Math.min(SZ, az + nz);

    this.beginOp();
    let changedAny = false;
    const cy0 = ay >> 5;
    const cy1 = (by - 1) >> 5;
    const cz0 = az >> 5;
    const cz1 = (bz - 1) >> 5;
    const cx0 = ax >> 5;
    const cx1 = (bx - 1) >> 5;
    for (let cy = cy0; cy <= cy1; cy++) {
      const oy = cy << 5;
      const ly0 = ay > oy ? ay - oy : 0;
      const ly1 = by < oy + 32 ? by - oy : 32;
      for (let cz = cz0; cz <= cz1; cz++) {
        const oz = cz << 5;
        const lz0 = az > oz ? az - oz : 0;
        const lz1 = bz < oz + 32 ? bz - oz : 32;
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = ((cy << 4) + cz) * 16 + cx;
          let c = this.chunks[key];
          if (c === null) {
            if (id === AIR) continue; // nothing to clear
            c = this.alloc(key);
          }
          const ox = cx << 5;
          const lx0 = ax > ox ? ax - ox : 0;
          const lx1 = bx < ox + 32 ? bx - ox : 32;
          let delta = 0;
          let minX = 32;
          let maxX = -1;
          let minY = 32;
          let maxY = -1;
          let minZ = 32;
          let maxZ = -1;
          for (let ly = ly0; ly < ly1; ly++) {
            for (let lz = lz0; lz < lz1; lz++) {
              let ci = lx0 | (lz << 5) | (ly << 10);
              let rmin = -1;
              let rmax = -1;
              for (let lx = lx0; lx < lx1; lx++, ci++) {
                const old = c[ci];
                if (old === id) continue;
                c[ci] = id;
                if (old === AIR) delta++;
                else if (id === AIR) delta--;
                if (rmin < 0) rmin = lx;
                rmax = lx;
              }
              if (rmax >= 0) {
                if (rmin < minX) minX = rmin;
                if (rmax > maxX) maxX = rmax;
                if (ly < minY) minY = ly;
                maxY = ly;
                if (lz < minZ) minZ = lz;
                if (lz > maxZ) maxZ = lz;
              }
            }
          }
          if (maxX >= 0) {
            changedAny = true;
            if ((this.counts[key] += delta) === 0) this.release(key);
            this.markChanged(cx, cy, cz, minX, maxX, minY, maxY, minZ, maxZ);
          } else if (this.counts[key] === 0) {
            // Freshly allocated but nothing written (cannot happen for id ≠ AIR; defensive).
            this.release(key);
          }
        }
      }
    }
    if (changedAny) this._revision++;
  }

  applyStamp(stamp: VoxelStamp, ox: number, oy: number, oz: number): void {
    if (!stamp) return;
    const sx = stamp.sx;
    const sz = stamp.sz;
    let sy = stamp.sy;
    const data = stamp.data;
    if (!(sx > 0 && sy > 0 && sz > 0) || !data) return;
    if ((sx | 0) !== sx || (sy | 0) !== sy || (sz | 0) !== sz) return;
    const layer = sx * sz;
    if (data.length < layer * sy) sy = Math.floor(data.length / layer); // short data: missing part = KEEP
    if (sy <= 0) return;
    // Flooring the origin reproduces the reference (which writes voxel floor(ox + x)).
    ox = Math.floor(ox);
    oy = Math.floor(oy);
    oz = Math.floor(oz);
    const ax = Math.max(0, ox);
    const ay = Math.max(0, oy);
    const az = Math.max(0, oz);
    const bx = Math.min(SX, ox + sx);
    const by = Math.min(SY, oy + sy);
    const bz = Math.min(SZ, oz + sz);
    if (!(ax < bx && ay < by && az < bz)) return; // also rejects NaN / ±Infinity origins

    this.beginOp();
    let changedAny = false;
    const cy0 = ay >> 5;
    const cy1 = (by - 1) >> 5;
    const cz0 = az >> 5;
    const cz1 = (bz - 1) >> 5;
    const cx0 = ax >> 5;
    const cx1 = (bx - 1) >> 5;
    for (let cy = cy0; cy <= cy1; cy++) {
      const wy0 = cy << 5;
      const ly0 = ay > wy0 ? ay - wy0 : 0;
      const ly1 = by < wy0 + 32 ? by - wy0 : 32;
      for (let cz = cz0; cz <= cz1; cz++) {
        const wz0 = cz << 5;
        const lz0 = az > wz0 ? az - wz0 : 0;
        const lz1 = bz < wz0 + 32 ? bz - wz0 : 32;
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = ((cy << 4) + cz) * 16 + cx;
          let c = this.chunks[key];
          const wx0 = cx << 5;
          const lx0 = ax > wx0 ? ax - wx0 : 0;
          const lx1 = bx < wx0 + 32 ? bx - wx0 : 32;
          // Stamp x of local lx0 in this chunk.
          const sx0 = wx0 + lx0 - ox;
          let delta = 0;
          let minX = 32;
          let maxX = -1;
          let minY = 32;
          let maxY = -1;
          let minZ = 32;
          let maxZ = -1;
          for (let ly = ly0; ly < ly1; ly++) {
            const syRow = (wy0 + ly - oy) * sz;
            for (let lz = lz0; lz < lz1; lz++) {
              let si = sx0 + sx * (wz0 + lz - oz + syRow);
              let ci = lx0 | (lz << 5) | (ly << 10);
              let rmin = -1;
              let rmax = -1;
              for (let lx = lx0; lx < lx1; lx++, si++, ci++) {
                const v = data[si];
                if (v === KEEP) continue;
                if (c === null) {
                  if (v === AIR) continue;
                  c = this.alloc(key);
                }
                const old = c[ci];
                if (old === v) continue;
                c[ci] = v;
                if (old === AIR) delta++;
                else if (v === AIR) delta--;
                if (rmin < 0) rmin = lx;
                rmax = lx;
              }
              if (rmax >= 0) {
                if (rmin < minX) minX = rmin;
                if (rmax > maxX) maxX = rmax;
                if (ly < minY) minY = ly;
                maxY = ly;
                if (lz < minZ) minZ = lz;
                if (lz > maxZ) maxZ = lz;
              }
            }
          }
          if (maxX >= 0) {
            changedAny = true;
            if ((this.counts[key] += delta) === 0) this.release(key);
            this.markChanged(cx, cy, cz, minX, maxX, minY, maxY, minZ, maxZ);
          }
        }
      }
    }
    if (changedAny) this._revision++;
  }

  getColumnTop(x: number, z: number): number {
    if (!(x >= 0 && z >= 0 && x < SX && z < SZ)) return -1;
    const cx = x >> 5;
    const cz = z >> 5;
    const col = (x & 31) | ((z & 31) << 5);
    for (let cy = CY_MAX; cy >= 0; cy--) {
      const c = this.chunks[((cy << 4) + cz) * 16 + cx];
      if (c === null) continue;
      for (let ly = 31; ly >= 0; ly--) if (c[col | (ly << 10)] !== AIR) return (cy << 5) | ly;
    }
    return -1;
  }

  isChunkEmpty(cx: number, cy: number, cz: number): boolean {
    if (!(cx >= 0 && cy >= 0 && cz >= 0 && cx <= CX_MAX && cy <= CY_MAX && cz <= CZ_MAX)) return true;
    return this.counts[(((cy | 0) << 4) + (cz | 0)) * 16 + (cx | 0)] === 0;
  }

  extractPadded(cx: number, cy: number, cz: number, out: Uint8Array): boolean {
    cx = Math.floor(cx);
    cy = Math.floor(cy);
    cz = Math.floor(cz);
    if (!(Math.abs(cx) < 1e6 && Math.abs(cy) < 1e6 && Math.abs(cz) < 1e6)) {
      // Pathological coordinates (NaN / huge, where shifts would overflow): no chunk data inside;
      // planes below y = 0 are BEDROCK, everything else AIR.
      if (cy < -1) out.fill(BEDROCK);
      else if (!(cy <= CHUNKS_Y)) out.fill(AIR);
      else for (let py = 0; py < P; py++) out.fill(cy * 32 - 1 + py < 0 ? BEDROCK : AIR, py * PP, py * PP + PP);
      return false;
    }
    const nb = this.nb;
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy;
      for (let dz = -1; dz <= 1; dz++) {
        const z = cz + dz;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          nb[(dy + 1) * 9 + (dz + 1) * 3 + dx + 1] =
            x >= 0 && y >= 0 && z >= 0 && x <= CX_MAX && y <= CY_MAX && z <= CZ_MAX ? this.chunks[((y << 4) + z) * 16 + x] : null;
        }
      }
    }
    const baseY = (cy << 5) - 1;
    for (let py = 0; py < P; py++) {
      const o0 = py * PP;
      const wy = baseY + py;
      if (wy < 0) {
        out.fill(BEDROCK, o0, o0 + PP);
        continue;
      }
      if (wy >= SY) {
        out.fill(AIR, o0, o0 + PP);
        continue;
      }
      const ny = py === 0 ? 0 : py === P - 1 ? 18 : 9;
      const ly = (py - 1) & 31;
      for (let pz = 0; pz < P; pz++) {
        const o = o0 + pz * P;
        const n = ny + (pz === 0 ? 0 : pz === P - 1 ? 6 : 3);
        const row = (((pz - 1) & 31) << 5) | (ly << 10);
        const left = nb[n];
        const mid = nb[n + 1];
        const right = nb[n + 2];
        out[o] = left === null ? AIR : left[row | 31];
        if (mid === null) {
          for (let k = 1; k <= 32; k++) out[o + k] = AIR;
        } else {
          for (let k = 0; k < 32; k++) out[o + 1 + k] = mid[row + k];
        }
        out[o + 33] = right === null ? AIR : right[row];
      }
    }
    if (!(cx >= 0 && cy >= 0 && cz >= 0 && cx <= CX_MAX && cy <= CY_MAX && cz <= CZ_MAX)) return false;
    return this.counts[((cy << 4) + cz) * 16 + cx] > 0;
  }

  getChunkVersion(key: number): number {
    if (!((key | 0) === key && key >= 0 && key < CHUNK_COUNT)) return 0;
    return this.versions[key];
  }

  takeDirtyChunks(): number[] {
    const n = this.dirtyCount;
    const out: number[] = [];
    const list = this.dirtyList;
    const flags = this.dirtyFlags;
    for (let i = 0; i < n; i++) {
      const k = list[i];
      out.push(k);
      flags[k] = 0;
    }
    this.dirtyCount = 0;
    return out;
  }

  markChunkDirty(cx: number, cy: number, cz: number): void {
    if (!(cx >= 0 && cy >= 0 && cz >= 0 && cx <= CX_MAX && cy <= CY_MAX && cz <= CZ_MAX)) return;
    if ((cx | 0) !== cx || (cy | 0) !== cy || (cz | 0) !== cz) return;
    this.markKey(((cy << 4) + cz) * 16 + cx);
  }

  markAllDirty(): void {
    for (let key = 0; key < CHUNK_COUNT; key++) this.markKey(key);
  }

  clear(): void {
    const chunks = this.chunks;
    for (let key = 0; key < CHUNK_COUNT; key++) {
      const c = chunks[key];
      if (c !== null) {
        chunks[key] = null;
        this.counts[key] = 0;
        if (this.cleanPool.length + this.stalePool.length < POOL_MAX) this.stalePool.push(c);
        this.markKey(key);
      }
    }
    this._revision++;
  }

  // ------------------------------------------------------------------ internals

  /** Adds a (valid) key to the dirty set and bumps its version. */
  private markKey(key: number): void {
    this.versions[key]++;
    if (this.dirtyFlags[key] === 0) {
      this.dirtyFlags[key] = 1;
      this.dirtyList[this.dirtyCount++] = key;
    }
  }

  private beginOp(): void {
    if (++this.opId > 0xffffffff) {
      this.opMark.fill(0);
      this.opId = 1;
    }
  }

  /** markKey at most once per bulk operation. */
  private markOnce(key: number): void {
    if (this.opMark[key] !== this.opId) {
      this.opMark[key] = this.opId;
      this.markKey(key);
    }
  }

  /** Dirty-marks chunk (cx,cy,cz) and the neighbours whose padded border the changed box touches. */
  private markChanged(cx: number, cy: number, cz: number, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): void {
    const dx0 = minX === 0 && cx > 0 ? -1 : 0;
    const dx1 = maxX === 31 && cx < CX_MAX ? 1 : 0;
    const dy0 = minY === 0 && cy > 0 ? -1 : 0;
    const dy1 = maxY === 31 && cy < CY_MAX ? 1 : 0;
    const dz0 = minZ === 0 && cz > 0 ? -1 : 0;
    const dz1 = maxZ === 31 && cz < CZ_MAX ? 1 : 0;
    for (let dy = dy0; dy <= dy1; dy++) {
      for (let dz = dz0; dz <= dz1; dz++) {
        const row = (((cy + dy) << 4) + cz + dz) * 16 + cx;
        for (let dx = dx0; dx <= dx1; dx++) this.markOnce(row + dx);
      }
    }
  }

  private alloc(key: number): Uint8Array {
    let a = this.cleanPool.pop();
    if (a === undefined) {
      a = this.stalePool.pop();
      if (a === undefined) a = new Uint8Array(CHUNK_VOLUME);
      else a.fill(AIR);
    }
    this.chunks[key] = a;
    this.counts[key] = 0;
    return a;
  }

  /** Releases an all-AIR chunk (count already 0). */
  private release(key: number): void {
    const a = this.chunks[key];
    this.chunks[key] = null;
    if (a !== null && this.cleanPool.length + this.stalePool.length < POOL_MAX) this.cleanPool.push(a);
  }
}
