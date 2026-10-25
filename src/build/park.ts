/**
 * MODULE: buildings — park tiles. Owner: civic/parks thread.
 *
 * STUB (lawn only). Spec: lawn (GRASS_LIGHT / GRASS); PARK_PATH paths (2 wide, voxels 3–4) from the
 * centre to every edge in parkMask | roadMask; 1–3 trees (parts.tree), BENCH_WOOD, flower beds;
 * variants by hash2(tx, tz, seed): fountain (FOUNTAIN_STONE + WATER, push a 'fountain' emitter),
 * playground (PLAY_RED / PLAY_BLUE), STATUE, small pond. 8×8 footprint; stamp layer 0 = ground
 * surface (world y = groundHeight - 1). Emitters in stamp-local coords. Deterministic, no Math.random.
 */
import { B } from '../voxel/blocks';
import { TILE_SIZE } from '../types';
import type { GeneratedStructure } from './buildingGen';
import type { ParkSpec } from './lotGen';
import { StampBuilder } from './stamp';

export function generateParkTile(spec: ParkSpec): GeneratedStructure {
  const b = new StampBuilder(TILE_SIZE, 1, TILE_SIZE);
  b.fill(0, 0, 0, TILE_SIZE, 1, TILE_SIZE, B.GRASS_LIGHT);
  return { stamp: b.toStamp(), originY: spec.groundHeight - 1, emitters: [] };
}
