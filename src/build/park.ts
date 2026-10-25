/**
 * MODULE: buildings — park tiles. Owner: civic/parks thread.
 *
 * Lawn, PARK_PATH paths that connect to neighbouring park and road tiles, 1–3 trees, benches,
 * flower beds; variants by hash: fountain (emits 'fountain'), playground, statue, pond, plaza.
 * Deterministic from (tx, tz, seed).
 */
import { hash2, hash3, Rng } from '../core/rng';
import { B, type BlockId } from '../voxel/blocks';
import { DIR_BIT, TILE_SIZE } from '../types';
import type { GeneratedStructure, LocalEmitter } from './buildingGen';
import type { ParkSpec } from './lotGen';
import { emit } from './parts';
import { leafyTree as tree } from './civic/kit';
import { StampBuilder } from './stamp';

export type ParkVariant = 'fountain' | 'playground' | 'statue' | 'pond' | 'plaza';
export const PARK_VARIANTS: readonly ParkVariant[] = ['fountain', 'playground', 'statue', 'pond', 'plaza'];

const S = TILE_SIZE;
const LEAVES: readonly BlockId[] = [B.LEAVES, B.LEAVES_DARK, B.LEAVES_LIGHT, B.LEAVES_AUTUMN, B.LEAVES_PINK];
const FLOWERS: readonly BlockId[] = [B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE];

export function parkVariantFor(tx: number, tz: number, seed: number): ParkVariant {
  return PARK_VARIANTS[hash2(tx, tz, seed ^ 0x9a4c) % PARK_VARIANTS.length];
}

export function generateParkTile(spec: ParkSpec, variant: ParkVariant = parkVariantFor(spec.tx, spec.tz, spec.seed)): GeneratedStructure {
  const s = new StampBuilder(S, 10, S);
  const rng = new Rng(hash2(spec.tx, spec.tz, spec.seed));
  const emitters: LocalEmitter[] = [];
  const plaza = variant === 'plaza';
  const conn = spec.parkMask | spec.roadMask;

  // ground: lawn checker, or paving for plazas
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      const h = hash3(spec.tx * S + x, 0, spec.tz * S + z, spec.seed);
      s.set(x, 0, z, plaza ? ((x + z) & 1 ? B.SIDEWALK : B.CONCRETE) : h % 5 === 0 ? B.GRASS : B.GRASS_LIGHT);
    }
  }

  // paths: 2-wide arms from the centre to every connected edge (a loop when nothing is connected)
  const path = B.PARK_PATH;
  if (!plaza) {
    s.fill(3, 0, 3, 5, 1, 5, path);
    if (conn & DIR_BIT[0]) s.fill(3, 0, 0, 5, 1, 3, path);
    if (conn & DIR_BIT[2]) s.fill(3, 0, 5, 5, 1, 8, path);
    if (conn & DIR_BIT[1]) s.fill(5, 0, 3, 8, 1, 5, path);
    if (conn & DIR_BIT[3]) s.fill(0, 0, 3, 3, 1, 5, path);
    if (conn === 0) {
      s.fill(1, 0, 1, 7, 1, 2, path); s.fill(1, 0, 6, 7, 1, 7, path);
      s.fill(1, 0, 1, 2, 1, 7, path); s.fill(6, 0, 1, 7, 1, 7, path);
    }
  }

  // centre feature
  switch (variant) {
    case 'fountain': fountain(s, emitters); break;
    case 'playground': playground(s, rng); break;
    case 'statue': statue(s, 2); break;
    case 'pond': pond(s, rng); break;
    case 'plaza': plazaTile(s, rng, emitters); break;
  }

  // corner trees / flower beds, kept off the paths and the feature
  const corners: [number, number][] = rng.shuffle([[1, 1], [6, 1], [1, 6], [6, 6]]);
  const nTrees = variant === 'pond' ? 1 : rng.int(1, 4);
  for (let i = 0; i < corners.length; i++) {
    const [x, z] = corners[i];
    if (!free(s, x, z)) continue;
    if (i < nTrees) {
      if (plaza) { s.fill(x - 1, 1, z - 1, x + 2, 2, z + 2, B.CONCRETE_DARK); s.set(x, 1, z, B.DIRT); }
      tree(s, x, plaza ? 2 : 1, z, rng.pick(LEAVES), rng.int(3, 5));
    } else {
      const fl = rng.pick(FLOWERS);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (free(s, x + dx, z + dz)) { s.set(x + dx, 0, z + dz, B.DIRT); s.set(x + dx, 1, z + dz, (dx + dz) & 1 ? fl : B.BUSH); }
      }
    }
  }

  // benches beside the path arms
  if (!plaza) {
    for (const [x, z, dir] of [[2, 1, 0], [5, 6, 2], [1, 5, 3], [6, 2, 1]] as const) {
      if (rng.chance(0.5) && free(s, x, z) && (conn & DIR_BIT[dir] || conn === 0)) s.set(x, 1, z, B.BENCH_WOOD);
    }
  }

  return { stamp: s.toStamp(), originY: spec.groundHeight - 1, emitters };
}

