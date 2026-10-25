/**
 * MODULE: voxel-world — natural decoration generators (trees, bushes, flowers).
 * Owner: voxel-world agent. Module-internal API (may change).
 *
 * Decor is written into a tile COLUMN BUFFER: a TILE_SIZE × sy × TILE_SIZE voxel box laid out like
 * a VoxelStamp (index x + 8*(z + 8*y)), with y = 0 at world y = 0. The terrain fills the ground
 * layers of the buffer, calls writeDecor() and applies the buffer to the world as one stamp — the
 * same code path for generateInto() and restoreTile(), so a restored tile is bit-identical.
 *
 * Rules (ARCHITECTURE.md §4):
 *  - At most one tree per tile; EVERY decor voxel stays inside the tile's own 8×8 footprint (the
 *    writer clips x/z to [0, 8)), from y = groundY up to groundY + DECOR_MAX_HEIGHT (exclusive).
 *    Trunks stand near local (3..4, 3..4), canopies have radius ≤ 3.
 *  - Deterministic: all variation comes from the per-tile `hash` (seeded Rng + hash3), never
 *    Math.random.
 *
 * Kinds: oak (round LEAVES / LEAVES_DARK / LEAVES_LIGHT canopy), pine (layered PINE cone, snowy
 * tips at altitude), birch (slim white trunk, light canopy), autumn (orange / yellow canopy),
 * blossom (pink cherry canopy + fallen petals), bush (BUSH clumps, sometimes with berries),
 * flowers (FLOWER_* single voxels at y = groundY).
 */
import { TILE_SIZE } from '../types';
import { Rng, hash3 } from '../core/rng';
import { B, type BlockId } from './blocks';

export type DecorKind = 'none' | 'oak' | 'pine' | 'birch' | 'autumn' | 'blossom' | 'bush' | 'flowers';

/** Numeric decor codes (stored per tile in a Uint8Array). */
export const DECOR_NONE = 0;
export const DECOR_OAK = 1;
export const DECOR_PINE = 2;
export const DECOR_BIRCH = 3;
export const DECOR_AUTUMN = 4;
export const DECOR_BLOSSOM = 5;
export const DECOR_BUSH = 6;
export const DECOR_FLOWERS = 7;

/** Decor code → kind name. */
export const DECOR_KIND_NAMES: readonly DecorKind[] = ['none', 'oak', 'pine', 'birch', 'autumn', 'blossom', 'bush', 'flowers'];

/** Decor voxels occupy y ∈ [groundY, groundY + DECOR_MAX_HEIGHT). */
export const DECOR_MAX_HEIGHT = 14;

export function decorKindName(code: number): DecorKind {
  return DECOR_KIND_NAMES[code] ?? 'none';
}

const T = TILE_SIZE;
const T2 = T * T;

// ------------------------------------------------------------------ clipped writer (module state)

let wBuf: Uint8Array = new Uint8Array(0);
let wY0 = 0;
let wY1 = 0;
let wTop = 0;
const rng = new Rng(1);

function put(x: number, y: number, z: number, id: BlockId): void {
  if (x < 0 || z < 0 || x >= T || z >= T || y < wY0 || y >= wY1) return;
  wBuf[x + T * (z + T * y)] = id;
  if (y >= wTop) wTop = y + 1;
}

function get(x: number, y: number, z: number): BlockId {
  if (x < 0 || z < 0 || x >= T || z >= T || y < wY0 || y >= wY1) return -1;
  return wBuf[x + T * (z + T * y)];
}

/**
 * Writes the decor of one tile into `buf` (TILE_SIZE × sy × TILE_SIZE column buffer, index
 * x + 8*(z + 8*y)). Cells in y ∈ [groundY, groundY + DECOR_MAX_HEIGHT) must be AIR beforehand.
 * `snowy` puts snow on pine tips (high altitude). Returns the exclusive top y of everything written
 * (groundY when nothing was written).
 */
export function writeDecor(buf: Uint8Array, code: number, groundY: number, hash: number, snowy = false): number {
  const sy = Math.floor(buf.length / T2);
  wBuf = buf;
  wY0 = Math.max(0, groundY | 0);
  wY1 = Math.min(sy, wY0 + DECOR_MAX_HEIGHT);
  wTop = wY0;
  if (wY1 <= wY0) return wY0;
  rng.state = (hash ^ 0x2545f491) >>> 0;
  const h = wY0;
  switch (code) {
    case DECOR_OAK:
      oak(h, hash);
      break;
    case DECOR_PINE:
      pine(h, hash, snowy);
      break;
    case DECOR_BIRCH:
      birch(h, hash);
      break;
    case DECOR_AUTUMN:
      autumn(h, hash);
      break;
    case DECOR_BLOSSOM:
      blossom(h, hash);
      break;
    case DECOR_BUSH:
      bushes(h, hash);
      break;
    case DECOR_FLOWERS:
      flowers(h);
      break;
    default:
      break;
  }
  const top = wTop;
  wBuf = EMPTY;
  return top;
}

