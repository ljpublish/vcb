/**
 * MODULE: input — tile highlight / ghost preview / grid / data overlays (module-internal API; may change).
 * Owner: input agent.
 *
 * STUB.
 *
 * Intended:
 *  - TileHighlighter: one InstancedMesh of thin boxes (TILE_SIZE × 0.25 × TILE_SIZE, slightly
 *    inset) floating ~0.06 above each tile's surface, per-instance colour, MeshBasicMaterial
 *    transparent (opacity ~0.45), depthWrite false, polygonOffset to avoid z-fighting; grows its
 *    capacity on demand (≥ MAX_ACTION_TILES). Optional animated pulse via sharedUniforms.uTime.
 *    For buildings/zones on hover, also show a crisp outline (EdgesGeometry / line loop).
 *  - GridOverlay: subtle tile grid lines around the cursor (fade with distance, radius ~12 tiles),
 *    visible while a build tool is active or when gridVisible.
 *  - DataOverlay: per-tile heat colours (green→yellow→red) for landValue / pollution / roadAccess,
 *    refreshed ≤ 2×/s while active, using one InstancedMesh over all land tiles.
 */
import * as THREE from 'three';
import type { OverlayMode, TerrainReader, TileCoord } from '../types';
import type { CityReader } from '../types';

export class TileHighlighter {
  readonly object = new THREE.Group();
  constructor(parent: THREE.Object3D) {
    parent.add(this.object);
  }
  /** Show the given tiles with per-tile colours (0xRRGGBB). */
  show(tiles: readonly TileCoord[], colors: readonly number[], terrain: TerrainReader): void {
    // TODO(input)
  }
  clear(): void {
    // TODO(input)
  }
  dispose(): void {
    this.object.removeFromParent();
  }
}

export class GridOverlay {
  readonly object = new THREE.Group();
  constructor(parent: THREE.Object3D) {
    parent.add(this.object);
  }
  update(center: TileCoord | null, visible: boolean, terrain: TerrainReader): void {
    // TODO(input)
  }
  dispose(): void {
    this.object.removeFromParent();
  }
}

export class DataOverlay {
  readonly object = new THREE.Group();
  constructor(parent: THREE.Object3D) {
    parent.add(this.object);
  }
  update(mode: OverlayMode, city: CityReader, terrain: TerrainReader, dt: number): void {
    // TODO(input)
  }
  dispose(): void {
    this.object.removeFromParent();
  }
}