/** Lawn or paving voxel with nothing above it. */
function free(s: StampBuilder, x: number, z: number): boolean {
  const g = s.get(x, 0, z);
  return (g === B.GRASS || g === B.GRASS_LIGHT || g === B.CONCRETE || g === B.SIDEWALK) && s.get(x, 1, z) === 255;
}

function fountain(s: StampBuilder, emitters: LocalEmitter[]): void {
  s.fill(2, 0, 2, 6, 1, 6, B.FOUNTAIN_STONE);
  s.fill(2, 1, 2, 6, 2, 6, B.FOUNTAIN_STONE);
  s.fill(3, 1, 3, 5, 2, 5, B.WATER);
  s.fill(3, 1, 3, 4, 3, 4, B.FOUNTAIN_STONE);
  s.set(3, 3, 3, B.WATER);
  emit(emitters, 4, 3, 4, 'fountain', 0.8);
}

function playground(s: StampBuilder, rng: Rng): void {
  s.fill(1, 0, 1, 7, 1, 7, B.SAND);
  // swing frame
  s.fill(1, 1, 2, 2, 4, 3, B.PLAY_RED);
  s.fill(4, 1, 2, 5, 4, 3, B.PLAY_RED);
  s.fill(1, 4, 2, 5, 5, 3, B.PLAY_RED);
  // slide: tower + ramp
  const c = rng.chance(0.5) ? B.PLAY_BLUE : B.PLAY_RED;
  s.fill(5, 1, 4, 7, 3, 6, B.PLAY_BLUE);
  s.set(5, 3, 4, c); s.set(6, 3, 5, c);
  s.set(4, 2, 5, B.PLAY_BLUE); s.set(3, 1, 5, B.PLAY_BLUE);
  // sandbox edge + bench
  s.set(1, 1, 6, B.WOOD_PLANK); s.set(2, 1, 6, B.WOOD_PLANK);
}

function statue(s: StampBuilder, y0: number): void {
  s.fill(2, 0, 2, 6, 1, 6, B.PARK_PATH);
  s.fill(3, y0 - 1, 3, 5, y0, 5, B.CONCRETE);
  s.fill(3, y0, 3, 4, y0 + 3, 4, B.STATUE);
  s.set(3, y0 + 3, 3, B.STATUE);
  s.set(4, y0 + 2, 3, B.STATUE);
}

function pond(s: StampBuilder, rng: Rng): void {
  // irregular pond in the ground layer, sandy rim, reeds and a lily-pad bush
  for (let z = 1; z < 7; z++) {
    for (let x = 1; x < 7; x++) {
      const d = Math.hypot(x - 3.5, z - 3.5);
      if (d < 2.3) s.set(x, 0, z, B.WATER);
      else if (d < 3.0) s.set(x, 0, z, B.SAND);
    }
  }
  if (rng.chance(0.6)) s.set(2, 1, 5, B.HEDGE);
  s.set(5, 1, 2, B.BUSH);
}

function plazaTile(s: StampBuilder, rng: Rng, emitters: LocalEmitter[]): void {
  if (rng.chance(0.5)) fountain(s, emitters);
  else statue(s, 2);
  // lamps at two opposite corners, benches facing the centre
  for (const [x, z] of [[4, 0], [3, 7]] as const) {
    s.fill(x, 1, z, x + 1, 5, z + 1, B.METAL_POLE);
    s.set(x, 5, z, B.STREET_LAMP);
  }
  s.set(1, 1, 3, B.BENCH_WOOD); s.set(1, 1, 4, B.BENCH_WOOD);
  s.set(6, 1, 3, B.BENCH_WOOD); s.set(6, 1, 4, B.BENCH_WOOD);
}
