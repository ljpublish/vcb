/**
 * MODULE: input — screen → world/tile picking (module-internal API; the input agent may change it,
 * other modules do not import it).
 * Owner: input agent.
 *
 * STUB: pickTile intersects a flat plane at BASE_GROUND_HEIGHT.
 *
 * Intended: pickTile marches the camera ray through the TILE grid (2D DDA over tiles, from the
 * ray's entry into the map AABB) and returns the first tile whose top surface
 * (terrain.getSurfaceHeight; road-on-water tiles: BRIDGE_DECK_HEIGHT) the ray crosses — i.e. a
 * heightfield of flat-topped tile columns, also hitting terrace side walls. Structures are ignored
 * on purpose (picking the ground under a tower is standard city-builder behaviour).
 * pickPlane intersects a horizontal plane (used for stable drags and camera panning).
 */
import * as THREE from 'three';
import { BASE_GROUND_HEIGHT, type TerrainReader, type TileCoord } from '../types';
import { inMap, voxelToTile } from '../core/coords';

export interface TilePick extends TileCoord {
  /** World-space hit point. */
  point: THREE.Vector3;
  /** Surface y of the picked tile. */
  surfaceY: number;
}

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();

/** Ray from the camera through the client-space pointer position. */
export function screenRay(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number, out = new THREE.Ray()): THREE.Ray {
  const r = dom.getBoundingClientRect();
  _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  _raycaster.setFromCamera(_ndc, camera);
  return out.copy(_raycaster.ray);
}

/** Intersection of the pointer ray with the plane y = planeY, or null if parallel/behind. */
export function pickPlane(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number, planeY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const ray = screenRay(camera, dom, clientX, clientY);
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (t < 0) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

/** Tile under the pointer (terrain heightfield), or null when pointing off the map / at the sky. */
export function pickTile(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number, terrain: TerrainReader): TilePick | null {
  // TODO(input): heightfield DDA
  const p = pickPlane(camera, dom, clientX, clientY, BASE_GROUND_HEIGHT);
  if (!p) return null;
  const tx = voxelToTile(p.x);
  const tz = voxelToTile(p.z);
  if (!inMap(tx, tz)) return null;
  return { tx, tz, point: p, surfaceY: BASE_GROUND_HEIGHT };
}
