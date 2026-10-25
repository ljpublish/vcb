/**
 * FROZEN CONTRACT — coordinate helpers shared by every module.
 * Owner: integrator. Module agents MUST NOT edit this file.
 * Worker-safe (no DOM / three imports).
 *
 * See the coordinate-system notes at the top of src/types.ts and ARCHITECTURE.md §3.
 */
import {
  BRIDGE_DECK_HEIGHT,
  CHUNK_SIZE,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  DIR_DX,
  DIR_DZ,
  MAP_TILES,
  PADDED_SIZE,
  TILE_SIZE,
  type Dir,
  type TerrainReader,
  type TileCoord,
} from '../types';

// ------------------------------------------------------------------ tiles

/** Tile index = tz * MAP_TILES + tx. */
export function tileIndex(tx: number, tz: number): number {
  return tz * MAP_TILES + tx;
}

/** Inverse of tileIndex. */
export function tileFromIndex(index: number): TileCoord {
  return { tx: index % MAP_TILES, tz: Math.floor(index / MAP_TILES) };
}

export function tileXFromIndex(index: number): number {
  return index % MAP_TILES;
}

export function tileZFromIndex(index: number): number {
  return Math.floor(index / MAP_TILES);
}

/** Is (tx,tz) inside the city grid? */
export function inMap(tx: number, tz: number): boolean {
  return tx >= 0 && tz >= 0 && tx < MAP_TILES && tz < MAP_TILES;
}

/** Tile on the outer ring of the map (roads here connect to the "region"). */
export function isEdgeTile(tx: number, tz: number): boolean {
  return tx === 0 || tz === 0 || tx === MAP_TILES - 1 || tz === MAP_TILES - 1;
}

/** Min voxel coordinate of a tile along one axis. */
export function tileToVoxel(t: number): number {
  return t * TILE_SIZE;
}

/** Tile containing a voxel/world coordinate along one axis (works for fractional world coords). */
export function voxelToTile(v: number): number {
  return Math.floor(v / TILE_SIZE);
}

/** World-space centre of a tile along one axis. */
export function tileCenter(t: number): number {
  return t * TILE_SIZE + TILE_SIZE / 2;
}

export function neighborTile(tx: number, tz: number, dir: Dir): TileCoord {
  return { tx: tx + DIR_DX[dir], tz: tz + DIR_DZ[dir] };
}

export function oppositeDir(d: Dir): Dir {
  return ((d + 2) & 3) as Dir;
}

export function rotateCW(d: Dir): Dir {
  return ((d + 1) & 3) as Dir;
}

export function rotateCCW(d: Dir): Dir {
  return ((d + 3) & 3) as Dir;
}

/** Dir for a unit step (dx,dz) between 4-neighbours, or -1 if not a unit step. */
export function dirFromDelta(dx: number, dz: number): Dir | -1 {
  if (dx === 0 && dz === -1) return 0;
  if (dx === 1 && dz === 0) return 1;
  if (dx === 0 && dz === 1) return 2;
  if (dx === -1 && dz === 0) return 3;
  return -1;
}

export function manhattan(a: TileCoord, b: TileCoord): number {
  return Math.abs(a.tx - b.tx) + Math.abs(a.tz - b.tz);
}

/** Clamp a tile coordinate into the map. */
export function clampTile(t: TileCoord): TileCoord {
  return {
    tx: Math.min(MAP_TILES - 1, Math.max(0, Math.round(t.tx))),
    tz: Math.min(MAP_TILES - 1, Math.max(0, Math.round(t.tz))),
  };
}

/** All tiles of the inclusive rectangle spanned by a and b, row-major, clipped to the map. */
export function rectTiles(a: TileCoord, b: TileCoord): TileCoord[] {
  const x0 = Math.max(0, Math.min(a.tx, b.tx));
  const x1 = Math.min(MAP_TILES - 1, Math.max(a.tx, b.tx));
  const z0 = Math.max(0, Math.min(a.tz, b.tz));
  const z1 = Math.min(MAP_TILES - 1, Math.max(a.tz, b.tz));
  const out: TileCoord[] = [];
  for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) out.push({ tx, tz });
  return out;
}

