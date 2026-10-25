/**
 * MODULE: buildings — construction-site and abandoned-building transforms (module-internal API).
 * Owner: buildings framework. Applied by buildingGen.ts AFTER the zone generator, BEFORE rotation,
 * so zone generators only ever author the finished Active look.
 */
import type { Rng } from '../core/rng';
import { B, STAMP_KEEP } from '../voxel/blocks';
import { CONSTRUCTION_STAGES } from '../types';
import type { BuildingSpec } from './buildingGen';
import { rand3 } from './parts';
import { StampBuilder } from './stamp';

const KEEP = STAMP_KEEP;

/**
 * Construction site for `spec` at spec.stage, derived from the finished building `finished`:
 * dirt/gravel lot, FOUNDATION slab under the building's columns, the real structure growing up to
 * ~70% of the current scaffold height (windows unlit), a SCAFFOLD frame around it up to
 * (stage+1)/(CONSTRUCTION_STAGES+1) of the final height, and a CRANE_YELLOW crane for level ≥ 2.
 */
export function generateConstruction(spec: BuildingSpec, finished: StampBuilder, rng: Rng): StampBuilder {
  const S = finished.sx;
  const finalH = Math.max(3, finished.usedHeight());
  const stage = Math.max(0, Math.min(CONSTRUCTION_STAGES - 1, spec.stage | 0));
  const scaffoldTop = Math.max(3, Math.round((finalH * (stage + 1)) / (CONSTRUCTION_STAGES + 1)));
  const wallTop = stage === 0 ? 2 : Math.max(2, Math.round(scaffoldTop * 0.7));
  const craneTop = spec.level >= 2 ? Math.min(finished.sy - 1, scaffoldTop + 8) : 0;
  const out = new StampBuilder(S, Math.max(scaffoldTop + 2, craneTop + 2), S);

  // Which columns does the finished building occupy (above the ground detail layer)?
  const mask = new Uint8Array(S * S);
  let minX = S, minZ = S, maxX = -1, maxZ = -1;
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      for (let y = 2; y < Math.min(finished.sy, 12); y++) {
        const v = finished.get(x, y, z);
        if (v !== KEEP && v !== B.AIR && !isPlant(v)) {
          mask[x + S * z] = 1;
          if (x < minX) minX = x;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (z > maxZ) maxZ = z;
          break;
        }
      }
    }
  }
  if (maxX < 0) { minX = 1; minZ = 1; maxX = S - 2; maxZ = S - 2; for (let z = 1; z < S - 1; z++) for (let x = 1; x < S - 1; x++) mask[x + S * z] = 1; }

  // Ground: dirt with gravel patches; foundation under the building.
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      out.set(x, 0, z, rand3(x, 0, z, spec.variant) < 0.3 ? B.GRAVEL : B.DIRT);
      if (mask[x + S * z]) out.set(x, 1, z, B.FOUNDATION);
    }
  }

  // Partial structure.
  for (let y = 2; y < wallTop; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (!mask[x + S * z]) continue;
        let v = finished.get(x, y, z);
        if (v === KEEP || v === B.AIR) continue;
        if (v === B.WINDOW_LIT || v === B.GLASS_LIT) v = B.GLASS_DARK;
        else if (v >= B.SIGN_YELLOW && v <= B.SIGN_WHITE) v = B.CONCRETE;
        out.set(x, y, z, v);
      }
    }
  }

  // Scaffold frame one voxel outside the building's bounding box (clipped to the footprint).
  const sx0 = Math.max(0, minX - 1), sx1 = Math.min(S - 1, maxX + 1);
  const sz0 = Math.max(0, minZ - 1), sz1 = Math.min(S - 1, maxZ + 1);
  for (let y = 2; y <= scaffoldTop; y++) {
    const deck = (y - 2) % 6 === 5 || y === scaffoldTop;
    for (let z = sz0; z <= sz1; z++) {
      for (let x = sx0; x <= sx1; x++) {
        const edge = x === sx0 || x === sx1 || z === sz0 || z === sz1;
        if (!edge) continue;
        const post = (x - sx0) % 4 === 0 && (z - sz0) % 4 === 0;
        if (post || deck || ((x === sx0 || x === sx1) && (z === sz0 || z === sz1))) {
          if (out.get(x, y, z) === KEEP) out.set(x, y, z, B.SCAFFOLD);
        }
      }
    }
  }
  // Open top floor slab at the current work level.
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) if (mask[x + S * z] && wallTop > 2) out.set(x, wallTop, z, B.CONCRETE);

  // Material piles on free ground.
  for (let i = 0; i < 3; i++) {
    const x = rng.int(0, S), z = rng.int(0, S);
    if (!mask[x + S * z] && out.get(x, 1, z) === KEEP) out.set(x, 1, z, i === 0 ? B.WOOD_PLANK : B.CRATE);
  }

  // Tower crane: mast at a free corner-ish column, jib across the site.
  if (craneTop > 0) {
    const cx = minX > 0 ? 0 : maxX < S - 1 ? S - 1 : 0;
    const cz = maxZ < S - 1 ? S - 1 : 0;
    out.fill(cx, 1, cz, cx + 1, craneTop, cz + 1, B.CRANE_YELLOW);
    const dirX = cx === 0 ? 1 : -1;
    const jibLen = Math.min(S - 1, Math.round(S * 0.85));
    for (let i = -2; i <= jibLen; i++) out.set(cx + dirX * i, craneTop, cz, B.CRANE_YELLOW);
    out.set(cx - dirX * 2, craneTop - 1, cz, B.CONCRETE_DARK); // counterweight
    const hookX = cx + dirX * Math.round(jibLen * 0.6);
    for (let y = scaffoldTop + 2; y < craneTop; y++) out.set(hookX, y, cz, B.METAL_POLE);
    out.set(hookX, scaffoldTop + 1, cz, B.CRATE);
  }
  return out;
}

