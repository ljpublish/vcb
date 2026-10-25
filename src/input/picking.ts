/**
 * MODULE: input — screen → world/tile picking (module-internal API; the input agent may change it,
 * other modules do not import it).
 * Owner: input agent.
 *
 * pickTile marches the camera ray through the TILE grid (2D DDA over tiles, from the ray's entry
 * into the map AABB) and returns the first tile whose top surface the ray crosses — a heightfield
 * of flat-topped tile columns, so terrace side walls are hit too. The top is
 * terrain.getSurfaceHeight unless the caller passes a height function (road-on-water tiles sit at
 * BRIDGE_DECK_HEIGHT; only the tool controller knows where roads are). Structures are ignored on
 * purpose (picking the ground under a tower is standard city-builder behaviour).
 * pickPlane intersects a horizontal plane (used for stable drags and camera panning).
 *
 * No allocations per call: results live in module-level scratch objects unless `out` is given, so
 * copy what you need before the next call.
 */
import * as THREE from 'three';
import { MAP_TILES, MAX_GROUND_HEIGHT, TILE_SIZE, type TerrainReader, type TileCoord } from '../types';

export interface TilePick extends TileCoord {
  /** World-space hit point. */
  point: THREE.Vector3;
  /** Surface y of the picked tile. */
  surfaceY: number;
}

/** Top height of a tile column used by pickTile. */
export type TileHeightFn = (tx: number, tz: number) => number;

const MAP_EXTENT = MAP_TILES * TILE_SIZE;
/** Top of the picking AABB: nothing pickable is higher than the highest hill. */
const PICK_MAX_Y = MAX_GROUND_HEIGHT + 1;
/** Plane hits further than this along the ray are treated as "sky" (avoids horizon jitter). */
const MAX_PLANE_DIST = 6000;

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _ray = new THREE.Ray();
const _plane = new THREE.Vector3();
const _pick: TilePick = { tx: 0, tz: 0, point: new THREE.Vector3(), surfaceY: 0 };

/** Ray from the camera through the client-space pointer position (reused object unless `out`). */
export function screenRay(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number, out: THREE.Ray = _ray): THREE.Ray {
  const r = dom.getBoundingClientRect();
  const w = r.width || 1;
  const h = r.height || 1;
  _ndc.set(((clientX - r.left) / w) * 2 - 1, -((clientY - r.top) / h) * 2 + 1);
  _raycaster.setFromCamera(_ndc, camera);
  return out.copy(_raycaster.ray);
}

/**
 * Intersection of the pointer ray with the plane y = planeY, or null if parallel / behind / near
 * the horizon. Unlike pickTile this does NOT reject points outside the map (camera panning and drag
 * clamping need them).
 */
export function pickPlane(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number, planeY: number, out: THREE.Vector3 = _plane): THREE.Vector3 | null {
  const ray = screenRay(camera, dom, clientX, clientY);
  return rayPlane(ray, planeY, out);
}

export function rayPlane(ray: THREE.Ray, planeY: number, out: THREE.Vector3 = _plane): THREE.Vector3 | null {
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (!(t >= 0) || t > MAX_PLANE_DIST) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

/** Tile under the pointer (terrain heightfield), or null when pointing off the map / at the sky. */
export function pickTile(
  camera: THREE.Camera,
  dom: HTMLElement,
  clientX: number,
  clientY: number,
  terrain: TerrainReader,
  heightAt?: TileHeightFn,
  out: TilePick = _pick,
): TilePick | null {
  return pickTileRay(screenRay(camera, dom, clientX, clientY), terrain, heightAt, out);
}

let _tEnter = 0;
let _tExit = Infinity;
/** Narrows [_tEnter, _tExit] to the slab lo..hi along one axis; false when the interval empties. */
function slab(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
  let t0 = (lo - o) / d;
  let t1 = (hi - o) / d;
  if (t0 > t1) {
    const s = t0;
    t0 = t1;
    t1 = s;
  }
  if (t0 > _tEnter) _tEnter = t0;
  if (t1 < _tExit) _tExit = t1;
  return _tEnter <= _tExit;
}

/** Heightfield DDA for an arbitrary ray (exported for tests). */
export function pickTileRay(ray: THREE.Ray, terrain: TerrainReader, heightAt?: TileHeightFn, out: TilePick = _pick): TilePick | null {
  const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
  const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;

  // Slab test against the map AABB [0,E]×[-1,PICK_MAX_Y]×[0,E].
  _tEnter = 0;
  _tExit = Infinity;
  if (!slab(ox, dx, 0, MAP_EXTENT) || !slab(oz, dz, 0, MAP_EXTENT) || !slab(oy, dy, -1, PICK_MAX_Y)) return null;
  const tEnter = _tEnter;
  const tExit = _tExit;
  if (tExit < 0) return null;

  let t = tEnter;
  const ex = ox + dx * t;
  const ez = oz + dz * t;
  let tx = Math.min(MAP_TILES - 1, Math.max(0, Math.floor(ex / TILE_SIZE)));
  let tz = Math.min(MAP_TILES - 1, Math.max(0, Math.floor(ez / TILE_SIZE)));

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? TILE_SIZE / Math.abs(dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? TILE_SIZE / Math.abs(dz) : Infinity;
  let tMaxX = stepX > 0 ? ((tx + 1) * TILE_SIZE - ox) / dx : stepX < 0 ? (tx * TILE_SIZE - ox) / dx : Infinity;
  let tMaxZ = stepZ > 0 ? ((tz + 1) * TILE_SIZE - oz) / dz : stepZ < 0 ? (tz * TILE_SIZE - oz) / dz : Infinity;

  for (let guard = 0; guard < MAP_TILES * 2 + 4; guard++) {
    const h = heightAt ? heightAt(tx, tz) : terrain.getSurfaceHeight(tx, tz);
    const tNext = Math.min(tMaxX, tMaxZ, tExit);
    const yIn = oy + dy * t;
    let tHit = -1;
    if (yIn <= h) {
      tHit = t; // entered the column through its side wall (terrace / map edge)
    } else if (dy < 0) {
      const tTop = (h - oy) / dy;
      if (tTop <= tNext) tHit = tTop;
    }
    if (tHit >= 0) {
      out.tx = tx;
      out.tz = tz;
      out.surfaceY = h;
      out.point.set(ox + dx * tHit, oy + dy * tHit, oz + dz * tHit);
      return out;
    }
    if (tNext >= tExit) return null;
    t = tNext;
    if (tMaxX < tMaxZ) {
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      tz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (tx < 0 || tz < 0 || tx >= MAP_TILES || tz >= MAP_TILES) return null;
  }
  return null;
}
