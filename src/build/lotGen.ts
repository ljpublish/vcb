/**
 * MODULE: buildings — zone lots (zoned, undeveloped tiles) and parks (module-internal API; may change).
 * Owner: buildings agent.
 *
 * STUB.
 *
 *  - Zone lot: replaces the top ground voxel (stamp y = 0 = groundHeight - 1) with LOT_RES / LOT_COM /
 *    LOT_IND, a 1-voxel LOT_*_EDGE border on edges NOT shared with a same-zone neighbour (edgeMask),
 *    and a tiny marker post at one corner. Must read clearly from far away (zones are the player's
 *    main visual feedback before buildings grow).
 *  - Park: lawn (GRASS_LIGHT / GRASS), PARK_PATH paths that connect to neighbouring park tiles and
 *    roads, 1–3 trees, benches, flower beds; variants: fountain (emits 'fountain'), playground,
 *    statue, pond. Deterministic from (tx, tz, seed).
 */
import type { RCIZone } from '../types';
import type { GeneratedStructure } from './buildingGen';

/** edgeMask: DIR_BIT set for edges that need a border (neighbour is not the same zone). */
export function generateZoneLot(zone: RCIZone, edgeMask: number, groundHeight: number, hash: number): GeneratedStructure {
  // TODO(buildings)
  return { stamp: { sx: 8, sy: 1, sz: 8, data: new Uint8Array(64).fill(255) }, originY: groundHeight - 1, emitters: [] };
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
  // TODO(buildings)
  return { stamp: { sx: 8, sy: 1, sz: 8, data: new Uint8Array(64).fill(255) }, originY: spec.groundHeight - 1, emitters: [] };
}