function isPlant(v: number): boolean {
  return (v >= B.WOOD && v <= B.FLOWER_PURPLE) || v === B.FENCE_WHITE;
}

/**
 * In-place: derelict version of a finished building. Lit windows/glass go dark or get boarded,
 * signs are boarded, some wall voxels are boarded, flowers die, rubble piles up in the yard.
 */
export function applyAbandoned(stamp: StampBuilder, rng: Rng): void {
  const seed = rng.nextU32();
  const { sx, sz, sy, data } = stamp;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = x + sx * (z + sz * y);
        const v = data[i];
        if (v === KEEP) continue;
        const r = rand3(x, y, z, seed);
        if (v === B.WINDOW_LIT || v === B.WINDOW) data[i] = r < 0.35 ? B.BOARDED : B.GLASS_DARK;
        else if (v === B.GLASS_LIT || v === B.GLASS_BLUE || v === B.GLASS_TEAL) data[i] = r < 0.15 ? B.BOARDED : B.GLASS_DARK;
        else if (v >= B.SIGN_YELLOW && v <= B.SIGN_WHITE) data[i] = B.BOARDED;
        else if (v === B.STREET_LAMP || v === B.BEACON_RED) data[i] = B.METAL_POLE;
        else if (v === B.DOOR || v === B.DOOR_GLASS) data[i] = B.BOARDED;
        else if (v >= B.FLOWER_RED && v <= B.FLOWER_PURPLE) data[i] = y <= 1 ? (r < 0.5 ? B.RUBBLE : B.AIR) : v;
        else if (y === 0 && (v === B.GRASS || v === B.GRASS_LIGHT)) data[i] = r < 0.5 ? B.GRASS_DARK : B.DIRT;
        else if (y > 0 && isWall(v) && r < 0.06) data[i] = B.BOARDED;
      }
    }
  }
  // Rubble piles on free ground.
  for (let k = 0; k < 4; k++) {
    const x = rng.int(0, sx), z = rng.int(0, sz);
    const above = stamp.get(x, 1, z);
    if (above === KEEP || above === B.AIR) stamp.set(x, 1, z, B.RUBBLE);
  }
}

function isWall(v: number): boolean {
  return (v >= B.BRICK_RED && v <= B.WOOD_DARK) || (v >= B.COM_CONCRETE && v <= B.COM_MARBLE) || (v >= B.METAL_SHEET && v <= B.METAL_GREEN);
}
