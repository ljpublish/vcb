/**
 * MODULE: buildings — zone lots (zoned, undeveloped tiles) and parks (module-internal API).
 * Owner: buildings framework (zone lots). Park looks live in park.ts (civic/parks owner).
 *
 *  - Zone lot: replaces the top ground voxel (stamp y = 0 = groundHeight - 1) with LOT_RES / LOT_COM /
 *    LOT_IND, a 1-voxel LOT_*_EDGE border on edges NOT shared with a same-zone neighbour (edgeMask),
 *    and a tiny marker post at one corner. Must read clearly from far away.
 *  - Park: see park.ts. Deterministic from (tx, tz, seed).
 */
import { B, type BlockId } from '../voxel/blocks';
import { DIR_BIT, DIR_E, DIR_N, DIR_S, DIR_W, TILE_SIZE, type RCIZone } from '../types';
import type { GeneratedStructure } from './buildingGen';
import { generateParkTile } from './park';
import { StampBuilder } from './stamp';

const LOT: Record<RCIZone, [BlockId, BlockId]> = {
  1: [B.LOT_RES, B.LOT_RES_EDGE],
  2: [B.LOT_COM, B.LOT_COM_EDGE],
  3: [B.LOT_IND, B.LOT_IND_EDGE],
};

/** edgeMask: DIR_BIT set for edges that need a border (neighbour is not the same zone). */
export function generateZoneLot(zone: RCIZone, edgeMask: number, groundHeight: number, hash: number): GeneratedStructure {
  const T = TILE_SIZE;
  const [fillId, edgeId] = LOT[zone] ?? LOT[1];
  const b = new StampBuilder(T, 3, T);
  b.fill(0, 0, 0, T, 1, T, fillId);
  if (edgeMask & DIR_BIT[DIR_N]) b.fill(0, 0, 0, T, 1, 1, edgeId);
  if (edgeMask & DIR_BIT[DIR_S]) b.fill(0, 0, T - 1, T, 1, T, edgeId);
  if (edgeMask & DIR_BIT[DIR_W]) b.fill(0, 0, 0, 1, 1, T, edgeId);
  if (edgeMask & DIR_BIT[DIR_E]) b.fill(T - 1, 0, 0, T, 1, T, edgeId);
  // Marker post on a corner that has a border (so posts outline the zone's outer corners).
  const corners: Array<[number, number, number]> = [
    [1, 1, DIR_BIT[DIR_N] | DIR_BIT[DIR_W]],
    [T - 2, 1, DIR_BIT[DIR_N] | DIR_BIT[DIR_E]],
    [1, T - 2, DIR_BIT[DIR_S] | DIR_BIT[DIR_W]],
    [T - 2, T - 2, DIR_BIT[DIR_S] | DIR_BIT[DIR_E]],
  ];
  const start = (hash >>> 0) & 3;
  for (let i = 0; i < 4; i++) {
    const [x, z, need] = corners[(start + i) & 3];
    if ((edgeMask & need) === need || (i === 3 && edgeMask !== 0)) {
      b.set(x, 1, z, B.METAL_POLE);
      b.set(x, 2, z, edgeId);
      break;
    }
  }
  return { stamp: b.toStamp(), originY: groundHeight - 1, emitters: [] };
}

export interface ParkSpec {
  tx: number;
  tz: number;
  groundHeight: number;
  seed: number;
  /** DIR_BIT mask of neighbouring park tiles. */
  parkMask: number;
  /** DIR_BIT mask of neighbouring road tiles. */
  roadMask: number;
}

export function generatePark(spec: ParkSpec): GeneratedStructure {
  return generateParkTile(spec);
}
