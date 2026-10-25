/**
 * MODULE: buildings — small drawing helpers shared by the civic generators (module-internal; may change).
 * Owner: civic/parks thread.
 */
import { hash3 } from '../../core/rng';
import { B, type BlockId } from '../../voxel/blocks';
import type { StampBuilder } from '../stamp';

/**
 * Window rows on the four walls of the box [x0,x1)×[z0,z1): one row per 3-voxel floor starting at y0
 * (window at floor + 1), every `step` voxels, corners kept solid. ~50% lit, hashed per window.
 */
export function windows(
  s: StampBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, floors: number,
  seed: number, step = 2, glass: BlockId = B.WINDOW, lit: BlockId = B.WINDOW_LIT,
): void {
  for (let f = 0; f < floors; f++) {
    const y = y0 + f * 3 + 1;
    for (let x = x0 + 1; x < x1 - 1; x++) {
      if ((x - x0) % step !== 1 % step) continue;
      s.set(x, y, z0, hash3(x, y, z0, seed) & 1 ? lit : glass);
      s.set(x, y, z1 - 1, hash3(x, y, z1, seed) & 1 ? lit : glass);
    }
    for (let z = z0 + 1; z < z1 - 1; z++) {
      if ((z - z0) % step !== 1 % step) continue;
      s.set(x0, y, z, hash3(x0, y, z, seed) & 1 ? lit : glass);
      s.set(x1 - 1, y, z, hash3(x1, y, z, seed) & 1 ? lit : glass);
    }
  }
}

/** Small voxel tree with its trunk base at (x, y, z). */
export function leafyTree(s: StampBuilder, x: number, y: number, z: number, leaves: BlockId, h = 3): void {
  s.fill(x, y, z, x + 1, y + h, z + 1, B.WOOD);
  s.fill(x - 1, y + h - 1, z - 1, x + 2, y + h + 1, z + 2, leaves);
  s.set(x, y + h + 1, z, leaves);
}

/** Flag pole with a 2×2 flag at the top. */
export function flag(s: StampBuilder, x: number, y: number, z: number, h: number, cloth: BlockId): void {
  s.fill(x, y, z, x + 1, y + h, z + 1, B.METAL_POLE);
  s.fill(x + 1, y + h - 2, z, x + 3, y + h, z + 1, cloth);
}
