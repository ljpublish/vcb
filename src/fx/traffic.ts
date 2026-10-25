/**
 * MODULE: atmosphere — cosmetic traffic: small voxel-style cars driving on the road network.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 * STUB.
 *
 * Intended:
 *  - Road graph from CityReader: nodes = road tiles, edges = DIR_BIT mask bits. Rebuild when dirty.
 *  - Cars: InstancedMesh(s) of a tiny merged box model (body 2 wide × 1.4 tall × 3.6 long voxels,
 *    cabin, wheels optional) with per-instance colours from a cheerful palette (+ buses/trucks near
 *    C/I). Headlight/taillight boxes on a second emissive InstancedMesh (or vertex-colour trick)
 *    that glows with nightFactor.
 *  - Movement: each car follows a path tile→tile, choosing a random allowed exit at intersections
 *    (no U-turns unless dead end). Drive on the RIGHT: lane centre = tile centre line offset by
 *    ROAD_LANE_OFFSET to the right of the travel direction; y = roadSurfaceY(terrain, tx, tz) (+ body
 *    offset), smooth quarter-circle turns at corners, ease y across terrace steps / bridges.
 *    Speed ~6–9 voxels/s × sim speed factor. Simple spacing: slow down when another car is ahead in
 *    the same lane on the same tile.
 *  - Population of cars: target = min(MAX_CARS (400), roadTiles × 0.35, 3 + (population + jobs) / 25);
 *    spawn/despawn gradually (fade/scale), only on tiles adjacent to developed zones or edge tiles.
 */
import * as THREE from 'three';
import type { CityReader, TerrainReader } from '../types';

export class TrafficSystem {
  readonly object = new THREE.Group();

  constructor(parent: THREE.Object3D, city: CityReader, terrain: TerrainReader) {
    parent.add(this.object);
  }

  markNetworkDirty(): void {
    // TODO(atmosphere)
  }

  /** speedFactor: 0 = frozen; nightFactor: 0..1 for lights. */
  update(dt: number, speedFactor: number, nightFactor: number): void {
    // TODO(atmosphere)
  }

  reset(): void {
    // TODO(atmosphere)
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}