const EMPTY = new Uint8Array(0);

// ------------------------------------------------------------------ shapes

/** Trunk column position near the tile centre: local 3 or 4 on each axis. */
function trunkPos(): number {
  return 3 + (rng.next() < 0.5 ? 0 : 1);
}

function trunk(x: number, z: number, y0: number, y1: number, id: BlockId): void {
  for (let y = y0; y < y1; y++) put(x, y, z, id);
}

/**
 * Ellipsoid canopy centred on the trunk column (tx, tz) at height cy (float, voxel units).
 * rx ≤ 3.2 keeps |dx| ≤ 3. Outer-shell voxels are randomly dropped (`rough` = 0..255 drop chance)
 * for a ragged silhouette; upper voxels use `light`, lower ones `dark`.
 */
function canopy(tx: number, tz: number, cy: number, rx: number, ry: number, main: BlockId, light: BlockId, dark: BlockId, hash: number, rough: number, lightOdds = 3): void {
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const ey = (dy * dy) / ry2;
    if (ey > 1) continue;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const e = (dx * dx + dz * dz) / rx2 + ey;
        if (e > 1) continue;
        const x = tx + dx;
        const z = tz + dz;
        const hv = hash3(x, y, z, hash);
        if (e > 0.58 && (hv & 255) < rough) continue;
        let id = main;
        if (dy > ry * 0.28 && ((hv >>> 8) & 3) < lightOdds) id = light;
        else if (dy < -ry * 0.3 && ((hv >>> 11) & 1) === 0) id = dark;
        put(x, y, z, id);
      }
    }
  }
}

function roundTree(h: number, hash: number, main: BlockId, light: BlockId, dark: BlockId, flat: boolean, lightOdds = 3): void {
  const tx = trunkPos();
  const tz = trunkPos();
  const trunkH = 2 + rng.int(0, 3); // canopy bottom ≥ 2 above ground
  const ry = flat ? rng.range(1.55, 2.05) : rng.range(1.9, 2.6);
  const rx = flat ? rng.range(2.7, 3.2) : rng.range(2.35, 3.15);
  const cy = h + trunkH + ry;
  canopy(tx, tz, cy, rx, ry, main, light, dark, hash, 70, lightOdds);
  trunk(tx, tz, h, Math.floor(cy) + 1, B.WOOD);
  // A low side branch with a small leaf tuft on bigger trees.
  if (!flat && trunkH >= 3 && rng.chance(0.5)) {
    const dir = rng.int(0, 4);
    const bx = tx + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
    const bz = tz + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
    const by = h + trunkH - 1;
    put(bx, by, bz, B.WOOD);
    put(bx + (bx - tx), by + 1, bz + (bz - tz), main);
  }
}

function oak(h: number, hash: number): void {
  if (rng.chance(0.35)) roundTree(h, hash, B.LEAVES_DARK, B.LEAVES, B.LEAVES_DARK, false);
  else roundTree(h, hash, B.LEAVES, B.LEAVES_LIGHT, B.LEAVES_DARK, false);
}

function autumn(h: number, hash: number): void {
  // Orange canopy with yellow highlights, or orange with red lower leaves (closest palette reds).
  if (rng.chance(0.55)) roundTree(h, hash, B.LEAVES_AUTUMN, B.FLOWER_YELLOW, B.LEAVES_AUTUMN, false, 1);
  else roundTree(h, hash, B.LEAVES_AUTUMN, B.LEAVES_AUTUMN, B.ROOF_RED, false);
}

function blossom(h: number, hash: number): void {
  roundTree(h, hash, B.LEAVES_PINK, B.FLOWER_WHITE, B.LEAVES_PINK, true, 1);
  // Fallen petals on the ground (single voxels at y = h, away from the trunk).
  const n = rng.int(2, 6);
  for (let i = 0; i < n; i++) {
    const x = rng.int(0, T);
    const z = rng.int(0, T);
    if (get(x, h, z) === B.AIR) put(x, h, z, B.LEAVES_PINK);
  }
}

