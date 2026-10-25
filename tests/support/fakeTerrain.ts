/** A flat, dry TerrainReader for pure-logic tests (no voxels, no noise). */
import { B } from '../../src/voxel/blocks';
import { BASE_GROUND_HEIGHT, MAP_TILES, WATER_LEVEL, type TerrainReader } from '../../src/types';

export function flatTerrain(seed = 1, height = BASE_GROUND_HEIGHT): TerrainReader {
  return {
    seed,
    mapTiles: MAP_TILES,
    getTileHeight: () => height,
    getSurfaceHeight: () => Math.max(height, WATER_LEVEL),
    isWater: () => false,
    hasNaturalDecor: () => false,
    getGroundBlock: () => B.GRASS,
  };
}