/**
 * L-shaped path from a to b (inclusive, no duplicates, 4-connected), clipped to the map.
 * Goes along the axis with the larger extent first, then the other. Ties: X first.
 * This is the default road-drag shape.
 */
export function lPathTiles(a: TileCoord, b: TileCoord): TileCoord[] {
  const out: TileCoord[] = [];
  const dx = b.tx - a.tx;
  const dz = b.tz - a.tz;
  const sx = Math.sign(dx);
  const sz = Math.sign(dz);
  let x = a.tx;
  let z = a.tz;
  const push = (px: number, pz: number): void => {
    if (inMap(px, pz)) out.push({ tx: px, tz: pz });
  };
  push(x, z);
  if (Math.abs(dx) >= Math.abs(dz)) {
    while (x !== b.tx) {
      x += sx;
      push(x, z);
    }
    while (z !== b.tz) {
      z += sz;
      push(x, z);
    }
  } else {
    while (z !== b.tz) {
      z += sz;
      push(x, z);
    }
    while (x !== b.tx) {
      x += sx;
      push(x, z);
    }
  }
  return out;
}

/** Straight path from a towards b along the dominant axis only (shift-drag). */
export function straightPathTiles(a: TileCoord, b: TileCoord): TileCoord[] {
  const dx = b.tx - a.tx;
  const dz = b.tz - a.tz;
  const end: TileCoord = Math.abs(dx) >= Math.abs(dz) ? { tx: b.tx, tz: a.tz } : { tx: a.tx, tz: b.tz };
  return lPathTiles(a, end);
}

/**
 * Height (y) of the drivable surface of a road tile: BRIDGE_DECK_HEIGHT on water, else ground height.
 * Also the y vehicles drive on.
 */
export function roadSurfaceY(terrain: TerrainReader, tx: number, tz: number): number {
  return terrain.isWater(tx, tz) ? BRIDGE_DECK_HEIGHT : terrain.getTileHeight(tx, tz);
}

// ------------------------------------------------------------------ chunks

/** Chunk key = (cy * CHUNKS_Z + cz) * CHUNKS_X + cx. Range [0, CHUNK_COUNT). */
export function chunkKey(cx: number, cy: number, cz: number): number {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/** Inverse of chunkKey. */
export function chunkCoordsFromKey(key: number, out?: ChunkCoord): ChunkCoord {
  const o = out ?? { cx: 0, cy: 0, cz: 0 };
  o.cx = key % CHUNKS_X;
  const rest = Math.floor(key / CHUNKS_X);
  o.cz = rest % CHUNKS_Z;
  o.cy = Math.floor(rest / CHUNKS_Z);
  return o;
}

export function chunkInBounds(cx: number, cy: number, cz: number): boolean {
  return cx >= 0 && cy >= 0 && cz >= 0 && cx < CHUNKS_X && cy < CHUNKS_Y && cz < CHUNKS_Z;
}

/** Index inside a chunk's CHUNK_VOLUME array for local coords (0..CHUNK_SIZE-1). */
export function chunkVoxelIndex(lx: number, ly: number, lz: number): number {
  return lx + CHUNK_SIZE * (lz + CHUNK_SIZE * ly);
}

/** Index inside a padded (PADDED_SIZE³) array, p = local + 1 (0..PADDED_SIZE-1). */
export function paddedIndex(px: number, py: number, pz: number): number {
  return px + PADDED_SIZE * (pz + PADDED_SIZE * py);
}

/** Index inside a VoxelStamp's data array. */
export function stampIndex(sx: number, sz: number, x: number, y: number, z: number): number {
  return x + sx * (z + sz * y);
}