function birch(h: number, hash: number): void {
  const tx = trunkPos();
  const tz = trunkPos();
  const trunkH = 5 + rng.int(0, 3);
  const ry = rng.range(2.3, 3.0);
  const rx = rng.range(1.6, 2.25);
  const cy = h + trunkH + 0.5;
  canopy(tx, tz, cy, rx, ry, B.LEAVES_LIGHT, B.LEAVES_LIGHT, B.LEAVES, hash, 60, 2);
  const top = Math.floor(cy) + 1;
  for (let y = h; y < top; y++) {
    const hv = hash3(tx, y, tz, hash ^ 0x6b1d);
    put(tx, y, tz, y > h && (hv & 3) === 0 ? B.WOOD_DARK : B.FENCE_WHITE);
  }
}

function pine(h: number, hash: number, snowy: boolean): void {
  const tx = trunkPos();
  const tz = trunkPos();
  const bare = 1 + rng.int(0, 2); // visible trunk below the foliage (1..2)
  const layers = 7 + rng.int(0, 5); // foliage layers (7..11)
  const maxR = layers >= 9 ? rng.range(2.6, 3.2) : rng.range(2.1, 2.7);
  const phase = rng.int(0, 3);
  const y0 = h + bare;
  for (let i = 0; i < layers; i++) {
    const f = 1 - i / layers;
    let r = maxR * f + 0.6 - ((i + phase) % 3) * 0.65;
    if (i >= layers - 2) r = i === layers - 1 ? 0 : Math.min(r, 0.9);
    if (r < 0.5) r = 0.5;
    else if (r > 3.1) r = 3.1;
    const r2 = r * r + 0.3;
    const y = y0 + i;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dz * dz <= r2) put(tx + dx, y, tz + dz, B.PINE);
      }
    }
  }
  put(tx, y0 + layers, tz, B.PINE);
  trunk(tx, tz, h, y0 + layers - 2, B.WOOD);
  if (snowy) {
    // Snow on the exposed top of each foliage column.
    for (let z = 0; z < T; z++) {
      for (let x = 0; x < T; x++) {
        for (let y = wY1 - 1; y >= y0; y--) {
          const v = get(x, y, z);
          if (v === B.AIR) continue;
          if (v === B.PINE && (hash3(x, y, z, hash ^ 0x5a0f) & 3) !== 0) put(x, y, z, B.SNOW);
          break;
        }
      }
    }
  }
}

function bushes(h: number, hash: number): void {
  const count = 1 + rng.int(0, 3);
  const berries = rng.chance(0.3);
  for (let i = 0; i < count; i++) {
    const bx = 1 + rng.int(0, 6);
    const bz = 1 + rng.int(0, 6);
    const big = rng.chance(0.45);
    put(bx, h, bz, B.BUSH);
    if (big) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const corner = dx !== 0 && dz !== 0;
          const hv = hash3(bx + dx, h, bz + dz, hash);
          if (corner && (hv & 3) !== 0) continue;
          put(bx + dx, h, bz + dz, B.BUSH);
        }
      }
      put(bx, h + 1, bz, B.BUSH);
      if (rng.chance(0.5)) put(bx + (rng.chance(0.5) ? 1 : -1), h + 1, bz, B.BUSH);
    } else if (rng.chance(0.5)) {
      put(bx + (rng.chance(0.5) ? 1 : -1), h, bz, B.BUSH);
    }
    if (berries) {
      const ox = rng.int(-1, 2);
      const oz = rng.int(-1, 2);
      const y = big ? h + 1 : h;
      if (get(bx + ox, y, bz + oz) === B.BUSH) put(bx + ox, y, bz + oz, B.FLOWER_RED);
    }
  }
}

const FLOWER_COLORS: readonly BlockId[] = [B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE];

function flowers(h: number): void {
  const primary = FLOWER_COLORS[rng.int(0, 4)];
  const secondary = FLOWER_COLORS[rng.int(0, 4)];
  const count = 4 + rng.int(0, 7);
  let placed = 0;
  for (let i = 0; i < count * 3 && placed < count; i++) {
    const x = rng.int(0, T);
    const z = rng.int(0, T);
    if (get(x, h, z) !== B.AIR) continue;
    put(x, h, z, rng.next() < 0.7 ? primary : secondary);
    placed++;
  }
  if (placed === 0) put(3, h, 3, primary);
  if (rng.chance(0.25)) {
    const x = rng.int(1, T - 1);
    const z = rng.int(1, T - 1);
    if (get(x, h, z) === B.AIR) put(x, h, z, B.BUSH);
  }
}
